import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The part of electron-updater's NsisUpdater the install step touches. */
export interface InstallableUpdater {
  autoInstallOnAppQuit: boolean
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface InstallRequest {
  version: string
  installerPath: string | null
  sha512: string | null
  reason: 'update' | 'rollback'
}
export interface InstallerStubRecord extends InstallRequest { requestedAt: string }

export const INSTALLER_STUB_FILE = 'installer-stub.json'
export const INSTALLER_STUB_HISTORY = 'installer-stub-history.jsonl'
const CACHE_CONFIG = 'updater-test-config.yml'
const CACHE_DIRECTORY = 'updater-cache'

/** Every way electron-updater reaches the NSIS installer: the explicit quitAndInstall, the
 *  quit handler's install(), and the doInstall() both of them end in, which spawns it. */
const INSTALL_ENTRY_POINTS = ['quitAndInstall', 'install', 'doInstall'] as const

/** The automation profile an unpackaged launch runs in, or null for a real launch. A packaged build
 *  ignores CONDUCTOR_TEST_USER_DATA entirely, so the owner's installed app always installs for real. */
export function testInstallProfile(options: { isPackaged: boolean; env?: NodeJS.ProcessEnv }): string | null {
  if (options.isPackaged) return null
  const directory = (options.env ?? process.env).CONDUCTOR_TEST_USER_DATA?.trim()
  return directory ? resolve(directory) : null
}

export interface UpdateInstallSeam {
  /** The test profile the stub writes into; null when installs are real. */
  readonly testUserData: string | null
  /** Configures a freshly created updater. In test mode it can no longer spawn any installer, it
   *  does not install on quit, and it downloads into the test profile instead of the shared cache. */
  prepare(updater: InstallableUpdater): void
  /** The single install step for updates, rollbacks, app.update.install and app.restart. */
  install(updater: InstallableUpdater, request: InstallRequest): void
  /** The version this launch reports: in test mode the one the stub last "installed". */
  reportedVersion(actual: string): string
}

/**
 * The one place Conductor hands a downloaded build to an installer. A real launch calls
 * electron-updater's quitAndInstall exactly as before. A test instance (CONDUCTOR_TEST_USER_DATA,
 * never packaged) must not: the NSIS package installs over the owner's app whatever profile the
 * test uses. So there the seam records what would have been installed in
 * <test userData>/installer-stub.json and relaunches the app the way a finished install does.
 */
export function createUpdateInstallSeam(options: { isPackaged: boolean; env?: NodeJS.ProcessEnv; relaunch(): void; now?: () => Date }): UpdateInstallSeam {
  const testUserData = testInstallProfile(options)
  if (!testUserData) {
    return {
      testUserData: null,
      prepare: () => {},
      install: updater => updater.quitAndInstall(true, true),
      reportedVersion: actual => actual
    }
  }
  const stubPath = join(testUserData, INSTALLER_STUB_FILE)
  return {
    testUserData,
    prepare(updater) {
      updater.autoInstallOnAppQuit = false
      const target = updater as unknown as Record<string, unknown>
      for (const name of INSTALL_ENTRY_POINTS) {
        target[name] = () => { throw new Error(`Test mode never runs an installer (${name}); installs go through the update-install seam`) }
      }
      // Without an app-update.yml an unpackaged updater cannot download at all, and the default
      // cache under %LOCALAPPDATA% is shared with the installed app's own pending update. Both are
      // redirected on the updater's own app adapter: the updateConfigPath setter would also drop
      // the feed the updater was constructed with ("Unsupported provider: undefined").
      mkdirSync(testUserData, { recursive: true })
      const config = join(testUserData, CACHE_CONFIG)
      writeFileSync(config, `updaterCacheDirName: ${CACHE_DIRECTORY}\n`, 'utf8')
      const adapter = target.app
      if (adapter && typeof adapter === 'object') {
        Object.defineProperty(adapter, 'baseCachePath', { value: testUserData, configurable: true })
        Object.defineProperty(adapter, 'appUpdateConfigPath', { value: config, configurable: true })
      }
    },
    install(_updater, request) {
      const record: InstallerStubRecord = { ...request, requestedAt: (options.now?.() ?? new Date()).toISOString() }
      mkdirSync(testUserData, { recursive: true })
      const temporary = `${stubPath}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      renameSync(temporary, stubPath)
      appendFileSync(join(testUserData, INSTALLER_STUB_HISTORY), `${JSON.stringify(record)}\n`, 'utf8')
      options.relaunch()
    },
    reportedVersion(actual) {
      try {
        const record = JSON.parse(readFileSync(stubPath, 'utf8')) as Partial<InstallerStubRecord>
        return typeof record.version === 'string' && record.version ? record.version : actual
      } catch { return actual }
    }
  }
}
