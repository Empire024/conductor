// V1 verify S11: is "saved ~= N tokens" honest? Generates a few real local-assist calls, computes
// raw/4 - returned/4 from savings.jsonl ourselves, opens the Processes dashboard (WeeklyUsage,
// non-compact) for a screenshot of "Local models saved ~= N tokens this week", and checks whether
// any app-control method exposes the figure (tools.list).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-s11-savings.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s11-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# S11 smoke\n')
// A log big enough that a frontier model would never plausibly read it whole.
await writeFile(join(projectPath, 'biglog.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i} of noise `.repeat(4)).join('\n'))

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 15 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('S11 smoke'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'S11 smoke' }).first().click()

  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const projectId = (await call('projects.list')).find(p => p.name === 'S11 smoke')?.id ?? (await call('projects.open', { path: projectPath, name: 'S11 smoke' })).id
  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id

  const before = new Set(await readdir(tmpdir()).catch(() => []))
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', exactPermission: true, title: 'S11' }, projectId).then(r => r.resourceId)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
  await call('agents.submit', { agentSessionId: tab, prompt: 'SYNTHETIC LONG 4' })
  await poll(async () => { const s = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 30_000, 1000)
  const created = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const c = list.filter(n => n.startsWith('conductor-local-mcp-') && !before.has(n)); return c.length ? c : null }, 40_000)
  const cfgFile = join(tmpdir(), created[0], `${tab.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  const server = JSON.parse(await readFile(cfgFile, 'utf8')).mcpServers['conductor-local']
  const rpc = async (method, params) => { const r = await fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return r.json() }
  await rpc('tools/call', { name: 'local_ask', arguments: { prompt: 'Summarise this file briefly.', files: ['biglog.txt'] } })
  await rpc('tools/call', { name: 'run_and_summarize', arguments: { command: 'echo hello from S11', timeoutSec: 15 } })

  const savingsPath = join(profile, 'local-assist', 'savings.jsonl')
  await poll(async () => existsSync(savingsPath), 15_000)
  const savingsLines = (await readFile(savingsPath, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const computedSaved = savingsLines.reduce((sum, l) => sum + Math.max(0, Math.floor(l.rawChars / 4) - Math.floor(l.returnedChars / 4)), 0)
  observe: console.log('savings ledger', JSON.stringify(savingsLines))

  // Does any app-control method expose this figure?
  const tools = await call('tools.list')
  const toolNames = Object.keys(tools)
  const exposedMethod = toolNames.find(n => /saving|local.*token|weekly/i.test(n))
  let usageWeeklyError = null
  try { await call('usage.weekly') } catch (e) { usageWeeklyError = String(e.message) }
  record('S11-control-exposure', exposedMethod ? 'INFO' : 'FAIL (real, matches docs)', `tools.list method names matching saving/local/weekly: ${exposedMethod ?? 'none'}. usage.weekly (not documented) result: ${usageWeeklyError ?? 'somehow succeeded'}. Confirms docs/local-assist.md "Not yet wired": usage.limits/local.savings need lines in agent-control.ts.`)

  // Screenshot the Usage view (Processes dashboard, WeeklyUsage non-compact).
  await page.keyboard.press('Control+KeyK')
  await page.waitForTimeout(300)
  await page.getByPlaceholder(/command|search/i).first().fill('process dashboard').catch(() => {})
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(output, 's11-usage-view.png'), fullPage: true })
  const displayedText = await page.locator('.weekly-usage-local').first().textContent().catch(() => null)
  const displayedMatch = /saved ~?=?\s*≈?\s*([\d.]+[kKmM]?)/i.exec(displayedText ?? '')
  record('S11', 'INFO', `computed saved (raw/4-returned/4 over ${savingsLines.length} calls) = ${computedSaved} tokens. Displayed in Usage view: "${displayedText ?? '(weekly-usage-local not found/visible)'}"`)
  await writeFile(join(output, 's11-savings.json'), JSON.stringify({ savingsLines, computedSaved, displayedText }, null, 2))

  // Realism note: S2-style (a huge real log) would never be read whole by a frontier model.
  const bigLogCall = savingsLines.find(l => l.tool === 'local_ask')
  if (bigLogCall) {
    const realisticAvoided = Math.floor(200 / 4) // a frontier model would read maybe a ~200-char tail/summary, not the whole biglog.txt
    record('S11-realism', bigLogCall.rawChars > 5000 ? 'INFO' : 'FAIL', `local_ask over biglog.txt claims rawChars=${bigLogCall.rawChars} (the whole file) as what was "avoided" reading; a realistic frontier-model alternative would read a small tail/excerpt (~${realisticAvoided} tokens), not the whole file, so the true "avoided" figure is smaller than raw/4 implies for large non-log files.`)
  }
} catch (error) {
  failed = error
  record('S11-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(r => setTimeout(r, 15_000))])
  try { app?.process().kill() } catch {}
  await writeFile(join(output, 's11-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S11 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed) process.exit(1)
