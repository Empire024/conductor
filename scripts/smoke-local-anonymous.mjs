// FX34 local-anonymous-mode: a real anonymous local conversation in a parked Conductor leaves no
// trace. One anonymous and one ordinary tab (the control) each run a real turn on the llama.cpp
// server this machine already runs (one server at a time; a running server is used as it is and
// never stopped here); each writes a workspace file and answers with its own unique marker. Then
// the anonymous tab is closed, Conductor quits and relaunches on the same profile, and every file
// under the profile plus the local model logs and runtime directory is scanned for both markers.
// Passes when the anonymous marker is found nowhere (its workspace file excepted: files stay), the
// control marker is found in the database, the anonymous tab is not restored and the ordinary one is.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-local-anonymous.mjs [--build] [--model local/dolphin-x1-8b]
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

const argv = process.argv.slice(2)
const flag = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback }
const model = flag('model', 'local/dolphin-x1-8b')
if (argv.includes('--build')) {
  const built = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0) throw new Error('electron-vite build failed')
}
const output = resolve('artifacts/local-anonymous')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-anonymous-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Scratch project for the anonymous smoke\n')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const sleep = ms => new Promise(done => setTimeout(done, ms))
const poll = async (read, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const value = await read(); if (value) return value; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const anonMarker = 'ANONZ' + randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()
const keptMarker = 'KEPTZ' + randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()
const { layoutFor, readPointer } = await import('../src/main/local-models/paths.ts')
const localLayout = layoutFor(readPointer())
const since = Date.now()

let app
const killElectron = () => { try { const pid = app.process().pid; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else app.process().kill('SIGKILL') } catch { /* already gone */ } }
const watchdog = setTimeout(() => { console.error('FAIL smoke-local-anonymous exceeded 15 min'); killElectron(); process.exit(1) }, 15 * 60_000)
watchdog.unref()
const checks = []
const check = label => { checks.push(label); console.log('PASS ' + label) }
let failed = false

const launch = async () => {
  await rm(join(profile, 'control-owner.json'), { force: true })
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  const page = await app.firstWindow()
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 90_000)
  const call = async (method, args = {}, projectId) => {
    const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }), signal: AbortSignal.timeout(60_000) })
    const body = await response.json(); if (response.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  return { page, call }
}
/** Graceful quit, so every normal flush on exit runs; force only if it hangs. */
const quit = async () => {
  await Promise.race([app.close(), sleep(30_000).then(() => { throw new Error('quit timed out') })]).catch(error => { console.log('quit:', error.message); killElectron() })
}
async function filesUnder(directory, newerThan = 0) {
  if (!existsSync(directory)) return []
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await filesUnder(path, newerThan))
    else if (entry.isFile() && (!newerThan || (await stat(path)).mtimeMs >= newerThan)) found.push(path)
  }
  return found
}
async function carriers(files, marker) {
  const hits = []
  for (const path of files) {
    let bytes
    try { bytes = await readFile(path) } catch { continue }
    if (bytes.includes(Buffer.from(marker, 'utf8')) || bytes.includes(Buffer.from(marker, 'utf16le'))) hits.push(path)
  }
  return hits
}

