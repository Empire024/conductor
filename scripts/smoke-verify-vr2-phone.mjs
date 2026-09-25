// VR2 group phone (feature-list.md phone-pin-lock, phone-secure-terminal), as a phone meets it: two
// phones paired over the real HTTPS listener, push subscriptions pointing at a local push endpoint
// that decrypts what a phone would receive (RFC 8291 aes128gcm), the terminal driven over the API.
//   P1  "hide entire conductor behind a 6 digit code on mobile": every /api path the phone app calls,
//       GET and POST, with no unlock token, a forged one and the other phone's valid one -> 423;
//       path variants never return data; a websocket upgrade is refused.
//       control: the same paths with this phone's own token get through.
//   P2  a locked phone's pushes carry no content; streams end when the code is set and on
//       "Lock every phone now". control: the unlocked phone's push of the same moment has the text.
//   T1  "do all this from a phone ... without having to tailscale": a shell opened with the code runs
//       a command; "Lock every phone now" kills it; one audit line without the typed text.
//   T2  only the unlocked owner: no code set, wrong code, the other phone, a re-unlock, another
//       machine are all refused. control: the owning phone's live shell answers.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr2-phone.mjs
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { REPO, call, configure, descendantsOf, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'
import { pairPhone, phoneClient, pushService } from './verify-phone-kit.mjs'

configure({ name: 'vr2-phone', output: process.env.VR2_OUT ?? 'artifacts/verification/2026-09-25-vr2' })
watchdog(14 * 60)
const CODE = '604213'
const CERT_DIR = resolve(process.env.VR2_CERT_DIR ?? join(REPO, '.conductor-scratch', 'vr2'))

const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'vr2-phone', parent_tool_use_id: null, ...m })
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {} } })
  if (message.type !== 'user') return
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  if (JSON.stringify(message.message.content).includes('second turn')) await new Promise(r => setTimeout(r, 4000))
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'VR2 secret reply text' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const push = await pushService(CERT_DIR)
const pushes = push.pushes
let phoneReq, openStream
const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const shellOutput = stream => stream.events.filter(event => event.type === 'data').map(event => Buffer.from(event.data.data, 'base64').toString('utf8')).join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

