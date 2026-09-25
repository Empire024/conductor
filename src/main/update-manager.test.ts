import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const f = vi.hoisted(() => ({
  instances: [] as Array<any>, local: vi.fn(), remoteVersion: '0.1.4', localVersion: '0.1.5-local.1',
  remoteGate: undefined as Promise<void> | undefined, downloadGate: undefined as Promise<void> | undefined,
  remoteError: false
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./local-update-feed', () => ({ LocalUpdateFeed: class {
  refresh = f.local
  dispose() {}
} }))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  return { NsisUpdater: class extends EventEmitter {
    autoInstallOnAppQuit = true
    version = ''
    constructor(readonly provider: { provider: string }) { super(); f.instances.push(this) }
    checkForUpdates = vi.fn(async () => {
      if (this.provider.provider === 'github') {
        await f.remoteGate
        if (f.remoteError) throw new Error('Offline')
      }
      this.version = this.provider.provider === 'github' ? f.remoteVersion : f.localVersion
      return { isUpdateAvailable: true, updateInfo: { version: this.version } }
    })
    downloadUpdate = vi.fn(async () => {
      await f.downloadGate
      this.emit('update-downloaded', { version: this.version, sha512: 'sha-' + this.version, downloadedFile: `C:\\cache\\Conductor-Setup-${this.version}.exe` })
    })
    quitAndInstall = vi.fn()
  } }
})
// Hermetic CLI rollback: no real CLI is resolved, run or looked for in the owner's home.
vi.mock('./cli-versions', async importOriginal => {
  const actual = await importOriginal<typeof import('./cli-versions')>()
  return { ...actual, CliVersionStore: class extends actual.CliVersionStore {
    constructor(options: import('./cli-versions').CliVersionStoreOptions) { super({ home: options.directory, resolveInstalled: () => null, readVersion: async () => null, ...options }) }
  } }
})
import { UpdateManager } from './update-manager'
import { CliVersionStore, pinnedCliExecutable } from './cli-versions'
import { RestorePointStore } from './restore-points'
import { createUpdateInstallSeam } from './update-install-seam'
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
