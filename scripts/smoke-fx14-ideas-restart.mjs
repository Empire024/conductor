// FX14 (RV1 C10): after an Ideas explore, app.restart({force:true}) answered restarting:true but no
// relaunched instance appeared within 120 s. RV1 ran it on a Playwright-launched app, while every
// restart smoke that passes spawns Electron itself. This separates the two: it launches the app
// either way, optionally runs a real light ideas.explore on whatever local model is loaded (a
// durable job; never starts or stops a model server itself), then restarts and records whether the
// old process exited and whether a new one wrote its credential.
// Finding (2026-09-25): spawn relaunches in about 1 s with or without an explore, and the idea
// survives. --launcher=playwright never relaunches, even with no explore: Playwright starts Electron
// with `-r .../electron/loader.js --inspect=0`, the loader withholds `ready` until Playwright calls
// __playwright_run, and app.relaunch() reuses that command line, so the new instance waits forever
// for a Playwright that is not attached (the test-mode watchdog ends it with its launcher). Restart
// smokes must spawn Electron themselves, as smoke-v3-s12-restart.mjs does.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx14-ideas-restart.mjs --launcher=spawn|playwright [--explore]
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const launcher = process.argv.find(arg => arg.startsWith('--launcher='))?.slice(11) ?? 'spawn'
const explore = process.argv.includes('--explore')
const root = await mkdtemp(join(tmpdir(), 'conductor-fx14-ideas-restart-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
const output = resolve('artifacts/fx14')
await mkdir(projectPath, { recursive: true }); await mkdir(output, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# fx14 ideas restart\n')
const observe = (label, data = {}) => console.log(`[${new Date().toISOString()}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`)

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS; delete env.CONDUCTOR_TEST_PARENT_PID

let owner, projectId, app
const readOwner = async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }
const call = async (method, args = {}) => {
  const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${r.status} ${JSON.stringify(body)}`); return body.result
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const summary = { launcher, explore, root }
const pids = new Set()
const watchdog = setTimeout(() => { observe('watchdog: giving up'); process.exit(1) }, 25 * 60_000)
let failed = null
try {
  if (launcher === 'playwright') {
    app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
    await app.firstWindow()
  } else {
    const log = openSync(join(root, 'app.log'), 'a')
    const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
    closeSync(log)
    pids.add(child.pid)
  }
  await expect.poll(async () => { owner = await readOwner(); return Boolean(owner?.pid && alive(owner.pid)) }, { timeout: 60_000, intervals: [500] }).toBe(true)
  pids.add(owner.pid)
  projectId = (await call('projects.open', { path: projectPath, name: 'FX14 ideas restart' })).id
  observe('app up', { pid: owner.pid })

  if (explore) {
    const idea = await call('ideas.capture', { text: 'FX14 restart after explore: a tiny idea to explore lightly' })
    const started = await call('ideas.explore', { ideaId: idea.id, intensity: 'light' }).catch(error => ({ error: String(error?.message ?? error) }))
    observe('explore', started)
    summary.explore = started
    if (started?.jobId) {
      const t0 = Date.now()
      await expect.poll(async () => (await call('jobs.status', { jobId: started.jobId })).status, { timeout: 12 * 60_000, intervals: [3000] }).toMatch(/^(completed|blocked|failed|stopped|cancelled)$/).catch(() => {})
      summary.jobStatus = (await call('jobs.status', { jobId: started.jobId }).catch(error => ({ error: String(error) })))?.status
      summary.jobSeconds = Math.round((Date.now() - t0) / 1000)
      observe('explore job settled', { status: summary.jobStatus, seconds: summary.jobSeconds })
    }
  }

  const before = await call('app.state').catch(() => null)
  summary.pendingBefore = before?.pendingQuitConfirmation ?? null
  const oldPid = owner.pid
  const t0 = Date.now()
  summary.reply = await call('app.restart', { force: true })
  observe('app.restart', summary.reply)
  const exited = await expect.poll(() => !alive(oldPid), { timeout: 60_000, intervals: [250] }).toBe(true).then(() => true, () => false)
  summary.oldExitedSeconds = exited ? (Date.now() - t0) / 1000 : null
  observe(exited ? 'old instance exited' : 'old instance STILL ALIVE after 60 s', { oldPid })
  const next = await expect.poll(async () => { const o = await readOwner(); return o && o.pid !== oldPid && alive(o.pid) ? o.pid : null }, { timeout: 90_000, intervals: [500] }).not.toBe(null).then(() => true, () => false)
  summary.relaunchSeconds = next ? (Date.now() - t0) / 1000 : null
  if (next) { owner = await readOwner(); pids.add(owner.pid); observe('relaunched', { pid: owner.pid, seconds: summary.relaunchSeconds }) }
  else throw new Error(`no relaunched instance within 90 s (old instance exited: ${exited})`)
  const ideas = await call('ideas.list', {})
  summary.ideasAfter = ideas.length
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
  try { summary.mainErrors = (await readFile(join(profile, 'main-errors.log'), 'utf8')).slice(-3000) } catch {}
  try { summary.appLog = (await readFile(join(root, 'app.log'), 'utf8')).slice(-3000) } catch {}
} finally {
  clearTimeout(watchdog)
  if (app) await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 10_000))])
  for (const pid of new Set([...pids, owner?.pid])) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary }
await writeFile(join(output, `ideas-restart-${launcher}${explore ? '-explore' : ''}.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
process.exit(failed ? 1 : 0)
