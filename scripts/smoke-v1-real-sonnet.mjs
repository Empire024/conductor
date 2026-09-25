// V1 verify S12: one short REAL Claude Sonnet session (not a fixture) in a parked instance, Auto
// permission, to see whether it reaches for mcp__conductor-local__run_and_summarize on its own
// (per the local-assist briefing) or just runs vitest with its own Bash tool. Also confirms a
// Codex fixture thread receives the conductor-local server in its thread config.
// Runs against a disposable git worktree, never the live checkout, so a real agent turn cannot
// touch tracked files.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-real-sonnet.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s12-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const worktree = join(root, 'worktree')
const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

const powershell = script => new Promise((done, fail) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(stdout)))

execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: resolve('.'), stdio: 'inherit' })
if (!existsSync(join(worktree, 'node_modules'))) await powershell(`New-Item -ItemType Junction -Path '${join(worktree, 'node_modules')}' -Target '${resolve('node_modules')}' | Out-Null`)

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1000) => {
  const started = Date.now()
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) }
}

try {
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const parsed = await r.json()
    if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(parsed)}`)
    return parsed.result
  }
  const proj = await call('projects.open', { path: worktree, name: 'V1 S12 worktree' })
  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', title: 'S12 real' }, proj.id).then(r => r.resourceId)
  console.log('tab open, submitting real prompt (spends real tokens)...')
  const t0 = Date.now()
  await call('agents.submit', { agentSessionId: tab, prompt: 'Run the tests in src/shared/usage-accounting.test.ts and tell me if anything fails.' })
  const status = await poll(async () => { const s = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 300_000, 2000)
  const elapsed = Date.now() - t0
  const events = call('agents.events', { agentSessionId: tab }).catch(() => null)
  const snapshot = await call('agents.status', { agentSessionId: tab }).catch(() => null)
  const usedLocalAssist = JSON.stringify(status).includes('conductor-local') || JSON.stringify(status).includes('run_and_summarize')
  record('S12', 'INFO', `phase=${status.phase} elapsedMs=${elapsed} usedLocalAssistTool(shallow check)=${usedLocalAssist} usage=${JSON.stringify(status.usage ?? snapshot?.usage ?? '(n/a)')}`)
  await writeFile(join(output, 's12-status.json'), JSON.stringify({ status, snapshot }, null, 2))
} catch (error) {
  record('S12', 'FAIL', String(error?.stack ?? error))
} finally {
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: resolve('.'), stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's12-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S12 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
