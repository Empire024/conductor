import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const f = vi.hoisted(() => ({
  instances: [] as Array<any>, local: vi.fn(), remoteVersion: '0.1.4', localVersion: '0.1.5-local.1',
  remoteGate: undefined as Promise<void> | undefined, downloadGate: undefined as Promise<void> | undefined,
  remoteError: false as boolean | string
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./local-update-feed', () => ({ LocalUpdateFeed: class {
  refresh = f.local
  dispose() {}
} }))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  // BaseUpdater too: the macOS updater (mac-zip-updater.ts) extends it.
  class Updater extends EventEmitter {
    autoInstallOnAppQuit = true
    version = ''
    constructor(readonly provider: { provider: string }) { super(); f.instances.push(this) }
    checkForUpdates = vi.fn(async () => {
      if (this.provider.provider === 'github') {
        await f.remoteGate
        if (f.remoteError) throw new Error(typeof f.remoteError === 'string' ? f.remoteError : 'Offline')
      }
      this.version = this.provider.provider === 'github' ? f.remoteVersion : f.localVersion
      return { isUpdateAvailable: true, updateInfo: { version: this.version } }
    })
    downloadUpdate = vi.fn(async () => {
      await f.downloadGate
      this.emit('update-downloaded', { version: this.version, sha512: 'sha-' + this.version, downloadedFile: `C:\\cache\\Conductor-Setup-${this.version}.exe` })
    })
    quitAndInstall = vi.fn()
  }
  return { BaseUpdater: Updater, NsisUpdater: class extends Updater {} }
})
// Hermetic CLI rollback: no real CLI is resolved, run or looked for in the owner's home.
vi.mock('./cli-versions', async importOriginal => {
  const actual = await importOriginal<typeof import('./cli-versions')>()
  return { ...actual, CliVersionStore: class extends actual.CliVersionStore {
    constructor(options: import('./cli-versions').CliVersionStoreOptions) { super({ home: options.directory, resolveInstalled: () => null, readVersion: async () => null, ...options }) }
  } }
})
import { UpdateManager, createPlatformUpdater } from './update-manager'
import { MacZipUpdater } from './mac-zip-updater'
import { CliVersionStore, pinnedCliExecutable } from './cli-versions'
import { RestorePointStore } from './restore-points'
import { createUpdateInstallSeam } from './update-install-seam'
import { writeLocalUpdateOffer } from './local-update-offer'
const managers: UpdateManager[] = []
const roots: string[] = []
const updateDir = (): string => { const root = mkdtempSync(join(tmpdir(), 'conductor-update-manager-')); roots.push(root); return root }
function manager() {
  const result = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: updateDir(), beforeInstall: vi.fn() })
  managers.push(result)
  result.configure('')
  return result
}
beforeEach(() => {
  f.instances.length = 0; f.remoteVersion = '0.1.4'; f.localVersion = '0.1.5-local.1'
  f.remoteGate = f.downloadGate = undefined; f.remoteError = false
  f.local.mockReset().mockImplementation(async () => ({ version: f.localVersion, url: 'http://127.0.0.1:9370/fixture/' }))
})
afterEach(() => { managers.splice(0).forEach(value => value.dispose()); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })
describe('installed updater source ownership — mocked transport, no installation', () => {
  it('requires batch verification before local installation and prevents quiet auto-installs', async () => {
    const directory = updateDir(), beforeInstall = vi.fn()
    let blockers: Array<{ id: string; title: string }> = []
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: directory, beforeInstall, requireVerifiedLocal: true, installBlockers: () => blockers })
    managers.push(m); m.configure(''); await m.check(); await m.download()
    await expect(m.install()).rejects.toThrow('full batch verification')
    expect(beforeInstall).not.toHaveBeenCalled()
    writeLocalUpdateOffer(directory, { version: f.localVersion, builder: 'test', verified: true, offered: false })
    m.getState(); expect(f.instances[1].autoInstallOnAppQuit).toBe(false)
    writeLocalUpdateOffer(directory, { version: f.localVersion, builder: 'test', verified: true, offered: true })
    m.getState(); expect(f.instances[1].autoInstallOnAppQuit).toBe(true)
    blockers = [{ id: 'busy', title: 'Background work' }]
    m.getState(); expect(f.instances[1].autoInstallOnAppQuit).toBe(false)
    blockers = []
    await m.install({ safe: true }); expect(beforeInstall).toHaveBeenCalledTimes(1)
  })
  it('keeps a local build quiet until verified, offered and idle, without gating releases', async () => {
    const directory = updateDir()
    let blockers = [{ id: 'fake', title: 'Fake busy tab' }]
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: directory, beforeInstall: vi.fn(), installBlockers: () => blockers })
    managers.push(m); m.configure(''); await m.check()
    expect(m.getState().promptAllowed).toBe(false)
    writeLocalUpdateOffer(directory, { version: f.localVersion, builder: 'test', verified: true, offered: true })
    expect(m.getState()).toMatchObject({ promptAllowed: false, quietReason: expect.stringContaining('1 tab is working') })
    blockers = []
    expect(m.getState().promptAllowed).toBe(true)
    f.remoteVersion = '0.1.6'; blockers = [{ id: 'fake', title: 'Fake busy tab' }]
    await m.check()
    expect(m.getState()).toMatchObject({ source: 'release', promptAllowed: true })
  })
  it('rechecks at click time and installs a queued version once idle', async () => {
    vi.useFakeTimers()
    let blockers = [{ id: 'fake', title: 'Fake busy tab' }]
    const beforeInstall = vi.fn()
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: updateDir(), beforeInstall, installBlockers: () => blockers })
    managers.push(m); m.configure(''); await m.check(); await m.download()
    await m.install({ safe: true })
    expect(m.getState().phase).toBe('ready'); expect(beforeInstall).not.toHaveBeenCalled()
    await m.install({ safe: true, whenIdle: true })
    expect(m.getState().installWhenIdle).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(beforeInstall).not.toHaveBeenCalled()
    blockers = []
    await vi.advanceTimersByTimeAsync(1000)
    expect(beforeInstall).toHaveBeenCalledTimes(1)
  })
  it('rechecks after asynchronous renderer preparation too', async () => {
    let blockers: Array<{ id: string; title: string }> = []
    const beforeInstall = vi.fn()
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: updateDir(), beforeInstall, installBlockers: () => blockers })
    managers.push(m); m.configure(''); await m.check(); await m.download()
    vi.spyOn(m as any, 'prepareRenderers').mockImplementation(async () => { blockers = [{ id: 'race', title: 'Started during flush' }] })
    await m.install({ safe: true })
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(m.getState()).toMatchObject({ phase: 'ready', installBlockers: blockers })
  })
  it('cancels an idle install when a newer candidate replaces the downloaded version', async () => {
    vi.useFakeTimers()
    let blockers = [{ id: 'busy', title: 'Running work' }]
    const beforeInstall = vi.fn()
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: updateDir(), beforeInstall, installBlockers: () => blockers })
    managers.push(m); m.configure(''); await m.check(); await m.download(); await m.install({ safe: true, whenIdle: true })
    f.localVersion = '0.1.5-local.2'
    await m.check()
    blockers = []
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.getState()).toMatchObject({ phase: 'available', availableVersion: f.localVersion, installWhenIdle: false })
    expect(beforeInstall).not.toHaveBeenCalled()
  })
  it('discovers local builds automatically shortly after startup', async () => {
    vi.useFakeTimers()
    const m = manager()
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.getState()).toMatchObject({ phase: 'available', source: 'local', availableVersion: f.localVersion })
    expect(f.instances[0].autoDownload).toBe(false)
    expect(f.instances[1].disableWebInstaller).toBe(true)
    expect(f.instances[1].allowDowngrade).toBe(false)
  })
  it('returns to a newer stable release instead of trapping the user on a local prerelease', async () => {
    f.remoteVersion = '0.1.5'
    const m = manager()
    expect(await m.check()).toMatchObject({ source: 'release', availableVersion: '0.1.5' })
  })
  it('honors disabling local test builds while preserving release discovery', async () => {
    const m = manager()
    m.configure('', false)
    expect(await m.check()).toMatchObject({ phase: 'idle' })
    expect(f.local).not.toHaveBeenCalled()
  })
  it('offers local builds even when the release network is offline', async () => {
    f.remoteError = true
    expect(await manager().check()).toMatchObject({ phase: 'available', source: 'local' })
  })
  it('rejects corrupt local artifacts without hiding a valid release', async () => {
    f.local.mockRejectedValue(new Error('checksum failed'))
    f.remoteVersion = '0.1.5'
    expect(await manager().check()).toMatchObject({ source: 'release', localBuildWarning: expect.stringContaining('checksum failed') })
  })
  it('pins a selected local download against a late newer remote response', async () => {
    let releaseRemote!: () => void
    let releaseDownload!: () => void
    f.remoteGate = new Promise(resolve => { releaseRemote = resolve })
    f.downloadGate = new Promise(resolve => { releaseDownload = resolve })
    f.remoteVersion = '0.1.6'
    const m = manager()
    const checking = m.check()
    await vi.waitFor(() => expect(m.getState().phase).toBe('available'))
    const downloading = m.download()
    expect(m.getState().phase).toBe('downloading')
    expect(() => m.configure('', false)).toThrow('Finish')
    releaseRemote()
    await checking
    expect(m.getState()).toMatchObject({ source: 'local', availableVersion: f.localVersion })
    releaseDownload()
    expect(await downloading).toMatchObject({ phase: 'ready', source: 'local' })
    expect(f.instances[0].downloadUpdate).not.toHaveBeenCalled()
    await m.install()
    expect(f.instances[1].quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  })
  it('a downloaded update can be held back from installing on this quit', async () => {
    const m = manager()
    await m.check()
    await m.download()
    expect(m.getState().phase).toBe('ready')
    expect(f.instances.every(instance => instance.autoInstallOnAppQuit)).toBe(true)
    m.deferInstallOnQuit()
    expect(f.instances.every(instance => instance.autoInstallOnAppQuit === false)).toBe(true)
    expect(m.getState().phase).toBe('ready')
  })
  it('offers a local build made after an update was downloaded, instead of installing the stale one', async () => {
    const m = manager()
    await m.check(); await m.download()
    expect(m.getState()).toMatchObject({ phase: 'ready', availableVersion: '0.1.5-local.1' })
    // Nothing newer: the downloaded update stays ready, untouched.
    expect(await m.check()).toMatchObject({ phase: 'ready', availableVersion: '0.1.5-local.1', progress: 100 })
    f.localVersion = '0.1.5-local.2'
    expect(await m.check()).toMatchObject({ phase: 'available', source: 'local', availableVersion: '0.1.5-local.2' })
    await m.download()
    expect(m.getState()).toMatchObject({ phase: 'ready', availableVersion: '0.1.5-local.2' })
    await m.install()
    expect(f.instances.filter(instance => instance.quitAndInstall.mock.calls.length)).toHaveLength(1)
  })
  it('a newer release replacing a downloaded local build stops the local one installing on quit', async () => {
    const m = manager()
    await m.check(); await m.download()
    const local = f.instances.find(instance => instance.provider.provider !== 'github')
    f.remoteVersion = '0.1.6'
    expect(await m.check()).toMatchObject({ phase: 'available', source: 'release', availableVersion: '0.1.6' })
    expect(local.autoInstallOnAppQuit).toBe(false)
  })
  it('coalesces repeated download actions from multiple windows', async () => {
    let finish!: () => void
    f.downloadGate = new Promise(resolve => { finish = resolve })
    const m = manager()
    await m.check()
    const first = m.download()
    await m.download()
    expect(f.instances[1].downloadUpdate).toHaveBeenCalledTimes(1)
    finish(); await first
  })

  it('rolls back through the same local feed with downgrades enabled', async () => {
    const directory = updateDir(), version = '0.1.3-local.1'
    const store = new RestorePointStore(directory)
    store.record({ version, commit: 'a'.repeat(40), createdAt: '2026-09-23T12:00:00Z', dirty: false,
      cliVersions: { claude: '2.1.278', codex: '0.155.1', grok: '1.0.41' }, models: [],
      installer: `Conductor-Setup-${version}.exe`, blockmap: `Conductor-Setup-${version}.exe.blockmap` })
    writeFileSync(join(directory, `restore-point-${version}.json`), JSON.stringify({ schemaVersion: 1, version }))
    f.localVersion = version
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: directory, beforeInstall: vi.fn() })
    managers.push(m); m.configure('')
    await m.rollback(version)
    const rollbackUpdater = f.instances.at(-1)
    expect(rollbackUpdater.allowDowngrade).toBe(true)
    expect(rollbackUpdater.downloadUpdate).toHaveBeenCalledOnce()
    expect(rollbackUpdater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  })

  it('rolls back the CLIs only: pins the recorded versions, installs nothing, and shows the plan first', async () => {
    const directory = updateDir(), version = '0.1.3-local.1', home = join(directory, 'home')
    new RestorePointStore(directory).record({ version, commit: 'a'.repeat(40), createdAt: '2026-09-23T12:00:00Z', dirty: false,
      cliVersions: { claude: '2.1.278 (Claude Code)', codex: 'codex-cli 0.155.1', grok: null }, models: [],
      installer: `Conductor-Setup-${version}.exe`, blockmap: `Conductor-Setup-${version}.exe.blockmap` })
    mkdirSync(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true })
    writeFileSync(join(home, '.local', 'share', 'claude', 'versions', '2.1.278'), '2.1.278')
    const installed = join(directory, 'claude.exe'); writeFileSync(installed, '2.1.290')
    const cliVersions = new CliVersionStore({ directory: join(directory, 'cli-cache'), home, resolveInstalled: provider => provider === 'claude' ? installed : null,
      readVersion: async file => { try { return readFileSync(file, 'utf8') } catch { return null } } })
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: directory, beforeInstall: vi.fn(), cliVersions, cliSnapshotDelayMs: null })
    managers.push(m); m.configure('')
    const plan = await m.restorePlan(version, 'clis')
    expect(plan.app).toBeNull()
    expect(plan.clis.map(change => [change.provider, change.from, change.to, change.action])).toEqual([['claude', '2.1.290', '2.1.278', 'pin'], ['codex', null, '0.155.1', 'unavailable']])
    // No saved build descriptor: the app cannot come back, the CLIs still can.
    expect((await m.restorePlan(version, 'all')).blocked).toMatch(/no saved build/)
    await m.rollback(version, 'clis')
    expect(pinnedCliExecutable('claude')).toBe(join(directory, 'cli-cache', 'claude', '2.1.278', process.platform === 'win32' ? 'claude.exe' : 'claude'))
    expect(f.instances.every(instance => instance.quitAndInstall.mock.calls.length === 0 && instance.downloadUpdate.mock.calls.length === 0)).toBe(true)
    expect(await m.cliPins()).toMatchObject([{ provider: 'claude', version: '2.1.278', installed: '2.1.290', restorePoint: version }])
    expect(await m.useInstalledClis()).toEqual([])
    expect(pinnedCliExecutable('claude')).toBeNull()
  })
})

