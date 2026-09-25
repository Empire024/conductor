// RV1 follow-up for local-models-save-tokens S11: usage.limits now carries localSavings, the same
// figure the Usage view shows (src/main/agent-control.ts usage.limits, AgentControl.setLocalAssist,
// src/main/index.ts). Generates one real conductor-local call (no local model needed: a short
// command under the raw-tail line count skips the model), then checks usage.limits's response
// shape directly instead of grepping tools.list method names for it.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-local-assist-savings-control.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

const root = await mkdtemp(join(tmpdir(), 'conductor-local-savings-control-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# local savings control smoke\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 5 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Local savings control smoke'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'Local savings control smoke' }).first().click()

  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const projectId = (await call('projects.list')).find(p => p.name === 'Local savings control smoke')?.id ?? (await call('projects.open', { path: projectPath, name: 'Local savings control smoke' })).id
  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id

  // Before any conductor-local call: localSavings is present (or null when unwired), never absent.
  const before = await call('usage.limits')
  record('before-shape', 'localSavings' in before ? 'PASS' : 'FAIL', `usage.limits result has a localSavings key before any call: ${'localSavings' in before}; value=${JSON.stringify(before.localSavings)}`)

  const beforeTmp = new Set(await readdir(tmpdir()).catch(() => []))
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', exactPermission: true, title: 'savings control' }, projectId).then(r => r.resourceId)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
  await call('agents.submit', { agentSessionId: tab, prompt: 'SYNTHETIC LONG 4' })
  await poll(async () => { const s = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 30_000, 1000)
  const created = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const c = list.filter(n => n.startsWith('conductor-local-mcp-') && !beforeTmp.has(n)); return c.length ? c : null }, 40_000)
  const cfgFile = join(tmpdir(), created[0], `${tab.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  const server = JSON.parse(await readFile(cfgFile, 'utf8')).mcpServers['conductor-local']
  const rpc = async (method, params) => { const r = await fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return r.json() }
  // One line of output, well under RAW_TAIL: no local model call needed, so this runs with no
  // local server. It still records a ledger line (rawChars/returnedChars, usedModel:false).
  await rpc('tools/call', { name: 'run_and_summarize', arguments: { command: 'echo hello from savings control smoke', timeoutSec: 15 } })

  const savingsPath = join(profile, 'local-assist', 'savings.jsonl')
  await poll(async () => existsSync(savingsPath), 15_000)

  const after = await call('usage.limits')
  const saved = after.localSavings
  const ok = saved && typeof saved.calls === 'number' && saved.calls >= 1 && typeof saved.tokensSaved === 'number' && typeof saved.days === 'number'
  record('after-call', ok ? 'PASS' : 'FAIL', `usage.limits localSavings after one conductor-local call: ${JSON.stringify(saved)}`)

  const beforeCalls = before.localSavings?.calls ?? 0
  record('increments', (saved?.calls ?? 0) > beforeCalls ? 'PASS' : 'FAIL', `calls went from ${beforeCalls} to ${saved?.calls}`)
} catch (error) {
  failed = error
  record('fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { app?.process().kill() } catch {}
  console.log('\n=== LOCAL SAVINGS CONTROL SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed || results.some(r => r.verdict === 'FAIL')) process.exit(1)
