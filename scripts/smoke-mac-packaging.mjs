// macOS packaging and self-update proof (FX30, docs/mac-node.md "Packaging and updates"). Runs ON a
// Mac, after two `electron-builder --mac dmg zip --arm64` builds of different versions:
//
//   node scripts/smoke-mac-packaging.mjs --old <dir holding the old .dmg> --new <dir holding the new
//        .zip and latest-mac.yml> --work <scratch dir>
//
// 1. Installs the old build from its dmg (hdiutil attach, ditto) into <work>/Applications, the way
//    the owner drags it to Applications, and reports codesign (ad-hoc), spctl and the spawn-helper.
// 2. Launches it packaged with its own --user-data-dir, and parked: it starts under --inspect-brk,
//    and before any app code runs a hook moves every window 6000 px left of the displays and hides
//    the Dock icon (a packaged build ignores CONDUCTOR_TEST_USER_DATA by design).
// 3. Points it at a loopback feed (CONDUCTOR_UPDATE_URL) serving the new zip, and drives the real
//    update: check -> download -> install. The app quits, mac-zip-updater's swap script replaces
//    the bundle and relaunches it with the same arguments; the relaunched build is parked the same
//    way and must report the new version.
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const arg = name => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? resolve(process.argv[index + 1]) : null }
const oldDir = arg('old'), newDir = arg('new'), work = arg('work')
if (!oldDir || !newDir || !work) { console.error('usage: --old <dir> --new <dir> --work <dir>'); process.exit(2) }
if (process.platform !== 'darwin') { console.error('macOS only'); process.exit(2) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const run = (command, args) => { const r = spawnSync(command, args, { encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() } }

// 1. Install from the dmg.
rmSync(work, { recursive: true, force: true })
const applications = join(work, 'Applications'), mount = join(work, 'mnt'), profile = join(work, 'profile')
mkdirSync(applications, { recursive: true }); mkdirSync(mount, { recursive: true })
const dmg = readdirSync(oldDir).find(name => name.endsWith('.dmg'))
const manifest = existsSync(join(newDir, 'latest-mac.yml')) ? readFileSync(join(newDir, 'latest-mac.yml'), 'utf8') : ''
const zip = /^path:\s*(\S+)/m.exec(manifest)?.[1]
if (!dmg || !zip || !existsSync(join(newDir, zip))) { console.error(`need a dmg in ${oldDir}, and latest-mac.yml with its zip in ${newDir}`); process.exit(2) }
console.log(`old ${dmg}, new ${zip}`)
const attach = run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, join(oldDir, dmg)])
check('dmg mounts', attach.code === 0, attach.code ? attach.out : '')
const dmgEntries = readdirSync(mount)
check('dmg holds Conductor.app and the Applications link', dmgEntries.includes('Conductor.app') && dmgEntries.includes('Applications'), dmgEntries.join(', '))
const app = join(applications, 'Conductor.app')
run('/usr/bin/ditto', [join(mount, 'Conductor.app'), app])
run('/usr/bin/hdiutil', ['detach', mount])
const info = run('/usr/bin/codesign', ['-dv', '--verbose=2', app])
console.log(info.out.split('\n').map(line => `  codesign: ${line}`).join('\n'))
check('ad-hoc signed', /Signature=adhoc/.test(info.out) && /flags=0x\d+\([^)]*adhoc/.test(info.out))
const verify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
check('codesign --verify --deep --strict', verify.code === 0, verify.out.split('\n').at(-1))
const assess = run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', app])
console.log(`  spctl: ${assess.out.replace(/\n/g, ' | ')} (an ad-hoc build is expected to be rejected: without quarantine Gatekeeper never asks)`)
const helper = join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
check('node-pty spawn-helper executable in the bundle', existsSync(helper) && (statSync(helper).mode & 0o111) === 0o111, existsSync(helper) ? (statSync(helper).mode & 0o777).toString(8) : 'missing')
check('icon.icns in the bundle', existsSync(join(app, 'Contents/Resources/icon.icns')))
const plistVersion = bundle => run('/usr/bin/defaults', ['read', join(bundle, 'Contents/Info'), 'CFBundleShortVersionString']).out
const oldVersion = plistVersion(app)
const newVersion = /^version:\s*(\S+)/m.exec(manifest)[1]
console.log(`installed ${oldVersion}; feed offers ${newVersion}`)

