// V1 verify group A tail: S2 (real npm test on the checkout), S4b (default 600s timeoutSec),
// S13a (no conductor-linux-deps-* volume appears on its own). Split out of
// smoke-v1-local-assist.mjs so a long-running headers-timeout fix didn't require re-running the
// whole (already-passing) S1/S3/S5-S9 batch.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-local-assist-tail.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }))

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-assist-tail-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const results = []
const record = (id, verdict, note, numbers) => { const e = { id, verdict, note, numbers, at: new Date().toISOString() }; results.push(e); console.log(`[${id}] ${verdict}: ${note}`) }
const powershell = script => new Promise((done, fail) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(stdout)))

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 500) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }

try {
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const parsed = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(parsed)}`); return parsed.result
  }
  const checkoutProj = await call('projects.open', { path: resolve('.'), name: 'V1 assist tail checkout' })
  await sleep(5000)
  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  const openTab = async (projectId, title, attempt = 0) => {
    try { return (await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', exactPermission: true, title }, projectId)).resourceId }
    catch (error) { if (attempt < 4 && /did not acknowledge/.test(String(error?.message))) { await sleep(8000); return openTab(projectId, title, attempt + 1) } throw error }
  }
  const before = new Set(await readdir(tmpdir()).catch(() => []))
  const tabCheckout = await openTab(checkoutProj.id, 'Checkout tail')
  const after = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const created = list.filter(n => n.startsWith('conductor-local-mcp-') && !before.has(n)); return created.length ? created : null }, 30_000).catch(() => null)
  const mcpConfigDir = after ? join(tmpdir(), after[0]) : null
  const submitAndWait = async (id, prompt, timeoutMs = 30_000) => { await call('agents.submit', { agentSessionId: id, prompt }); await poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, timeoutMs, 1000) }
  await submitAndWait(tabCheckout, 'SYNTHETIC LONG 4')
  const file = join(mcpConfigDir, `${tabCheckout.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  const server = parsed.mcpServers['conductor-local']
  const cfgCheckout = { url: server.url, auth: server.headers.Authorization }

  const before13a = await powershell('docker volume ls 2>$null').catch(() => '(docker unavailable)')

  let rpcId = 0
  const mcpCall = async (cfg, method, params, timeoutMs = 1_700_000) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try { const r = await fetch(cfg.url, { method: 'POST', headers: { Authorization: cfg.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: controller.signal }); return await r.json() }
    finally { clearTimeout(timer) }
  }
  const toolCall = (cfg, name, args, timeoutMs) => mcpCall(cfg, 'tools/call', { name, arguments: args }, timeoutMs).then(r => r.result)
  const textOf = result => result?.content?.[0]?.text ?? ''

  // ---- S4b: default timeoutSec (600) blocks the caller ----
  const t4b = Date.now()
  const s4b = await toolCall(cfgCheckout, 'run_and_summarize', { command: 'node -e "setInterval(()=>console.log(Date.now()),500)"' }, 700_000).catch(error => ({ content: [{ type: 'text', text: `ERROR: ${error?.message ?? error}` }] }))
  const elapsed4b = Date.now() - t4b
  record('S4b', 'INFO', `default timeoutSec (600) blocked the caller for ${elapsed4b}ms before returning: ${textOf(s4b).slice(0, 250)}`, { elapsedMs: elapsed4b })

  // ---- S2: real npm test on the checkout itself ----
  const t2 = Date.now()
  const s2 = await toolCall(cfgCheckout, 'run_and_summarize', { command: 'npm test', maxLines: 30, timeoutSec: 1700 }, 1_750_000).catch(error => ({ content: [{ type: 'text', text: `ERROR: ${error?.message ?? error}` }] }))
  const elapsed2 = Date.now() - t2
  const s2text = textOf(s2)
  record('S2', /exit 0/.test(s2text) ? 'PASS' : 'FAIL', `${elapsed2}ms: ${s2text.slice(0, 500)}`, { elapsedMs: elapsed2 })

  // ---- S13a ----
  const after13a = await powershell('docker volume ls 2>$null').catch(() => '(docker unavailable)')
  const newVolumes = after13a.split('\n').filter(l => !before13a.includes(l) && l.includes('conductor-linux-deps-'))
  record('S13a', newVolumes.length ? 'FAIL' : 'PASS', `new conductor-linux-deps-* volumes after S2/S4b: ${JSON.stringify(newVolumes)}`)
} catch (error) {
  record('tail-fatal', 'FAIL', String(error?.stack ?? error))
} finally {
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 'group-a-tail-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== TAIL SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
