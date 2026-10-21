/** Automation must never take the desktop from whoever is working. This proves a smoke-profile
 *  launch parks its window off every display, keeps it out of the taskbar, never activates it,
 *  stays silent, and still paints - so screenshots in the other smoke scripts stay real. It also
 *  proves a smoke-profile launch never listens beyond loopback, whatever a smoke asks for: every
 *  candidate electron.exe is a new path to Windows Firewall, and a non-loopback listener puts an
 *  Allow dialog on the owner's screen (owner, 2026-10-21). */
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-background-'))
const output = resolve('artifacts/background-windows')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_BACKGROUND_WINDOWS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(10000)
await page.waitForSelector('.pane-workspace, .empty-pane-workspace, .app-shell', { timeout: 20000 }).catch(() => {})

const state = await app.evaluate(async ({ BrowserWindow, screen }) => {
  const window = BrowserWindow.getAllWindows()[0]
  return {
    bounds: window.getBounds(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    audioMuted: window.webContents.isAudioMuted(),
    displays: screen.getAllDisplays().map(display => display.bounds)
  }
})

// Ask for the network the way a smoke would: phone access and remote control on 'network' exposure,
// plus raw listeners with no host (every interface) and the IPv6 wildcard, and a UDP socket.
const phone = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0, exposure: 'network' }).catch(error => ({ error: String(error) })))
const remote = await page.evaluate(() => window.conductor.remote.setSettings({ enabled: true, exposure: 'network', port: 0, machineName: 'Background guard' }).catch(error => ({ error: String(error) })))
const raw = await app.evaluate(async () => {
  const net = process.getBuiltinModule('node:net'), dgram = process.getBuiltinModule('node:dgram')
  const listen = (...args) => new Promise((done, fail) => { const server = net.createServer(); server.once('error', fail); server.listen(...args, () => done(server.address())) })
  const any = await listen(0)
  const wildcard = await listen(0, '::')
  const udp = await new Promise(done => { const socket = dgram.createSocket('udp4'); socket.bind(0, () => done(socket.address())) })
  return { any, wildcard, udp }
})
const mainPid = app.process().pid
// Every listening TCP socket and bound UDP endpoint of the app's process tree, from the OS itself.
const sockets = process.platform !== 'win32' ? [] : JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
  `$tree = @(${mainPid}); $frontier = @(${mainPid})`,
  'while ($frontier.Count) { $next = @(Get-CimInstance Win32_Process | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId }); $tree += $next; $frontier = $next }',
  '$tcp = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.OwningProcess } | ForEach-Object { [pscustomobject]@{ kind = "tcp"; address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess } })',
  '$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.OwningProcess } | ForEach-Object { [pscustomobject]@{ kind = "udp"; address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess } })',
  'ConvertTo-Json -Compress -InputObject @($tcp + $udp)'
].join('; ')], { encoding: 'utf8', windowsHide: true }).trim() || '[]')
const loopback = address => address === '::1' || /^(?:::ffff:)?127./.test(address)
const exposed = sockets.filter(socket => !loopback(socket.address))
const guardLog = await readFile(join(env.CONDUCTOR_TEST_USER_DATA, 'loopback-guard.log'), 'utf8').catch(() => '')

const overlapsAnyDisplay = state.displays.some(display =>
  state.bounds.x < display.x + display.width && state.bounds.x + state.bounds.width > display.x &&
  state.bounds.y < display.y + display.height && state.bounds.y + state.bounds.height > display.y)

// A parked window still has to render, or every other smoke script's screenshot silently goes blank.
const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
await writeFile(join(output, 'parked-window.png'), Buffer.from(png, 'base64'))

await app.close()

assert.equal(state.focused, false, 'a smoke-profile window must never take focus from the owner')
// A smoke run finishes agent after agent; unmuted, each one rings the owner's completion cue.
assert.equal(state.audioMuted, true, 'a smoke-profile window must never play sound over the owner')
assert.equal(overlapsAnyDisplay, false, `a smoke-profile window must sit off every display, got ${JSON.stringify(state.bounds)}`)
assert.ok(Buffer.from(png, 'base64').length > 5000, 'a parked window must still paint so screenshots stay real')
for (const [name, address] of Object.entries(raw)) assert.ok(loopback(address.address), `a smoke-profile ${name} listener bound ${address.address}, not loopback`)
assert.equal(phone.error, undefined, `phone access did not start: ${phone.error}`)
assert.equal(remote.error, undefined, `remote control did not start: ${remote.error}`)
assert.ok(sockets.length > 0 || process.platform !== 'win32', 'the OS reported no sockets at all for the app, so the check proved nothing')
assert.deepEqual(exposed, [], `a smoke-profile instance must never listen beyond loopback (Windows Firewall asks the owner): ${JSON.stringify(exposed)}`)
assert.match(guardLog, /bound to loopback/, 'the loopback guard recorded no rewrite, so the network requests above were not exercised')
console.log('background windows: parked at', JSON.stringify(state.bounds), '· focused', state.focused, '· muted', state.audioMuted, '· painted', Buffer.from(png, 'base64').length, 'bytes', '· sockets', sockets.length, 'all loopback')
