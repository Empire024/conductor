import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// End-to-end check of the Cloud coworker (docs/cloud-coworker.md) in the built app, parked
// off-screen under CONDUCTOR_TEST_USER_DATA and driven as the owner through control-owner.json.
//
//   node scripts/smoke-cloud-coworker.mjs      fixture client (scripts/fixtures/cloud-cli.cjs), no
//        cloud session is created: a temp project whose origin is a bare local repository.
//        tabs.open({provider:"cloud"}) creates the "session"; the CLI's attach gate refuses a live
//        view (as on the owner's account), so cloud.send is refused with the reason; the smoke then
//        pushes the session's branch and a pull request ref to origin, and the run must find them,
//        pull its transcript (teleport), fetch the branch into a worktree from the tab's button,
//        and stop. Also router.dispatch with provider "cloud", the launcher's Claude Cloud form
//        and a renderer reload.
//   node scripts/smoke-cloud-coworker.mjs --real [--model=claude-opus-5-5] [--wait-min=25]
//        ONE real cloud session (spends cloud credit) on this repository, started with
//        tabs.open({provider:"cloud"}) from a detached worktree of this checkout, followed until
//        it pushes, its transcript pulled, its branch fetched. Profile kept under
//        .conductor-scratch/cloud/real-profile-<time>.
//   node scripts/smoke-cloud-coworker.mjs --real --resume=<profile dir> --run=<runId>
//        the same, for a run that profile already started: no new session.
const argv = process.argv.slice(2)
const flag = name => argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`))
const value = (name, fallback) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const real = flag('real')
const resumeProfile = value('resume', null)
const resumeRun = value('run', null)
const model = value('model', 'claude-opus-5-5')
const waitMs = Number(value('wait-min', '25')) * 60_000
const output = resolve('artifacts/cloud-coworker')
await mkdir(output, { recursive: true })
const root = resumeProfile ? resolve(resumeProfile) : real ? resolve('.conductor-scratch/cloud/real-profile-' + Date.now()) : await mkdtemp(join(tmpdir(), 'conductor-cloud-'))
await mkdir(root, { recursive: true })
const profile = join(root, 'profile')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}
const gitIn = cwd => (...args) => execFileSync('git', ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', ...args], { cwd, stdio: 'pipe' }).toString().trim()

// --- The project: a detached worktree of this checkout for --real, else a temp repo ----------
let projectPath, origin, helper
const FIXTURE_BRANCH = 'claude/fixture-note'
if (real) {
  projectPath = resolve('.conductor-scratch/cloud/e2e-checkout')
  if (!existsSync(projectPath)) execFileSync('git', ['worktree', 'add', '--detach', projectPath, 'HEAD'], { stdio: 'pipe' })
} else {
  projectPath = join(root, 'project'); origin = join(root, 'origin.git'); helper = join(root, 'helper')
  await mkdir(projectPath, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const git = gitIn(projectPath)
  git('init', '-q', '-b', 'main')
  await writeFile(join(projectPath, 'README.md'), '# Cloud coworker smoke\n')
  git('add', '.'); git('commit', '-q', '-m', 'Initial')
  git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, helper])
}
const projectGit = gitIn(projectPath)
const headBefore = projectGit('rev-parse', 'HEAD')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_LIVE_TESTS', 'CONDUCTOR_BACKGROUND_WINDOWS', 'CONDUCTOR_OFFLINE_TESTS']) delete env[key]
if (!real) Object.assign(env, { CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CLAUDE_CONFIG_DIR: join(root, 'claude-config'), CLOUD_FIXTURE_BRANCH: FIXTURE_BRANCH })

let app, page, owner, projectId
const call = async (method, args = {}, { expectError = false } = {}) => {
  const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  if (expectError) { assert.notEqual(response.status, 200, `${method} should have been refused`); return body.error }
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const waitFor = async (runId, predicate, label, timeout) => {
  let last
  try { await expect.poll(async () => predicate(last = await call('cloud.status', { runId, lines: 40 })), { timeout, intervals: [1000, 2000, 5000, 15000] }).toBe(true) }
  catch {
    observe(`TIMEOUT waiting for ${label}`, { status: last?.status, error: last?.error, screen: last?.screen?.split('\n').slice(-15) })
    throw new Error(`Timed out waiting for ${label}; last status ${last?.status}`)
  }
  observe(label, { runId, status: last.status, sessionId: last.sessionId, liveView: last.liveView, branch: last.branch, headCommit: last.headCommit, prUrl: last.prUrl, confirmedModel: last.confirmedModel, transcriptEntries: last.transcriptEntries })
  return last
}
const tabsOfKind = kind => page.evaluate(async ({ id, kind }) => {
  const sessions = await window.conductor.sessions.list(id)
  const tabs = node => Array.isArray(node?.tabs) ? node.tabs : (node?.children ?? []).flatMap(tabs)
  return sessions.flatMap(session => tabs(session.layout.root)).filter(tab => tab.kind === kind).map(tab => ({ id: tab.id, resourceId: tab.resourceId, title: tab.title }))
}, { id: projectId, kind })
const shot = async name => { const path = join(output, `${real ? 'real' : 'fixture'}-${name}.png`); await page.screenshot({ path }); observe('screenshot', { path }); return path }

const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ root, observations }, null, 2)); process.exit(1) }, (real ? waitMs / 60_000 + 10 : 6) * 60_000)
let failed = null
const evidence = { mode: real ? (resumeRun ? 'real (resumed run)' : 'real') : 'fixture', root }
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => { if (error.message !== 'Canceled') observe('page error', { message: error.message }) })
  await page.waitForFunction(() => Boolean(window.conductor?.cloud))
  observe('app launched (parked)', { pid: app.process().pid })
  const credential = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(credential), { timeout: 30_000 }).toBe(true)
  owner = JSON.parse(await readFile(credential, 'utf8'))
  projectId = (await call('projects.open', { path: projectPath, name: 'Cloud smoke' })).id
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.cloud))
  await page.locator('.project-row').filter({ hasText: 'Cloud smoke' }).first().click()
  const tools = await call('tools.list')
  for (const method of ['cloud.start', 'cloud.list', 'cloud.status', 'cloud.transcript', 'cloud.send', 'cloud.interrupt', 'cloud.stop', 'cloud.attach', 'cloud.fetch']) assert.ok(tools[method], `${method} is not listed: cloud runs are not plugged into AgentControl (setCloud)`)
  const catalog = (await call('models.list')).find(entry => entry.provider === 'cloud')
  assert.ok(catalog?.available, `models.list has no available cloud entry: ${JSON.stringify(catalog)}`)
  assert.ok(catalog.models.some(entry => entry.id === model), `${model} is not a cloud model`)
  evidence.cloudModels = catalog.models.map(entry => entry.id)
  observe('control protocol ready', { projectId, cloudModels: evidence.cloudModels })
  assert.match(await call('tabs.open', { provider: 'cloud', prompt: 'x', model: 'gpt-6' }, { expectError: true }), /cloud model/)

  let runId = resumeRun
  if (!runId) {
    const prompt = real
      ? 'Append exactly one line to docs/cloud-coworker-log.md (create the file with a "# Cloud coworker log" heading if it does not exist): "- 2026-09-25: first cloud session started by Conductor app control, end to end." Change nothing else. Commit it on a new branch, push the branch, and open a pull request against main.'
      : 'Add a one-line note in NOTE.md on a branch and open a pull request.'
    const started = await call('tabs.open', { provider: 'cloud', prompt, model, ...(real ? { branch: 'main' } : {}), title: real ? 'Cloud E2E: one-line log note' : 'Cloud smoke: note' })
    runId = started.id
    assert.ok(runId?.startsWith('cloud_'), `tabs.open({provider:"cloud"}) returned no run: ${JSON.stringify(started)}`)
    assert.equal(started.tab?.kind, 'cloud', `no cloud tab came back: ${JSON.stringify(started.tab)}`)
    observe('cloud run started from tabs.open', { runId, tab: started.tab?.id, model: started.model })
  } else {
    observe('resuming run', { runId })
    // Where the live view was never tried, Conductor tries it now, against the real account gate.
    const before = await call('cloud.status', { runId })
    if (before.liveView === null && !before.attached) await call('cloud.attach', { runId })
  }
  evidence.runId = runId
  const created = await waitFor(runId, run => Boolean(run.sessionId) && run.status !== 'starting' && run.liveView !== null, 'session created, live view decided', real ? 5 * 60_000 : 30_000)
  Object.assign(evidence, { sessionId: created.sessionId, sessionUrl: created.sessionUrl, liveView: created.liveView, requestedModel: created.confirmedModel, branchHint: created.branchHint })
  if (!real) {
    assert.equal(created.confirmedModel, model, 'the debug log did not confirm the model')
    assert.equal(created.liveView, false, 'the fixture refuses a live view, as the owner\'s account does')
    assert.match(await call('cloud.send', { runId, message: 'Also mention the date' }, { expectError: true }), /not enabled for your account[\s\S]*claude\.ai\/code/)
    observe('steering refused with the reason and link')
  }
  const pane = page.locator(`.cloud-pane[data-cloud-run="${runId}"]`)
  if (!resumeRun) {
    await expect.poll(async () => (await tabsOfKind('cloud')).some(tab => tab.resourceId === runId)).toBe(true)
    await expect(pane).toBeVisible({ timeout: 20_000 })
    await expect(pane.locator('header a').first()).toContainText(created.sessionId)
  }

  if (!real) {
    // What the cloud session does: push its branch (with a suffix) and open a pull request.
    const pushGit = gitIn(helper)
    pushGit('checkout', '-q', '-b', `${FIXTURE_BRANCH}-x1`)
    await writeFile(join(helper, 'NOTE.md'), 'A one-line note from the cloud session.\n')
    pushGit('add', '.'); pushGit('commit', '-q', '-m', 'Add a note')
    pushGit('push', '-q', 'origin', `${FIXTURE_BRANCH}-x1`, `${FIXTURE_BRANCH}-x1:refs/pull/5/head`)
  }
  const pushed = await waitFor(runId, run => run.status === 'pushed' && Boolean(run.branch), 'branch pushed', real ? waitMs : 60_000)
  Object.assign(evidence, { branch: pushed.branch, headCommit: pushed.headCommit, prUrl: pushed.prUrl })
  if (!real) assert.equal(pushed.branch, `${FIXTURE_BRANCH}-x1`)
  if (real && !pushed.prUrl) await waitFor(runId, run => Boolean(run.prUrl), 'pull request found', 10 * 60_000).then(run => { evidence.prUrl = run.prUrl }).catch(() => observe('no pull request yet'))

  // The transcript is pulled once by itself on the first push; a refresh pulls it again.
  const transcript = await call('cloud.transcript', { runId, refresh: true, limit: 80 })
  assert.ok(transcript.total > 0, 'the transcript is empty')
  Object.assign(evidence, { transcriptTotal: transcript.total, usage: transcript.usage, sessionModel: transcript.confirmedModel, transcript: transcript.entries.map(entry => `${entry.role}: ${entry.text.slice(0, 300)}`) })
  observe('transcript pulled', { total: transcript.total, usage: transcript.usage, model: transcript.confirmedModel })

  if (await pane.count()) {
    await expect(pane.locator('.cloud-transcript')).toBeVisible({ timeout: 20_000 })
    evidence.screenshotTranscript = await shot('tab-transcript')
    await pane.getByRole('button', { name: /Fetch for verification/ }).click()
    await expect(pane.locator('.cloud-result')).toContainText('Worktree', { timeout: 120_000 })
  } else await call('cloud.fetch', { runId })
  const fetched = (await call('cloud.list')).find(run => run.id === runId)
  assert.ok(fetched.worktreePath && existsSync(fetched.worktreePath), `no worktree: ${JSON.stringify(fetched)}`)
  const worktreeGit = gitIn(fetched.worktreePath)
  assert.equal(worktreeGit('rev-parse', 'HEAD'), fetched.fetchedCommit)
  const base = (() => { try { return worktreeGit('merge-base', 'HEAD', headBefore) } catch { return 'HEAD~1' } })()
  evidence.worktree = { path: fetched.worktreePath, commit: fetched.fetchedCommit, files: worktreeGit('diff', '--stat', base, 'HEAD').split('\n'), log: worktreeGit('log', '--oneline', '-3').split('\n') }
  if (!real) assert.equal((await readFile(join(fetched.worktreePath, 'NOTE.md'), 'utf8')).replace(/\r\n/g, '\n'), 'A one-line note from the cloud session.\n')
  assert.equal(projectGit('rev-parse', 'HEAD'), headBefore, 'the fetch moved the project\'s HEAD')
  observe('fetched for verification', evidence.worktree)
  if (await pane.count()) evidence.screenshotFetched = await shot('tab-fetched')

  const stopped = await call('cloud.stop', { runId })
  assert.equal(stopped.status, 'stopped')
  evidence.stopNote = stopped.note
  observe('stopped following', { note: stopped.note })

  if (!real) {
    // router.dispatch hands a task to the cloud too.
    await call('router.dispatch', { tasks: [{ title: 'Cloud via router', prompt: 'Add a note', provider: 'cloud', model: 'claude-sonnet-5' }] })
    await expect.poll(async () => (await call('cloud.list')).length).toBe(2)
    observe('router.dispatch started a cloud run')

    // The owner's launcher: a new tab, the Claude Cloud tile, the form, Start.
    await page.locator('.pane-add-tab').first().click()
    await page.getByRole('button', { name: /Claude Cloud/ }).click()
    await page.locator('.launcher-cloud-form textarea').first().fill('Launcher cloud task')
    await page.getByRole('button', { name: /Start cloud session/ }).click()
    await expect.poll(async () => (await call('cloud.list')).length).toBe(3)
    const fromLauncher = (await call('cloud.list')).find(run => run.prompt === 'Launcher cloud task')
    assert.equal(fromLauncher.startedBy, 'owner')
    await expect(page.locator(`.cloud-pane[data-cloud-run="${fromLauncher.id}"]`)).toBeVisible({ timeout: 20_000 })
    evidence.screenshotLauncher = await shot('launcher-run')
    observe('launcher started a run', { runId: fromLauncher.id })

    // A reload keeps the tabs; the first run's tab still shows its transcript.
    await page.reload()
    await page.waitForFunction(() => Boolean(window.conductor?.cloud))
    await expect.poll(async () => (await tabsOfKind('cloud')).length).toBeGreaterThanOrEqual(3)
    const first = (await tabsOfKind('cloud')).find(tab => tab.resourceId === runId)
    await page.getByText(first.title, { exact: true }).first().click()
    await expect(page.locator(`.cloud-pane[data-cloud-run="${runId}"] .cloud-transcript`)).toContainText('pushed the branch', { timeout: 20_000 })
    observe('reload kept the tabs and the transcript')
  }
  evidence.runs = (await call('cloud.list')).map(run => ({ id: run.id, status: run.status, model: run.model, sessionId: run.sessionId, branch: run.branch, prUrl: run.prUrl, startedBy: run.startedBy }))
} catch (error) {
  failed = error
  observe('FAILED', { message: error instanceof Error ? error.message : String(error) })
  if (page) await shot('failure').catch(() => undefined)
} finally {
  clearTimeout(watchdog)
  await app?.close().catch(() => undefined)
}
const report = join(output, `${real ? 'real' : 'fixture'}-evidence.json`)
await writeFile(report, JSON.stringify({ ok: !failed, ...evidence, observations }, null, 2))
console.log(JSON.stringify({ ok: !failed, report, runId: evidence.runId, branch: evidence.branch, prUrl: evidence.prUrl, worktree: evidence.worktree?.path }, null, 2))
if (failed) process.exit(1)
