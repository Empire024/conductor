import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'

// Production Electron/main/preload/renderer with only the provider boundary replaced by the
// repository's deterministic fixtures. CONDUCTOR_TEST_USER_DATA keeps every window off-screen.
const scratch = await mkdtemp(join(tmpdir(), 'conductor-processes-fixer-'))
const output = resolve('artifacts/processes-fixer')
const capture = join(scratch, 'provider-input.txt')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture,
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_SMOKE_BACKGROUND_MS: '600000',
  CONDUCTOR_TEST_USER_DATA: join(scratch, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(scratch, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

// Root serializes real Electron runs. A fresh grant message supplies this generation argument;
// the on-disk lease is read at the last possible moment so a paused/revoked slot cannot launch.
const slotGeneration = Number(process.argv.find(argument => argument.startsWith('--electron-slot-generation='))?.split('=')[1])
assert.ok(Number.isSafeInteger(slotGeneration) && slotGeneration > 0, 'A fresh --electron-slot-generation grant is required')
const slot = JSON.parse(await readFile(resolve('artifacts/fixer-coordination/electron-slot.json'), 'utf8'))
assert.deepEqual(
  { generation: slot.generation, status: slot.status, agentSessionId: slot.agentSessionId, script: slot.script },
  { generation: slotGeneration, status: 'granted', agentSessionId: 'agent_mtydfzvr_sxv01gz', script: 'scripts/smoke-processes-fixer.mjs' },
  'Electron slot does not match this exact agent, script, and fresh grant generation'
)
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, inference: 'none', checks: [], screenshots: [], errors: [] }
const page = await app.firstWindow()
page.setDefaultTimeout(20_000)
page.on('pageerror', error => results.errors.push(error.stack ?? error.message))
const pass = message => { results.checks.push(message); console.log(`PASS ${message}`) }
const receivesPointerAtCenter = locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return Boolean(hit && (hit === element || element.contains(hit)))
})
const computedContrastRatio = locator => locator.evaluate(element => {
  const parse = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const luminance = value => {
    const [red = 0, green = 0, blue = 0] = parse(value).map(channel => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const style = getComputedStyle(element)
  const foreground = luminance(style.color)
  const background = luminance(style.backgroundColor)
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
})
const sidebarRoleGeometry = () => page.locator('.workspace-tab-row:has(.workspace-tab-role)').evaluateAll(rows => rows.map(row => {
  const select = row.querySelector('.workspace-tab-select')?.getBoundingClientRect()
  const role = row.querySelector('.workspace-tab-role')?.getBoundingClientRect()
  const more = row.querySelector('.workspace-tab-more')?.getBoundingClientRect()
  const titleText = row.querySelector('.workspace-tab-select .ellipsis')?.getBoundingClientRect()
  const roleElement = row.querySelector('.workspace-tab-role')
  const box = rect => rect && { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
  return { title: row.querySelector('.workspace-tab-select')?.getAttribute('title'), select: box(select), titleText: box(titleText), role: box(role), more: box(more), roleTextFits: Boolean(roleElement && roleElement.scrollWidth <= roleElement.clientWidth + 1) }
}))
const sidebarRolesAreReadable = rows => {
  const overlaps = (left, right) => left.left < right.right - 0.5 && left.right > right.left + 0.5 && left.top < right.bottom - 0.5 && left.bottom > right.top + 0.5
  return rows.every(({ select, titleText, role, more, roleTextFits }) => Boolean(select && titleText && role && more && titleText.width >= 24 && roleTextFits && !overlaps(select, role) && !overlaps(select, more) && !overlaps(role, more)))
}
const screenshot = async name => {
  const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  const path = join(output, `${name}.png`)
  await writeFile(path, Buffer.from(bytes, 'base64'))
  results.screenshots.push(`artifacts/processes-fixer/${name}.png`)
}
const call = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Synthetic provider must receive the native control briefing')
  return { endpoint, token }
}
const startPane = async label => {
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: label }).click()
  else {
    await page.locator('.pane-add-tab').first().click()
    await page.locator('.launcher-grid button').filter({ hasText: label }).click()
  }
  const pane = page.locator('.structured-agent-pane').last()
  await pane.waitFor()
  return pane.getAttribute('data-structured-session')
}
const openProcesses = async () => {
  if (!await page.locator('.workspace-utility-drawer .pd-dashboard').count()) {
    await page.getByRole('button', { name: 'Processes', exact: true }).click()
  }
  await page.locator('.workspace-utility-drawer .pd-dashboard').waitFor()
}

