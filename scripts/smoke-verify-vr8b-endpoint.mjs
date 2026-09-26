// VR8b B1 + B3 (docs/verification/2026-09-26-vr8b.md). Owner: "'The restart gave app control a new
// port and token' make sure that never happens ... that can't ever happen".
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8b-endpoint.mjs [--label fixed] [--only b1]
// B1 port, owner token and a conversation's token are unchanged after (1) an update-style restart
//    with a kept turn, (2) a clean quit (WM_CLOSE) and relaunch, (3) a crash (main killed) and
//    relaunch; the old conversation token still answers; no token lands outside the profile.
// B3 a foreign process takes the port in the restart gap: the app falls back to another port, says
//    so, briefs the kept turn with the new endpoint (which then works), and keeps the new port after.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunched, relaunchParked, sleep, step, watchdog } from './verify-kit.mjs'

const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback }
const label = argument('--label', 'fixed'), only = argument('--only', 'all')
configure({ name: `vr8b-endpoint-${label}`, output: argument('--output', 'artifacts/verification/2026-09-26-vr8b') })
watchdog(19 * 60)
await loadCheck()

const FIXTURE = readFileSync(new URL('./fixtures/vr8b-claude.mjs', import.meta.url), 'utf8')
const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const portOf = endpoint => Number(new URL(endpoint).port)
const raw = async (endpoint, token) => { try { return (await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'agents.list', args: {} }), signal: AbortSignal.timeout(30_000) })).status } catch (error) { return String(error.cause?.code ?? error.message) } }
const files = (dir, skip) => { const out = []; for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (skip(path)) continue; if (entry.isDirectory()) out.push(...files(path, skip)); else out.push(path) } return out }
const holding = (paths, secret) => paths.filter(path => { try { return statSync(path).size < 300 * 1024 * 1024 && readFileSync(path).includes(secret) } catch { return false } })

