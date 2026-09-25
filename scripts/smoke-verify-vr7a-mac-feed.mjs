// VR7a S1b (macos-node-green, FX30 mac-packaging), runs ON the Mac: what the owner meets on the
// first install from GitHub today, per docs/mac-node.md "First install on the owner's Mac".
//   node scripts/smoke-verify-vr7a-mac-feed.mjs --dmg <Conductor-x-arm64.dmg> --work <scratch dir>
// 1. The downloaded dmg carries com.apple.quarantine; installed by drag (ditto) the app carries it
//    too; the doc's `xattr -dr com.apple.quarantine` leaves none.
// 2. The installed app, launched parked (as smoke-mac-packaging.mjs does) and WITHOUT a feed
//    override, checks its bundled GitHub feed. The real latest release carries no latest-mac.yml, so
//    the update control must say "The latest release has no Mac build yet." and not be an error.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? resolve(process.argv[i + 1]) : null }
const dmgSource = arg('dmg'), work = arg('work')
if (!dmgSource || !work || process.platform !== 'darwin') { console.error('macOS only: --dmg <file> --work <dir>'); process.exit(2) }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const run = (command, args) => { const r = spawnSync(command, args, { encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() } }

rmSync(work, { recursive: true, force: true })
const applications = join(work, 'Applications'), mount = join(work, 'mnt'), profile = join(work, 'profile'), dmg = join(work, 'download.dmg')
mkdirSync(applications, { recursive: true }); mkdirSync(mount, { recursive: true })
copyFileSync(dmgSource, dmg)
run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, dmg])
check('downloaded dmg carries quarantine', run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', dmg]).code === 0)
const attach = run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
check('quarantined dmg mounts', attach.code === 0, attach.code ? attach.out : '')
const app = join(applications, 'Conductor.app')
run('/usr/bin/ditto', [join(mount, 'Conductor.app'), app])
run('/usr/bin/hdiutil', ['detach', mount])
const quarantined = run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app])
console.log(`  installed app quarantine: ${quarantined.code === 0 ? quarantined.out : 'none'} (Finder copies it from a quarantined image; ditto may or may not)`)
const assessBefore = run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', app])
console.log(`  spctl before: ${assessBefore.out.replace(/\n/g, ' | ')}`)
run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]) // the doc's step 2, verbatim apart from the path
const left = run('/bin/sh', ['-c', `/usr/bin/xattr -lr "${app}" | grep -c com.apple.quarantine || true`]).out
check("after the doc's xattr -dr no file carries quarantine", left === '0', `${left} left`)
check('codesign --verify --deep --strict', run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).code === 0)
const feedConfig = existsSync(join(app, 'Contents/Resources/app-update.yml')) ? readFileSync(join(app, 'Contents/Resources/app-update.yml'), 'utf8') : ''
check('bundled feed is the GitHub release', /provider:\s*github/.test(feedConfig) && /repo:\s*conductor/.test(feedConfig), feedConfig.replace(/\n/g, ' | '))

// Parked launch (same technique as smoke-mac-packaging.mjs: --inspect-brk, park before app code).
async function inspector(port, ms) {
  const deadline = Date.now() + ms
  let targets = []
  while (Date.now() < deadline && !targets.length) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { await sleep(250) } }
  if (!targets.length) throw new Error(`no inspector on ${port}`)
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  let id = 0
  const pending = new Map(), waiters = []
  socket.onmessage = event => {
    const m = JSON.parse(event.data)
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id) } else for (const w of waiters.filter(x => x.method === m.method)) { waiters.splice(waiters.indexOf(w), 1); w.done(m.params) }
  }
  const send = (method, params = {}) => new Promise((done, fail) => { const n = ++id; pending.set(n, m => m.error ? fail(new Error(`${method}: ${JSON.stringify(m.error)}`)) : done(m.result)); socket.send(JSON.stringify({ id: n, method, params })) })
  const next = (method, wait) => new Promise((done, fail) => { const t = setTimeout(() => fail(new Error(`no ${method}`)), wait); waiters.push({ method, done: v => { clearTimeout(t); done(v) } }) })
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value }
  return { send, next, evaluate, close: () => socket.close() }
}
const PARK = `(() => { try { const electron = require('electron'); const { app } = electron
  const park = w => { if (!w.isDestroyed()) { const [x] = w.getPosition(); if (x > -5000) w.setPosition(-6000, 0) } }
  app.on('browser-window-created', (_e, w) => { park(w); for (const e of ['show', 'ready-to-show', 'move', 'restore']) w.on(e, () => park(w)) })
  app.whenReady().then(() => app.dock && app.dock.hide()); globalThis.__smoke = electron; return 'parked' } catch (error) { return 'error: ' + error.message } })()`
