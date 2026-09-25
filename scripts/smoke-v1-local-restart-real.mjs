// V1 verify group B (S14): local-turns-survive-restart (docs/runtime-host.md) against the REAL
// running llama.cpp server -- no stand-in endpoint, unlike scripts/smoke-local-restart.mjs. A
// parked instance with the runtime host on, a local tab (accept-edits) given a task that needs
// >=4 rounds, restarted mid-task with the owner credential, must continue the same turn after
// relaunch with no round lost or repeated.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-local-restart-real.mjs
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MODEL = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-restart-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
for (const [name, body] of [['a.txt', 'Alpha file: the sky is blue.\n'], ['b.txt', 'Bravo file: the grass is green.\n'], ['c.txt', 'Charlie file: the sun is bright.\n'], ['d.txt', 'Delta file: the ocean is deep.\n']]) await writeFile(join(projectPath, name), body)

const observations = []
const observe = (label, data = {}) => { const e = { at: new Date().toISOString(), label, ...data }; observations.push(e); console.log(`[${e.at}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`) }

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_RUNTIME_HOST_IDLE_MS: '20000' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const projection = agentSessionId => { const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(agentSessionId).projection_json) } finally { db.close() } }
const credential = async () => JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
const hostLock = () => { try { return JSON.parse(readFileSync(join(profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }

const summary = { root, profile }
let owner, projectId, firstPid = null, relaunchedPid = null, failed = null
const appLog = join(root, 'app.log')
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, 20 * 60_000)
try {
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid })
  await poll(async () => { try { return (await credential()).pid === firstPid } catch { return false } }, 60_000)
  owner = await credential()
  await poll(() => hostLock()?.pid ?? null, 30_000)
  const call = async (method, args = {}) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  projectId = (await call('projects.open', { path: projectPath, name: 'V1 restart real' })).id
  const tab = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S14 real restart' })
  const agentSessionId = tab.resourceId
  summary.agentSessionId = agentSessionId
  await call('agents.submit', { agentSessionId, prompt: 'Read a.txt, b.txt, c.txt and d.txt one at a time, in that order, using a separate tool call for each file. After reading all four, write SUMMARY.md with exactly one line per file summarising its content.' })

  const toolCount = () => (projection(agentSessionId).items ?? []).filter(i => i.data?.type === 'tool').length
  await poll(() => toolCount() >= 2 ? true : null, 300_000, 2000)
  observe('at least 2 tool rounds observed; restarting now', { tools: toolCount() })
  const beforeItems = projection(agentSessionId).items ?? []
  const beforeTools = beforeItems.filter(i => i.data?.type === 'tool').map(i => ({ name: i.data.name, status: i.data.status, id: i.id }))

  await call('app.restart', { force: true })
  observe('app.restart requested')
  await poll(() => !alive(firstPid), 30_000)
  owner = await poll(async () => { try { const next = await credential(); return next.pid !== firstPid && alive(next.pid) ? next : null } catch { return null } }, 90_000)
  relaunchedPid = owner.pid
  observe('app relaunched', { pid: relaunchedPid })

  await poll(async () => { try { return (await call('agents.status', { agentSessionId })).phase } catch { return null } }, 600_000, 2000).then(p => observe('phase after relaunch', { phase: p }))
  await poll(async () => { const s = await call('agents.status', { agentSessionId }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s.phase : null }, 600_000, 3000)
  await sleep(1500)

  const items = projection(agentSessionId).items ?? []
  const tools = items.filter(i => i.data?.type === 'tool').map(i => ({ name: i.data.name, status: i.data.status, id: i.id }))
  const notices = items.filter(i => i.data?.type === 'notice').map(i => i.data.message)
  const assistant = items.filter(i => i.data?.type === 'text' && i.data.role === 'assistant').map(i => i.data.text)
  const sequences = items.map(i => i.sequence)
  const strictlyIncreasing = sequences.every((s, i) => i === 0 || s > sequences[i - 1])
  const noDuplicateSeq = new Set(sequences).size === sequences.length
  const summaryFile = join(projectPath, 'SUMMARY.md')
  const summaryText = existsSync(summaryFile) ? await readFile(summaryFile, 'utf8') : '(missing)'
  Object.assign(summary, { beforeTools, tools, notices, assistant: assistant.map(t => t.slice(0, 200)), strictlyIncreasing, noDuplicateSeq, summaryText })
  const resumeNoticed = notices.some(m => /paused|continues here|resume/i.test(m))
  const summaryOk = /a\.txt|Alpha|blue/i.test(summaryText) && /b\.txt|Bravo|green/i.test(summaryText) && /c\.txt|Charlie|bright/i.test(summaryText) && /d\.txt|Delta|deep/i.test(summaryText)
  observe('S14 ' + (strictlyIncreasing && noDuplicateSeq && summaryOk ? 'PASS' : 'FAIL'), { resumeNoticed, summaryOk, strictlyIncreasing, noDuplicateSeq })
  summary.s14 = { resumeNoticed, summaryOk, strictlyIncreasing, noDuplicateSeq }

  // ---- S15: a tool call in flight (run_command mid-sleep) must not be replayed ----------------
  const call2 = async (method, args = {}) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const tab2 = await call2('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S15 in-flight tool' })
  const agentSessionId2 = tab2.resourceId
  await call2('agents.submit', { agentSessionId: agentSessionId2, prompt: "First read a.txt with a tool call. Then, as a second and separate tool call, run this exact shell command with your command-running tool: sh -c 'echo run >> counter.txt; sleep 25'. Wait for it to finish, then reply with just DONE." })
  await poll(() => (projection(agentSessionId2).items ?? []).some(i => i.data?.type === 'tool' && /run_command|bash|shell/i.test(i.data.name)) ? true : null, 180_000, 1000)
  await sleep(4000) // land inside the 25s sleep
  const beforeItems2 = projection(agentSessionId2).items ?? []
  observe('S15 tool call in flight; restarting now', { tools: beforeItems2.filter(i => i.data?.type === 'tool').map(i => ({ name: i.data.name, status: i.data.status })) })

  await call2('app.restart', { force: true })
  observe('S15 app.restart requested')
  const secondPid = relaunchedPid
  await poll(() => !alive(secondPid), 30_000)
  owner = await poll(async () => { try { const next = await credential(); return next.pid !== secondPid && alive(next.pid) ? next : null } catch { return null } }, 90_000)
  const thirdPid = owner.pid
  observe('S15 app relaunched', { pid: thirdPid })
  await poll(async () => { const s = await call2('agents.status', { agentSessionId: agentSessionId2 }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s.phase : null }, 300_000, 3000)
  await sleep(1500)

  const items2 = projection(agentSessionId2).items ?? []
  const runCommandTools = items2.filter(i => i.data?.type === 'tool' && /run_command|bash|shell/i.test(i.data.name))
  const interruptedReported = runCommandTools.some(i => i.data.status === 'interrupted' || /interrupt/i.test(JSON.stringify(i.data.output ?? '')))
  const counterFile = join(projectPath, 'counter.txt')
  const counterLines = existsSync(counterFile) ? (await readFile(counterFile, 'utf8')).trim().split('\n').filter(Boolean) : []
  observe('S15 ' + (counterLines.length === 1 && interruptedReported ? 'PASS' : 'FAIL'), { counterLines, interruptedReported, runCommandTools: runCommandTools.map(i => ({ status: i.data.status })) })
  summary.s15 = { counterLines, interruptedReported }
  relaunchedPid = thirdPid
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.stack ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  for (const pid of [firstPid, relaunchedPid, owner?.pid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(l => /runtime host|reattach|local|Error|error/i.test(l)).slice(-60) } catch {}
}
const result = { ...summary, observations }
await writeFile(join(output, 's14-s16-restart-real.json'), JSON.stringify(result, null, 2))
console.log('\n=== S14 SUMMARY ===')
console.log(JSON.stringify(result, null, 2).slice(0, 4000))
