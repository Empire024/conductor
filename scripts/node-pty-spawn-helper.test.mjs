import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const { afterPack, ensureSpawnHelperExecutable, findSpawnHelpers, unpackedNodeModules } = createRequire(import.meta.url)('./node-pty-spawn-helper.cjs')

const posixOnly = { skip: process.platform === 'win32' ? 'file modes are POSIX-only' : false }
const mode = async path => (await stat(path)).mode & 0o777

/** A node_modules tree with node-pty prebuilds laid out as npm installs them, spawn-helper at 0644. */
async function fakeNodeModules(root, platforms = ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
  const nodeModules = join(root, 'node_modules')
  const helpers = []
  for (const platform of platforms) {
    const folder = join(nodeModules, 'node-pty', 'prebuilds', platform)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'pty.node'), 'native')
    if (platform.startsWith('darwin')) {
      const helper = join(folder, 'spawn-helper')
      await writeFile(helper, '#!/bin/sh\n')
      await chmod(helper, 0o644)
      helpers.push(helper)
    }
  }
  return { nodeModules, helpers }
}

test('postinstall adds the execute bit to every darwin spawn-helper and leaves the rest alone', posixOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'conductor-spawn-helper-'))
  const { nodeModules, helpers } = await fakeNodeModules(root)
  assert.deepEqual(findSpawnHelpers(nodeModules), helpers)
  const first = ensureSpawnHelperExecutable(nodeModules)
  assert.deepEqual(first, { fixed: helpers, alreadyExecutable: [] })
  for (const helper of helpers) assert.equal(await mode(helper), 0o755)
  assert.equal(await mode(join(nodeModules, 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node')), 0o644)
  // Idempotent: a second run reports the helpers as already executable and changes nothing.
  assert.deepEqual(ensureSpawnHelperExecutable(nodeModules), { fixed: [], alreadyExecutable: helpers })
})

test('a tree without node-pty prebuilds is a no-op, and so is Windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conductor-spawn-helper-'))
  assert.deepEqual(ensureSpawnHelperExecutable(join(root, 'node_modules')), { fixed: [], alreadyExecutable: [] })
  const { nodeModules } = await fakeNodeModules(root)
  assert.deepEqual(ensureSpawnHelperExecutable(nodeModules, { platform: 'win32' }), { fixed: [], alreadyExecutable: [] })
  assert.deepEqual(unpackedNodeModules(join(root, 'missing')), [])
})

test('afterPack fixes the copy under app.asar.unpacked inside a .app bundle and beside a Linux executable', posixOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'conductor-spawn-helper-'))
  const mac = join(root, 'mac-arm64')
  const { helpers: macHelpers } = await fakeNodeModules(join(mac, 'Conductor.app', 'Contents', 'Resources', 'app.asar.unpacked'), ['darwin-arm64'])
  const linux = join(root, 'linux-unpacked')
  const { helpers: linuxHelpers } = await fakeNodeModules(join(linux, 'resources', 'app.asar.unpacked'), ['darwin-x64'])
  assert.deepEqual(await afterPack({ appOutDir: mac, electronPlatformName: 'darwin' }), { fixed: macHelpers, alreadyExecutable: [] })
  assert.equal(await mode(macHelpers[0]), 0o755)
  assert.deepEqual(await afterPack({ appOutDir: linux, electronPlatformName: 'linux' }), { fixed: linuxHelpers, alreadyExecutable: [] })
  assert.equal(await mode(linuxHelpers[0]), 0o755)
  // A Windows build never touches modes, even when a darwin prebuild is lying in the tree.
  const win = join(root, 'win-unpacked')
  const { helpers: strayHelpers } = await fakeNodeModules(join(win, 'resources', 'app.asar.unpacked'), ['darwin-arm64'])
  assert.deepEqual(await afterPack({ appOutDir: win, electronPlatformName: 'win32' }), { fixed: [], alreadyExecutable: [] })
  assert.equal(await mode(strayHelpers[0]), 0o644)
})

test('the installed node-pty prebuilds carry an executable spawn-helper after postinstall', posixOnly, async () => {
  const helpers = findSpawnHelpers(resolve('node_modules'))
  if (!helpers.length) return
  for (const helper of helpers) assert.equal((await mode(helper)) & 0o111, 0o111, `${helper} is not executable`)
})