try {
  const inst = await launchParked({ mode: 'spawn', name: `vr8b-endpoint-${label}`, env: { CONDUCTOR_RUNTIME_HOST: '1' }, fixtures: { 'fake-claude.mjs': FIXTURE } })
  const fixtures = join(inst.root, 'fixtures')
  await page(inst)
  await openProject({ name: `VR8b endpoint ${label}`, git: true })
  const keeper = (await openTab({ provider: 'claude', title: 'keeper' })).resourceId, briefed = (await openTab({ provider: 'claude', title: 'briefed' })).resourceId
  await call('agents.submit', { agentSessionId: briefed, prompt: 'VR8B ACK first briefed' })
  const first = await poll(() => lines(join(fixtures, 'inbox.jsonl')).find(entry => entry.text.startsWith('VR8B ACK first briefed') && /Bearer [a-f0-9]{64}/.test(entry.text)), { timeoutMs: 60_000, label: 'the briefed tab to receive its briefing' })
  const conversationToken = /Bearer ([a-f0-9]{64})/.exec(first.text)[1]
  const base = { ...inst.credential }
  const endpointFile = join(inst.profile, 'control-endpoint.json')
  record('B1-baseline', 'INFO', { port: portOf(base.endpoint), endpointFile: existsSync(endpointFile), conversationTokenAnswers: await raw(base.endpoint, conversationToken) })

  const keptTurn = async seconds => {
    const since = new Date().toISOString()
    await call('agents.submit', { agentSessionId: keeper, prompt: `VR8B LONG keeper ${seconds}` })
    await poll(() => lines(join(fixtures, 'calls.jsonl')).some(entry => entry.at >= since && entry.status === 200), { timeoutMs: 60_000, label: 'the kept turn to call app control' })
  }
  const idle = () => poll(async () => { const state = await call('agents.status', { agentSessionId: keeper }); return ['running', 'starting'].includes(state.phase) ? null : state }, { timeoutMs: 150_000, intervalMs: 2000, label: 'the keeper to finish its turn' })
  const check = async kind => {
    await poll(() => call('app.state', {}), { timeoutMs: 60_000, intervalMs: 1000, label: 'the relaunched app to answer' })
    const now = inst.credential
    const same = { port: portOf(now.endpoint) === portOf(base.endpoint), ownerToken: now.token === base.token }
    const conversation = await raw(now.endpoint, conversationToken)
    record(`B1-${kind}`, same.port && same.ownerToken && conversation === 200 ? 'PASS' : 'FAIL', { portBefore: portOf(base.endpoint), portAfter: portOf(now.endpoint), ownerTokenSame: same.ownerToken, oldConversationToken: conversation, pidBefore: base.pid, pidAfter: now.pid })
  }
  const gracefulQuit = async () => {
    const pid = inst.credential.pid
    spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    const exited = await poll(() => !isAlive(pid), { timeoutMs: 45_000, intervalMs: 500, label: `pid ${pid} to quit on WM_CLOSE` }).catch(() => false)
    if (!exited) throw new Error(`the app (pid ${pid}) did not quit on WM_CLOSE within 45 s`)
  }

  step('B1 (1) update-style restart with a kept turn')
  await keptTurn(40)
  let before = inst.credential.pid
  await call('app.restart', { force: true })
  await relaunched(inst, before, { timeoutMs: 90_000 })
  await check('update-restart-kept-turn')
  await idle()

  step('B1 (2) clean quit and relaunch')
  await gracefulQuit()
  await relaunchParked(inst)
  await check('clean-quit-relaunch')

  step('B1 (3) crash with a turn running, and relaunch')
  await keptTurn(40)
  before = inst.credential.pid
  spawnSync('taskkill', ['/PID', String(before), '/F'], { stdio: 'ignore', windowsHide: true })
  await relaunchParked(inst)
  await check('crash-relaunch')

  step('B1 leak scan')
  const outside = files(inst.root, path => path.startsWith(inst.profile) || path.startsWith(fixtures))
  const inside = files(inst.profile, () => false)
  const ownerOutside = holding(outside, base.token), conversationOutside = holding(outside, conversationToken)
  const ownerInside = holding(inside, base.token).map(path => relative(inst.profile, path))
  const endpointCopies = files(inst.root, () => false).filter(path => /control-endpoint\.json$/.test(path)).map(path => relative(inst.root, path))
  record('B1-token-leak-scan', !ownerOutside.length && !conversationOutside.length && endpointCopies.every(path => path.startsWith('profile')) ? 'PASS' : 'FAIL',
    { filesOutsideProfile: outside.length, ownerTokenOutside: ownerOutside.length, conversationTokenOutside: conversationOutside.length },
    JSON.stringify({ ownerOutside: ownerOutside.map(path => relative(inst.root, path)), conversationOutside: conversationOutside.map(path => relative(inst.root, path)), ownerTokenInProfile: ownerInside, endpointCopies }))

  if (only !== 'b1') {
    step('B3 a foreign process takes the port during the restart gap')
    const port = portOf(inst.credential.endpoint)
    let attempt = 0, won = false
    while (!won && attempt < 3) {
      attempt++
      await idle()
      const marker = join(inst.root, `racer-${attempt}.txt`)
      const racer = spawn(process.execPath, ['-e', `const http=require('http');const fs=require('fs');const go=()=>{const s=http.createServer((q,r)=>{r.writeHead(503,{'Content-Type':'application/json'});r.end('{"error":"vr8b foreign process"}')});s.once('error',()=>setTimeout(go,2));s.listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(marker)},'bound '+new Date().toISOString()))};go();setTimeout(()=>process.exit(0),600000)`], { stdio: 'ignore', windowsHide: true })
      await keptTurn(70)
      const restartAt = new Date().toISOString()
      before = inst.credential.pid
      await call('app.restart', { force: true })
      await relaunched(inst, before, { timeoutMs: 90_000 })
      await poll(() => call('app.state', {}), { timeoutMs: 60_000, intervalMs: 1000, label: 'the relaunched app to answer' })
      won = existsSync(marker)
      const newPort = portOf(inst.credential.endpoint)
      if (!won) { record(`B3-attempt${attempt}`, 'INFO', { racerBound: false, portAfter: newPort }, 'the runtime host took the port first; repeating'); spawnSync('taskkill', ['/PID', String(racer.pid), '/F'], { stdio: 'ignore' }); continue }
      const notice = await poll(() => lines(join(fixtures, 'inbox.jsonl')).find(entry => entry.at >= restartAt && /^\[Conductor\].*kept running/.test(entry.text)), { timeoutMs: 60_000, label: 'the reattach notice' }).catch(() => null)
      const briefedNew = Boolean(notice && notice.text.includes(`POST http://127.0.0.1:${newPort}/control`) && /Bearer [a-f0-9]{64}/.test(notice.text))
      await sleep(5000)
      const newCalls = lines(join(fixtures, 'calls.jsonl')).filter(entry => entry.at >= restartAt && Number(entry.port) === newPort)
      await idle()
      await call('agents.submit', { agentSessionId: keeper, prompt: 'VR8B CALL keeper' })
      const answer = await poll(async () => /call:keeper:(\S+?):(\d+|-)/.exec(JSON.stringify(await call('agents.snapshot', { agentSessionId: keeper })).split('long-done:keeper').at(-1)), { timeoutMs: 60_000, label: 'the keeper to call with what it holds' }).catch(() => null)
      // Information only: a relaunched app's stdout does not reach app.log (app.relaunch), and index.ts wires no log sink.
      const logged = /App control could not keep port/.test(readFileSync(join(inst.root, 'app.log'), 'utf8'))
      spawnSync('taskkill', ['/PID', String(racer.pid), '/F'], { stdio: 'ignore', windowsHide: true })
      record('B3-port-taken-falls-back', newPort !== port && briefedNew && newCalls.some(entry => entry.status === 200) && answer?.[1] === '200' && Number(answer?.[2]) === newPort ? 'PASS' : 'FAIL',
        { attempt, oldPort: port, newPort, errorLogged: logged, noticeHasNewEndpoint: briefedNew, callsOnNewPort: newCalls.length, callsOnNewPort200: newCalls.filter(entry => entry.status === 200).length, keeperCall: answer?.[1] ?? null },
        JSON.stringify({ notice: notice?.text.slice(0, 200) }))
      step('B3 the fallback port is kept by the next launch')
      const fallbackPort = newPort, fallbackToken = inst.credential.token
      await gracefulQuit()
      await relaunchParked(inst)
      await poll(() => call('app.state', {}), { timeoutMs: 60_000, intervalMs: 1000, label: 'the relaunched app to answer' })
      record('B3-fallback-port-kept', portOf(inst.credential.endpoint) === fallbackPort && inst.credential.token === fallbackToken ? 'PASS' : 'FAIL', { fallbackPort, portAfter: portOf(inst.credential.endpoint), tokenSame: inst.credential.token === fallbackToken })
    }
    if (!won) record('B3-port-taken-falls-back', 'NOT RUN (harness)', { attempts: attempt }, 'the foreign process never won the port race')
  }
} catch (error) { await failed(error, 'endpoint') }
await finish()
