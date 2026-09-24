import { createServer } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { expect } from '@playwright/test'

// local-turns-survive-restart acceptance (docs/runtime-host.md, "Local model turns"): a local-model
// turn paused by an owner app.restart continues in its tab after the relaunch, with no round lost
// or repeated and the finished tool call not run again. The built app runs parked under
// CONDUCTOR_TEST_USER_DATA with the runtime host on; a stand-in llama.cpp endpoint served by this
// script (so it outlives both app processes) answers through the unpackaged endpoint override.
// Round 1 is a read_file call; round 2 streams slowly and the restart lands in it; the resumed
// request must be that same request again, and the turn must complete.
//
//   node scripts/smoke-lock.mjs -- node scripts/smoke-local-restart.mjs [--keep]

const MODEL = 'local/qwen3.5-9b'
const KEY = 'c'.repeat(64)
const FINAL = 'The README says local restart smoke.'
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-local-restart-'))
const output = resolve('artifacts/local-restart')
await mkdir(output, { recursive: true })
// The local stack refuses a root on the system drive, so the stand-in config (two small files)
// goes to a scratch folder on the first other fixed drive, and is removed at the end.
const systemDrive = (process.env.SystemDrive ?? 'C:').toUpperCase()
const scratchDrive = process.env.CONDUCTOR_SMOKE_LOCAL_DRIVE ?? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:`).find(letter => letter !== systemDrive && existsSync(letter + '\\'))
if (!scratchDrive) { console.error('No non-system drive for the local stand-in root; set CONDUCTOR_SMOKE_LOCAL_DRIVE.'); process.exit(2) }
const localRoot = await mkdtemp(join(scratchDrive + '\\', 'conductor-local-restart-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(join(localRoot, 'config'), { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// The llama.cpp stand-in: identity and context for the adapter's probes, then a scripted turn.
const requests = []
const sse = (response, delta, finish) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`)
const endpoint = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401).end('{}'); return }
  if (request.method === 'GET') {
    if (request.url === '/props') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } })); return }
    if (request.url?.startsWith('/v1/models')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] })); return }
    response.writeHead(404).end(); return
  }
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', async () => {
    const index = requests.length
    const parsed = JSON.parse(body)
    requests.push({ at: new Date().toISOString(), messages: parsed.messages })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.on('error', () => {})
    if (index === 0) {
      sse(response, { tool_calls: [{ index: 0, id: 'call-readme', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, 'tool_calls')
      response.end('data: [DONE]\n\n'); return
    }
    if (index === 1) {
      // Long enough for the restart to land in the middle of it.
      for (let word = 0; word < 240 && !response.destroyed; word++) { sse(response, { content: `slow${word} ` }); await new Promise(done => setTimeout(done, 250)) }
      if (!response.destroyed) { sse(response, {}, 'stop'); response.end('data: [DONE]\n\n') }
      return
    }
    sse(response, { content: FINAL }, 'stop')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => endpoint.listen(0, '127.0.0.1', done))
const endpointPort = endpoint.address().port

await writeFile(join(localRoot, 'config', 'api-key'), KEY + '\n')
await writeFile(join(localRoot, 'config', 'config.json'), JSON.stringify({
  // Local is offered only when its server executable resolves; with the endpoint override nothing is launched.
  version: 1, llamaServer: process.execPath, llamaVersion: 'smoke stand-in',
  models: { [MODEL]: { id: MODEL, label: 'Smoke model', repo: 'owner/repo', revision: 'a'.repeat(40), file: 'model.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'b'.repeat(64), port: endpointPort, contextTokens: 32768, gpuLayers: 1, extraArgs: [] } },
  sandbox: { image: 'conductor-local-sandbox:1', memory: '4g', cpus: '4', pids: 256, timeoutSec: 120, maxOutputBytes: 262144, tmpfsSizeMb: 512 }
}, null, 2))

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# Local restart smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_RUNTIME_HOST_IDLE_MS: '5000',
  CONDUCTOR_LOCAL_ROOT: localRoot, CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: `http://127.0.0.1:${endpointPort}` }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
const call = async (method, args = {}) => {
  const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const hostLock = () => { try { return JSON.parse(readFileSync(join(profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }
const hostShutdown = lock => new Promise(done => {
  const socket = connect(lock.pipe)
  const timer = setTimeout(() => { socket.destroy(); done() }, 5000)
  socket.on('error', () => { clearTimeout(timer); done() })
  socket.on('connect', () => socket.write(JSON.stringify({ op: 'hello', id: 1, secret: lock.secret, protocol: lock.protocol }) + '\n' + JSON.stringify({ op: 'shutdown', id: 2 }) + '\n'))
  socket.on('data', () => { clearTimeout(timer); socket.end(); done() })
})
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const projection = agentSessionId => {
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(agentSessionId).projection_json) } finally { db.close() }
}

const summary = { root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, 6 * 60_000)
let firstPid = null, relaunchedPid = null, failed = null
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
  await expect.poll(() => hostLock()?.pid ?? null, { timeout: 30_000 }).not.toBe(null)
  projectId = (await call('projects.open', { path: projectPath, name: 'Local restart smoke' })).id
  const tab = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'read-only', exactPermission: true, title: 'Paused local turn' })
  const agentSessionId = tab.resourceId ?? tab.agentSessionId
  summary.agentSessionId = agentSessionId
  await call('agents.submit', { agentSessionId, prompt: 'Read README.md and tell me what it says.' })
  // Round 1 done and round 2 streaming: the restart lands mid-generation.
  await expect.poll(() => requests.length, { timeout: 60_000, intervals: [250] }).toBe(2)
  await new Promise(done => setTimeout(done, 1500))
  observe('turn under way in round 2', { requests: requests.length })

  await call('app.restart', { force: true })
  observe('app.restart requested')
  await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = await credential(); return next.pid !== firstPid && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  relaunchedPid = owner.pid
  observe('app relaunched', { pid: relaunchedPid })

  await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId })).phase } catch { return null } }, { timeout: 90_000, intervals: [500] }).toBe('completed')
  await new Promise(done => setTimeout(done, 1500))
  const items = projection(agentSessionId).items ?? []
  const notices = items.filter(item => item.data?.type === 'notice').map(item => item.data.message)
  const assistant = items.filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
  const tools = items.filter(item => item.data?.type === 'tool').map(item => ({ name: item.data.name, status: item.data.status }))
  Object.assign(summary, { requests: requests.length, notices: notices.slice(-6), assistant, tools })
  observe('turn completed after the restart', { requests: requests.length, tools })

  assert.equal(requests.length, 3, 'the resumed turn should send exactly one more request')
  assert.deepEqual(requests[2].messages, requests[1].messages, 'the resumed request is not the one the restart cut off')
  const prompts = requests[2].messages.filter(message => message.role === 'user' && message.content.includes('Read README.md'))
  assert.equal(prompts.length, 1, 'the owner prompt was sent twice')
  assert.equal(requests[2].messages.filter(message => message.role === 'tool' && message.tool_call_id === 'call-readme').length, 1)
  assert.equal(tools.filter(tool => tool.name === 'read_file').length, 1, 'read_file ran again')
  assert.ok(notices.some(message => /paused after tool round 1 and continues here/.test(message)), 'no resume notice in the tab')
  assert.ok(assistant.some(text => text.includes(FINAL)), 'the final answer is missing')
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1200) })
} finally {
  clearTimeout(watchdog)
  for (const pid of [firstPid, relaunchedPid, owner?.pid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /runtime host|reattach|Kept|kept|local|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
  const lock = hostLock()
  if (lock) await hostShutdown(lock)
  endpoint.closeAllConnections?.(); endpoint.close()
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', localRoot, observations }
await writeFile(join(output, 'smoke-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(done => setTimeout(done, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
if (!keep) await rm(localRoot, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})
process.exit(failed ? 1 : 0)