const report = { at: new Date().toISOString(), model, anonMarker, keptMarker }
try {
  let { page, call } = await launch()
  report.servers = await call('local.servers').catch(() => null)
  console.log('local servers:', JSON.stringify(report.servers))
  const project = await call('projects.open', { path: projectPath, name: 'Anonymous smoke' })
  await page.locator('.project-row').filter({ hasText: 'Anonymous smoke' }).first().click().catch(error => console.log('project row:', error.message))
  // The option is offered, with the warning, before the owner opens anything.
  const option = page.locator('.launcher-anonymous').first()
  await option.waitFor({ state: 'attached', timeout: 30_000 })
  await option.locator('input').check()
  const warning = (await option.textContent()) ?? ''
  assert.match(warning, /not restored after a restart/)
  assert.match(warning, /Files it writes stay/)
  check('The launcher offers anonymous mode and says it is gone on close and not restored after a restart')
  await page.screenshot({ path: join(output, 'launcher.png') }).catch(() => {})

  const open = async (anonymous) => {
    const args = { kind: 'agent', provider: 'local', model, permission: 'accept-edits', exactPermission: true, title: anonymous ? 'Anonymous · smoke' : 'Kept · smoke', ...(anonymous ? { anonymous: true } : {}) }
    return call('tabs.open', args, project.id).catch(async error => {
      if (!/did not acknowledge/.test(String(error))) throw error
      await sleep(10_000)
      return call('tabs.open', args, project.id)
    })
  }
  const anonTab = await open(true), keptTab = await open(false)
  report.tabs = { anonymous: anonTab.resourceId, kept: keptTab.resourceId }
  const prompt = marker => `Use the write_file tool once to create the file note-${marker.slice(0, 5).toLowerCase()}.txt containing exactly: ${marker}\nThen reply with exactly this code and nothing else: ${marker}`
  const turn = async (tab, marker) => {
    const started = Date.now()
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt: prompt(marker) })
    const status = await poll(async () => {
      const current = await call('agents.status', { agentSessionId: tab.resourceId })
      return ['completed', 'failed', 'interrupted', 'idle'].includes(current.phase) && Date.now() - started > 3000 ? current : null
    }, 6 * 60_000, 2000)
    const snapshot = await call('agents.snapshot', { agentSessionId: tab.resourceId })
    const answer = (snapshot.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('')
    return { phase: status.phase, seconds: Math.round((Date.now() - started) / 1000), answer: answer.replace(/\s+/g, ' ').slice(0, 300), tools: (snapshot.items ?? []).filter(item => item.data?.type === 'tool').map(item => `${item.data.name}:${item.data.status}`) }
  }
  report.anonymousTurn = await turn(anonTab, anonMarker)
  console.log('anonymous turn:', JSON.stringify(report.anonymousTurn))
  report.keptTurn = await turn(keptTab, keptMarker)
  console.log('kept turn:', JSON.stringify(report.keptTurn))
  assert.equal(report.anonymousTurn.phase, 'completed')
  assert.ok(report.anonymousTurn.answer.includes(anonMarker), 'the anonymous answer carries its marker, so there was something to leak')
  check(`A real anonymous ${model} turn completed in ${report.anonymousTurn.seconds} s and answered with its marker (tools: ${report.anonymousTurn.tools.join(', ') || 'none'})`)

  // Visible markers on the tab and in the composer.
  await call('tabs.focus', { tabId: anonTab.id }, project.id).catch(error => console.log('tabs.focus:', error.message))
  await page.locator('.pane-tab-anonymous').first().waitFor({ state: 'attached', timeout: 20_000 })
  await page.locator('.sa-anonymous-mark').first().waitFor({ state: 'attached', timeout: 20_000 })
  await page.screenshot({ path: join(output, 'anonymous-tab.png') }).catch(() => {})
  check('The anonymous tab and its composer show the Anonymous marker')

  // While it is open: nothing in the database carries it.
  {
    const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM structured_sessions WHERE id = ?').get(anonTab.resourceId).n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?').get(anonTab.resourceId).n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM structured_sessions WHERE id = ?').get(keptTab.resourceId).n, 1)
      assert.ok(!db.prepare('SELECT layout_json FROM sessions').all().some(row => row.layout_json.includes(anonTab.resourceId)), 'the saved layout leaves the anonymous tab out')
    } finally { db.close() }
  }
  check('While open, the anonymous conversation has no database row and no saved-layout entry; the ordinary one has both')

  // Close it: it is gone for good.
  await call('agents.finish', { agentSessionId: anonTab.resourceId }, project.id)
  await poll(async () => { try { await call('agents.snapshot', { agentSessionId: anonTab.resourceId }); return false } catch { return true } }, 30_000)
  const serversAfter = await call('local.servers').catch(() => [])
  assert.ok(!JSON.stringify(serversAfter).includes(anonTab.resourceId), 'the model server no longer lists it')
  check('Closing the anonymous tab forgets the conversation: it cannot be read and no server lists it')

  await quit()
  // Restart on the same profile.
  ;({ page, call } = await launch())
  const listed = await call('agents.list', {}, project.id).catch(() => [])
  report.afterRestart = listed.map(entry => ({ agentSessionId: entry.agentSessionId, title: entry.title }))
  assert.ok(!listed.some(entry => entry.agentSessionId === anonTab.resourceId), 'the anonymous tab is not restored')
  assert.ok(listed.some(entry => entry.agentSessionId === keptTab.resourceId), 'the ordinary tab is restored')
  check('After a restart the ordinary tab is back and the anonymous one is not')
  await quit()

  // The scan: the profile, and whatever the local model runtime wrote during this run.
  const profileFiles = await filesUnder(profile)
  const localFiles = [...await filesUnder(localLayout.logs, since), ...await filesUnder(localLayout.runtime, since)]
  const workspaceFiles = await filesUnder(projectPath)
  report.scanned = { profileFiles: profileFiles.length, localFiles: localFiles.length }
  report.anonymousCarriers = await carriers([...profileFiles, ...localFiles], anonMarker)
  report.keptCarriers = await carriers([...profileFiles, ...localFiles], keptMarker)
  report.workspaceAnonymousFiles = await carriers(workspaceFiles, anonMarker)
  console.log('scan:', JSON.stringify({ scanned: report.scanned, anonymousCarriers: report.anonymousCarriers, keptCarriers: report.keptCarriers, workspaceAnonymousFiles: report.workspaceAnonymousFiles }, null, 1))
  assert.deepEqual(report.anonymousCarriers, [], 'no file under the profile or the local runtime carries the anonymous marker')
  check(`No trace of the anonymous conversation in ${profileFiles.length} profile files and ${localFiles.length} local runtime files`)
  assert.ok(report.keptCarriers.some(path => /conductor\.db/.test(path)), 'control: the ordinary conversation is in the database')
  check(`Control: the ordinary conversation's marker is found (${report.keptCarriers.map(path => path.slice(profile.length + 1)).join(', ')})`)
  if (report.workspaceAnonymousFiles.length) check(`The file the anonymous model wrote stays in the workspace (${report.workspaceAnonymousFiles.map(path => path.slice(projectPath.length + 1)).join(', ')})`)
  else console.log('NOTE the anonymous model did not write its file this run (tools: ' + report.anonymousTurn.tools.join(', ') + ')')
} catch (error) {
  failed = true
  console.error('FAIL', error?.stack ?? error)
} finally {
  killElectron()
  await writeFile(join(output, 'result.json'), JSON.stringify({ ...report, checks, pass: !failed }, null, 2))
  console.log(failed ? 'FAIL' : `PASS ${checks.length} checks`, output)
  process.exit(failed ? 1 : 0)
}
