// V1 verify group E: S25 (real coding task with acceptance, deps not prepared), S27 (1MB file read
// in a local coding tab), S28 (multi-file rename with a contract). Real running model, three
// separate small projects (never the live checkout).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-local-coding.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MODEL = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-coding-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

// ---- S25 project: a tiny copy of shared/usage-warning.ts + its test, node_modules junctioned ----
const s25Project = join(root, 'p25')
await mkdir(join(s25Project, 'src', 'shared'), { recursive: true })
await execFileSync('powershell.exe', ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path '${join(s25Project, 'node_modules')}' -Target '${resolve('node_modules')}' | Out-Null`])
for (const f of ['usage-warning.ts', 'usage-accounting.ts']) await writeFile(join(s25Project, 'src', 'shared', f), await readFile(resolve('src/shared', f)))
await writeFile(join(s25Project, 'src', 'shared', 'usage-warning.test.ts'), "import { describe, it, expect } from 'vitest'\nimport { evaluateUsageWarning } from './usage-warning'\ndescribe('placeholder', () => { it('keeps the suite non-empty', () => { expect(true).toBe(true) }) })\n")
await writeFile(join(s25Project, 'package.json'), JSON.stringify({ name: 'p25', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2))
await writeFile(join(s25Project, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: {} })\n")

// ---- S27 project: reuse the 1MB needle file idea from S7 ----
const s27Project = join(root, 'p27')
await mkdir(s27Project, { recursive: true })
{
  const chunks = []; let bytes = 0; let i = 0
  while (bytes < 1_000_000) {
    let line = `line ${i} filler filler filler filler filler filler filler filler\n`
    if (bytes < 400_000 && bytes + line.length >= 400_000) line = 'NEEDLE: the codeword right here is BRAVO-2024\n'
    chunks.push(line); bytes += line.length; i++
  }
  await writeFile(join(s27Project, 'big.txt'), chunks.join(''))
}

// ---- S28 project: a function used in 3 files + a test, to be renamed everywhere ----
const s28Project = join(root, 'p28')
await mkdir(s28Project, { recursive: true })
await writeFile(join(s28Project, 'compute.js'), 'export function computeTotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0)\n}\n')
await writeFile(join(s28Project, 'cart.js'), "import { computeTotal } from './compute.js'\nexport function cartSummary(items) {\n  return `Total: $${computeTotal(items).toFixed(2)}`\n}\n")
await writeFile(join(s28Project, 'report.js'), "import { computeTotal } from './compute.js'\nexport function reportLine(items) {\n  return `items=${items.length} total=${computeTotal(items)}`\n}\n")
await writeFile(join(s28Project, 'compute.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { computeTotal } from './compute.js'\ntest('computeTotal sums price*qty', () => { assert.equal(computeTotal([{price:2,qty:3},{price:1,qty:1}]), 7) })\n")

const observe = (label, data = {}) => console.log(`[${new Date().toISOString()}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`)
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1500) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const projection = agentSessionId => { const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(agentSessionId).projection_json) } finally { db.close() } }

const watchdog = setTimeout(() => { observe('watchdog: giving up'); process.exit(1) }, 50 * 60_000)
try {
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const waitDone = async (id, timeoutMs) => poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, timeoutMs, 2000)

  // ---- S25 ----
  const proj25 = await call('projects.open', { path: s25Project, name: 'V1 S25' })
  const tab25 = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S25', contract: { allowedPaths: ['src/shared/usage-warning.test.ts'], acceptance: { command: 'npx vitest run src/shared/usage-warning.test.ts', timeoutSec: 180 } } }, proj25.id).then(r => r.resourceId)
  await call('agents.submit', { agentSessionId: tab25, prompt: 'Add a unit test in src/shared/usage-warning.test.ts for evaluateUsageWarning covering the case where cap is null and report.costUsd is exactly 5 (the DEFAULT_COST_WARNING_USD.high threshold) -- it should return level "high". Make the acceptance command pass.' })
  const done25 = await waitDone(tab25, 15 * 60_000)
  const items25 = (projection(tab25).items ?? [])
  const acceptanceTool = items25.filter(i => i.data?.type === 'tool')
  const acceptanceOutput = JSON.stringify(acceptanceTool).slice(0, 2000)
  const sandboxEvidence = /rollup|esbuild|native binary|EACCES|permission denied|linux/i.test(acceptanceOutput) ? 'sandbox (Linux container, deps not prepared)' : /vitest|passed|PASS/i.test(acceptanceOutput) ? 'ran somewhere and reported vitest output' : 'unclear'
  record('S25', done25.phase === 'completed' ? 'PASS' : 'FAIL', `phase=${done25.phase}; acceptance evidence: ${sandboxEvidence}; deps not prepared (owner action, never run here)`)
  await writeFile(join(output, 's25-items.json'), acceptanceOutput)

  // ---- S27 ----
  const proj27 = await call('projects.open', { path: s27Project, name: 'V1 S27' })
  const tab27 = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S27' }, proj27.id).then(r => r.resourceId)
  await call('agents.submit', { agentSessionId: tab27, prompt: 'Find the exact codeword in big.txt after the phrase "the codeword right here is" and reply with just it. If the file is too large to read at once, say so plainly and read it in chunks.' })
  const done27 = await waitDone(tab27, 10 * 60_000)
  const proj27state = projection(tab27)
  const assistant27 = (proj27state.items ?? []).filter(i => i.data?.type === 'text' && i.data.role === 'assistant').map(i => i.data.text).join('')
  const errors27 = (proj27state.items ?? []).filter(i => i.data?.type === 'error')
  const no400 = !errors27.some(e => /400/.test(e.data.message ?? ''))
  const foundOrHonest = /BRAVO-2024/.test(assistant27) || /too large|chunk|truncat/i.test(assistant27)
  record('S27', done27.phase === 'completed' && no400 && foundOrHonest ? 'PASS' : 'FAIL', `phase=${done27.phase}, no llama 400=${no400}, found or honest=${foundOrHonest}: ${assistant27.slice(0, 300)}`)

  // ---- S28 ----
  const proj28 = await call('projects.open', { path: s28Project, name: 'V1 S28' })
  const tab28 = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S28', contract: { allowedPaths: ['compute.js', 'cart.js', 'report.js', 'compute.test.mjs'], acceptance: { command: 'node --test compute.test.mjs', timeoutSec: 60 } } }, proj28.id).then(r => r.resourceId)
  await call('agents.submit', { agentSessionId: tab28, prompt: 'Rename the function computeTotal to computeGrandTotal everywhere it is used (compute.js, cart.js, report.js, compute.test.mjs) and make sure the test still passes.' })
  const done28 = await waitDone(tab28, 10 * 60_000)
  const [compute, cart, report, test] = await Promise.all(['compute.js', 'cart.js', 'report.js', 'compute.test.mjs'].map(f => readFile(join(s28Project, f), 'utf8')))
  const allRenamed = [compute, cart, report, test].every(text => text.includes('computeGrandTotal') && !text.includes('computeTotal'))
  let testPasses = false
  try { execFileSync('node', ['--test', 'compute.test.mjs'], { cwd: s28Project, stdio: 'pipe' }); testPasses = true } catch { testPasses = false }
  record('S28', done28.phase === 'completed' && allRenamed && testPasses ? 'PASS' : 'FAIL', `phase=${done28.phase}, allThreeFilesAndTestRenamed=${allRenamed}, testPassesAfterward=${testPasses}`)
} catch (error) {
  record('coding-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's25-s27-s28-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== E SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
