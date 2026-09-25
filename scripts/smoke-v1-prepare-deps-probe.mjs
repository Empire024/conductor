// V1 verify S13b: prepare-deps is only ever an explicit owner CLI action, never triggered
// silently. Docker's sandbox image is already present on this machine (checked by the caller).
// A temp project with a package.json + package-lock.json that declare ZERO dependencies, so the
// container step is fast and installs nothing real; run `npm run local -- prepare-deps` through
// run_and_summarize (Auto fixture conversation, cwd = checkout) and record what happened.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-prepare-deps-probe.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s13b-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const zeroDepsDir = join(root, 'zero-deps')
await mkdir(zeroDepsDir, { recursive: true })
await writeFile(join(zeroDepsDir, 'package.json'), JSON.stringify({ name: 'zero-deps', version: '1.0.0', dependencies: {} }, null, 2))
await writeFile(join(zeroDepsDir, 'package-lock.json'), JSON.stringify({ name: 'zero-deps', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'zero-deps', version: '1.0.0' } } }, null, 2))

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

try {
  const before = execFileSync('docker', ['volume', 'ls'], { encoding: 'utf8' })
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const parsed = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(parsed)}`); return parsed.result
  }
  const proj = await call('projects.open', { path: resolve('.'), name: 'V1 S13b checkout' })
  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  // The --mcp-config directory is minted the moment the session is first `ensure`d, at tabs.open
  // time, not at first submit -- so the tmpdir snapshot must be taken BEFORE tabs.open.
  const beforeDirs = new Set(await readdir(tmpdir()).catch(() => []))
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission: 'auto', exactPermission: true, title: 'S13b' }, proj.id).then(r => r.resourceId)
  await call('agents.submit', { agentSessionId: tab, prompt: 'SYNTHETIC LONG 4' })
  await poll(async () => { const s = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 30_000)
  const created = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const c = list.filter(n => n.startsWith('conductor-local-mcp-') && !beforeDirs.has(n)); return c.length ? c : null }, 60_000)
  const cfgFile = join(tmpdir(), created[0], `${tab.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  const parsed = JSON.parse(await readFile(cfgFile, 'utf8'))
  const server = parsed.mcpServers['conductor-local']

  const rpc = async (method, params) => { const r = await fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return r.json() }
  const res = await rpc('tools/call', { name: 'run_and_summarize', arguments: { command: `npm run local -- prepare-deps --cwd "${zeroDepsDir}"`, timeoutSec: 300 } })
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res)
  record('S13b-command', 'INFO', text.slice(0, 800))

  const after = execFileSync('docker', ['volume', 'ls'], { encoding: 'utf8' })
  const newVolumes = after.split('\n').filter(l => !before.includes(l) && l.includes('conductor-linux-deps-'))
  record('S13b', 'INFO', `new conductor-linux-deps-* volumes after explicit CLI call: ${JSON.stringify(newVolumes)}`)
  await writeFile(join(output, 's13b-output.txt'), text)
} catch (error) {
  record('S13b', 'FAIL', String(error?.stack ?? error))
} finally {
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's13b-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S13b SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
