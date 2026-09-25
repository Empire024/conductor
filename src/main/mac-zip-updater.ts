import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants, mkdirSync, openSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { BaseUpdater, type NsisUpdater, type ResolvedUpdateFileInfo } from 'electron-updater'
import type { DownloadExecutorTask, DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import type { InstallOptions } from 'electron-updater/out/BaseUpdater'

type DownloadOptions = Parameters<DownloadExecutorTask['task']>[1]

/**
 * macOS updates without Squirrel.Mac. The Mac build is ad-hoc signed (no Apple Developer ID), and
 * Squirrel.Mac only installs a build whose signature satisfies the running app's designated
 * requirement, which for an ad-hoc signature is the exact code hash: every new build fails it.
 * So a Mac downloads the release zip (latest-mac.yml, sha512-checked by electron-updater) like any
 * other update, and installing it is a detached /bin/sh that waits for Conductor to exit, unpacks
 * the zip next to the running .app, checks the new bundle's signature, swaps the two bundles with
 * renames, and relaunches the new one with the same arguments and environment (as app.relaunch).
 * Windows keeps NsisUpdater; update-manager.ts picks the class per platform.
 */

/** The .app bundle an executable runs from (`X.app/Contents/MacOS/X`), or null outside one (a dev run). */
export function macAppBundle(execPath: string): string | null {
  const parts = execPath.split('/')
  if (parts.length < 4 || parts.at(-2) !== 'MacOS' || parts.at(-3) !== 'Contents' || !parts.at(-4)?.endsWith('.app')) return null
  return parts.slice(0, -3).join('/') || null
}

/** Why a bundle cannot replace itself in place, or null when it can. */
export function macInstallBlocker(bundle: string, canWrite: (directory: string) => boolean): string | null {
  if (bundle.includes('/AppTranslocation/')) return 'Conductor is running from a quarantined download (App Translocation). Move Conductor.app to Applications and run `xattr -dr com.apple.quarantine /Applications/Conductor.app`, then update again.'
  if (bundle.startsWith('/Volumes/')) return 'Conductor is running from the disk image. Drag Conductor.app to Applications and open it from there, then update again.'
  if (!canWrite(dirname(bundle))) return `Conductor cannot write to ${dirname(bundle)}, so it cannot replace ${basename(bundle)} there.`
  return null
}

/** The update zip for this Mac: this architecture's build when the release names one, else an untagged (universal) zip. */
export function pickMacZip(files: ResolvedUpdateFileInfo[], arch: string = process.arch): ResolvedUpdateFileInfo | null {
  const zips = files.filter(file => file.url.pathname.toLowerCase().endsWith('.zip'))
  const tagged = (file: ResolvedUpdateFileInfo, tag: string): boolean => new RegExp(`[-_.]${tag}[-_.]`, 'i').test(basename(decodeURIComponent(file.url.pathname)))
  return zips.find(file => tagged(file, arch)) ?? zips.find(file => !['arm64', 'x64', 'universal'].some(tag => tagged(file, tag))) ?? zips.find(file => tagged(file, 'universal')) ?? null
}

/**
 * The installer: `sh -c MAC_SWAP_SCRIPT conductor-update <pid> <zip> <app> <relaunch 0|1> [app args…]`.
 * Every step is logged with a timestamp; any failure leaves the old app in place (a failed second
 * rename moves the old bundle back) and exits non-zero.
 */
export const MAC_SWAP_SCRIPT = String.raw`set -u
pid="$1"; zip="$2"; app="$3"; relaunch="$4"; shift 4
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
say "installing $zip over $app once pid $pid exits"
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 600 ]; then say "pid $pid still running after 120 s; update not installed"; exit 1; fi
  sleep 0.2
done
name=$(basename "$app")
stage=$(mktemp -d "$(dirname "$app")/.$name.update.XXXXXX") || { say "cannot write next to $app; update not installed"; exit 1; }
fail() { say "$1; update not installed"; rm -rf "$stage"; exit 1; }
/usr/bin/ditto -x -k "$zip" "$stage/new" || fail "could not unpack $zip"
new="$stage/new/$name"
if [ ! -d "$new" ]; then new=$(find "$stage/new" -maxdepth 1 -type d -name '*.app' | head -n 1); fi
[ -n "$new" ] && [ -d "$new/Contents/MacOS" ] || fail "$zip holds no .app bundle"
/usr/bin/xattr -dr com.apple.quarantine "$new" 2>/dev/null
/usr/bin/codesign --verify --deep --strict "$new" || fail "the new bundle's signature does not verify"
mv "$app" "$stage/old.app" || fail "could not move the running app aside"
if ! mv "$new" "$app"; then mv "$stage/old.app" "$app"; fail "could not move the new app in (old app restored)"; fi
rm -rf "$stage"
say "installed $(/usr/bin/defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
if [ "$relaunch" = 1 ]; then
  exe="$app/Contents/MacOS/$(/usr/bin/defaults read "$app/Contents/Info" CFBundleExecutable)"
  nohup "$exe" "$@" >/dev/null 2>&1 &
  say "relaunched $exe as pid $!"
fi
exit 0`

export interface MacSwapRequest {
  pid: number
  zip: string
  bundle: string
  relaunch: boolean
  /** The running app's arguments after the executable, passed to the relaunched one. */
  args: string[]
}

/** The detached /bin/sh invocation that installs one downloaded zip. */
export function macSwapCommand(request: MacSwapRequest): { command: string; args: string[] } {
  return { command: '/bin/sh', args: ['-c', MAC_SWAP_SCRIPT, 'conductor-update', String(request.pid), request.zip, request.bundle, request.relaunch ? '1' : '0', ...request.args] }
}

const canWrite = (directory: string): boolean => { try { accessSync(directory, constants.W_OK); return true } catch { return false } }

export class MacZipUpdater extends BaseUpdater {
  constructor(options?: ConstructorParameters<typeof NsisUpdater>[0]) { super(options) }

  protected doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<string[]> {
    const { provider, info } = downloadUpdateOptions.updateInfoAndProvider
    const fileInfo = pickMacZip(provider.resolveFiles(info))
    if (!fileInfo) throw new Error(`Conductor ${info.version} has no macOS zip for ${process.arch}`)
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo,
      downloadUpdateOptions,
      task: (destination, options) => this.download(fileInfo.url, destination, options)
    })
  }

  /** electron-updater's own HTTP executor (private in its typings, used by every updater it ships). */
  private download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return (this as unknown as { httpExecutor: { download(url: URL, destination: string, options: DownloadOptions): Promise<string> } }).httpExecutor.download(url, destination, options)
  }

  protected doInstall(options: InstallOptions): boolean {
    const bundle = macAppBundle(process.execPath)
    const zip = this.installerPath
    if (!bundle || !zip) throw new Error('Only an installed Conductor.app can install a macOS update')
    const blocker = macInstallBlocker(bundle, canWrite)
    if (blocker) throw new Error(blocker)
    // The cache folder above pending/, which electron-updater empties when the next download starts.
    const logDirectory = dirname(dirname(zip))
    mkdirSync(logDirectory, { recursive: true })
    const log = openSync(join(logDirectory, 'install.log'), 'a')
    try {
      const { command, args } = macSwapCommand({ pid: process.pid, zip, bundle, relaunch: options.isForceRunAfter, args: process.argv.slice(1) })
      this._logger.info(`Installing ${zip} over ${bundle} (log ${join(logDirectory, 'install.log')})`)
      const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log], env: process.env })
      child.unref()
    } finally { closeSync(log) }
    return true
  }
}
