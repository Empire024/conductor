// RV1 E4 (decisive): a REAL Claude tab (haiku, cheapest) in a parked instance streaming a long
// count; 5 agents.steer messages sent while it streams, then app.restart({force:true}) ~1s later.
// PASS: turn completes, each ack-N answered exactly once in order, waitingPrompts 0, phase settles.
// 2 runs. Adapted from scripts/smoke-v1-real-sonnet.mjs's real-Claude harness (not edited here).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-e4-real-claude-steer-restart.mjs
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const output = resolve('artifacts/verification/2026-09-25-rv1/E')
await mkdir(output, { recursive: true })
const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }

async function runOnce(label) {
  const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-e4-'))
  const profile = join(root, 'profile'), projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(projectPath, 'README.md'), '# rv1 e4\n')
  const env = { ...process.env, CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
  const fs = await import('node:fs')
  const logFd = fs.openSync(join(root, 'app.log'), 'a')
  let child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
  console.log(label, 'launched pid', child.pid, 'root', root)
  try {
    let owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
    let projectId
    const call = async (method, args = {}) => {
      const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
      const parsed = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(parsed)}`); return parsed.result
    }
    projectId = (await call('projects.open', { path: projectPath, name: `RV1 E4 ${label}` })).id
    await sleep(5000) // let the renderer mount the new project's workspace before the first tabs.open IPC round trip
    const catalog = await call('models.list')
    const haiku = catalog.find(p => p.provider === 'claude')?.models.find(m => /haiku/i.test(m.id))?.id ?? catalog.find(p => p.provider === 'claude')?.models[0]?.id
    const openTab = async (attempt = 0) => {
      try { return (await call('tabs.open', { kind: 'agent', provider: 'claude', model: haiku, permission: 'auto', exactPermission: true, title: 'E4 real' })).resourceId }
      catch (error) { if (attempt < 5 && /did not acknowledge/.test(String(error?.message))) { await sleep(8000); return openTab(attempt + 1) } throw error }
    }
    const tabId = await openTab()
    await poll(async () => { const list = await call('agents.list'); return (list ?? []).some(a => a.agentSessionId === tabId) ? true : null }, 20_000, 500).catch(() => {})
    await call('agents.submit', { agentSessionId: tabId, prompt: 'Count from 1 to 400, one number per line, no other text.' })
    // Wait until streaming has genuinely started (some content already produced) before steering.
    await poll(async () => { const s = await call('agents.status', { agentSessionId: tabId }); return s.phase === 'running' ? s : null }, 30_000, 500).catch(() => {})
    await sleep(1500)
    for (let i = 1; i <= 5; i++) await call('agents.steer', { agentSessionId: tabId, prompt: `reply with exactly: ack-${i}` })
    await sleep(1000)
    const restartResult = await call('app.restart', { force: true }).catch(error => ({ error: String(error?.message ?? error) }))
    console.log(label, 'restart requested', restartResult)
    // Reattach: control-owner.json is rewritten on relaunch.
    await sleep(3000)
    owner = await poll(async () => { try { const o = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return o } catch { return null } }, 90_000)
    const final = await poll(async () => { const s = await call('agents.status', { agentSessionId: tabId }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 5 * 60_000, 2000)
    const history = await call('agents.history', { agentSessionId: tabId }).catch(() => null)
    const text = JSON.stringify(history ?? '')
    const acks = [1, 2, 3, 4, 5].map(n => (text.match(new RegExp(`ack-${n}`, 'g')) ?? []).length)
    const eachExactlyOnce = acks.every(c => c === 1)
    const inOrder = (() => { const idxs = [1, 2, 3, 4, 5].map(n => text.indexOf(`ack-${n}`)); return idxs.every((v, i) => i === 0 || v === -1 || idxs[i - 1] === -1 || v > idxs[i - 1]) })()
    const has400 = text.includes('\n400') || text.includes(' 400') || /\b400\b/.test(text)
    const waiting = await call('agents.status', { agentSessionId: tabId }).then(s => s.waitingPrompts ?? 0).catch(() => 'n/a')
    record(`E4-${label}`, final.phase === 'completed' && eachExactlyOnce && inOrder && waiting === 0 ? 'PASS' : 'FAIL',
      `phase=${final.phase}; ack counts=${JSON.stringify(acks)} (each exactly once=${eachExactlyOnce}); in order=${inOrder}; reached ~400=${has400}; waitingPrompts=${waiting}`)
  } catch (error) {
    record(`E4-${label}`, 'FAIL', String(error?.stack ?? error).slice(0, 1500))
  } finally {
    try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
}

const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 30 * 60_000)
await runOnce('run1')
await runOnce('run2')
clearTimeout(watchdog)
await writeFile(join(output, 'e4-results.json'), JSON.stringify(results, null, 2))
console.log('\n=== E4 SUMMARY ===')
for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
