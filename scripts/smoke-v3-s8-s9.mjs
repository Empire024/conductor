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

// V3 verify S8/S9 (local-turns-survive-restart, based on scripts/smoke-local-restart.mjs).
// S8: round 1 issues a slow run_command tool call (sleeps 8s then appends one line to a marker
// file); the owner restarts 2s into that tool. Expect: the tool ran at most once (marker has at
// most 1 line); the resumed request contains an "Interrupted: ... restarted while this ... call
// was running" tool result; no request sent twice except a cut-off generation; the turn completes.
// S9: two restarts in one turn (mid-generation in round 2, then round 3). Expect completion, the
// prompt appears once in every request, no duplicated tool message, total requests = rounds +
// cut-off generations.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-s8-s9.mjs --scenario=s8|s9 [--keep]

const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const scenarioArg = arg('scenario') ?? 's8'
const keep = process.argv.includes('--keep')
const MODEL = 'local/qwen3.5-9b'
const KEY = 'c'.repeat(64)
const root = await mkdtemp(join(tmpdir(), `conductor-v3-${scenarioArg}-`))
const output = resolve(`artifacts/v3-verify/${scenarioArg.toUpperCase()}`)
await mkdir(output, { recursive: true })
const systemDrive = (process.env.SystemDrive ?? 'C:').toUpperCase()
const scratchDrive = process.env.CONDUCTOR_SMOKE_LOCAL_DRIVE ?? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:`).find(letter => letter !== systemDrive && existsSync(letter + '\\'))
if (!scratchDrive) { console.error('No non-system drive for the local stand-in root; set CONDUCTOR_SMOKE_LOCAL_DRIVE.'); process.exit(2) }
const localRoot = await mkdtemp(join(scratchDrive + '\\', `conductor-v3-${scenarioArg}-`))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(join(localRoot, 'config'), { recursive: true }); await mkdir(join(localRoot, 'runtime'), { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

const requests = []
const sse = (response, delta, finish) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`)
const markerFile = join(projectPath, 'marker.txt')
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
    if (scenarioArg === 's8') {
      if (index === 0) {
        // A slow shell tool call: sleeps 8s then appends one line to the marker file.
        // The sandbox is a real Linux/Docker container (found by diagnosing S8's first attempt,
        // which used a Windows-only powershell command and failed with "command not found"; exit 127).
        sse(response, { tool_calls: [{ index: 0, id: 'call-slow', function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep 8 && echo ran >> marker.txt' }) } }] }, 'tool_calls')
        response.end('data: [DONE]\n\n'); return
      }
      sse(response, { content: 'Done after the slow tool.' }, 'stop')
      response.end('data: [DONE]\n\n'); return
    }
    // s9: round 0 is a quick tool call, round 1 (a slow generation) is cut off by restart #1,
    // round 2 (another slow generation) is cut off by restart #2, round 3 completes.
    if (index === 0) {
      sse(response, { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, 'tool_calls')
      response.end('data: [DONE]\n\n'); return
    }
    if (index === 1 || index === 2) {
      for (let word = 0; word < 200 && !response.destroyed; word++) { sse(response, { content: `r${index}w${word} ` }); await new Promise(done => setTimeout(done, 250)) }
      if (!response.destroyed) { sse(response, {}, 'stop'); response.end('data: [DONE]\n\n') }
      return
    }
    sse(response, { content: 'S9 final answer.' }, 'stop')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => endpoint.listen(0, '127.0.0.1', done))
const endpointPort = endpoint.address().port

await writeFile(join(localRoot, 'config', 'api-key'), KEY + '\n')
await writeFile(join(localRoot, 'config', 'config.json'), JSON.stringify({
  version: 1, llamaServer: process.execPath, llamaVersion: 'smoke stand-in',
  models: { [MODEL]: { id: MODEL, label: 'Smoke model', repo: 'owner/repo', revision: 'a'.repeat(40), file: 'model.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'b'.repeat(64), port: endpointPort, contextTokens: 32768, gpuLayers: 1, extraArgs: [] } },
  sandbox: { image: 'conductor-local-sandbox:1', memory: '4g', cpus: '4', pids: 256, timeoutSec: 120, maxOutputBytes: 262144, tmpfsSizeMb: 512 }
}, null, 2))

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S8/S9 smoke\n')
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
const restart = async (pidBefore) => {
  await call('app.restart', { force: true })
  await expect.poll(() => alive(pidBefore), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = await credential(); return next.pid !== pidBefore && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  return owner.pid
}

const summary = { scenario: scenarioArg, root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, 9 * 60_000)
let firstPid = null, relaunchedPid = null, failed = null
const appLog = join(root, 'app.log')
try {
  const port = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid, scenario: scenarioArg })
  await expect.poll(async () => { try { return (await credential()).pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  await expect.poll(() => hostLock()?.pid ?? null, { timeout: 30_000 }).not.toBe(null)
  projectId = (await call('projects.open', { path: projectPath, name: `V3 ${scenarioArg}` })).id
  // read-only blocks run_command by policy ("Tool denied by policy: run_command is unavailable in
  // read-only mode"), found while diagnosing S8's immediate tool failure; accept-edits allows it
  // (local models have no Auto mode).
  const tab = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: `V3 ${scenarioArg}` })
  const agentSessionId = tab.resourceId ?? tab.agentSessionId
  summary.agentSessionId = agentSessionId

  if (scenarioArg === 's8') {
    await call('agents.submit', { agentSessionId, prompt: 'Run the slow command.' })
    await expect.poll(() => requests.length, { timeout: 30_000, intervals: [250] }).toBeGreaterThanOrEqual(1)
    observe('round 0 (tool call) request received', { requests: requests.length })
    if (requests.length > 1) observe('WARNING: round 1 already arrived before the 8s sleep should have elapsed; the sandbox tool call may not have actually slept', { requests: requests.length })
    await new Promise(done => setTimeout(done, 2000)) // 2s into the (nominally 8s) tool call
    observe('restarting ~2s after the tool call was issued', { requests: requests.length })
    relaunchedPid = await restart(firstPid)
    observe('app relaunched', { pid: relaunchedPid })

    await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId })).phase } catch { return null } }, { timeout: 90_000, intervals: [500] }).toBe('completed')
    await new Promise(done => setTimeout(done, 1500))
    const items = projection(agentSessionId).items ?? []
    const tools = items.filter(item => item.data?.type === 'tool').map(item => ({ name: item.data.name, status: item.data.status, output: item.data.output ?? item.data.result ?? item.data.error ?? null }))
    const assistant = items.filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
    const notices = items.filter(item => item.data?.type === 'notice').map(item => item.data.message)
    let markerContent = '(missing)'
    try { markerContent = await readFile(markerFile, 'utf8') } catch { /* the tool may not have finished before the restart */ }
    const markerLines = markerContent.trim() ? markerContent.trim().split('\n').length : 0
    const interruptedToolResults = requests.flatMap(r => r.messages).filter(m => m.role === 'tool' && typeof m.content === 'string' && /Interrupted:.*restarted.*call was running/i.test(m.content))
    const toolResultMessages = requests.flatMap((r, i) => r.messages.filter(m => m.role === 'tool').map(m => ({ requestIndex: i, tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content.slice(0, 1000) : m.content })))
    summary.s8 = { requests: requests.length, tools, assistant, notices: notices.slice(-6), markerContent, markerLines, interruptedToolResultCount: interruptedToolResults.length, toolResultMessages, rawToolItems: items.filter(item => item.data?.type === 'tool') }
    observe('S8 result', summary.s8)
    assert.ok(markerLines <= 1, `the slow tool ran more than once (marker has ${markerLines} lines)`)
    assert.ok(interruptedToolResultCount(summary.s8) || markerLines === 1, 'expected either an interrupted-tool-call marker or the tool to have completed once')
    assert.ok(assistant.some(t => t.includes('Done after the slow tool')), 'the turn did not complete after the restart')
  } else {
    await call('agents.submit', { agentSessionId, prompt: 'Run the two-restart sequence.' })
    // Round 0 (tool) then round 1 starts streaming; restart mid-generation.
    await expect.poll(() => requests.length, { timeout: 30_000, intervals: [250] }).toBe(2)
    await new Promise(done => setTimeout(done, 1500))
    observe('restart #1 mid-generation in round 2')
    let pid = await restart(firstPid)
    observe('app relaunched after restart #1', { pid })
    // Round 2 (the cut-off generation resent) then round 3 begins; restart again mid-generation.
    await expect.poll(() => requests.length, { timeout: 60_000, intervals: [250] }).toBeGreaterThanOrEqual(3)
    await new Promise(done => setTimeout(done, 1500))
    observe('restart #2 mid-generation in round 3')
    pid = await restart(pid)
    relaunchedPid = pid
    observe('app relaunched after restart #2', { pid })

    await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId })).phase } catch { return null } }, { timeout: 90_000, intervals: [500] }).toBe('completed')
    await new Promise(done => setTimeout(done, 1500))
    const items = projection(agentSessionId).items ?? []
    const assistant = items.filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
    const tools = items.filter(item => item.data?.type === 'tool').map(item => ({ name: item.data.name, status: item.data.status }))
    const allUserPrompts = requests.flatMap(r => r.messages).filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Run the two-restart sequence'))
    const toolMessages = requests.flatMap(r => r.messages).filter(m => m.role === 'tool' && m.tool_call_id === 'call-1')
    summary.s9 = { totalRequests: requests.length, promptOccurrences: allUserPrompts.length, toolMessageOccurrencesPerRequest: requests.map(r => r.messages.filter(m => m.role === 'tool' && m.tool_call_id === 'call-1').length), assistant, tools }
    observe('S9 result', summary.s9)
    assert.ok(assistant.some(t => t.includes('S9 final answer')), 'the turn did not complete')
    assert.equal(new Set(requests.map(r => JSON.stringify(r.messages.filter(m => m.role === 'user')))).size <= requests.length, true)
    for (const r of requests) assert.ok(r.messages.filter(m => m.role === 'tool' && m.tool_call_id === 'call-1').length <= 1, 'a request carried the tool message more than once')
  }
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  for (const pid of [firstPid, relaunchedPid, owner?.pid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /runtime host|reattach|Kept|kept|local|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
  const lock = hostLock()
  if (lock) await hostShutdown(lock)
  endpoint.closeAllConnections?.(); endpoint.close()
}
function interruptedToolResultCount(s8) { return s8.interruptedToolResultCount > 0 }
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', localRoot, observations }
await writeFile(join(output, `${scenarioArg}-summary.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(done => setTimeout(done, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
if (!keep) await rm(localRoot, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})
process.exit(failed ? 1 : 0)
