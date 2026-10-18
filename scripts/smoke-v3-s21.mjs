import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { expect } from '@playwright/test'

// V3 verify S21: local.servers / local.stop / local.protect against a stand-in llama.cpp server.
// The stand-in answers /health, /slots (is_processing while a chat completion is in flight) and
// /v1/chat/completions (slowly). A run record is written by hand, with the stand-in's own launch
// identity, so local.servers reports it startedByConductor:true and local.stop can prove it is ours.
// Isolation (2026-10-18: a real Qwen 9B another project ran on this machine was listed instead of
// the stand-in): the instance reads its llama.cpp process inventory from a file this script writes
// (CONDUCTOR_TEST_LLAMA_INVENTORY), naming only the stand-in and a decoy process this script owns,
// so no server of the machine is ever listed, matched or stopped. Hard safety rules: local.stop is
// never called with force:true, every stop and protect names a pid, and only the stand-in's or the
// decoy's (callSafe refuses anything else before a request is sent).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-s21.mjs [--keep]

const keep = process.argv.includes('--keep')
const MODEL = 'local/qwen3.5-9b'
const KEY = 'c'.repeat(64)
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-s21-'))
const output = resolve('artifacts/v3-verify/S21')
await mkdir(output, { recursive: true })
const systemDrive = (process.env.SystemDrive ?? 'C:').toUpperCase()
const scratchDrive = process.env.CONDUCTOR_SMOKE_LOCAL_DRIVE ?? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:`).find(letter => letter !== systemDrive && existsSync(letter + '\\'))
if (!scratchDrive) { console.error('No non-system drive for the local stand-in root; set CONDUCTOR_SMOKE_LOCAL_DRIVE.'); process.exit(2) }
const localRoot = await mkdtemp(join(scratchDrive + '\\', 'conductor-v3-s21-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(join(localRoot, 'config'), { recursive: true }); await mkdir(join(localRoot, 'runtime'), { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// The stand-in server runs as a SEPARATE child process, not inline: local.stop's job is to signal
// the recorded pid, and that pid must never be this test harness's own process. It answers
// /health, /slots (is_processing while mid-turn) and /v1/chat/completions (slowly), and writes its
// own port to a file on startup.
const standInScriptPath = join(root, 'stand-in-server.mjs')
const standInPortFile = join(root, 'stand-in-port.txt')
await writeFile(standInScriptPath, `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const MODEL = ${JSON.stringify(MODEL)}
let processing = false
const server = createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}'); return }
  if (request.url === '/slots' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([{ id: 0, is_processing: processing }])); return }
  if (request.url === '/props') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } })); return }
  if (request.url?.startsWith('/v1/models')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] })); return }
  if (request.method === 'POST' && request.url?.includes('/v1/chat/completions')) {
    let body = ''
    request.on('data', c => { body += c })
    request.on('end', async () => {
      processing = true
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.on('error', () => {})
      for (let word = 0; word < 20 && !response.destroyed; word++) { response.write(\`data: \${JSON.stringify({ choices: [{ delta: { content: \`w\${word} \` }, finish_reason: null }] })}\\n\\n\`); await new Promise(r => setTimeout(r, 400)) }
      processing = false
      if (!response.destroyed) { response.write(\`data: \${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\\n\\n\`); response.end('data: [DONE]\\n\\n') }
    })
    return
  }
  response.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () => { writeFileSync(${JSON.stringify(standInPortFile)}, String(server.address().port)) })
process.on('SIGTERM', () => process.exit(0))
`)
const standInChild = spawn(process.execPath, [standInScriptPath], { stdio: 'ignore', windowsHide: true })
const standInPid = standInChild.pid
await expect.poll(() => existsSync(standInPortFile), { timeout: 15_000, intervals: [200] }).toBe(true)
const standInPort = Number(await readFile(standInPortFile, 'utf8'))
const standInFetch = (path, init) => fetch(`http://127.0.0.1:${standInPort}${path}`, init)
// The decoy stands in for "a llama-server this Conductor did not start": a process of this
// script's own, listed in the test inventory only, so the refusal case never names a real pid.
const decoyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
const decoyPid = decoyChild.pid
const DECOY_MODEL = 'local/smoke-foreign'
const ownPids = new Set([standInPid, decoyPid])
const inventoryPath = join(root, 'llama-inventory.json')
await writeFile(inventoryPath, JSON.stringify([{ pid: standInPid, model: MODEL, port: standInPort }, { pid: decoyPid, model: DECOY_MODEL }]))
// The identity a launch records (llama.ts processControl, read while the child handle pins the pid).
const { processControl } = await import(new URL('../src/main/local-models/llama.ts', import.meta.url).href)
const standInIdentity = await processControl.inspect(standInPid, 15_000)
assert.equal(standInIdentity.state, 'running', `the stand-in's identity could not be read: ${JSON.stringify(standInIdentity)}`)

await writeFile(join(localRoot, 'config', 'api-key'), KEY + '\n')
await writeFile(join(localRoot, 'config', 'config.json'), JSON.stringify({
  version: 1, llamaServer: process.execPath, llamaVersion: 'smoke stand-in',
  models: { [MODEL]: { id: MODEL, label: 'Smoke model', repo: 'owner/repo', revision: 'a'.repeat(40), file: 'model.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'b'.repeat(64), port: standInPort, contextTokens: 32768, gpuLayers: 1, extraArgs: [] } },
  sandbox: { image: 'conductor-local-sandbox:1', memory: '4g', cpus: '4', pids: 256, timeoutSec: 120, maxOutputBytes: 262144, tmpfsSizeMb: 512 }
}, null, 2))
// The run record local.servers reads (src/main/local-models/config.ts runFile): pid must be alive.
const runRecordPath = join(localRoot, 'runtime', MODEL.replace(/[^a-z0-9.-]/gi, '_') + '.json')
await writeFile(runRecordPath, JSON.stringify({ pid: standInPid, port: standInPort, model: MODEL, file: 'model.gguf', startedAt: new Date().toISOString(), generation: 'smoke-v3-s21', identity: { creationTime: standInIdentity.creationTime, executable: standInIdentity.executable } }, null, 2))

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S21 smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_LOCAL_ROOT: localRoot, CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: `http://127.0.0.1:${standInPort}`, CONDUCTOR_TEST_LLAMA_INVENTORY: inventoryPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
const request = async (method, args = {}) => { const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) }); return { status: r.status, body: await r.json() } }
const call = async (method, args = {}) => { const r = await request(method, args); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
// Every call that can stop or claim a server goes through here: it must name a pid of this script's.
const callSafe = async (method, args) => {
  if (!ownPids.has(args.pid)) throw new Error(`refusing to send ${method} for pid ${args.pid}: not the stand-in's or the decoy's`)
  return request(method, args)
}
// No server of the machine may ever be visible to this instance.
const isolated = (servers, label) => { for (const server of servers) if (server.pid !== null && !ownPids.has(server.pid)) throw new Error(`${label}: local.servers listed pid ${server.pid} (${server.model}), which is not this script's; isolation failed`) }
const tasklistLines = () => { try { return execFileSync('tasklist', { encoding: 'utf8' }).split('\n').filter(l => l.toLowerCase().includes('llama')) } catch { return [] } }

const summary = { root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, 8 * 60_000)
let firstPid = null, failed = null
const appLog = join(root, 'app.log')
try {
  const port = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid })
  await expect.poll(async () => { try { return (await credential()).pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 S21' })).id

  const serversBefore = await call('local.servers')
  observe('local.servers (before any turn)', { serversBefore })
  summary.serversBefore = serversBefore
  isolated(serversBefore, 'before any turn')
  const ours = serversBefore.find(s => s.model === MODEL)
  assert.ok(ours, 'the stand-in server was not reported by local.servers')
  assert.equal(ours.startedByConductor, true, 'the stand-in should be reported startedByConductor:true')
  assert.equal(ours.pid, standInPid)
  assert.equal(ours.port, standInPort)
  assert.equal(ours.ownerProject, null, 'a hand-written record names no owner')
  assert.equal(ours.protected, false)

  // tabs.open needs the renderer's workspace pane mounted after projects.open (see S7's finding:
  // the shipped smoke-local-restart.mjs races this under load); this script has no CDP window
  // navigation to settle it, so wait briefly instead.
  await new Promise(r => setTimeout(r, 3000))
  const tab = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'read-only', exactPermission: true, title: 'V3 S21' })
  const agentSessionId = tab.resourceId ?? tab.agentSessionId
  await call('agents.submit', { agentSessionId, prompt: 'Say something slowly.' })
  const standInProcessing = async () => { try { return (await (await standInFetch('/slots')).json())[0]?.is_processing === true } catch { return false } }
  await expect.poll(standInProcessing, { timeout: 15_000, intervals: [200] }).toBe(true)
  observe('turn is mid-flight against the stand-in')

  const stopWhileBusy = await callSafe('local.stop', { pid: standInPid })
  observe('local.stop({pid}) while busy', stopWhileBusy)
  assert.notEqual(stopWhileBusy.status, 200, 'local.stop should refuse while the conversation is mid-turn')
  assert.match(JSON.stringify(stopWhileBusy.body), /mid-turn|busy|generating/i)

  const serversWhileBusy = await call('local.servers')
  summary.serversWhileBusy = serversWhileBusy
  isolated(serversWhileBusy, 'while busy')
  observe('local.servers while busy', { serversWhileBusy })

  // The decoy is listed as a server this Conductor did not start; stopping it is refused, and it lives on.
  const notOurs = serversWhileBusy.find(s => s.pid === decoyPid)
  assert.ok(notOurs, 'the decoy from the test inventory was not listed')
  assert.equal(notOurs.startedByConductor, false)
  const refusedPid = await callSafe('local.stop', { pid: decoyPid })
  observe('local.stop({pid: not-started-by-conductor}) refusal', { pid: decoyPid, refusedPid })
  summary.notStartedByConductorRefusal = { pid: decoyPid, status: refusedPid.status, body: refusedPid.body }
  assert.notEqual(refusedPid.status, 200)
  assert.match(JSON.stringify(refusedPid.body), /not started by this Conductor/i)
  assert.equal(alive(decoyPid), true, 'the refused stop must leave the decoy running')

  await expect.poll(async () => (await call('agents.status', { agentSessionId })).phase, { timeout: 30_000, intervals: [500] }).toBe('completed')
  await expect.poll(standInProcessing, { timeout: 5000 }).toBe(false)
  observe('turn completed; stand-in now idle')

  // local.protect keeps its claim in the run record (cross-project-cleanup-guardrails): the file
  // on disk carries it, local.servers reports it, and lifting it removes it again.
  const protectedNow = await callSafe('local.protect', { pid: standInPid, reason: 'smoke: keep the stand-in up' })
  observe('local.protect({pid})', protectedNow)
  assert.equal(protectedNow.status, 200, JSON.stringify(protectedNow.body))
  const recordProtection = JSON.parse(await readFile(runRecordPath, 'utf8')).protection
  assert.equal(recordProtection?.reason, 'smoke: keep the stand-in up', 'the protection must be written into the run record')
  assert.equal(recordProtection?.projectId, projectId)
  const serversProtected = await call('local.servers')
  isolated(serversProtected, 'while protected')
  assert.equal(serversProtected.find(s => s.pid === standInPid)?.protected, true)
  assert.equal(serversProtected.find(s => s.pid === standInPid)?.protection?.reason, 'smoke: keep the stand-in up')
  const lifted = await callSafe('local.protect', { pid: standInPid, protect: false })
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body))
  assert.equal(JSON.parse(await readFile(runRecordPath, 'utf8')).protection, undefined, 'lifting must remove the protection from the run record')
  summary.protection = { protected: protectedNow.body, record: recordProtection, lifted: lifted.body }

  const stopNowOk = await callSafe('local.stop', { pid: standInPid })
  observe('local.stop({pid}) after completion', stopNowOk)
  assert.equal(stopNowOk.status, 200, JSON.stringify(stopNowOk.body))
  summary.stopNowOk = stopNowOk.body
  await expect.poll(() => alive(standInPid), { timeout: 10_000, intervals: [300] }).toBe(false)
  summary.standInPidGoneAfterStop = true
  observe('the stand-in pid is gone after local.stop', { standInPid })

  const noArgs = await request('local.stop', {})
  const badModel = await request('local.stop', { model: 'nope' })
  summary.clearErrors = { noArgs: { status: noArgs.status, body: noArgs.body }, badModel: { status: badModel.status, body: badModel.body } }
  observe('local.stop({}) and local.stop({model:"nope"}) clear errors', summary.clearErrors)
  assert.notEqual(noArgs.status, 200)
  assert.notEqual(badModel.status, 200)

  summary.tasklistLlama = tasklistLines()
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (firstPid && alive(firstPid)) { try { execFileSync('taskkill.exe', ['/pid', String(firstPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /local|llama|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
  summary.standInPidAliveAtEnd = alive(standInPid)
  if (alive(standInPid)) { try { execFileSync('taskkill.exe', ['/pid', String(standInPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  // The decoy is this script's own child, killed through its handle (never a pid lookup).
  try { decoyChild.kill() } catch { /* gone */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', localRoot, observations }
await writeFile(join(output, 'S21-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(done => setTimeout(done, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
if (!keep) await rm(localRoot, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})
process.exit(failed ? 1 : 0)
