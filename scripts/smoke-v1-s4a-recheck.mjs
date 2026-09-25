// V1 verify S4a clean re-check: run_and_summarize's timeoutSec kill must leave no orphan process.
// Polls the target pid pattern every 1s for up to 60s and records exactly when it disappears,
// run once the machine is quieter than during the first (contended) attempt.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-s4a-recheck.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s4a-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
const powershell = script => new Promise((done, fail) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(stdout)))

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 500) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

try {
  const before = await powershell("Get-CimInstance Win32_Process | Measure-Object | Select-Object -ExpandProperty Count")
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const proj = await call('projects.open', { path: projectPath, name: 'V1 S4a recheck' })
  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  const openTab = async (attempt = 0) => {
    try { return (await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', exactPermission: true, title: 'S4a recheck' }, proj.id)).resourceId }
    catch (error) { if (attempt < 5 && /did not acknowledge/.test(String(error?.message))) { await sleep(8000); return openTab(attempt + 1) } throw error }
  }
  const tab = await openTab()
  const beforeMcp = new Set(await readdir(tmpdir()).catch(() => []))
  await call('agents.submit', { agentSessionId: tab, prompt: 'SYNTHETIC LONG 4' })
  await poll(async () => { const s = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 60_000, 1000)
  const created = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const c = list.filter(n => n.startsWith('conductor-local-mcp-') && !beforeMcp.has(n)); return c.length ? c : null }, 40_000)
  const cfgFile = join(tmpdir(), created[0], `${tab.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  const parsed = JSON.parse(await readFile(cfgFile, 'utf8'))
  const server = parsed.mcpServers['conductor-local']

  const t0 = Date.now()
  const res = await fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_and_summarize', arguments: { command: 'node -e "setInterval(()=>console.log(Date.now()),500)"', timeoutSec: 30 } } }) })
  const body = await res.json()
  const elapsed = Date.now() - t0
  console.log('run_and_summarize returned', elapsed, 'ms:', JSON.stringify(body).slice(0, 300))

  const findPid = async () => { const out = await powershell("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*setInterval*Date.now*' } | Select-Object -ExpandProperty ProcessId").catch(() => ''); return out.trim() }
  const timeline = []
  const pollStart = Date.now()
  let disappearedAtMs = null
  for (let i = 0; i < 60; i++) {
    const pid = await findPid()
    timeline.push({ atMs: Date.now() - pollStart, pid: pid || null })
    if (!pid && disappearedAtMs === null) { disappearedAtMs = Date.now() - pollStart; break }
    await sleep(1000)
  }
  await writeFile(join(output, 's4a-recheck-timeline.json'), JSON.stringify({ elapsedToolMs: elapsed, machineProcessCountBefore: before.trim(), timeline, disappearedAtMs }, null, 2))
  record('S4a-recheck', disappearedAtMs !== null ? 'PASS' : 'FAIL', `tool returned in ${elapsed}ms; pid disappeared ${disappearedAtMs !== null ? `at +${disappearedAtMs}ms` : 'NEVER within 60s'} after the call returned`)
} catch (error) {
  record('S4a-recheck', 'FAIL', String(error?.stack ?? error).slice(0, 1200))
} finally {
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's4a-recheck-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S4a RECHECK SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