try {
  await loadCheck()
  const inst = await launchParked({ mode: 'playwright', fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', NODE_EXTRA_CA_CERTS: join(CERT_DIR, 'push-cert.pem'), NODE_TLS_REJECT_UNAUTHORIZED: '0' } })
  const view = await page()
  const project = await openProject({ name: 'VR2 phone', git: true })
  const desk = () => view.evaluate(() => window.conductor.phone.state())

  step('pair phones A and B while no code is set')
  const enabled = await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  if (!enabled.listening) throw new Error('phone listener did not start: ' + enabled.message)
  const client = phoneClient(`https://127.0.0.1:${new URL(enabled.primaryEndpoint).port}`)
  phoneReq = client.req; openStream = client.stream
  const pair = name => pairPhone(view, client, name)
  const A = await pair('VR2 phone A'), B = await pair('VR2 phone B')
  for (const [token, name] of [[A, 'A'], [B, 'B']]) {
    const answer = await phoneReq('/api/push/subscribe', { method: 'POST', token, body: { subscription: push.subscription(name) } })
    if (answer.status !== 200) throw new Error(`push subscribe ${name}: ${answer.status} ${answer.text}`)
  }
  const noCodeTerminal = await phoneReq('/api/terminal/open', { method: 'POST', token: A, body: { code: CODE, projectId: project.id, workspaceId: inst.workspaceId, cols: 100, rows: 30 } })
  const earlyStream = openStream('/api/stream', { token: A })
  await poll(() => earlyStream.status === 200 && earlyStream.events.length > 0, { timeoutMs: 15_000, label: 'the pre-code stream to open' })

  step('set the code')
  await view.evaluate(code => window.conductor.phone.setLockCode(code), CODE)
  const earlyClosed = await poll(() => earlyStream.ended, { timeoutMs: 10_000, label: 'the pre-code stream to close' }).then(() => true, () => false)

  step('P1 every phone route is locked')
  const appJs = await phoneReq('/app.js')
  const literals = [...new Set([...(appJs.text ?? '').matchAll(/['"`](\/api\/[A-Za-z0-9/_-]*)/g)].map(match => match[1]))]
  const paths = [...new Set([...literals.map(path => path.endsWith('/') ? path + 'x' : path), '/api/state', '/api/stream', '/api/metrics', '/api/me', '/api/unpair', '/api/tabs/open', '/api/projects/' + project.id + '/tasks', '/api/sessions/x', '/api/sessions/x/message', '/api/terminal', '/api/terminal/open', '/api/terminal/x/stream', '/api/terminal/x/input', '/api/push/test', '/api/notifications', '/api/ideas', '/api/ideas/x', '/api/idea-runs', '/api/idea-runs/x']
  )].filter(path => !/^\/api\/(lock\/|health$|pair$)/.test(path) && path !== '/api/lock' && path !== '/api/')
  const unlockB = await phoneReq('/api/lock/unlock', { method: 'POST', token: B, body: { code: CODE } })
  if (unlockB.status !== 200) throw new Error('unlocking B: ' + unlockB.text)
  const tokenB = unlockB.json.unlockToken
  const offenders = [], probes = { count: 0 }
  for (const path of paths) {
    for (const method of ['GET', 'POST']) {
      if (path === '/api/unpair' && method === 'POST') continue // would revoke A if the gate were open
      for (const [label, unlock] of [['none', undefined], ['forged', randomBytes(32).toString('base64url')], ['other phone', tokenB]]) {
        probes.count++
        const answer = await phoneReq(path, { method, token: A, unlock, body: method === 'POST' ? {} : undefined, timeoutMs: 8000 }).catch(error => ({ status: 'no answer', text: String(error.message) }))
        if (answer.status !== 423) offenders.push({ path, method, label, status: answer.status, text: answer.text.slice(0, 120) })
      }
    }
  }
  const variants = ['/api/lock/../state', '/api/lock/%2e%2e/state', '//api/state', '/API/state', '/api/state/', '/api/lock/state/../../state', '/api/./state', '/api/state?x=/api/lock/', '/api/lock%2fstate']
  const variantAnswers = []
  for (const path of variants) {
    const answer = await phoneReq(path, { token: A })
    variantAnswers.push({ path, status: answer.status })
    if (answer.status === 200 && path !== '/api/lock%2fstate') offenders.push({ path, method: 'GET', label: 'variant', status: 200, text: answer.text.slice(0, 120) })
  }
  const upgrade = await phoneReq('/api/stream', { token: A, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } }).then(answer => answer.status, error => 'refused: ' + String(error.message).slice(0, 60))
  const lockState = await phoneReq('/api/lock/state', { token: A })
  const unlockA = await phoneReq('/api/lock/unlock', { method: 'POST', token: A, body: { code: CODE } })
  const tokenA = unlockA.json?.unlockToken
  const own = {}
  for (const path of ['/api/state', '/api/me', '/api/metrics', '/api/projects/' + project.id + '/tasks']) own[path] = (await phoneReq(path, { token: A, unlock: tokenA })).status
  const ownOk = Object.values(own).every(status => status === 200)
  record('P1', offenders.length === 0 && upgrade !== 101 && lockState.status === 200 && lockState.json?.configured === true && ownOk ? 'PASS' : 'FAIL',
    { paths: paths.length, fromAppJs: literals.length, probes: probes.count, offenders: offenders.length, upgrade, ownToken: own },
    `offenders ${JSON.stringify(offenders.slice(0, 8))}; variants ${JSON.stringify(variantAnswers)}; control: A's own unlock token got ${JSON.stringify(own)}`)

  step('P2 pushes while locked carry no content')
  await phoneReq('/api/lock/lock', { method: 'POST', token: A, unlock: tokenA })
  const aLocked = (await phoneReq('/api/state', { token: A, unlock: tokenA })).status
  const tab = await openTab({ provider: 'claude', title: 'VR2 push title' })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'warm up' })
  await poll(async () => (await call('agents.status', { agentSessionId: tab.resourceId })).phase === 'completed', { timeoutMs: 30_000, label: 'warm-up turn' })
  await sleep(2000)
  const testB = await phoneReq('/api/push/test', { method: 'POST', token: B, unlock: tokenB, body: {} })
  const mark = pushes.length
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'second turn' })
  await poll(() => pushes.slice(mark).filter(entry => entry.payload?.kind === 'done').length >= 2, { timeoutMs: 40_000, label: 'the Done push to both phones' }).catch(() => null)
  const done = pushes.slice(mark).filter(entry => entry.payload?.kind === 'done' || entry.error)
  const toA = done.find(entry => entry.phone === 'A'), toB = done.find(entry => entry.phone === 'B')
  const redacted = toA?.payload && toA.payload.title === 'Conductor' && toA.payload.body === 'Unlock Conductor to see what changed.' && toA.payload.sessionId === null && !JSON.stringify(toA.payload).includes('VR2')
  const fullB = toB?.payload && /VR2 push title/.test(toB.payload.title) && toB.payload.sessionId
  const streamB = openStream('/api/stream', { token: B, unlock: tokenB })
  await poll(() => streamB.status === 200 && streamB.events.length > 0, { timeoutMs: 15_000, label: 'B stream open' })
  await view.evaluate(() => window.conductor.phone.lockPhones())
  const bClosed = await poll(() => streamB.ended, { timeoutMs: 10_000, label: 'B stream closed by Lock every phone now' }).then(() => true, () => false)
  const bLockedEvent = streamB.events.some(event => event.type === 'locked')
  const bAfter = (await phoneReq('/api/state', { token: B, unlock: tokenB })).status
  record('P2', aLocked === 423 && redacted && fullB && earlyClosed && bClosed && bAfter === 423 ? 'PASS' : 'FAIL',
    { pushesSeen: done.length, testPushB: testB.json ?? testB.status, allPushes: pushes.length, aLockedStatus: aLocked, earlyStreamClosedOnCodeSet: earlyClosed, lockAllClosedStream: bClosed, lockedEvent: bLockedEvent, bAfterLockAll: bAfter },
    `A (locked) got ${JSON.stringify(toA?.payload ?? toA?.error ?? null)}; control B (unlocked) got ${JSON.stringify(toB?.payload ? { title: toB.payload.title, body: String(toB.payload.body).slice(0, 60), sessionId: Boolean(toB.payload.sessionId) } : toB?.error ?? null)}`)

  step('T1 a shell from the phone, killed by Lock every phone now')
  const tokenA2 = (await phoneReq('/api/lock/unlock', { method: 'POST', token: A, body: { code: CODE } })).json?.unlockToken
  const treeBefore = await listProcesses()
  const shellsBefore = new Set(descendantsOf(treeBefore.list, [...inst.pids]))
  const opened = await phoneReq('/api/terminal/open', { method: 'POST', token: A, unlock: tokenA2, body: { code: CODE, projectId: project.id, workspaceId: inst.workspaceId, cols: 100, rows: 30 } })
  if (opened.status !== 200) throw new Error('terminal open: ' + opened.status + ' ' + opened.text)
  const terminalId = opened.json.terminalId
  const treeAfter = await listProcesses()
  const newShells = [...descendantsOf(treeAfter.list, [...inst.pids])].filter(pid => !shellsBefore.has(pid)).map(pid => treeAfter.list.find(entry => entry.pid === pid)).filter(entry => /^(powershell|pwsh|cmd|bash)\.exe$/i.test(entry.name))
  const shellPids = newShells.map(entry => entry.pid)
  const term = openStream(`/api/terminal/${terminalId}/stream?from=0`, { token: A, unlock: tokenA2 })
  await poll(() => term.status === 200, { timeoutMs: 15_000, label: 'terminal stream' })
  await sleep(2500)
  await phoneReq(`/api/terminal/${terminalId}/input`, { method: 'POST', token: A, unlock: tokenA2, body: { data: Buffer.from('echo VR2T1OK\r').toString('base64') } })
  const ran = await poll(() => /^\s*VR2T1OK\s*$/m.test(shellOutput(term)), { timeoutMs: 20_000, label: 'the command output' }).then(() => true, () => false)
  const aliveBefore = shellPids.map(isAlive)
  await view.evaluate(() => window.conductor.phone.lockPhones())
  const termClosed = await poll(() => term.ended, { timeoutMs: 10_000, label: 'terminal stream closed' }).then(() => true, () => false)
  const shellGone = await poll(() => shellPids.length > 0 && shellPids.every(pid => !isAlive(pid)), { timeoutMs: 15_000, label: 'the shell process to exit' }).then(() => true, () => false)
  const audit = await poll(async () => { const text = await readFile(join(inst.profile, 'logs', 'phone-audit.log'), 'utf8').catch(() => ''); const lines = text.split('\n').filter(line => line.includes('phone terminal:')); return lines.length ? lines : null }, { timeoutMs: 15_000, label: 'the audit line' }).catch(() => [])
  record('T1', ran && aliveBefore.length > 0 && aliveBefore.every(Boolean) && termClosed && shellGone && audit.length === 1 && !audit[0].includes('VR2T1OK') ? 'PASS' : 'FAIL',
    { ran, shells: newShells.map(entry => entry.name + ':' + entry.pid), aliveBeforeLock: aliveBefore, streamClosed: termClosed, shellGoneAfterLock: shellGone, auditLines: audit.length },
    `audit: ${audit[0] ?? 'none'}; output tail ${JSON.stringify(shellOutput(term).slice(-160))}; control: the shell was alive and ran the command before the lock`)

  step('T2 only the unlocked owner gets a shell')
  const tokenA3 = (await phoneReq('/api/lock/unlock', { method: 'POST', token: A, body: { code: CODE } })).json?.unlockToken
  const tokenB2 = (await phoneReq('/api/lock/unlock', { method: 'POST', token: B, body: { code: CODE } })).json?.unlockToken
  const body = extra => ({ projectId: project.id, workspaceId: inst.workspaceId, cols: 80, rows: 24, ...extra })
  const wrong = await phoneReq('/api/terminal/open', { method: 'POST', token: A, unlock: tokenA3, body: body({ code: '000001' }) })
  const failuresAfterWrong = (await desk()).lock?.failures
  const otherMachine = await phoneReq('/api/terminal/open', { method: 'POST', token: A, unlock: tokenA3, body: body({ code: CODE, machineId: 'machine-elsewhere' }) })
  const mine = await phoneReq('/api/terminal/open', { method: 'POST', token: A, unlock: tokenA3, body: body({ code: CODE }) })
  const shellId = mine.json?.terminalId
  const ownStream = openStream(`/api/terminal/${shellId}/stream?from=0`, { token: A, unlock: tokenA3 })
  await poll(() => ownStream.status === 200, { timeoutMs: 15_000, label: 'own terminal stream' }).catch(() => null)
  const ownInput = await phoneReq(`/api/terminal/${shellId}/input`, { method: 'POST', token: A, unlock: tokenA3, body: { data: Buffer.from('echo VR2T2OWN\r').toString('base64') } })
  const ownRan = await poll(() => /^\s*VR2T2OWN\s*$/m.test(shellOutput(ownStream)), { timeoutMs: 20_000, label: 'own output' }).then(() => true, () => false)
  const fromB = {
    list: (await phoneReq('/api/terminal', { token: B, unlock: tokenB2 })).json,
    stream: (await phoneReq(`/api/terminal/${shellId}/stream?from=0`, { token: B, unlock: tokenB2 })).status,
    input: (await phoneReq(`/api/terminal/${shellId}/input`, { method: 'POST', token: B, unlock: tokenB2, body: { data: Buffer.from('echo VR2FROMB\r').toString('base64') } })).status,
    close: (await phoneReq(`/api/terminal/${shellId}/close`, { method: 'POST', token: B, unlock: tokenB2, body: {} })).status
  }
  await sleep(1500)
  const bTyped = /VR2FROMB/.test(shellOutput(ownStream))
  const stillOpenForA = JSON.stringify((await phoneReq('/api/terminal', { token: A, unlock: tokenA3 })).json ?? '').includes(shellId)
  await phoneReq('/api/lock/lock', { method: 'POST', token: A, unlock: tokenA3 })
  const tokenA4 = (await phoneReq('/api/lock/unlock', { method: 'POST', token: A, body: { code: CODE } })).json?.unlockToken
  const afterReunlock = (await phoneReq(`/api/terminal/${shellId}/stream?from=0`, { token: A, unlock: tokenA4 })).status
  const refused = status => status >= 400 && status < 500
  const bSawIt = JSON.stringify(fromB.list ?? '').includes(shellId)
  record('T2', noCodeTerminal.status === 403 && refused(wrong.status) && failuresAfterWrong === 1 && otherMachine.status === 403 && mine.status === 200 && ownInput.status === 200 && ownRan && !bSawIt && refused(fromB.stream) && refused(fromB.input) && refused(fromB.close) && !bTyped && stillOpenForA && refused(afterReunlock) ? 'PASS' : 'FAIL',
    { beforeAnyCode: noCodeTerminal.status, wrongCode: wrong.status, failuresAfterWrong, otherMachine: otherMachine.status, phoneB: { ...fromB, list: bSawIt ? 'lists it' : 'not listed' }, bTypedIntoA: bTyped, afterReunlock },
    `control: A's own shell opened ${mine.status}, input ${ownInput.status}, ran ${ownRan}, still open after B's close ${stillOpenForA}; wrong-code text ${JSON.stringify(wrong.json?.error ?? wrong.text).slice(0, 100)}`)
  await shot('vr2-phone-end')
} catch (error) {
  await failed(error, 'vr2-phone')
}
await push.close()
await finish()
