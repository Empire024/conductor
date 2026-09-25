import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateInstallSeam, INSTALLER_STUB_FILE, INSTALLER_STUB_HISTORY, testInstallProfile } from './update-install-seam'

/** Mirrors electron-updater's BaseUpdater: quitAndInstall and the quit handler both go through
 *  install(), which ends in doInstall(), the method that spawns the NSIS installer. */
class FakeBaseUpdater {
  autoInstallOnAppQuit = true
  readonly spawned: string[] = []
  readonly app = { get baseCachePath(): string { return 'C:\\Users\\owner\\AppData\\Local' }, get appUpdateConfigPath(): string { return 'C:\\app\\dev-app-update.yml' } }
  /** electron-updater's setter also drops the feed the updater was constructed with. */
  feedCleared = false
  set updateConfigPath(_value: string | null) { this.feedCleared = true }
  private quitHandler: (() => void) | null = null
  quitAndInstall(isSilent = false, isForceRunAfter = false): void { this.install(isSilent, isForceRunAfter) }
  install(_isSilent = false, _isForceRunAfter = false): boolean { return this.doInstall() }
  doInstall(): boolean { this.spawned.push('Conductor-Setup.exe'); return true }
  /** What electron-updater registers once a download finishes. */
  addQuitHandler(): void { if (this.autoInstallOnAppQuit) this.quitHandler = () => this.install(true, false) }
  quit(): void { this.quitHandler?.() }
}

const roots: string[] = []
const profile = (): string => { const root = mkdtempSync(join(tmpdir(), 'conductor-install-seam-')); roots.push(root); return root }
const request = { version: '0.1.60-local.5', installerPath: 'C:\\cache\\Conductor-Setup-0.1.60-local.5.exe', sha512: 'abc==', reason: 'rollback' as const }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('update install seam', () => {
  it('never reaches the real installer in test mode: no spawn by install, quitAndInstall or quit', () => {
    const userData = profile(), relaunch = vi.fn()
    const seam = createUpdateInstallSeam({ isPackaged: false, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch, now: () => new Date('2026-09-25T10:00:00Z') })
    const updater = new FakeBaseUpdater()
    seam.prepare(updater)
    expect(updater.autoInstallOnAppQuit).toBe(false)

    seam.install(updater, request)
    expect(updater.spawned).toEqual([])
    expect(relaunch).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(join(userData, INSTALLER_STUB_FILE), 'utf8'))).toEqual({ ...request, requestedAt: '2026-09-25T10:00:00.000Z' })
    expect(readFileSync(join(userData, INSTALLER_STUB_HISTORY), 'utf8').trim().split('\n')).toHaveLength(1)

    // Every path electron-updater itself has to the installer refuses instead of spawning.
    expect(() => updater.quitAndInstall(true, true)).toThrow(/Test mode never runs an installer/)
    expect(() => updater.install(true, false)).toThrow(/Test mode never runs an installer/)
    expect(() => updater.doInstall()).toThrow(/Test mode never runs an installer/)
    updater.addQuitHandler(); updater.quit()
    expect(updater.spawned).toEqual([])
  })

  it('downloads into the test profile instead of the cache the installed app shares', () => {
    const userData = profile()
    const updater = new FakeBaseUpdater()
    createUpdateInstallSeam({ isPackaged: false, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch: () => {} }).prepare(updater)
    expect(updater.app.baseCachePath).toBe(userData)
    expect(updater.app.appUpdateConfigPath).toBe(join(userData, 'updater-test-config.yml'))
    expect(readFileSync(updater.app.appUpdateConfigPath, 'utf8')).toContain('updaterCacheDirName: updater-cache')
    // The explicit loopback/GitHub feed survives; setting updateConfigPath would have dropped it.
    expect(updater.feedCleared).toBe(false)
  })

  it('reports the stub-installed version after the relaunch', () => {
    const userData = profile()
    const seam = createUpdateInstallSeam({ isPackaged: false, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch: () => {} })
    expect(seam.reportedVersion('0.1.53')).toBe('0.1.53')
    seam.install(new FakeBaseUpdater(), request)
    expect(createUpdateInstallSeam({ isPackaged: false, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch: () => {} }).reportedVersion('0.1.53')).toBe(request.version)
  })

  it('a packaged build ignores the test profile and installs for real', () => {
    const userData = profile(), relaunch = vi.fn()
    expect(testInstallProfile({ isPackaged: true, env: { CONDUCTOR_TEST_USER_DATA: userData } })).toBeNull()
    const seam = createUpdateInstallSeam({ isPackaged: true, env: { CONDUCTOR_TEST_USER_DATA: userData }, relaunch })
    const updater = new FakeBaseUpdater()
    seam.prepare(updater)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    seam.install(updater, request)
    expect(updater.spawned).toEqual(['Conductor-Setup.exe'])
    expect(relaunch).not.toHaveBeenCalled()
    expect(existsSync(join(userData, INSTALLER_STUB_FILE))).toBe(false)
    expect(seam.reportedVersion('0.1.53')).toBe('0.1.53')
  })

  it('an unpackaged launch without a test profile installs for real too', () => {
    const updater = new FakeBaseUpdater()
    const seam = createUpdateInstallSeam({ isPackaged: false, env: {}, relaunch: () => {} })
    expect(seam.testUserData).toBeNull()
    seam.prepare(updater)
    seam.install(updater, request)
    expect(updater.spawned).toEqual(['Conductor-Setup.exe'])
  })
})
