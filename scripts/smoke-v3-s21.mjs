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

// V3 verify S21: local.servers / local.stop against a stand-in llama.cpp server. The stand-in
// answers /health, /slots (is_processing while a chat completion is in flight) and
// /v1/chat/completions (slowly); a run record is written by hand so local.servers reports it
// startedByConductor:true. Hard safety rule: local.stop is never called with force:true, and the
// "not started by this Conductor" refusal case only uses a pid that this test instance's OWN
// local.servers already reports startedByConductor:false (never the real machine-wide llama pid
// found any other way).
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

await writeFile(join(localRoot, 'config', 'api-key'), KEY + '\n')
await writeFile(join(localRoot, 'config', 'config.json'), JSON.stringify({
  version: 1, llamaServer: process.execPath, llamaVersion: 'smoke stand-in',
  models: { [MODEL]: { id: MODEL, label: 'Smoke model', repo: 'owner/repo', revision: 'a'.repeat(40), file: 'model.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'b'.repeat(64), port: standInPort, contextTokens: 32768, gpuLayers: 1, extraArgs: [] } },
  sandbox: { image: 'conductor-local-sandbox:1', memory: '4g', cpus: '4', pids: 256, timeoutSec: 120, maxOutputBytes: 262144, tmpfsSizeMb: 512 }
}, null, 2))
// The run record local.servers reads (src/main/local-models/config.ts runFile): pid must be alive.
const runRecordPath = join(localRoot, 'runtime', MODEL.replace(/[^a-z0-9.-]/gi, '_') + '.json')
await writeFile(runRecordPath, JSON.stringify({ pid: standInPid, port: standInPort, model: MODEL, file: 'model.gguf', startedAt: new Date().toISOString() }, null, 2))

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S21 smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_LOCAL_ROOT: localRoot, CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: `http://127.0.0.1:${standInPort}` }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
const request = async (method, args = {}) => { const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) }); return { status: r.status, body: await r.json() } }
const call = async (method, args = {}) => { const r = await request(method, args); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
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
  const ours = serversBefore.find(s => s.model === MODEL)
  summary.serversBefore = serversBefore
  assert.ok(ours, 'the stand-in server was not reported by local.servers')
  assert.equal(ours.startedByConductor, true, 'the stand-in should be reported startedByConductor:true')
  assert.equal(ours.pid, standInPid)
  assert.equal(ours.port, standInPort)

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

  const stopWhileBusy = await request('local.stop', { model: MODEL })
  observe('local.stop({model}) while busy', stopWhileBusy)
  assert.notEqual(stopWhileBusy.status, 200, 'local.stop should refuse while the conversation is mid-turn')
  assert.match(JSON.stringify(stopWhileBusy.body), /mid-turn|busy|generating/i)

  const serversWhileBusy = await call('local.servers')
  summary.serversWhileBusy = serversWhileBusy
  observe('local.servers while busy', { serversWhileBusy })

  // A pid this test instance's own local.servers reports startedByConductor:false (never the real
  // owner pid found any other way) — only if one exists (a real llama-server may be visible via
  // the machine-wide process inventory scan).
  const notOurs = serversWhileBusy.find(s => s.startedByConductor === false)
  if (notOurs) {
    const refusedPid = await request('local.stop', { pid: notOurs.pid })
    observe('local.stop({pid: not-started-by-conductor}) refusal', { pid: notOurs.pid, refusedPid })
    summary.notStartedByConductorRefusal = { pid: notOurs.pid, status: refusedPid.status, body: refusedPid.body }
    assert.notEqual(refusedPid.status, 200)
    assert.match(JSON.stringify(refusedPid.body), /not started by this Conductor/i)
  } else {
    summary.notStartedByConductorRefusal = 'no startedByConductor:false server was visible in this test instance; case not exercised'
    observe('no startedByConductor:false server visible; skipping that refusal case')
  }

  await expect.poll(async () => (await call('agents.status', { agentSessionId })).phase, { timeout: 30_000, intervals: [500] }).toBe('completed')
  await expect.poll(standInProcessing, { timeout: 5000 }).toBe(false)
  observe('turn completed; stand-in now idle')

  const stopNowOk = await request('local.stop', { model: MODEL })
  observe('local.stop({model}) after completion', stopNowOk)
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
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', localRoot, observations }
await writeFile(join(output, 'S21-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(done => setTimeout(done, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
if (!keep) await rm(localRoot, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})
process.exit(failed ? 1 : 0)
