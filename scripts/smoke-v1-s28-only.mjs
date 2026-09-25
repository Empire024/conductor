// V1 verify S28 only, with full transcript capture (brain's request): a multi-file rename with a
// contract (allowedPaths + acceptance). Saves the complete ordered transcript to
// artifacts/verification/2026-09-24-v1/s28-transcript.json via a LIVE query before the app closes
// (the first attempt's DB lost data to an unclean taskkill).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-s28-only.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MODEL = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s28-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const s28Project = join(root, 'p28')
await mkdir(s28Project, { recursive: true })
await writeFile(join(s28Project, 'compute.js'), 'export function computeTotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0)\n}\n')
await writeFile(join(s28Project, 'cart.js'), "import { computeTotal } from './compute.js'\nexport function cartSummary(items) {\n  return `Total: $${computeTotal(items).toFixed(2)}`\n}\n")
await writeFile(join(s28Project, 'report.js'), "import { computeTotal } from './compute.js'\nexport function reportLine(items) {\n  return `items=${items.length} total=${computeTotal(items)}`\n}\n")
await writeFile(join(s28Project, 'compute.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { computeTotal } from './compute.js'\ntest('computeTotal sums price*qty', () => { assert.equal(computeTotal([{price:2,qty:3},{price:1,qty:1}]), 7) })\n")

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1500) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 20 * 60_000)
try {
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const proj28 = await call('projects.open', { path: s28Project, name: 'V1 S28 only' })
  const tab28 = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S28', contract: { allowedPaths: ['compute.js', 'cart.js', 'report.js', 'compute.test.mjs'], acceptance: { command: 'node --test compute.test.mjs', timeoutSec: 60 } } }, proj28.id).then(r => r.resourceId)
  await call('agents.submit', { agentSessionId: tab28, prompt: 'Rename the function computeTotal to computeGrandTotal everywhere it is used (compute.js, cart.js, report.js, compute.test.mjs) and make sure the test still passes.' })
  const done28 = await poll(async () => { const s = await call('agents.status', { agentSessionId: tab28 }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 15 * 60_000, 2000)
  // Query the DB directly WHILE the app is still alive, so nothing is lost to an unclean shutdown.
  await sleep(1500)
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  const row = db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(tab28)
  const proj = JSON.parse(row.projection_json)
  db.close()
  await writeFile(join(output, 's28-transcript.json'), JSON.stringify(proj, null, 2))

  const items = proj.items ?? []
  const toolCalls = items.filter(i => i.data?.type === 'tool')
  const edits = toolCalls.filter(i => ['write_file', 'edit_file', 'str_replace'].includes(i.data.name))
  const acceptanceCalls = toolCalls.filter(i => i.data.name === 'acceptance')
  const finalAnswer = items.filter(i => i.data?.type === 'text' && i.data.role === 'assistant').map(i => i.data.text).join('\n---\n')
  const [compute, cart, report, test] = await Promise.all(['compute.js', 'cart.js', 'report.js', 'compute.test.mjs'].map(f => readFile(join(s28Project, f), 'utf8')))
  const allRenamed = [compute, cart, report, test].every(t => t.includes('computeGrandTotal') && !t.includes('computeTotal'))
  const orderSummary = toolCalls.map((i, idx) => `${idx}: ${i.data.name} status=${i.data.status}`).join(' | ')
  record('S28', 'INFO', `phase=${proj.phase}, toolCalls=${toolCalls.length}, edits=${edits.length}, acceptanceCalls=${acceptanceCalls.length}, allRenamed=${allRenamed}. Order: ${orderSummary}`)
  await writeFile(join(output, 's28-analysis.json'), JSON.stringify({ phase: proj.phase, toolCallCount: toolCalls.length, editCount: edits.length, acceptanceCallCount: acceptanceCalls.length, allRenamed, order: toolCalls.map(i => ({ name: i.data.name, status: i.data.status, input: i.data.input })), finalAnswer }, null, 2))
} catch (error) {
  record('S28', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's28-only-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S28 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
