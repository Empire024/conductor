// node-pty 1.1 ships prebuilds/darwin-<arch>/spawn-helper without its execute bit (the npm
// tarball records it as 0644), so on macOS every pty ends with "posix_spawnp failed". The
// fix is one chmod +x, applied twice: after `npm ci` (postinstall) and after electron-builder
// packs the app (afterPack, on the copy under app.asar.unpacked). Both are no-ops on Windows,
// where node-pty uses conpty and has no spawn-helper, and when the files are absent.
'use strict'
const { readdirSync, statSync, chmodSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const EXECUTE_BITS = 0o111

/** Every `node-pty/prebuilds/<platform>/spawn-helper` under a node_modules folder. */
function findSpawnHelpers(nodeModules) {
  const prebuilds = join(nodeModules, 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) return []
  const found = []
  for (const platform of readdirSync(prebuilds)) {
    const candidate = join(prebuilds, platform, 'spawn-helper')
    if (existsSync(candidate) && statSync(candidate).isFile()) found.push(candidate)
  }
  return found.sort()
}

/**
 * Adds the execute bits to every spawn-helper under `nodeModules`. Returns what changed and what
 * was already executable; nothing on Windows (no mode bits to set, and no spawn-helper in use).
 */
function ensureSpawnHelperExecutable(nodeModules, { platform = process.platform } = {}) {
  const result = { fixed: [], alreadyExecutable: [] }
  if (platform === 'win32') return result
  for (const helper of findSpawnHelpers(nodeModules)) {
    const mode = statSync(helper).mode & 0o777
    if ((mode & EXECUTE_BITS) === EXECUTE_BITS) { result.alreadyExecutable.push(helper); continue }
    chmodSync(helper, mode | EXECUTE_BITS)
    result.fixed.push(helper)
  }
  return result
}

/**
 * The node_modules folders electron-builder leaves outside the asar for one packed app: on macOS
 * inside the .app bundle's Resources, on Linux and Windows next to the executable.
 */
function unpackedNodeModules(appOutDir) {
  const candidates = [join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules')]
  if (existsSync(appOutDir)) {
    for (const entry of readdirSync(appOutDir)) {
      if (!entry.endsWith('.app')) continue
      candidates.push(join(appOutDir, entry, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules'))
    }
  }
  return candidates.filter(candidate => existsSync(candidate))
}

/** electron-builder `afterPack` hook: fixes the spawn-helper copies inside the packed app. */
async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return { fixed: [], alreadyExecutable: [] }
  const result = { fixed: [], alreadyExecutable: [] }
  for (const nodeModules of unpackedNodeModules(context.appOutDir)) {
    const part = ensureSpawnHelperExecutable(nodeModules)
    result.fixed.push(...part.fixed)
    result.alreadyExecutable.push(...part.alreadyExecutable)
  }
  for (const helper of result.fixed) console.log(`  • node-pty spawn-helper made executable: ${helper}`)
  return result
}

module.exports = { EXECUTE_BITS, afterPack, ensureSpawnHelperExecutable, findSpawnHelpers, unpackedNodeModules }

if (require.main === module) {
  // postinstall: `node scripts/node-pty-spawn-helper.cjs [node_modules]`
  const nodeModules = resolve(process.argv[2] ?? join(__dirname, '..', 'node_modules'))
  const { fixed } = ensureSpawnHelperExecutable(nodeModules)
  for (const helper of fixed) console.log(`node-pty spawn-helper made executable: ${helper}`)
}