// 2. A loopback feed with the new build.
const feed = createServer((request, response) => {
  const name = basename(decodeURIComponent((request.url ?? '').split('?')[0]))
  const path = join(newDir, name)
  if (!existsSync(path)) { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'Content-Length': statSync(path).size }); createReadStream(path).pipe(response)
})
await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve))
const feedUrl = `http://127.0.0.1:${feed.address().port}/`

// A minimal CDP client for the main process's inspector.
async function inspector(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let targets = []
  while (Date.now() < deadline) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break } catch { /* not up yet */ }
    await sleep(250)
  }
  if (!targets.length) throw new Error(`no inspector on ${port} within ${timeoutMs} ms`)
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map(), waiters = []
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    else for (const waiter of waiters.filter(entry => entry.method === message.method)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message.params) }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, message => message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result))
    socket.send(JSON.stringify({ id: n, method, params }))
  })
  const next = (method, ms) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`no ${method} in ${ms} ms`)), ms); waiters.push({ method, resolve: value => { clearTimeout(timer); resolve(value) } }) })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  return { send, next, evaluate, close: () => socket.close() }
}

// Runs before the app's own code: every window parked off the displays, no Dock icon.
const PARK = `(() => { try {
  const electron = require('electron'); const { app } = electron
  const park = w => { if (!w.isDestroyed()) { const [x] = w.getPosition(); if (x > -5000) w.setPosition(-6000, 0) } }
  app.on('browser-window-created', (_e, w) => { park(w); for (const e of ['show', 'ready-to-show', 'move', 'restore']) w.on(e, () => park(w)) })
  app.whenReady().then(() => app.dock && app.dock.hide())
  globalThis.__smoke = electron
  return 'parked'
} catch (error) { return 'error: ' + error.message } })()`

/** Connects to a launch paused by --inspect-brk, installs PARK where the app's own require is in scope, and lets it run. */
async function parkedStart(port) {
  const client = await inspector(port, 60_000)
  await client.send('Runtime.enable')
  let paused = client.next('Debugger.paused', 20_000)
  await client.send('Debugger.enable')
  await client.send('Runtime.runIfWaitingForDebugger')
  let outcome = 'error: not paused'
  for (let attempt = 0; attempt < 3 && outcome !== 'parked'; attempt++) {
    const frame = (await paused).callFrames[0]
    const result = await client.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: PARK, returnByValue: true })
    outcome = result.result.value
    if (outcome !== 'parked') {
      // Paused inside Electron's own startup: stop again at the app's entry, where require is the app's.
      await client.send('Debugger.setBreakpointByUrl', { urlRegex: 'app\\.asar[\\\\/]out[\\\\/]main[\\\\/]index\\.js', lineNumber: 0 })
      paused = client.next('Debugger.paused', 20_000)
    }
    await client.send('Debugger.resume')
  }
  await client.send('Debugger.disable')
  if (outcome !== 'parked') throw new Error(`could not park the app: ${outcome}`)
  return client
}

const RENDERER = `globalThis.__smoke.BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())`
const updates = (client, call) => client.evaluate(`(async () => {
  for (const w of ${RENDERER}) {
    const ok = await w.webContents.executeJavaScript('typeof window.conductor?.updates?.getState === "function"').catch(() => false)
    if (ok) return await w.webContents.executeJavaScript(${JSON.stringify(`window.conductor.updates.${call}`)})
  }
  return null
})()`)
async function until(what, ms, probe) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) { last = await probe().catch(error => ({ error: error.message })); if (last?.done) return last; await sleep(500) }
  throw new Error(`${what}: timed out, last ${JSON.stringify(last)}`)
}
const describeApp = client => client.evaluate(`({ version: globalThis.__smoke.app.getVersion(), packaged: globalThis.__smoke.app.isPackaged, pid: process.pid, userData: globalThis.__smoke.app.getPath('userData'), execPath: process.execPath, argv: process.argv.slice(1),
  windows: ${RENDERER}.map(w => ({ bounds: w.getBounds(), visible: w.isVisible(), focused: w.isFocused() })) })`)

