import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Based on smoke-conversation-declutter.mjs and smoke-churning-activity.mjs. This drives the
// production Electron/preload/main path; only the Codex provider is a deterministic offline
// fixture, so it never spends model quota or claims live-provider coverage.
const root = await mkdtemp(join(tmpdir(), 'conductor-conversation-fixer-'))
const output = resolve('artifacts/conversation-fixer')
const capture = join(root, 'provider-input.txt')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20_000)
const checks = []
const errors = []
const consoleErrors = []
const geometry = []
let failure = null
const pass = (name) => { checks.push(name); console.log('PASS ' + name) }
page.on('pageerror', error => errors.push(error.stack ?? error.message))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })

const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Synthetic native provider received the scoped control briefing')
  return { endpoint, token }
}
const call = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const payload = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.agentControl))
  const project = await page.evaluate(() => window.conductor.projects.create('Conversation fixer'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Conversation fixer' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const sourceId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'synthetic:steer', { ...state.settings, model: 'synthetic-model', effort: 'low' }, [])
  }, sourceId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const owner = await credentials()
  const catalog = await call(owner, 'models.list')
  const model = catalog.find(provider => provider.provider === 'codex').models[0].id
  const claudeModel = catalog.find(provider => provider.provider === 'claude').models[0].id
  const router = await call(owner, 'router.start', { prompt: 'Coordinate the deterministic conversation fixture.', provider: 'codex', model })
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Your orchestration task ID is ' + router.taskId)).catch(() => false)).toBe(true)
  const routerAuth = await credentials()
  const [worker] = await call(routerAuth, 'router.dispatch', { tasks: [
    { title: 'Codex conversation activity fixture', prompt: 'synthetic:activity-groups', provider: 'codex', model: 'synthetic-model', effort: 'low' }
  ] })
  assert.ok(worker.accepted, 'The deterministic Codex fixture accepted native dispatch: ' + JSON.stringify(worker))
  // Claude advertises its model asynchronously. Creating the real controlled tab first and
  // waiting for that native capability avoids pretending the router's no-retry refusal succeeded.
  const claudeTab = await call(routerAuth, 'tabs.open', { provider: 'claude', model: claudeModel, title: 'Claude conversation activity fixture', focus: false })
  const claudeWorker = { ...claudeTab, agentSessionId: claudeTab.resourceId, tabId: claudeTab.id }
  await page.evaluate(id => window.conductor.structured.connect(id), claudeWorker.resourceId)
  await page.waitForFunction(async id => Boolean((await window.conductor.structured.snapshot(id))?.capabilities?.models?.length), claudeWorker.resourceId)
  const discoveredClaude = await page.evaluate(id => window.conductor.structured.snapshot(id), claudeWorker.resourceId)
  const discoveredModel = discoveredClaude.capabilities.models[0]
  assert.ok(discoveredModel?.id, 'The connected offline Claude fixture advertised a concrete model')
  const discoveredEffort = discoveredModel.defaultEffort ?? discoveredModel.effort?.[0]
  await page.evaluate(async ({ id, settings, model, effort }) => window.conductor.structured.saveSettings(id, { ...settings, model, ...(effort ? { effort } : {}) }), {
    id: claudeWorker.resourceId, settings: discoveredClaude.settings, model: discoveredModel.id, effort: discoveredEffort
  })
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), claudeWorker.resourceId))?.settings.model).toBe(discoveredModel.id)
  const submitClaude = async () => {
    const before = await page.evaluate(id => window.conductor.structured.snapshot(id), claudeWorker.resourceId)
    const submission = await call(routerAuth, 'agents.submit', { agentSessionId: claudeWorker.resourceId, prompt: 'SYNTHETIC B' })
    // The ready native endpoint returns the started turn (with phase "running"); only its
    // documented accepted:false shape means no prompt was sent and is safe to replace.
    assert.notEqual(submission.accepted, false, 'The connected offline Claude fixture rejected the discovered model before sending: ' + JSON.stringify(submission))
    assert.equal(submission.agentSessionId, claudeWorker.resourceId, 'The ready native endpoint started the intended Claude fixture turn')
    await expect.poll(async () => {
      const snapshot = await page.evaluate(id => window.conductor.structured.snapshot(id), claudeWorker.resourceId)
      return snapshot?.phase === 'completed' && snapshot.sequence > before.sequence
    }).toBe(true)
  }
  await submitClaude()
  // A real scrollport is essential here: a short fixture cannot expose text that would otherwise
  // paint under a sticky pin. These remain deterministic, offline Claude turns.
  for (let index = 0; index < 10; index++) await submitClaude()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), worker.agentSessionId))?.phase).toBe('completed')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), claudeWorker.agentSessionId))?.phase).toBe('completed')
  const appState = await call(owner, 'app.state')
  const focus = async target => page.evaluate(scope => window.conductor.agentControl.focusTab(scope.projectId, scope.sessionId, scope.tabId), { projectId: project.id, sessionId: appState.workspace.id, tabId: target.tabId })
  const measureCoworkerPin = async (target, provider, initiatingPrompt) => {
    await focus(target)
    const targetPane = page.locator('[data-structured-session="' + target.agentSessionId + '"]')
    await expect(targetPane).toBeVisible()
    await expect(targetPane).toHaveAttribute('data-provider', provider)
    const targetTimeline = targetPane.locator('.sa-timeline')
    const targetPin = targetPane.locator('.sa-pinned-prompt')
    await expect(targetPin).toContainText(initiatingPrompt)
    await expect(targetPin).toHaveAttribute('aria-label', /initiating message/)
    const readGeometry = async stage => {
      const measured = await targetPane.evaluate(el => {
        const wrapper = el.querySelector('.sa-timeline-wrap')
        const timeline = el.querySelector('.sa-timeline')
        const pin = el.querySelector('.sa-pinned-prompt')
        if (!wrapper || !timeline || !pin) throw new Error('Conversation pin geometry elements are missing')
        const wrapperRect = wrapper.getBoundingClientRect()
        const timelineRect = timeline.getBoundingClientRect()
        const pinRect = pin.getBoundingClientRect()
        const backgroundColor = getComputedStyle(pin).backgroundColor
        const rgba = /^rgba?\(([^)]+)\)$/.exec(backgroundColor)?.[1].split(',').map(part => Number(part.trim()))
        const alpha = rgba?.length === 4 ? rgba[3] : rgba?.length === 3 ? 1 : 0
        return {
          wrapperTop: wrapperRect.top,
          pinTop: pinRect.top,
          pinBottom: pinRect.bottom,
          timelineTop: timelineRect.top,
          topGap: Math.abs(pinRect.top - wrapperRect.top),
          seamGap: Math.abs(pinRect.bottom - timelineRect.top),
          scrollTop: timeline.scrollTop,
          scrollHeight: timeline.scrollHeight,
          clientHeight: timeline.clientHeight,
          backgroundColor,
          opaque: alpha >= 0.999
        }
      })
      geometry.push({ provider, stage, ...measured })
      return measured
    }
    const beforeScroll = await readGeometry('before-scroll')
    assert.ok(beforeScroll.scrollHeight > beforeScroll.clientHeight + 1, `${provider} fixture overflows the real timeline before geometry is measured`)
    assert.ok(beforeScroll.topGap <= 1, `${provider} pin top equals its wrapper top (gap ${beforeScroll.topGap}px)`)
    assert.ok(beforeScroll.seamGap <= 1, `${provider} pin bottom meets the timeline top (gap ${beforeScroll.seamGap}px)`)
    assert.ok(beforeScroll.opaque, `${provider} pin has an opaque computed background (${beforeScroll.backgroundColor})`)
    await targetTimeline.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await expect.poll(async () => targetTimeline.evaluate(el => el.scrollTop > 0)).toBe(true)
    const afterScroll = await readGeometry('after-scroll')
    assert.ok(afterScroll.topGap <= 1, `${provider} pin remains at wrapper top after scroll (gap ${afterScroll.topGap}px)`)
    assert.ok(afterScroll.seamGap <= 1, `${provider} pin remains adjacent to timeline after scroll (gap ${afterScroll.seamGap}px)`)
    assert.ok(afterScroll.opaque, `${provider} pin remains opaque after scroll (${afterScroll.backgroundColor})`)
    return { pane: targetPane, timeline: targetTimeline }
  }
  await focus(worker)
  const pane = page.locator('[data-structured-session="' + worker.agentSessionId + '"]')
  const group = pane.locator('.sa-completed-group')
  await expect(group.locator('summary')).toContainText('Latest')
  await expect(group.locator('summary')).toContainText('OUT EXACT OUTPUT 8')
  pass('Collapsed completed activity keeps the latest task and its explicitly prefixed OUT preview visible')
  await group.locator('summary').click()
  const { pane: measuredPane } = await measureCoworkerPin(worker, 'codex', 'synthetic:activity-groups')
  const { pane: claudePane } = await measureCoworkerPin(claudeWorker, 'claude', 'SYNTHETIC B')
  await claudePane.getByRole('button', { name: /Show .* tab/ }).first().click()
  await expect(page.locator('.pane-tab.active')).toHaveAttribute('data-control-agent-id', router.tab.resourceId)
  await focus(worker)

  await expect(measuredPane.locator('.sa-activity-time[title]')).toHaveCount(await measuredPane.locator('.sa-activity').count())
  pass('Codex and Claude coworker conversations pin their initiating messages in a non-scrolling opaque row at the real message viewport after overflow and scroll, use coworker sender wording, and every rendered event has a real timestamp hover')

  await measuredPane.getByRole('button', { name: /Show .* tab/ }).first().click()
  await expect(page.locator('.pane-tab.active')).toHaveAttribute('data-control-agent-id', router.tab.resourceId)
  // The coordinator released the worker relationship, then its own tab was closed through the
  // real owner tab UI. The same sender link must still restore that exact retained tab, not a
  // freshly created lookalike.
  await call(routerAuth, 'agents.release', { agentSessionId: worker.agentSessionId })
  const routerTab = page.locator('.pane-tab[data-control-agent-id="' + router.tab.resourceId + '"]')
  await routerTab.locator('.tab-close').click()
  await expect(routerTab).toHaveCount(0)
  await focus(worker)
  await measuredPane.getByRole('button', { name: /Show .* tab/ }).first().click()
  await expect(page.locator('.pane-tab.active')).toHaveAttribute('data-control-agent-id', router.tab.resourceId)
  pass('Sender links open the exact controller source from both Codex and Claude coworker panes, and a released closed source reopens from retained history')

  await focus(worker)
  const workerComposer = page.getByRole('textbox', { name: 'Message Codex', exact: true }).last()
  await workerComposer.fill('synthetic:question')
  await workerComposer.press('Enter')
  const question = measuredPane.locator('.sa-interaction.needs-attention')
  await expect(question).toBeVisible()
  const answer = question.getByRole('radio').first()
  await answer.check()
  await question.getByRole('button', { name: 'Collapse question to bottom dock', exact: true }).click()
  const dock = measuredPane.locator('.sa-interaction-docked')
  await expect(dock).toBeVisible()
  await dock.getByRole('button', { name: 'Reopen question', exact: true }).click()
  await expect(answer).toBeChecked()
  pass('A pending question collapses into the sticky bottom dock, reopens, and retains its selected answer')

  await page.screenshot({ path: join(output, 'conversation-fixer.png'), fullPage: true })
  assert.deepEqual(errors, [])
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error)
  errors.push('Smoke assertion failure: ' + failure)
  await page.screenshot({ path: join(output, 'conversation-fixer-failed.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'conversation-fixer-results.json'), JSON.stringify({ synthetic: true, checks, errors, consoleErrors, geometry, failure, url: page.url(), providerBoundary: 'deterministic Codex and Claude fixtures; no paid model calls' }, null, 2))
  await app.close().catch(() => {})
}

console.log(JSON.stringify({ synthetic: true, checks, geometry }, null, 2))