let failure
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.agentControl))
  const project = await page.evaluate(() => window.conductor.projects.create('Processes fixture'))
  await page.reload()
  await page.getByText('Processes fixture', { exact: true }).first().click()

  // A completed Claude fixture turn supplies this native tab's real scoped app-control briefing.
  const mainId = await startPane('Claude Code')
  assert.ok(mainId)
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B controlled parent setup', { ...state.settings, model: 'synthetic-claude' }, [])
  }, mainId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), mainId))?.phase).toBe('completed')
  const auth = await credentials()
  const appState = await call(auth, 'app.state')
  const mainTab = appState.tabs.find(tab => tab.resourceId === mainId)
  assert.ok(mainTab, 'app.state must retain the controlling Claude tab')
  const catalog = await call(auth, 'models.list')
  const claude = catalog.find(entry => entry.provider === 'claude' && entry.available)
  const workerModel = claude?.models.find(model => model.id === 'synthetic-claude') ?? claude?.models[0]
  assert.ok(workerModel, 'models.list must advertise the connected synthetic Claude fixture')
  const workerEffort = workerModel.effort?.includes('low') ? 'low' : workerModel.defaultEffort
  const [coworker] = await call(auth, 'router.dispatch', { tasks: [{ title: 'Visible process coworker', prompt: 'SYNTHETIC B bounded process fixture', provider: 'claude', model: workerModel.id, ...(workerEffort ? { effort: workerEffort } : {}) }] })
  assert.ok(coworker?.agentSessionId && coworker?.tabId)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), coworker.agentSessionId))?.phase).toBe('completed')
  await expect(page.locator('.agent-control-marker.controller')).toContainText('MAIN')
  await expect(page.locator('.agent-control-marker.controlled')).toContainText('COWORKER')
  const markerTitles = await page.locator('.agent-control-marker').evaluateAll(nodes => nodes.map(node => node.getAttribute('title') ?? ''))
  assert.ok(markerTitles.some(title => title.includes('main coordinating tab') && title.includes('coworker')))
  assert.ok(markerTitles.some(title => title.includes('coworker controlled by')))
  await expect(page.locator('.agent-control-popover')).toHaveCount(0)
  await screenshot('persistent-tab-roles')
  pass('Main and coworker tabs carry persistent text roles with directional hover explanations')

  await page.evaluate(scope => window.conductor.agentControl.focusTab(scope.projectId, scope.sessionId, scope.tabId), { projectId: project.id, sessionId: appState.workspaceId, tabId: mainTab.id })
  const mainPane = page.locator(`[data-structured-session="${mainId}"]`)
  const mainComposer = mainPane.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  const send = mainPane.getByRole('button', { name: 'Send message', exact: true })
  assert.equal(await receivesPointerAtCenter(send), true, 'Single-link relationship UI must not intercept the real Send button')
  await page.locator('.agent-control-marker.controller').click()
  const popover = page.getByRole('dialog', { name: /Agent tab relationships for/ })
  await expect(popover).toBeVisible()
  const [popoverBox, composerBox] = await Promise.all([popover.boundingBox(), mainComposer.boundingBox()])
  assert.ok(popoverBox && composerBox && popoverBox.y + popoverBox.height < composerBox.y, 'Relationship details must stay anchored above the composer')
  await popover.getByRole('button', { name: 'Close agent tab relationships', exact: true }).click()
  await expect(popover).toHaveCount(0)

  const [secondCoworker] = await call(auth, 'router.dispatch', { tasks: [{ title: 'Second visible process coworker', prompt: 'SYNTHETIC B second bounded process fixture', provider: 'claude', model: workerModel.id, ...(workerEffort ? { effort: workerEffort } : {}) }] })
  assert.ok(secondCoworker?.agentSessionId && secondCoworker?.tabId)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), secondCoworker.agentSessionId))?.phase).toBe('completed')
  await page.evaluate(scope => window.conductor.agentControl.focusTab(scope.projectId, scope.sessionId, scope.tabId), { projectId: project.id, sessionId: appState.workspaceId, tabId: mainTab.id })
  await expect(page.locator('.agent-control-marker.controller em')).toHaveText('2')
  assert.ok(await computedContrastRatio(page.locator('.agent-control-marker.controller em')) >= 4.5, 'Pane-tab relationship count must have readable computed foreground/background contrast')
  assert.ok(await computedContrastRatio(page.locator('.workspace-tab-role.main b').first()) >= 4.5, 'Sidebar relationship count must have readable computed foreground/background contrast')
  assert.equal(await receivesPointerAtCenter(send), true, 'Multiple closed relationship links must not intercept Send')
  const wideRoleGeometry = await sidebarRoleGeometry()
  assert.equal(sidebarRolesAreReadable(wideRoleGeometry), true, `Wide sidebar rows must keep usable tab names, complete role labels, and non-overlapping controls: ${JSON.stringify(wideRoleGeometry)}`)
  await page.setViewportSize({ width: 520, height: 740 })
  const narrowRoleGeometry = await sidebarRoleGeometry()
  assert.equal(sidebarRolesAreReadable(narrowRoleGeometry), true, `Narrow sidebar rows must keep usable tab names, complete role labels, and non-overlapping controls: ${JSON.stringify(narrowRoleGeometry)}`)
  assert.equal(await receivesPointerAtCenter(send), true, 'Narrow-pane relationship UI must not intercept Send')
  await page.locator('.agent-control-marker.controller').click()
  await expect(popover).toBeVisible()
  const narrowPopoverBox = await popover.boundingBox()
  assert.ok(narrowPopoverBox && narrowPopoverBox.x >= 8 && narrowPopoverBox.x + narrowPopoverBox.width <= 512, 'Narrow relationship popover must remain inside the viewport')
  await popover.getByRole('button', { name: 'Close agent tab relationships', exact: true }).click()
  await page.setViewportSize({ width: 1540, height: 960 })
  assert.equal(await receivesPointerAtCenter(send), true, 'Wide-pane Send must remain the real pointer target after closing details')
  await screenshot('relationship-layout-hit-tests')
  pass('Single and multiple relationships preserve real Send hit targets and non-overlapping tab roles at narrow and wide sizes')

  // Raw Claude protocol proves both sides of its actual task_type boundary: local_agent belongs
  // in the roster, while local_bash remains a normal process/tool row.
  await mainComposer.fill('SYNTHETIC BACKGROUND: emit a real local agent.')
  await send.click()
  await expect(mainPane.locator('.sa-subagent-summary')).toContainText('1 subagent', { timeout: 15_000 })
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), mainId))?.phase).toBe('completed')
  const backgroundTaskRow = mainPane.locator('.sa-tool').filter({ hasText: 'Synthetic background worker' })
  await expect(backgroundTaskRow).not.toContainText('failed')
  await mainComposer.fill('SYNTHETIC BASH BACKGROUND: emit a background shell process.')
  await send.click()
  await expect(mainPane.locator('.sa-tool[aria-label="Bash: completed"]')).toContainText('Synthetic background Bash process')
  await expect(mainPane.locator('.sa-subagent-summary')).toContainText('1 subagent')
  const classified = await page.evaluate(async id => {
    const snapshot = await window.conductor.structured.snapshot(id)
    return {
      subagents: snapshot?.items.filter(item => item.data.type === 'subagent').length ?? 0,
      agentStatus: snapshot?.items.find(item => item.data.type === 'subagent' && item.data.name === 'Synthetic background worker')?.data.status,
      taskLaunchFailed: snapshot?.items.some(item => item.data.type === 'tool' && item.data.name === 'Task' && item.data.description === 'Synthetic background worker' && item.data.status === 'failed') ?? false,
      bash: snapshot?.items.some(item => item.data.type === 'tool' && item.data.name === 'Bash' && item.data.status === 'completed') ?? false
    }
  }, mainId)
  assert.deepEqual(classified, { subagents: 1, agentStatus: 'running', taskLaunchFailed: false, bash: true })
  await mainPane.locator('.sa-subagent-summary').click()
  const roster = page.getByRole('dialog', { name: 'Subagents', exact: true })
  await expect(roster.locator('.sa-agent-card')).toHaveCount(1)
  await expect(roster.locator('.sa-subagent-dot')).toHaveCount(1)
  await expect(roster.locator('.sa-subagent-identity')).toHaveCount(0)
  await roster.locator('.sa-agent-card-heading').click()
  await expect(roster).toContainText('Lifecycle only · child activity not reported')
  await expect(roster).not.toContainText('Activity (0)')
  await expect(roster).not.toContainText('0 tools')
  const statusHelp = await roster.locator('.sa-subagent-dot').evaluateAll(nodes => nodes.map(node => node.getAttribute('title') ?? ''))
  assert.ok(statusHelp.every(title => title.includes('provider reports this agent is active')))
  await screenshot('claude-agent-versus-bash')
  await page.getByRole('button', { name: 'Close Subagents', exact: true }).click()
  pass('Claude local_agent appears once with an explained status marker while local_bash stays on its Bash row')

  // A second workspace retains a native history but contributes no work while merely connected.
  await page.locator('.session-add').click()
  await expect(page.locator('.session-tab')).toHaveCount(2)
  const historyId = await startPane('Claude Code')
  assert.ok(historyId)
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B retained history fixture', { ...state.settings, model: 'synthetic-claude' }, [])
  }, historyId)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), historyId))?.phase).toBe('completed')
  await openProcesses()
  const mainRow = page.locator(`.pd-row[data-process-id="${mainId}"]`)
  const historyRow = page.locator(`.pd-row[data-process-id="${historyId}"]`)
  await expect(mainRow).toContainText('Working')
  await expect(historyRow).toContainText('Finished')
  await expect(historyRow).toContainText('No plan reported')
  await expect(page.locator('.pd-overview > span').filter({ hasText: 'Working now' }).locator('b')).toHaveText('1')
  await expect(page.locator('.process-status-summary')).toContainText('1 working')
  await screenshot('runtime-facts')
  pass('Processes shows actual runtime state, reported usage/time, and no invented plan percentage')

  // Closing and undo-restoring this workspace preserves its tab/history but disconnects its
  // provider. Open must reveal that history without reconnecting; Reconnect remains explicit.
  await page.locator('.session-tab').nth(1).locator('.session-tab-close').click()
  await expect(page.locator('.session-tab')).toHaveCount(1)
  await page.keyboard.press('Control+Shift+Z')
  await expect(page.locator('.session-tab')).toHaveCount(2)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), historyId))?.phase).toBe('disconnected')
  await page.locator('.session-tab').first().click()
  await openProcesses()
  const disconnectedRow = page.locator(`.pd-row[data-process-id="${historyId}"]`)
  await expect(disconnectedRow).toContainText('Disconnected')
  await disconnectedRow.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.locator(`[data-structured-session="${historyId}"]`)).toBeVisible()
  expect((await page.evaluate(id => window.conductor.structured.snapshot(id), historyId))?.phase).toBe('disconnected')
  await screenshot('disconnected-history-open')
  // Open follows the retained process into its owning workspace. Reconnect is a dashboard action,
  // so return to the original Processes workspace and acquire a fresh visible row locator.
  await page.locator('.session-tab').first().click()
  await openProcesses()
  const reconnectRow = page.locator(`.pd-row[data-process-id="${historyId}"]`)
  await expect(reconnectRow).toContainText('Disconnected')
  await expect(reconnectRow.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await reconnectRow.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), historyId))?.phase).not.toBe('disconnected')
  pass('A disconnected retained row opens its history first and reconnects only from the explicit action')

  assert.deepEqual(results.errors, [])
} catch (error) {
  failure = error
  results.failures = [error.stack ?? String(error)]
  await screenshot('failure').catch(() => {})
  results.failureDom = await page.locator('body').innerText().catch(() => null)
} finally {
  let cleanupFailure
  try { await cleanupFixtureApp(app, results, 'Processes fixture cleanup') }
  catch (error) { cleanupFailure = error; results.cleanupFailure = error.stack ?? String(error) }
  try { await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2)) }
  catch (error) { cleanupFailure = combinedSmokeFailure(cleanupFailure, error) }
  failure = combinedSmokeFailure(failure, cleanupFailure)
}

if (failure) throw failure
console.log(JSON.stringify(results, null, 2))
