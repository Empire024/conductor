import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// FX12: rollback and app.update-in-Auto, verified through the test-mode installer stub
// (src/main/update-install-seam.ts). No installer ever runs: in a CONDUCTOR_TEST_USER_DATA profile
// the install step writes <profile>/installer-stub.json and relaunches the app instead.
//   S18  app.update from a native Claude fixture tab in Auto builds three times in a row with no
//        owner prompt and no app.update.authorize; the same call from a tab below Auto still asks.
//        Builds publish into the test profile's own feed, never the installed app's.
//   S16  restore-points.json metadata (commit, CLI versions, model catalogs), pinning from the UI,
//        an ordinary update to the newest build, then a rollback to the oldest from the Versions
//        menu; the stub records each installer and the relaunched app reports the stub's version.
//   S17  a rollback while a turn runs goes through the "Work is still running" confirmation (guarded
//        and logged in test mode; CONDUCTOR_TEST_STOP_DECISION=background takes "keep running"),
//        and the turn finishes after the relaunch through the runtime host.
// The app is launched as `electron .` so app.getVersion() is the package version; launched as
// `electron out/main/index.js` it reports Electron's own version and no local build is newer.
//   node scripts/smoke-lock.mjs --timeout-min 100 -- node scripts/smoke-fx12-rollback.mjs [--keep] [--feed <local-updates dir with 3 builds>] [--only s16,s17]

