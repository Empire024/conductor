// RV1 A2,A3,A5-A8,A14-A16: conductor-local MCP tool edge cases beyond scripts/smoke-v1-local-assist.mjs
// (not edited here). Real running llama.cpp server, one parked Electron instance, one Auto tab.
// Constants confirmed from src/main/local-assist/tools.ts: DEFAULT_RETURN_SEC=120, DEFAULT_KILL_SEC=600,
// MAX_TIMEOUT_SEC=1800, MAX_FILE_BYTES=1536*1024 (1,572,864 bytes).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-a-limits.mjs
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }))
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-a-limits-'))
const output = resolve('artifacts/verification/2026-09-25-rv1/A')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const results = []
const record = (id, verdict, note, numbers) => { results.push({ id, verdict, note, numbers }); console.log(`[${id}] ${verdict}: ${note}`) }

const powershell = script => new Promise((done, fail) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(stdout)))

const scratchProject = join(root, 'scratch-project')
mkdirSync(scratchProject, { recursive: true })

// A5: 1.45 MB file (under the 1,572,864-byte cap), needle in the last 20KB.
const buildFile = (totalBytes, needleAt, needleLine) => {
  const chunks = []
  let bytes = 0, i = 0
  while (bytes < totalBytes) {
    let line = `line ${i} filler filler filler filler filler filler filler filler\n`
    if (needleAt !== null && bytes < needleAt && bytes + line.length >= needleAt) line = needleLine
    chunks.push(line); bytes += line.length; i++
  }
  return chunks.join('')
}
const A5_TOTAL = 1_450_000
await writeFile(join(scratchProject, 'a5-under-cap.txt'), buildFile(A5_TOTAL, A5_TOTAL - 20_000, 'NEEDLE_A5: the near-tail codeword is BETA-6204\n'))
// A6: 3 MB file (over cap), needle at 2.5MB (beyond the 1,572,864-byte read cap).
await writeFile(join(scratchProject, 'a6-over-cap.txt'), buildFile(3_000_000, 2_500_000, 'NEEDLE_A6: the past-cap codeword is GAMMA-1188\n'))
// A7: 1 MB file with NO needle.
await writeFile(join(scratchProject, 'a7-no-needle.txt'), buildFile(1_000_000, null, ''))
// A8: 1 MB log, exactly 7 distinct "ERROR:" lines at known positions.
{
  const total = 1_000_000
  const errorAt = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map(f => Math.floor(total * f))
  const chunks = []
  let bytes = 0, i = 0, errorsWritten = 0
  while (bytes < total) {
    let line = `noise line ${i} filler filler filler filler\n`
    if (errorsWritten < errorAt.length && bytes >= errorAt[errorsWritten]) { line = `ERROR: distinct-error-${errorsWritten} at line ${i}\n`; errorsWritten++ }
    chunks.push(line); bytes += line.length; i++
  }
  await writeFile(join(scratchProject, 'a8-errors.log'), chunks.join(''))
}
// A14-A16 projects: acceptance-driven local coding tasks.
const a14Project = join(root, 'a14-fail')
mkdirSync(join(a14Project, 'test'), { recursive: true })
await writeFile(join(a14Project, 'package.json'), JSON.stringify({ name: 'a14', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2))
await writeFile(join(a14Project, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } })\n")
await writeFile(join(a14Project, 'src.js'), 'export function add(a, b) { return a + b }\n')
await writeFile(join(a14Project, 'test', 'add.test.ts'), "import { test, expect } from 'vitest'\nimport { add } from '../src.js'\ntest('add is wrong on purpose', () => {\n  expect(add(2, 2)).toBe(5)\n})\n")
if (!existsSync(join(a14Project, 'node_modules'))) await powershell(`New-Item -ItemType Junction -Path '${join(a14Project, 'node_modules')}' -Target '${resolve('node_modules')}' | Out-Null`)

const a15Project = join(root, 'a15-leak-check')
mkdirSync(a15Project, { recursive: true })
await writeFile(join(a15Project, 'README.md'), '# a15 leak check\n')

