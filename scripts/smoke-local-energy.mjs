// FX31 local model energy (3477066e): one real local turn in a parked Conductor shows its energy.
// The turn runs on the llama.cpp server this machine already runs for the model (one server at a
// time; a running server is used as it is and never stopped here). Passes when the turn's energy
// notice carries a measured, non-zero Wh from nvidia-smi and the timeline shows it; on a machine
// without nvidia-smi it must say "not measured" with no number, which --expect-unmeasured checks.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-local-energy.mjs [--build] [--model local/dolphin-x1-8b]
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

const argv = process.argv.slice(2)
const flag = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback }
const model = flag('model', 'local/dolphin-x1-8b')
const expectUnmeasured = argv.includes('--expect-unmeasured')
if (argv.includes('--build')) {
  const built = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0) throw new Error('electron-vite build failed')
}
const output = resolve('artifacts/local-energy')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-energy-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Scratch project for the energy smoke\n')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const sleep = ms => new Promise(done => setTimeout(done, ms))
const poll = async (read, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const value = await read(); if (value) return value; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
const killElectron = () => { try { const pid = app.process().pid; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else app.process().kill('SIGKILL') } catch { /* already gone */ } }
const watchdog = setTimeout(() => { console.error('FAIL smoke-local-energy exceeded 8 min'); killElectron(); process.exit(1) }, 8 * 60_000)
watchdog.unref()
const checks = []
const check = label => { checks.push(label); console.log('PASS ' + label) }
let failed = false
try {
  const page = await app.firstWindow()
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 90_000)
  const call = async (method, args = {}, projectId) => {
    const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }), signal: AbortSignal.timeout(60_000) })
    const body = await response.json(); if (response.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const servers = await call('local.servers').catch(() => null)
  console.log('local servers:', JSON.stringify(servers))
  const project = await call('projects.open', { path: projectPath, name: 'Energy smoke' })
  const open = { kind: 'agent', provider: 'local', model, permission: 'accept-edits', exactPermission: true, title: 'Energy smoke' }
  const tab = await call('tabs.open', open, project.id).catch(async error => {
    if (!/did not acknowledge/.test(String(error))) throw error
    await sleep(10_000)
    return call('tabs.open', open, project.id)
  }).then(result => result.resourceId)
  const projection = () => {
    const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
    try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(tab).projection_json) } finally { db.close() }
  }
  const started = Date.now()
  await call('agents.submit', { agentSessionId: tab, prompt: 'In two or three sentences, explain why the sky is blue. Do not use any tools.' })
  const status = await poll(async () => {
    const current = await call('agents.status', { agentSessionId: tab })
    const users = (projection().items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user').length
    return ['completed', 'failed', 'interrupted', 'idle'].includes(current.phase) && Date.now() - started > 3000 && users > 0 ? current : null
  }, 6 * 60_000, 2000)
  const items = (projection().items ?? []).map(item => item.data).filter(Boolean)
  await writeFile(join(output, 'projection.json'), JSON.stringify(items, null, 2))
  const answer = items.filter(item => item.type === 'text' && item.role === 'assistant').map(item => item.text).join('')
  console.log(`turn ${status.phase} in ${Math.round((Date.now() - started) / 1000)} s: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`)
  const energy = items.find(item => item.type === 'notice' && item.payload?.localEnergy)?.payload.localEnergy
  assert.ok(energy, 'the turn must end with a local energy notice')
  console.log('energy:', JSON.stringify(energy))
  if (expectUnmeasured) {
    assert.equal(energy.measured, false)
    assert.equal(energy.totalWh, undefined)
    check(`Without nvidia-smi the turn says not measured: ${energy.reason}`)
  } else {
    assert.equal(energy.measured, true, `expected a measured reading, got: ${energy.reason}`)
    assert.ok(energy.gpuWh > 0 && energy.totalWh > energy.gpuWh, 'GPU Wh measured and a system estimate added')
    assert.ok(energy.samples > 0 && energy.averageGpuWatts > 0)
    check(`A real ${model} turn measured ${energy.totalWh.toFixed(3)} Wh (GPU ${energy.gpuWh.toFixed(3)} Wh at ${Math.round(energy.averageGpuWatts)} W avg, ${energy.samples} samples, ${(energy.durationMs / 1000).toFixed(1)} s)`)
  }
  // The timeline shows it where the turn's other figures are.
  const card = page.locator(`.sa-local-energy[data-energy="${expectUnmeasured ? 'unmeasured' : 'measured'}"]`).first()
  await card.waitFor({ state: 'attached', timeout: 30_000 })
  const text = (await card.textContent()) ?? ''
  console.log('timeline:', text)
  if (!expectUnmeasured) assert.match(text, /Wh .*this turn/)
  await card.scrollIntoViewIfNeeded().catch(() => {})
  await page.screenshot({ path: join(output, 'timeline.png') }).catch(() => {})
  check('The timeline shows the turn\'s energy line')
  // No sampler outlives the turn.
  await sleep(2000)
  const smi = spawnSync('tasklist', ['/FI', 'IMAGENAME eq nvidia-smi.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout ?? ''
  console.log('nvidia-smi processes after the turn:', smi.includes('nvidia-smi.exe') ? smi.trim() : 'none')
} catch (error) {
  failed = true
  console.error('FAIL', error?.stack ?? error)
} finally {
  killElectron()
  await writeFile(join(output, 'result.json'), JSON.stringify({ at: new Date().toISOString(), model, checks, pass: !failed }, null, 2))
  console.log(failed ? 'FAIL' : `PASS ${checks.length} checks`, output)
  process.exit(failed ? 1 : 0)
}
