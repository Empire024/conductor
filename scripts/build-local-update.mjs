import { spawn, execFileSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builderArguments, localFeedDirectory, parseVersion, publishLocalPackage, readPreviousDescriptor, selectLocalVersion } from './local-update-package.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = { github: true }
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  if (argument === '--no-github') options.github = false
  else if (argument === '--feed-dir' || argument === '--base-version') {
    const value = process.argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`)
    options[argument === '--feed-dir' ? 'feedDirectory' : 'baseVersion'] = value
  } else throw new Error(`Unknown argument: ${argument}`)
}
if (process.platform !== 'win32') throw new Error('Local installed-app updates currently require Windows x64')
// electron-builder collects production dependencies by walking node_modules; through a junction
// (a worktree borrowing the checkout's node_modules) it silently drops hoisted transitive ones such
// as fs-extra, and the installed app then dies at startup with "Cannot find module".
if (existsSync(resolve(workspace, 'node_modules')) && lstatSync(resolve(workspace, 'node_modules')).isSymbolicLink()) {
  throw new Error('node_modules is a junction or symlink; electron-builder would package an app missing its dependencies. Build from the main checkout, or run npm ci inside this worktree first.')
}
const sourcePackage = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'))
const feedDirectory = options.feedDirectory ? resolve(options.feedDirectory) : localFeedDirectory()
const previous = await readPreviousDescriptor(feedDirectory)
const versions = [sourcePackage.version]
if (options.baseVersion) versions.push(options.baseVersion)

// Read version resources only. Never launch, replace, or terminate the installed app.
const installedExecutable = process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Programs', 'conductor-desktop', 'Conductor.exe')
if (installedExecutable && existsSync(installedExecutable)) {
  try {
    const powershell = resolve(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // FileVersion retains the packaged prerelease. ProductVersion is reduced to x.y.z.0
    // by electron-builder and would incorrectly advance the patch for each local install.
    const installed = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:CONDUCTOR_VERSION_PROBE_FILE).VersionInfo.FileVersion'], {
      env: { ...process.env, CONDUCTOR_VERSION_PROBE_FILE: installedExecutable }, encoding: 'utf8', windowsHide: true, timeout: 10_000
    }).trim()
    if (parseVersion(installed)) { versions.push(installed); console.log(`Installed Conductor: ${installed}`) }
    else console.warn('Installed version metadata is unrecognized; using other version baselines.')
  } catch { console.warn('Could not read installed version; using other version baselines.') }
}
if (options.github) {
  try {
    const response = await fetch('https://api.github.com/repos/Empire024/conductor/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Conductor-local-update-builder' }, signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const release = await response.json()
    const stable = parseVersion(release.tag_name)
    if (!stable || stable.prerelease || release.draft || release.prerelease) throw new Error('Latest release is not stable')
    versions.push(stable.version)
    console.log(`Latest published Conductor: ${stable.version}`)
  } catch (error) { console.warn(`GitHub version metadata unavailable (${error.message}); using installed/source/feed baselines.`) }
}
const version = selectLocalVersion({ versions, previousVersion: previous?.version })
const outputDirectory = resolve(workspace, 'release', 'local-builds', version)
await mkdir(resolve(workspace, 'release', 'local-builds'), { recursive: true })
await mkdir(outputDirectory) // Unique version: never clear or reuse somebody else's build output.
let commit = null
let dirty = true
try {
  const gitArguments = ['-c', `safe.directory=${workspace.replaceAll('\\', '/')}`]
  commit = execFileSync('git', [...gitArguments, 'rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim()
  dirty = Boolean(execFileSync('git', [...gitArguments, 'status', '--porcelain'], { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim())
} catch { console.warn('Git metadata unavailable; local build will not claim a clean commit.') }

const cliVersion = (command, args = ['--version']) => {
  try { return execFileSync(command, args, { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim().split(/\r?\n/)[0] || null }
  catch { return null }
}
const parseModels = () => {
  try {
    const value = JSON.parse(process.env.CONDUCTOR_MODELS_LIST_JSON || '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}
const captureRestorePoint = async descriptor => {
  const catalogPath = resolve(feedDirectory, 'restore-points.json')
  let catalog = { schemaVersion: 1, points: [] }
  try {
    const value = JSON.parse(await readFile(catalogPath, 'utf8'))
    if (value?.schemaVersion === 1 && Array.isArray(value.points)) catalog = value
  } catch {}
  const existing = catalog.points.find(point => point.version === version)
  const point = {
    version, commit, createdAt: descriptor.createdAt, dirty,
    cliVersions: { claude: cliVersion('claude'), codex: cliVersion('codex'), grok: cliVersion('grok') },
    models: parseModels(), installer: descriptor.installer, blockmap: descriptor.blockmap,
    // This build honours CLI pins (src/main/cli-versions.ts), so rolling back to it keeps restored CLIs.
    cliPinning: true,
    pinned: existing?.pinned === true, knownGood: existing?.knownGood === true,
    crashCount: existing?.crashCount || 0, failedShipCount: existing?.failedShipCount || 0,
    ...(existing?.firstLaunchedAt ? { firstLaunchedAt: existing.firstLaunchedAt } : {})
  }
  catalog.points = [point, ...catalog.points.filter(entry => entry.version !== version)]
  const descriptorCopy = resolve(feedDirectory, `restore-point-${version}.json`)
  await writeFile(descriptorCopy, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const temporary = resolve(feedDirectory, `.restore-points-${process.pid}-${Date.now()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await rename(temporary, catalogPath)
  return point
}

const npmCandidates = [process.env.npm_execpath, resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
const npmCli = npmCandidates.find(path => path && path.endsWith('.js') && existsSync(path))
if (!npmCli) throw new Error('Could not resolve npm-cli.js; invoke with npm.cmd run update:local')
async function runNode(arguments_) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: workspace, stdio: 'inherit', windowsHide: true, shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Build failed (${signal || code})`)))
  })
}
console.log(`Building ${version}; the source package version and Git tags remain unchanged.`)
await runNode([npmCli, 'run', 'build'])
await runNode([resolve(workspace, 'node_modules', 'electron-builder', 'cli.js'), ...builderArguments(version, outputDirectory)])
const descriptor = await publishLocalPackage({ version, outputDirectory, feedDirectory, commit, dirty })
const restorePoint = await captureRestorePoint(descriptor)
console.log(`Local update ready: ${descriptor.version}\nFeed: ${feedDirectory}\nThe installed app's Include local test builds option must be enabled (the default). It will offer Update pending; no installer needs to be run manually.`)
console.log(`Restore point: ${restorePoint.version}; Claude ${restorePoint.cliVersions.claude ?? 'unknown'}, Codex ${restorePoint.cliVersions.codex ?? 'unknown'}, Grok ${restorePoint.cliVersions.grok ?? 'unknown'}; ${restorePoint.models.length} provider catalogs captured.`)
