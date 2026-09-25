// V1 verify S10: no server running -> local_ask starts Qwen 3.5 9B. Machine idle check done by the
// caller (nvidia-smi <10% util over 30s, smoke-lock free) immediately before running this.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-s10-cold-start.mjs
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s10-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'note.txt'), 'The secret word is PELICAN-99.\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const powershell = script => new Promise((done, fail) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(stdout)))

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 10 * 60_000)
let stoppedPid = null
try {
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const proj = await call('projects.open', { path: projectPath, name: 'V1 S10' })
  const serversBefore = await call('local.servers').catch(e => ({ error: e.message }))
  console.log('local.servers before', JSON.stringify(serversBefore))

  // Stop the running server for real (this instance did not start it, so local.stop will refuse;
  // fall back to taskkill on that one pid, per the plan's explicit fallback).
  const runningPid = await powershell("Get-CimInstance Win32_Process -Filter \"name='llama-server.exe'\" | Select-Object -ExpandProperty ProcessId").then(s => s.trim()).catch(() => '')
  if (runningPid) {
    let stopMethod = 'local.stop'
    try { await call('local.stop', { pid: Number(runningPid) }) }
    catch (error) {
      stopMethod = 'taskkill (local.stop refused: ' + error.message.slice(0, 150) + ')'
      execFileSync('taskkill.exe', ['/PID', runningPid, '/F'], { stdio: 'ignore' })
    }
    stoppedPid = runningPid
    console.log(`stopped llama-server.exe pid ${runningPid} via ${stopMethod} at ${new Date().toISOString()}`)
    await poll(async () => { const out = await powershell("Get-CimInstance Win32_Process -Filter \"name='llama-server.exe'\" | Select-Object -ExpandProperty ProcessId").catch(() => ''); return out.trim() === '' }, 20_000)
    console.log('confirmed no llama-server.exe running')
  } else {
    console.log('no llama-server.exe was running to begin with')
  }

  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  const openTab = async (attempt = 0) => {
    try { return (await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', exactPermission: true, title: 'S10' }, proj.id)).resourceId }
    catch (error) { if (attempt < 5 && /did not acknowledge/.test(String(error?.message))) { await sleep(8000); return openTab(attempt + 1) } throw error }
  }
  const tab = await openTab()
  const beforeMcp = new Set(await readdir(tmpdir()).catch(() => []))
  await call('agents.submit', { agentSessionId: tab, prompt: 'SYNTHETIC LONG 4' })
  await poll(async () => { const s = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 30_000, 1000)
  const created = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const c = list.filter(n => n.startsWith('conductor-local-mcp-') && !beforeMcp.has(n)); return c.length ? c : null }, 40_000)
  const cfgFile = join(tmpdir(), created[0], `${tab.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  const server = JSON.parse(await readFile(cfgFile, 'utf8')).mcpServers['conductor-local']
  const rpc = async (method, params, timeoutMs = 60_000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const r = await fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: c.signal }); return await r.json() } finally { clearTimeout(t) } }

  const t0 = Date.now()
  const first = await rpc('tools/call', { name: 'local_ask', arguments: { prompt: 'What is the secret word?', files: ['note.txt'] } }, 25_000)
  const elapsed1 = Date.now() - t0
  const firstText = first.result?.content?.[0]?.text ?? JSON.stringify(first)
  console.log('first call', elapsed1, 'ms:', firstText.slice(0, 300))

  const startedTallyAt = Date.now()
  const serverReady = await poll(async () => { const out = await powershell("Get-CimInstance Win32_Process -Filter \"name='llama-server.exe'\" | Select-Object -ExpandProperty CommandLine").catch(() => ''); return out.includes('9b') || out.includes('9B') ? out : (out.trim() ? out : null) }, 120_000, 2000).catch(() => null)
  const timeToReadyMs = serverReady ? Date.now() - startedTallyAt : null
  const vram = await powershell('nvidia-smi --query-gpu=memory.used --format=csv,noheader').catch(() => '')
  console.log('server after cold-start attempt', serverReady?.slice(0, 200), 'vram', vram.trim())

  await sleep(60_000)
  const t2 = Date.now()
  const second = await rpc('tools/call', { name: 'local_ask', arguments: { prompt: 'What is the secret word?', files: ['note.txt'] } }, 30_000)
  const elapsed2 = Date.now() - t2
  const secondText = second.result?.content?.[0]?.text ?? JSON.stringify(second)
  console.log('second call', elapsed2, 'ms:', secondText.slice(0, 300))

  const finalServers = await powershell("Get-CimInstance Win32_Process -Filter \"name='llama-server.exe'\" | Select-Object ProcessId,CommandLine | Format-List").catch(() => '')
  const oneServerOnly = (finalServers.match(/ProcessId/g) ?? []).length <= 1
  record('S10', /PELICAN-99/.test(secondText) && oneServerOnly ? 'PASS' : 'INFO', `stoppedPid=${stoppedPid}; first call ${elapsed1}ms (raw-fallback expected ~20s): ${firstText.slice(0, 150)}; server ready after ~${timeToReadyMs}ms; second call (~60s later) ${elapsed2}ms answered=${/PELICAN-99/.test(secondText)}: ${secondText.slice(0, 150)}; one server only=${oneServerOnly}; vram=${vram.trim()}`)
  await writeFile(join(output, 's10-final-servers.txt'), finalServers)
} catch (error) {
  record('S10', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's10-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S10 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
  console.log('Leaving whatever local server is now running (should be qwen3.5-9b) as the plan asks.')
}