it('keeps a downloaded update ready when the owner cancels closing dirty editors', async () => {
  const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: updateDir(), beforeInstall: () => { throw Object.assign(new Error('Cancelled'), { code: 'UPDATE_CANCELLED' }) } })
  managers.push(m); m.configure('')
  await m.check(); await m.download(); await m.install()
  expect(m.getState().phase).toBe('ready')
  expect(f.instances.every((instance) => instance.quitAndInstall.mock.calls.length === 0)).toBe(true)
})

describe('test-mode installs go through the installer stub', () => {
  const rollbackFixture = (directory: string, version: string): void => {
    new RestorePointStore(directory).record({ version, commit: 'a'.repeat(40), createdAt: '2026-09-23T12:00:00Z', dirty: false,
      cliVersions: { claude: '2.1.278', codex: '0.155.1', grok: '1.0.41' }, models: [{ provider: 'claude', models: [{ id: 'opus' }] }],
      installer: `Conductor-Setup-${version}.exe`, blockmap: `Conductor-Setup-${version}.exe.blockmap` })
    writeFileSync(join(directory, `restore-point-${version}.json`), JSON.stringify({ schemaVersion: 1, version }))
  }
  it('a test-mode rollback writes installer-stub.json and relaunches instead of running the installer', async () => {
    const userData = updateDir(), directory = join(userData, 'local-updates'), version = '0.1.3-local.1'
    mkdirSync(directory, { recursive: true }); rollbackFixture(directory, version)
    f.localVersion = version
    const relaunch = vi.fn()
    const installSeam = createUpdateInstallSeam({ isPackaged: false, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch, now: () => new Date('2026-09-25T10:00:00Z') })
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: false, allowDevelopmentUpdates: true, localBuildDirectory: directory, beforeInstall: vi.fn(), installSeam })
    managers.push(m); m.configure('')
    expect(f.instances.every(instance => instance.autoInstallOnAppQuit === false)).toBe(true)
    await m.rollback(version)
    const rollbackUpdater = f.instances.at(-1)
    expect(rollbackUpdater.autoInstallOnAppQuit).toBe(false)
    expect(() => rollbackUpdater.quitAndInstall(true, true)).toThrow(/Test mode never runs an installer/)
    expect(relaunch).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(join(userData, 'installer-stub.json'), 'utf8'))).toEqual({
      version, installerPath: `C:\\cache\\Conductor-Setup-${version}.exe`, sha512: 'sha-' + version, reason: 'rollback', requestedAt: '2026-09-25T10:00:00.000Z'
    })
    // The relaunched app reports the version the stub "installed".
    const next = new UpdateManager({ currentVersion: '0.1.4', isPackaged: false, localBuildDirectory: directory, beforeInstall: vi.fn(),
      installSeam: createUpdateInstallSeam({ isPackaged: false, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch: vi.fn() }) })
    managers.push(next)
    expect(next.getState().currentVersion).toBe(version)
    expect(next.versions().find(point => point.version === version)?.firstLaunchedAt).toBeTruthy()
  })
  it('a normal test-mode update install records reason "update"', async () => {
    const userData = updateDir(), relaunch = vi.fn()
    const installSeam = createUpdateInstallSeam({ isPackaged: false, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch })
    const m = new UpdateManager({ currentVersion: '0.1.4', isPackaged: false, allowDevelopmentUpdates: true, localBuildDirectory: join(userData, 'local-updates'), beforeInstall: vi.fn(), installSeam })
    managers.push(m); m.configure('')
    await m.check(); await m.download(); await m.install()
    expect(relaunch).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(join(userData, 'installer-stub.json'), 'utf8'))).toMatchObject({ version: f.localVersion, reason: 'update' })
  })
})

