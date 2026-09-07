import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      this.emit('update-downloaded', { version: this.version })
    })
    quitAndInstall = vi.fn()
  } }
})
import { UpdateManager } from './update-manager'
const managers: UpdateManager[] = []
function manager() {
  const result = new UpdateManager({ currentVersion: '0.1.4', isPackaged: true, localBuildDirectory: 'fixture', beforeInstall: vi.fn() })
  managers.push(result)
  result.configure('')
  return result
}
beforeEach(() => {
  f.instances.length = 0; f.remoteVersion = '0.1.4'; f.localVersion = '0.1.5-local.1'
  f.remoteGate = f.downloadGate = undefined; f.remoteError = false
  f.local.mockReset().mockImplementation(async () => ({ version: f.localVersion, url: 'http://127.0.0.1:9370/fixture/' }))
})
afterEach(() => { managers.splice(0).forEach(value => value.dispose()); vi.useRealTimers() })
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
})