async function parkedStart(port) {
  const client = await inspector(port, 60_000)
  await client.send('Runtime.enable')
  let paused = client.next('Debugger.paused', 20_000)
  await client.send('Debugger.enable'); await client.send('Runtime.runIfWaitingForDebugger')
  let outcome = 'not paused'
  for (let attempt = 0; attempt < 3 && outcome !== 'parked'; attempt++) {
    const frame = (await paused).callFrames[0]
    outcome = (await client.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: PARK, returnByValue: true })).result.value
    if (outcome !== 'parked') { await client.send('Debugger.setBreakpointByUrl', { urlRegex: 'app\\.asar[\\\\/]out[\\\\/]main[\\\\/]index\\.js', lineNumber: 0 }); paused = client.next('Debugger.paused', 20_000) }
    await client.send('Debugger.resume')
  }
  await client.send('Debugger.disable')
  if (outcome !== 'parked') throw new Error(`could not park: ${outcome}`)
  return client
}
const state = client => client.evaluate(`(async () => { for (const w of globalThis.__smoke.BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())) {
  if (await w.webContents.executeJavaScript('typeof window.conductor?.updates?.getState === "function"').catch(() => false)) return await w.webContents.executeJavaScript('window.conductor.updates.getState()') } return null })()`)

const port = 9800 + Math.floor(Math.random() * 150)
const env = { ...process.env }
for (const key of ['CONDUCTOR_UPDATE_URL', 'CONDUCTOR_TEST_USER_DATA']) delete env[key]
const child = spawn(join(app, 'Contents/MacOS/Conductor'), [`--inspect-brk=${port}`, `--user-data-dir=${profile}`], { env, detached: true, stdio: 'ignore' })
child.unref()
let client
try {
  client = await parkedStart(port)
  const bounds = await client.evaluate('globalThis.__smoke.app.whenReady().then(() => new Promise(r => setTimeout(r, 3000))).then(() => globalThis.__smoke.BrowserWindow.getAllWindows().map(w => w.getBounds().x))')
  check('window parked', bounds.length > 0 && bounds.every(x => x <= -5000), JSON.stringify(bounds))
  const deadline = Date.now() + 120_000
  let last = null
  while (Date.now() < deadline) {
    last = await state(client).catch(error => ({ error: error.message }))
    if (last?.lastCheckedAt || last?.phase === 'error' || last?.phase === 'available') break
    if (last?.phase === 'idle' && Date.now() > deadline - 90_000) await client.evaluate(`(async () => { for (const w of globalThis.__smoke.BrowserWindow.getAllWindows()) { await w.webContents.executeJavaScript('window.conductor?.updates?.check?.()').catch(() => {}) } return 1 })()`).catch(() => {})
    await sleep(2000)
  }
  console.log(`update state: ${JSON.stringify(last)}`)
  check('GitHub check without Mac files reads "no Mac build yet", not an error', last?.phase === 'idle' && /no Mac build yet/.test(last?.message ?? ''), `${last?.phase}: ${last?.message}`)
  await client.evaluate('globalThis.__smoke.app.exit(0), true').catch(() => {})
} catch (error) {
  check('smoke ran to the end', false, error.stack ?? String(error))
} finally {
  client?.close()
  await sleep(1000)
  spawnSync('/usr/bin/pkill', ['-f', `${work}/Applications/Conductor.app/`])
}
const failed = results.filter(r => !r.ok)
console.log(failed.length ? `FAILED ${failed.length}/${results.length}: ${failed.map(f => f.name).join('; ')}` : `ALL ${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