describe('the updater per platform', () => {
  it('a Mac swaps in the release zip itself; Windows keeps the NSIS updater', () => {
    const feed = { provider: 'github', owner: 'Empire024', repo: 'conductor', releaseType: 'release' } as const
    expect(createPlatformUpdater(feed, 'darwin')).toBeInstanceOf(MacZipUpdater)
    const windows = createPlatformUpdater(feed, 'win32')
    expect(windows).not.toBeInstanceOf(MacZipUpdater)
    expect(windows.constructor.name).not.toBe('MacZipUpdater')
  })
  it('on a Mac, a release published without its Mac files is nothing to install, not an error', async () => {
    const missing = 'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/Empire024/conductor/releases/download/v0.1.9/latest-mac.yml): HttpError: 404'
    f.remoteError = missing
    f.local.mockResolvedValue(null)
    const mac = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: updateDir(), beforeInstall: vi.fn(), platform: 'darwin' })
    managers.push(mac); mac.configure('')
    expect(await mac.check()).toMatchObject({ phase: 'idle', message: 'The latest release has no Mac build yet.' })
    expect(f.instances.at(-1)).toBeInstanceOf(MacZipUpdater)
    // Windows still reports it: there it would be a broken release.
    const windows = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: updateDir(), beforeInstall: vi.fn(), platform: 'win32' })
    managers.push(windows); windows.configure('')
    expect(await windows.check()).toMatchObject({ phase: 'error', message: missing })
  })
})
