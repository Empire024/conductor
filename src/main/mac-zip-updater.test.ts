import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron-updater', () => ({ BaseUpdater: class {} }))
import { MAC_SWAP_SCRIPT, macAppBundle, macInstallBlocker, macSwapCommand, pickMacZip } from './mac-zip-updater'

const file = (name: string) => ({ url: new URL(`https://github.com/Empire024/conductor/releases/download/v0.1.4/${name}`), info: { url: name, sha512: 'x', size: 1 } })

describe('macOS update (no Squirrel.Mac)', () => {
  it('finds the .app bundle the running executable belongs to', () => {
    expect(macAppBundle('/Applications/Conductor.app/Contents/MacOS/Conductor')).toBe('/Applications/Conductor.app')
    expect(macAppBundle('/Users/me/Apps/Conductor.app/Contents/MacOS/Conductor')).toBe('/Users/me/Apps/Conductor.app')
    // A dev run is plain Electron inside node_modules: no Conductor bundle to replace.
    expect(macAppBundle('/Users/me/conductor/node_modules/electron/dist/Electron')).toBeNull()
    expect(macAppBundle('/usr/local/bin/conductor')).toBeNull()
  })

  it('refuses to install over a translocated, disk-image or read-only copy, with the fix in words', () => {
    const writable = () => true
    expect(macInstallBlocker('/Applications/Conductor.app', writable)).toBeNull()
    expect(macInstallBlocker('/private/var/folders/x/T/AppTranslocation/ABC/d/Conductor.app', writable)).toMatch(/xattr -dr com\.apple\.quarantine/)
    expect(macInstallBlocker('/Volumes/Conductor 0.1.4/Conductor.app', writable)).toMatch(/Drag Conductor\.app to Applications/)
    expect(macInstallBlocker('/Applications/Conductor.app', () => false)).toMatch(/cannot write to \/Applications/)
  })

  it('downloads this architecture\'s zip, never the dmg', () => {
    const files = [file('Conductor-0.1.4-arm64.dmg'), file('Conductor-0.1.4-x64-mac.zip'), file('Conductor-0.1.4-arm64-mac.zip')]
    expect(pickMacZip(files, 'arm64')?.info.url).toBe('Conductor-0.1.4-arm64-mac.zip')
    expect(pickMacZip(files, 'x64')?.info.url).toBe('Conductor-0.1.4-x64-mac.zip')
    expect(pickMacZip([file('Conductor-0.1.4-mac.zip'), file('Conductor-0.1.4-x64-mac.zip')], 'arm64')?.info.url).toBe('Conductor-0.1.4-mac.zip')
    expect(pickMacZip([file('Conductor-0.1.4-universal-mac.zip')], 'arm64')?.info.url).toBe('Conductor-0.1.4-universal-mac.zip')
    expect(pickMacZip([file('Conductor-0.1.4-arm64.dmg'), file('Conductor-Setup-0.1.4.exe')], 'arm64')).toBeNull()
  })

  it('hands the swap to a detached sh with the pid, zip, bundle, relaunch flag and the app\'s own arguments', () => {
    const { command, args } = macSwapCommand({ pid: 42, zip: '/c/u.zip', bundle: '/Applications/Conductor.app', relaunch: true, args: ['--user-data-dir=/tmp/p'] })
    expect(command).toBe('/bin/sh')
    expect(args).toEqual(['-c', MAC_SWAP_SCRIPT, 'conductor-update', '42', '/c/u.zip', '/Applications/Conductor.app', '1', '--user-data-dir=/tmp/p'])
    expect(MAC_SWAP_SCRIPT).not.toContain('Squirrel')
  })
})

// The real script against real bundles: ditto, codesign (ad-hoc) and the two renames.
describe.runIf(process.platform === 'darwin')('the swap script on macOS', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  /** A minimal ad-hoc signed bundle whose executable records its arguments in `marker`. */
  function bundle(root: string, version: string, marker: string): string {
    const app = join(root, 'Conductor.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Conductor</string><key>CFBundleIdentifier</key><string>io.conductor.test</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`)
    const exe = join(app, 'Contents', 'MacOS', 'Conductor')
    writeFileSync(exe, `#!/bin/sh\necho "${version} $*" > "${marker}"\n`)
    chmodSync(exe, 0o755)
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app])
    return app
  }
  const zip = (app: string, target: string): string => { execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, target]); return target }
  const exitedPid = (): number => { const child = spawnSync('/usr/bin/true'); return child.pid! }
  const run = (args: string[]): Promise<{ code: number | null; log: string }> => new Promise(resolve => {
    const child = spawn('/bin/sh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
    child.on('close', code => resolve({ code, log }))
  })
  const waitFor = async (path: string): Promise<string> => {
    for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise(resolve => setTimeout(resolve, 100))
    return readFileSync(path, 'utf8').trim()
  }

  it('replaces the bundle once the app has exited and relaunches it with the same arguments', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-mac-swap-'))); roots.push(root)
    const marker = join(root, 'launched.txt')
    const installed = bundle(join(root, 'Applications'), '0.1.4', marker)
    const update = zip(bundle(join(root, 'build'), '0.1.5', marker), join(root, 'Conductor-0.1.5-arm64-mac.zip'))
    const result = await run(macSwapCommand({ pid: exitedPid(), zip: update, bundle: installed, relaunch: true, args: ['--user-data-dir=/tmp/p', 'two words'] }).args)
    expect(result.code, result.log).toBe(0)
    expect(execFileSync('/usr/bin/defaults', ['read', join(installed, 'Contents', 'Info'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()).toBe('0.1.5')
    expect(await waitFor(marker)).toBe('0.1.5 --user-data-dir=/tmp/p two words')
    expect(readdirSync(join(root, 'Applications'))).toEqual(['Conductor.app'])
    expect(result.log).toMatch(/installed 0\.1\.5/)
  })

  it('keeps the old bundle when the new one does not verify', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-mac-swap-'))); roots.push(root)
    const marker = join(root, 'launched.txt')
    const installed = bundle(join(root, 'Applications'), '0.1.4', marker)
    const tampered = bundle(join(root, 'build'), '0.1.5', marker)
    writeFileSync(join(tampered, 'Contents', 'MacOS', 'Conductor'), '#!/bin/sh\necho tampered\n')
    const update = zip(tampered, join(root, 'Conductor-0.1.5-arm64-mac.zip'))
    const result = await run(macSwapCommand({ pid: exitedPid(), zip: update, bundle: installed, relaunch: true, args: [] }).args)
    expect(result.code).toBe(1)
    expect(result.log).toMatch(/signature does not verify; update not installed/)
    expect(execFileSync('/usr/bin/defaults', ['read', join(installed, 'Contents', 'Info'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()).toBe('0.1.4')
    expect(readdirSync(join(root, 'Applications'))).toEqual(['Conductor.app'])
    expect(existsSync(marker)).toBe(false)
  })
})