const HARD_TIMEOUT_MS = 95 * 60_000
const BUILD_TIMEOUT_MS = 25 * 60_000
const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const seedFeed = option('--feed')
const only = new Set((option('--only') ?? 's18,s16,s17').split(','))
const repo = resolve('.')
const output = resolve('.conductor-scratch/fx12')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-fx12-'))
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), feed = join(profile, 'local-updates')
await mkdir(fixtures, { recursive: true }); await mkdir(profile, { recursive: true })
if (seedFeed) await cp(resolve(seedFeed), feed, { recursive: true })
const capture = join(root, 'controller-input.txt')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// S13's fixture Claude: captures each prompt (the briefing carries the tab's control credential)
// and streams slowly on request.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'fx12-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE && typeof prompt === 'string') writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  const slow = typeof prompt === 'string' && prompt.includes('stream slowly')
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  if (slow) { for (let i = 0; i < 240; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' + i + ' ' } } }); await wait(250) } }
  else emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Short done.' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: slow ? 'slow-done' : 'Short done.' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

if (only.has('s17') && only.size > 1) { console.error('Run s17 on its own: the runtime host it needs keeps the debugging port of a relaunched app from answering, which s16 needs.'); process.exit(2) }
const env = {
  ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_TEST_CONTROL_CAPTURE: capture,
  CONDUCTOR_UPDATE_DEV: '1', CONDUCTOR_RUNTIME_HOST: only.has('s17') ? '1' : '0', CONDUCTOR_TEST_STOP_DECISION: 'background'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS; delete env.CONDUCTOR_TEST_DIALOGS

let owner, projectId, browser, page, port
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const readOwner = () => { try { return JSON.parse(readFileSync(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }
const request = async (auth, method, args = {}, scope) => { const r = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) }); return { status: r.status, body: await r.json() } }
const call = async (method, args = {}) => { const r = await request(owner, method, args, projectId ? { projectId } : undefined); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const stub = () => { try { return JSON.parse(readFileSync(join(profile, 'installer-stub.json'), 'utf8')) } catch { return null } }
const catalog = () => JSON.parse(readFileSync(join(feed, 'restore-points.json'), 'utf8'))
const mainErrors = () => { try { return readFileSync(join(profile, 'main-errors.log'), 'utf8') } catch { return '' } }
const shot = async name => { await page.screenshot({ path: join(output, name) }).catch(error => observe('screenshot failed', { name, error: String(error) })) }
const sha512 = file => createHash('sha512').update(readFileSync(file)).digest('base64')
const pids = new Set()

const connect = async () => {
  if (browser) await browser.close().catch(() => {})
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  await expect.poll(() => browser.contexts().flatMap(c => c.pages()).some(p => p.url().includes('index.html')), { timeout: 30_000, intervals: [500] }).toBe(true)
  page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('index.html'))
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'FX12 Conductor' }).first().click().catch(() => {})
  await page.waitForTimeout(500)
}
const launch = async () => {
  port = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(join(root, 'app.log'), 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, repo], { cwd: repo, env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  pids.add(child.pid)
  await expect.poll(() => readOwner()?.pid === child.pid, { timeout: 90_000, intervals: [500] }).toBe(true)
  owner = readOwner()
  observe('app launched (parked)', { pid: child.pid, appVersion: owner.appVersion })
}
/** Waits for the process that asked for an install to go and its relaunch to publish a credential. */
const relaunched = async (previousPid, { cdp = true } = {}) => {
  await expect.poll(() => alive(previousPid), { timeout: 60_000, intervals: [500] }).toBe(false)
  await expect.poll(() => { const next = readOwner(); return next && next.pid !== previousPid && alive(next.pid) ? next.pid : null }, { timeout: 90_000, intervals: [500] }).not.toBe(null)
  owner = readOwner(); pids.add(owner.pid)
  try {
    const commandLine = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${owner.pid}").CommandLine`], { encoding: 'utf8', windowsHide: true }).trim()
    const listeners = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.State) pid=$($_.OwningProcess)" }`], { encoding: 'utf8', windowsHide: true }).trim()
    observe('relaunched command line', { commandLine, listeners })
  } catch { /* diagnostics only */ }
  if (cdp) await connect()
  observe('relaunched', { pid: owner.pid })
}
const tabCredential = async (id, prompt = 'hello') => {
  await writeFile(capture, '')
  await call('agents.submit', { agentSessionId: id, prompt })
  await expect.poll(async () => readFile(capture, 'utf8').then(t => t.includes('Conductor app control:')).catch(() => false), { timeout: 30_000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  await expect.poll(async () => (await call('agents.status', { agentSessionId: id })).phase, { timeout: 30_000, intervals: [250] }).toBe('completed')
  return { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
}
const openClaude = async (title, extra = {}) => {
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title, ...extra })
  const id = tab.resourceId ?? tab.agentSessionId
  const settings = await page.evaluate(async id => (await window.conductor.structured.snapshot(id))?.settings, id)
  return { id, settings }
}
const pendingConfirms = () => page.evaluate(() => window.conductor.agentConfirm.pending())
const updateState = () => page.evaluate(() => window.conductor.updates.getState())
/** The startup "A Conductor update is pending" prompt is the owner's own offer; the smoke answers
 *  "Not now" and drives the status-bar control and Versions menu instead. */
const clearPrompt = async () => {
  const prompt = page.locator('.update-prompt')
  if (await prompt.isVisible().catch(() => false)) {
    summary.promptsSeen = [...(summary.promptsSeen ?? []), await prompt.innerText().catch(() => '')]
    await prompt.getByRole('button', { name: 'Not now' }).last().click()
    await expect(page.locator('.update-prompt-backdrop')).toHaveCount(0)
  }
}
const openVersions = async () => {
  await clearPrompt()
  const menu = page.locator('.update-versions-menu').first()
  if (!await menu.evaluate(element => element.open)) await menu.locator('summary').click()
  return menu
}
/** Clicks `button` from inside the page shortly after CDP is detached. A CDP session still open
 *  when the process exits kept the relaunched app's --remote-debugging-port from answering. */
const clickDetached = async button => {
  await button.evaluate(element => { setTimeout(() => element.click(), 1500) })
  await browser.close().catch(() => {}); browser = undefined
}
const rollbackFromUi = async version => {
  // window.confirm is a native box; answer it in-page so nothing can appear on a real screen. The
  // text is kept in localStorage so it can be read back after the relaunch.
  await page.evaluate(() => { localStorage.removeItem('fx12Confirm'); window.confirm = message => { localStorage.setItem('fx12Confirm', String(message)); return true } })
  const menu = await openVersions()
  const row = menu.locator('li').filter({ hasText: version })
  await expect(row).toHaveCount(1)
  await clickDetached(row.getByRole('button', { name: 'Roll back to this version' }))
}
const confirmText = () => page.evaluate(() => localStorage.getItem('fx12Confirm'))

const summary = { root, profile, feed, repo, s18: {}, s16: {}, s17: {}, verdicts: {} }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); void finish(new Error('hard timeout')) }, HARD_TIMEOUT_MS)
let failed = null
try {
  await launch()
  projectId = (await call('projects.open', { path: repo, name: 'FX12 Conductor' })).id
  await connect()
  observe('project opened', { projectId })
  summary.initialState = await updateState()

  if (only.has('s18')) {
    // S18: an Auto coworker builds three times in a row without asking.
    const auto = await openClaude('Auto coworker')
    summary.s18.autoSettings = auto.settings
    assert.equal(auto.settings?.permission, 'auto', 'a native coworker opened by tabs.open should be on Auto')
    const autoAuth = await tabCredential(auto.id)
    summary.s18.builds = []
    for (let index = 1; index <= 3; index++) {
      const before = await pendingConfirms()
      const started = Date.now()
      const response = await request(autoAuth, 'app.update')
      const confirmsWhileStarting = await pendingConfirms()
      observe(`S18 build ${index} requested`, { status: response.status, authorizedBy: response.body?.result?.authorizedBy, error: response.body?.error })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.result.authorizedBy, 'auto')
      assert.deepEqual(confirmsWhileStarting, [], 'no owner prompt for an Auto coworker')
      await expect.poll(async () => (await call('app.update.status')).state, { timeout: BUILD_TIMEOUT_MS, intervals: [5000] }).not.toBe('running')
      const status = await call('app.update.status')
      summary.s18.builds.push({ index, seconds: Math.round((Date.now() - started) / 1000), state: status.state, version: status.version, feedDirectory: status.feedDirectory, confirmsBefore: before, log: status.log.slice(-6) })
      observe(`S18 build ${index} finished`, { state: status.state, version: status.version, feedDirectory: status.feedDirectory })
      assert.equal(status.state, 'succeeded', status.log.join('\n'))
      assert.equal(resolve(status.feedDirectory), resolve(feed), 'a test instance publishes into its own profile feed')
    }
    summary.s18.ownerPromptsLogged = mainErrors().split('\n').filter(line => line.includes('wants to build Conductor'))
    assert.deepEqual(summary.s18.ownerPromptsLogged, [])
    await shot('S18-after-three-builds.png')

    // The same call from a tab below Auto still asks the owner (declined here).
    const low = await openClaude('Ask-mode coworker', { permission: 'default', exactPermission: true })
    summary.s18.lowSettings = low.settings
    assert.notEqual(low.settings?.permission, 'auto')
    const lowAuth = await tabCredential(low.id)
    const lowCall = request(lowAuth, 'app.update')
    await expect.poll(async () => (await pendingConfirms()).length, { timeout: 30_000, intervals: [250] }).toBeGreaterThan(0)
    const [prompt] = await pendingConfirms()
    await shot('S18-below-auto-asks.png')
    // The owner declines in the in-app prompt itself.
    await page.locator('.agent-confirm-backdrop').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('.agent-confirm-backdrop')).toHaveCount(0)
    const lowResult = await lowCall
    summary.s18.belowAuto = { permission: low.settings?.permission, prompt, status: lowResult.status, body: lowResult.body, builderAfter: (await call('app.update.status')).state }
    observe('S18 below-Auto app.update', summary.s18.belowAuto)
    assert.notEqual(lowResult.status, 200)
    assert.match(JSON.stringify(lowResult.body), /declined/)
    summary.verdicts.S18 = 'VERIFIED (Auto: 3 builds, no prompt; below Auto: prompt shown and declined). Local-model tab: unit test only'
  }

  if (only.has('s16')) {
    // S16: restore-point metadata, pinning, an update to the newest build, a rollback to the oldest.
    const points = catalog().points.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    assert.ok(points.length >= 2, `need two restore points, found ${points.length}`)
    const oldest = points[0].version, newest = points.at(-1).version
    summary.s16.metadata = points.map(point => ({ version: point.version, commit: point.commit, dirty: point.dirty, cliVersions: point.cliVersions,
      catalogs: point.models.map(entry => ({ provider: entry.provider, available: entry.available, models: entry.models?.length ?? 0 })),
      installerExists: existsSync(join(feed, point.installer)), blockmapExists: existsSync(join(feed, point.blockmap)), descriptorExists: existsSync(join(feed, `restore-point-${point.version}.json`)) }))
    await writeFile(join(output, 'S16-restore-points.json'), JSON.stringify(catalog(), null, 2))
    for (const point of summary.s16.metadata) {
      assert.ok(point.installerExists && point.blockmapExists && point.descriptorExists, `artifacts for ${point.version}`)
      assert.ok(point.cliVersions && 'claude' in point.cliVersions && 'codex' in point.cliVersions, `CLI versions for ${point.version}`)
      assert.ok(point.catalogs.length > 0, `model catalogs for ${point.version}`)
    }
    // The Versions menu must list builds made while this window was open.
    const menu = await openVersions()
    await expect(menu.locator('li')).toHaveCount(points.length, { timeout: 10_000 }).catch(() => {})
    summary.s16.menuListsAllBuilds = await menu.locator('li').count()
    await shot('S16-versions-menu.png')
    assert.equal(summary.s16.menuListsAllBuilds, points.length, 'the Versions menu lists every restore point without a restart')
    await menu.locator('li').filter({ hasText: oldest }).getByRole('button', { name: 'Pin as known good' }).click()
    await expect.poll(() => catalog().points.find(point => point.version === oldest)?.pinned, { timeout: 10_000 }).toBe(true)
    summary.s16.pinned = catalog().points.find(point => point.version === oldest)
    await expect(menu.locator('li').filter({ hasText: oldest }).getByRole('button', { name: 'Unpin' })).toBeVisible()
    await shot('S16-pinned.png')
    await menu.locator('summary').click()

    // An ordinary update to the newest build: "Update pending" is one click that downloads, then
    // installs and restarts (use-app-updates.ts).
    await page.evaluate(() => window.conductor.updates.check())
    const button = page.locator('.statusbar-update').first()
    await expect(button).toHaveClass(/available/, { timeout: 30_000 })
    await page.waitForTimeout(1000)
    await clearPrompt()
    await shot('S16-update-pending.png')
    const pidBeforeUpdate = owner.pid
    await clickDetached(button)
    await relaunched(pidBeforeUpdate)
    summary.s16.update = { stub: stub(), state: await updateState() }
    observe('S16 update installed through the stub', summary.s16.update)
    assert.equal(summary.s16.update.stub?.version, newest)
    assert.equal(summary.s16.update.stub?.reason, 'update')
    assert.equal(summary.s16.update.state.currentVersion, newest)

    // Roll back to the oldest from the Versions menu: two clicks and the confirm.
    const pidBeforeRollback = owner.pid
    await rollbackFromUi(oldest)
    await relaunched(pidBeforeRollback)
    const confirms = await confirmText()
    const record = stub()
    summary.s16.rollback = { confirms, stub: record, state: await updateState(),
      installerHashMatches: record?.installerPath && existsSync(record.installerPath) ? sha512(record.installerPath) === record.sha512 : null,
      firstLaunchedAt: catalog().points.find(point => point.version === oldest)?.firstLaunchedAt ?? null }
    observe('S16 rollback installed through the stub', summary.s16.rollback)
    assert.equal(record?.version, oldest)
    assert.equal(record?.reason, 'rollback')
    assert.equal(summary.s16.rollback.installerHashMatches, true, 'the stub names the downloaded installer of the older build')
    assert.equal(summary.s16.rollback.state.currentVersion, oldest)
    const after = await openVersions()
    await expect(after.locator('li').filter({ hasText: oldest }).locator('em', { hasText: 'Current' })).toBeVisible()
    await shot('S16-after-rollback.png')
    await after.locator('summary').click()
    summary.verdicts.S16 = 'VERIFIED through the installer stub (the rolled-back version is the stub-installed marker, not a real install)'
  }

  if (only.has('s17')) {
    // S17: a rollback while a turn runs asks "Work is still running" (guarded + logged in test mode)
    // and the turn survives the relaunch through the runtime host.
    const points = catalog().points.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const current = (await updateState()).currentVersion
    const target = [...points].reverse().find(point => point.version !== current)?.version
    assert.ok(target, 'a restore point other than the current version')
    const worker = await openClaude('Streaming through rollback')
    const logBefore = mainErrors().length
    await call('agents.submit', { agentSessionId: worker.id, prompt: 'stream slowly' })
    await expect.poll(async () => (await call('agents.status', { agentSessionId: worker.id })).phase, { timeout: 30_000, intervals: [250] }).toBe('running')
    await page.waitForTimeout(2000)
    const pidBefore = owner.pid
    await rollbackFromUi(target)
    // With the runtime host on, the relaunched app's debugging port never answers (the host holds an
    // inherited handle to the old listening socket), so everything after this goes through app control.
    await relaunched(pidBefore, { cdp: false })
    const confirms = '(window.confirm answered in-page; not read back without CDP)'
    const guarded = mainErrors().slice(logBefore).split('\n').filter(line => line.includes('Work is still running'))
    await expect.poll(async () => (await call('agents.status', { agentSessionId: worker.id })).phase, { timeout: 120_000, intervals: [1000] }).toBe('completed')
    const history = await call('agents.history', { agentSessionId: worker.id }).catch(error => ({ error: String(error) }))
    const text = JSON.stringify(history)
    summary.s17 = { target, confirms, guardedDialog: guarded, stub: stub(), relaunchedAs: catalog().points.find(point => point.version === target)?.firstLaunchedAt ?? null, finishedAfterRelaunch: text.includes('slow-done'), lastChunk: /slow23\d/.test(text) }
    observe('S17 rollback during a running turn', summary.s17)
    assert.ok(guarded.some(line => /-> response 0/.test(line)), 'the running-work confirmation was asked (guarded, logged) and answered keep running')
    assert.equal(summary.s17.stub?.version, target)
    assert.ok(summary.s17.relaunchedAs, 'the relaunched app started as the rolled-back version (its restore point records the launch)')
    assert.ok(summary.s17.finishedAfterRelaunch, 'the streaming turn completed after the relaunch')
    summary.verdicts.S17 = 'VERIFIED (running-work confirmation guarded+logged, keep-running answer, turn completed after relaunch)'
  }
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.stack ?? error).slice(0, 2500) })
  if (page) await shot('failure.png')
}
await finish(failed)

async function finish(error) {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  for (const pid of [...pids, readOwner()?.pid].filter(Boolean)) if (alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(join(root, 'app.log'), 'utf8').split('\n').filter(line => /update|install|rollback|restore|stub|Error|error/i.test(line)).slice(-60) } catch { /* no log */ }
  summary.mainErrors = mainErrors().split('\n').slice(-30)
  summary.stubHistory = (() => { try { return readFileSync(join(profile, 'installer-stub-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) } catch { return [] } })()
  const result = { result: error ? 'FAIL' : 'PASS', ...summary, root: keep || error || only.has('s18') ? root : '(removed)', observations }
  await writeFile(join(output, `summary-${[...only].join('-')}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ result: result.result, verdicts: summary.verdicts, root: result.root }, null, 2))
  process.exit(error ? 1 : 0)
}