const a16Project = join(root, 'a16 path with spaces')
mkdirSync(join(a16Project, 'test'), { recursive: true })
await writeFile(join(a16Project, 'package.json'), JSON.stringify({ name: 'a16', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2))
await writeFile(join(a16Project, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } })\n")
await writeFile(join(a16Project, 'src.js'), 'export function double(a) { return a * 2 }\n')
await writeFile(join(a16Project, 'test', 'double.test.ts'), "import { test, expect } from 'vitest'\nimport { double } from '../src.js'\ntest('double works', () => {\n  expect(double(3)).toBe(6)\n})\n")
if (!existsSync(join(a16Project, 'node_modules'))) await powershell(`New-Item -ItemType Junction -Path '${join(a16Project, 'node_modules')}' -Target '${resolve('node_modules')}' | Out-Null`)

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const appLog = join(root, 'app.log')
const fs = await import('node:fs')
const logFd = fs.openSync(appLog, 'a')
const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid, 'root', root)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 500) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out waiting'); await sleep(intervalMs) } }

const HARD_TIMEOUT_MS = 90 * 60_000
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, HARD_TIMEOUT_MS)
try {
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const body = { method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const parsed = await r.json()
    if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(parsed)}`)
    return parsed.result
  }
  const scratchProj = await call('projects.open', { path: scratchProject, name: 'RV1 A limits scratch' })
  const a14Proj = await call('projects.open', { path: a14Project, name: 'RV1 A14' })
  const a15Proj = await call('projects.open', { path: a15Project, name: 'RV1 A15' })
  const a16Proj = await call('projects.open', { path: a16Project, name: 'RV1 A16' })
  await sleep(4000)
  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  const localProvider = catalog.find(p => p.provider === 'local')
  const bigModel = localProvider?.models.find(m => m.id.includes('35b'))?.id ?? localProvider?.models[0]?.id
  console.log('models', { claudeModel, bigModel })

  const before = new Set(await (await import('node:fs/promises')).readdir(tmpdir()).catch(() => []))
  const openTab = async (projectId, title, attempt = 0) => {
    try { return (await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', exactPermission: true, title }, projectId)).resourceId }
    catch (error) { if (attempt < 4 && /did not acknowledge/.test(String(error?.message))) { await sleep(8000); return openTab(projectId, title, attempt + 1) } throw error }
  }
  const tabAuto = await openTab(scratchProj.id, 'A limits Auto')
  const submitAndWait = async (id, prompt, timeoutMs = 60_000) => { await call('agents.submit', { agentSessionId: id, prompt }); await poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, timeoutMs, 1000) }
  await submitAndWait(tabAuto, 'SYNTHETIC LONG 4')
  const { readdir } = await import('node:fs/promises')
  const after = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const created = list.filter(n => n.startsWith('conductor-local-mcp-') && !before.has(n)); return created.length ? created : null }, 30_000).catch(() => null)
  const mcpConfigDir = after ? join(tmpdir(), after[0]) : null
  const cfg = (() => { const file = join(mcpConfigDir, `${tabAuto.replace(/[^a-zA-Z0-9_-]/g, '')}.json`); return readFile(file, 'utf8').then(JSON.parse).then(parsed => { const s = parsed.mcpServers['conductor-local']; return { url: s.url, auth: s.headers.Authorization } }) })()
  const cfgAuto = await cfg
  let rpcId = 0
  const mcpCall = async (c, method, params, timeoutMs = 700_000) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
    try { const r = await fetch(c.url, { method: 'POST', headers: { Authorization: c.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: controller.signal }); return await r.json() } finally { clearTimeout(timer) }
  }
  const toolCall = (c, name, args, timeoutMs) => mcpCall(c, 'tools/call', { name, arguments: args }, timeoutMs).then(r => r.result)
  const textOf = result => result?.content?.[0]?.text ?? ''

  // ---- A3: timeoutSec 5000 must clamp (<=1800), never hold 5000s ----
  {
    const t0 = Date.now()
    const res = await toolCall(cfgAuto, 'run_and_summarize', { command: 'echo clamp-check', timeoutSec: 5000 }, 60_000)
    const elapsed = Date.now() - t0
    record('A3', elapsed < 60_000 ? 'PASS' : 'FAIL', `timeoutSec:5000 -> call returned in ${elapsed}ms (a 5000s hold would still be running); reply: ${textOf(res).slice(0, 200)}`, { elapsedMs: elapsed })
  }

  // ---- A2: 150s-printing command that exits 3; after early return, what does the caller have? ----
  {
    const t0 = Date.now()
    const res = await toolCall(cfgAuto, 'run_and_summarize', { command: 'node -e "let n=0;const t=setInterval(()=>{console.log(\'tick\',n++);if(n>=15)clearInterval(t)},10000);setTimeout(()=>process.exit(3),150000)"' }, 200_000)
    const elapsed = Date.now() - t0
    const text = textOf(res)
    const stillRunning = /still running/i.test(text)
    const logPathMatch = /Log: (\S+)/.exec(text)
    record('A2-early-return', 'INFO', `returned in ${elapsed}ms (default return bound ~120s); stillRunning=${stillRunning}; caller has: ${logPathMatch ? 'a log path (' + logPathMatch[1] + '), no job handle to re-attach -- calling run_and_summarize again starts a NEW process rather than re-checking this one' : 'no log path found in text'}; text=${text.slice(0, 250)}`, { elapsedMs: elapsed })
    if (logPathMatch) {
      await sleep(15_000)
      const logContent = await readFile(join(scratchProject, logPathMatch[1]), 'utf8').catch(error => `(read failed: ${error.message})`)
      record('A2-log-fills', /exit 3|tick/i.test(logContent) || logContent.length > 0 ? 'PASS' : 'FAIL', `log at ${logPathMatch[1]} after waiting: ${logContent.slice(0, 300)}`)
    }
  }

  // ---- A2b: 700s sleeper, confirm killed at the 600s bound (check pid at 610s) ----
  {
    const marker = `rv1-a2b-${Date.now()}`
    const t0 = Date.now()
    const resPromise = toolCall(cfgAuto, 'run_and_summarize', { command: `node -e "console.log('${marker}');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),700000)"` }, 650_000)
    await sleep(610_000 - (Date.now() - t0))
    const alive = await powershell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId`).catch(() => '')
    const res = await resPromise
    const elapsed = Date.now() - t0
    record('A2-kill-bound', !alive.trim() ? 'PASS' : 'FAIL', `at ~610s, orphan pids matching marker: "${alive.trim()}"; call itself returned/settled at ${elapsed}ms: ${textOf(res).slice(0, 200)}`, { elapsedMs: elapsed })
  }

  // ---- A5: 1.45MB file, needle in last 20KB (under the 1,572,864-byte cap) ----
  {
    const res = await toolCall(cfgAuto, 'local_ask', { prompt: 'Find the exact codeword after "the near-tail codeword is" and reply with just it, or say plainly if the file was truncated before reaching it.', files: ['a5-under-cap.txt'] })
    const t = textOf(res)
    const found = /BETA-6204/.test(t)
    const honestTruncation = /truncat/i.test(t)
    record('A5', found || honestTruncation ? 'PASS' : 'FAIL', `found=${found}, said truncated=${honestTruncation}: ${t.slice(0, 250)}`)
  }
  // ---- A6: 3MB file, needle at 2.5MB (past the cap) ----
  {
    const res = await toolCall(cfgAuto, 'local_ask', { prompt: 'Find the exact codeword after "the past-cap codeword is" and reply with just it, or say plainly if the file was truncated before reaching it.', files: ['a6-over-cap.txt'] })
    const t = textOf(res)
    const invented = /GAMMA-1188/.test(t)
    const honestTruncation = /truncat/i.test(t)
    record('A6', !invented && honestTruncation ? 'PASS' : (invented ? 'FAIL' : 'INFO'), `invented codeword despite being past cap=${invented}, said truncated=${honestTruncation}: ${t.slice(0, 250)}`)
  }
  // ---- A7: 1MB file, NO needle -- must not invent NEEDLE-XYZ ----
  {
    const res = await toolCall(cfgAuto, 'local_ask', { prompt: 'Quote the exact line containing NEEDLE-XYZ.', files: ['a7-no-needle.txt'] })
    const t = textOf(res)
    const invented = /NEEDLE-XYZ.{0,40}(filler|line \d)/i.test(t) && !/not found|no such|does not (appear|contain)|cannot find/i.test(t)
    const saidNotFound = /not found|no such|does not (appear|contain)|cannot find/i.test(t)
    record('A7', saidNotFound && !invented ? 'PASS' : 'FAIL', `said not found=${saidNotFound}, looks invented=${invented}: ${t.slice(0, 250)}`)
  }
  // ---- A8: exactly 7 ERROR: lines, aggregation across the file ----
  {
    const res = await toolCall(cfgAuto, 'local_ask', { prompt: 'How many lines contain "ERROR:" in this file, and what are their line numbers (1-based)? Answer with the count first.', files: ['a8-errors.log'] })
    const t = textOf(res)
    const sevenMentioned = /\b7\b/.test(t)
    record('A8', sevenMentioned ? 'PASS' : 'FAIL', `correct count (7) mentioned=${sevenMentioned}: ${t.slice(0, 400)}`)
  }

  // ---- A14: local coding, acceptance npx vitest run, a test that genuinely fails ----
  {
    const tabId = await openTab(a14Proj.id, 'A14 coding')
    await call('agents.submit', { agentSessionId: tabId, prompt: 'Make sure the tests pass. Run `npx vitest run test/add.test.ts` as your acceptance check and report the result honestly, even if it fails.' })
    const status = await poll(async () => { const s = await call('agents.status', { agentSessionId: tabId }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 20 * 60_000, 3000)
    const transcript = await call('agents.transcript', { agentSessionId: tabId }).catch(() => null)
    const text = JSON.stringify(transcript ?? status).toLowerCase()
    const reportsFailure = text.includes('fail') && (text.includes('expected') || text.includes('tobe'))
    record('A14', reportsFailure ? 'PASS' : 'INFO', `phase=${status.phase}; transcript mentions a failing assertion=${reportsFailure}`)
  }
  // ---- A15: acceptance command also writes LEAK.txt before vitest; must not appear in the real tree ----
  {
    const tabId = await openTab(a15Proj.id, 'A15 leak')
    await call('agents.submit', { agentSessionId: tabId, prompt: 'Run this exact acceptance command in this project and report the output: `node -e "require(\'fs\').writeFileSync(\'LEAK.txt\',\'leaked\')" && echo done`' })
    await poll(async () => { const s = await call('agents.status', { agentSessionId: tabId }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 10 * 60_000, 3000)
    const leaked = existsSync(join(a15Project, 'LEAK.txt'))
    record('A15', leaked ? 'FAIL' : 'PASS', `LEAK.txt present in the real project tree=${leaked}`)
  }
  // ---- A16: same shape as A14 but a project path with spaces ----
  {
    const tabId = await openTab(a16Proj.id, 'A16 spaces')
    await call('agents.submit', { agentSessionId: tabId, prompt: 'Confirm the tests pass. Run `npx vitest run test/double.test.ts` as your acceptance check.' })
    const status = await poll(async () => { const s = await call('agents.status', { agentSessionId: tabId }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 20 * 60_000, 3000)
    record('A16', status.phase === 'completed' ? 'PASS' : 'FAIL', `project path with spaces (${a16Project}): phase=${status.phase}`)
  }
} catch (error) {
  record('A-limits-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1800))
} finally {
  clearTimeout(watchdog)
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 'a-limits-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== A LIMITS SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
  console.log('root kept at', root)
}