const port = 9300 + Math.floor(Math.random() * 500)
const exe = join(app, 'Contents/MacOS/Conductor')
const env = { ...process.env, CONDUCTOR_UPDATE_URL: feedUrl }
delete env.CONDUCTOR_TEST_USER_DATA
const child = spawn(exe, [`--inspect-brk=${port}`, `--user-data-dir=${profile}`], { env, detached: true, stdio: 'ignore' })
child.unref()
let client
try {
  client = await parkedStart(port)
  const first = await until('first window', 60_000, async () => { const d = await describeApp(client); return { ...d, done: d.windows.length > 0 } })
  console.log(`launched: ${JSON.stringify(first)}`)
  check('packaged launch runs the old version', first.version === oldVersion && first.packaged, `${first.version} packaged=${first.packaged}`)
  check('own profile (--user-data-dir)', resolve(first.userData) === resolve(profile), first.userData)
  check('window parked off every display', first.windows.every(w => w.bounds.x <= -5000), JSON.stringify(first.windows.map(w => w.bounds)))

  // 3. The update, through the app's own update control.
  const available = await until('update offered', 90_000, async () => { const s = await updates(client, 'getState()'); return { ...s, done: s?.phase === 'available' || s?.phase === 'error' } })
  check('update pending from the feed', available.phase === 'available' && available.availableVersion === newVersion, `${available.phase}: ${available.message}`)
  await updates(client, 'download()').catch(() => null)
  const ready = await until('download', 300_000, async () => { const s = await updates(client, 'getState()'); return { ...s, done: s?.phase === 'ready' || s?.phase === 'error' } })
  check('downloaded (sha512 checked by electron-updater)', ready.phase === 'ready', `${ready.phase}: ${ready.message}`)
  await client.evaluate(`(() => { for (const w of ${RENDERER}) w.webContents.executeJavaScript('window.conductor?.updates?.install?.(); 1').catch(() => {}); return true })()`)
  client.close()
  const oldPid = first.pid
  const exited = await until('old app exit', 60_000, async () => { try { process.kill(oldPid, 0); return { done: false } } catch { return { done: true } } }).then(() => true, () => false)
  check('old app quit for the install', exited)
  client = await parkedStart(port)
  const second = await until('relaunched window', 90_000, async () => { const d = await describeApp(client); return { ...d, done: d.windows.length > 0 } })
  console.log(`relaunched: ${JSON.stringify(second)}`)
  check('relaunched as the new version', second.version === newVersion && second.pid !== oldPid, `${second.version} pid ${second.pid}`)
  check('relaunched with the same arguments', second.argv.includes(`--user-data-dir=${profile}`), second.argv.join(' '))
  check('relaunched window parked', second.windows.every(w => w.bounds.x <= -5000))
  const state = await until('state', 30_000, async () => { const s = await updates(client, 'getState()'); return { ...s, done: Boolean(s) } })
  check('update control reports the new version', state.currentVersion === newVersion, `${state.phase}: ${state.message}`)
  check('bundle on disk is the new version', plistVersion(app) === newVersion)
  const swapped = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  check('swapped bundle verifies', swapped.code === 0, swapped.out)
  check('no staging folder left beside the app', readdirSync(applications).join(',') === 'Conductor.app', readdirSync(applications).join(','))
  await client.evaluate('globalThis.__smoke.app.exit(0), true').catch(() => {})
} catch (error) {
  check('smoke ran to the end', false, error.stack ?? String(error))
} finally {
  client?.close()
  feed.close()
  const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(existsSync(join(app, 'Contents/Resources/app-update.yml')) ? readFileSync(join(app, 'Contents/Resources/app-update.yml'), 'utf8') : '')?.[1]
  const log = cacheName && join(homedir(), 'Library/Caches', cacheName, 'install.log')
  if (log && existsSync(log)) console.log(`install.log (${log}):\n${readFileSync(log, 'utf8').trim().split('\n').slice(-12).map(line => `  ${line}`).join('\n')}`)
  await sleep(1000)
  spawnSync('/usr/bin/pkill', ['-f', `${work}/Applications/Conductor.app/`])
}
const failed = results.filter(result => !result.ok)
console.log(failed.length ? `FAILED ${failed.length}/${results.length}: ${failed.map(f => f.name).join('; ')}` : `ALL ${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
