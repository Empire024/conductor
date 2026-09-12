import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Real Electron main/preload/renderer/control broker; only the provider process is synthetic.
const root = await mkdtemp(join(tmpdir(), 'conductor-agent-settings-fixer-'))
const output = resolve('artifacts/agent-settings-fixer')
const capture = join(root, 'provider-input.txt')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_USAGE_ROUTING: '1',
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture,
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
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
const cleanup = []
const targetCatalog = { beforeConnect: null, afterConnect: null }
const visualEvidence = { window: null, configured: null, reloaded: null }
let failure = null
let failureStamp = null
let sourceId = null
let workerId = null
const check = label => { checks.push(label); console.log('PASS ' + label) }
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.stack ?? error.message) })

const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Synthetic native provider received the scoped control briefing')
  return { endpoint, token }
}
const request = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return { response, payload: await response.json() }
}
const call = async (auth, method, args = {}) => {
  const { response, payload } = await request(auth, method, args)
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}
const refuse = async (auth, method, args, pattern) => {
  const { response, payload } = await request(auth, method, args)
  assert.equal(response.status, 400, method + ' unexpectedly succeeded: ' + JSON.stringify(payload))
  assert.match(String(payload.error), pattern)
  return payload.error
}

const pngIhdr = png => png.length >= 24 && png.subarray(1, 4).toString('ascii') === 'PNG'
  ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  : null
const nativeVisualState = () => app.evaluate(async ({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) throw new Error('Electron BrowserWindow is unavailable')
  const png = (await window.webContents.capturePage()).toPNG()
  return {
    bounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
    focused: window.isFocused(),
    visible: window.isVisible(),
    zoomFactor: window.webContents.getZoomFactor(),
    capturePng: { bytes: png.length, ihdr: png.length >= 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null }
  }
})

const captureVisibleControls = async (key, controls, modelControl, effortControl, filename) => {
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }))
  const native = await nativeVisualState()
  const [controlsBox, modelBox, effortBox] = await Promise.all([controls.boundingBox(), modelControl.boundingBox(), effortControl.boundingBox()])
  const evidence = { native, viewport, controls: controlsBox, model: modelBox, effort: effortBox, clip: null, screenshot: null }
  visualEvidence[key] = evidence
  assert.equal(native.zoomFactor, 1, 'The isolated Electron fixture must capture at baseline zoom 1')
  assert.ok(controlsBox && modelBox && effortBox, 'Model and effort controls must have physical renderer bounds')
  const intersects = box => box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0
  assert.ok(intersects(controlsBox) && intersects(modelBox) && intersects(effortBox), 'Model and effort controls must intersect the actual Electron content viewport')
  const left = Math.max(0, Math.floor(Math.min(modelBox.x, effortBox.x) - 12))
  const top = Math.max(0, Math.floor(Math.min(modelBox.y, effortBox.y) - 12))
  const right = Math.min(viewport.width, Math.ceil(Math.max(modelBox.x + modelBox.width, effortBox.x + effortBox.width) + 12))
  const bottom = Math.min(viewport.height, Math.ceil(Math.max(modelBox.y + modelBox.height, effortBox.y + effortBox.height) + 12))
  const clip = { x: left, y: top, width: right - left, height: bottom - top }
  evidence.clip = clip
  assert.ok(clip.width > 0 && clip.height > 0, 'Visible model and effort controls must produce a non-empty screenshot clip')
  const path = join(output, filename)
  const png = await page.screenshot({ path, clip })
  evidence.screenshot = { bytes: png.length, ihdr: pngIhdr(png) }
  assert.deepEqual(evidence.screenshot.ihdr, { width: clip.width, height: clip.height }, 'Control screenshot dimensions must match its exact visible renderer clip')
  return evidence
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.agentControl))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(1)
  const requestedContentSize = { width: 1600, height: 1000 }
  const nativeWindow = await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('Electron BrowserWindow is unavailable')
    window.setContentSize(size.width, size.height, false)
    return { bounds: window.getBounds(), contentBounds: window.getContentBounds(), focused: window.isFocused(), visible: window.isVisible(), zoomFactor: window.webContents.getZoomFactor() }
  }, requestedContentSize)
  await expect.poll(async () => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual(requestedContentSize)
  visualEvidence.window = { requestedContentSize, nativeWindow, nativeCapture: await nativeVisualState(), rendererViewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })) }
  const project = await page.evaluate(() => window.conductor.projects.create('Agent settings fixer'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Agent settings fixer' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const sourcePane = page.locator('.structured-agent-pane')
  await expect(sourcePane.getByRole('textbox', { name: 'Message Codex', exact: true })).toBeEnabled()
  sourceId = await sourcePane.getAttribute('data-structured-session')
  assert.ok(sourceId)
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'synthetic:steer', { ...state.settings, model: 'gpt-6-astra', effort: 'xhigh' }, [])
  }, sourceId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const owner = await credentials()
  const tools = await call(owner, 'tools.list')
  assert.ok(tools['agents.configure'], 'tools.list advertises agents.configure')
  const catalog = await call(owner, 'models.list')
  const codex = catalog.find(entry => entry.provider === 'codex')
  assert.ok(codex?.models.some(model => model.id === 'gpt-6-astra' && model.effort.includes('xhigh')))
  assert.ok(codex?.models.some(model => model.id === 'gpt-5.6-sol' && model.effort.includes('high')))

  const worker = await call(owner, 'tabs.open', { provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh', title: 'Settings worker', focus: false })
  workerId = worker.resourceId
  const safeCatalog = state => ({
    agentSessionId: state?.sessionId ?? worker.resourceId,
    phase: state?.phase ?? null,
    hasNativeSession: Boolean(state?.nativeSessionId),
    models: state?.capabilities?.models?.map(model => ({ id: model.id, effort: model.effort ?? [], defaultEffort: model.defaultEffort })) ?? []
  })
  targetCatalog.beforeConnect = safeCatalog(await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId))
  // ensure() exposes the adapter's configured baseline immediately; only connect() performs the
  // native model/list discovery that agents.configure intentionally treats as authoritative.
  await page.evaluate(id => window.conductor.structured.connect(id), worker.resourceId)
  await expect.poll(async () => page.evaluate(async id => Boolean((await window.conductor.structured.snapshot(id))?.capabilities?.models?.some(model => model.id === 'gpt-5.6-sol')), worker.resourceId)).toBe(true)
  targetCatalog.afterConnect = safeCatalog(await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId))
  const guarded = await page.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, permission: 'read-only', sandbox: 'read-only', browserMcp: false }
    await window.conductor.structured.saveSettings(id, settings)
    return settings
  }, worker.resourceId)
  const invalidBefore = await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId)
  await refuse(owner, 'agents.configure', { agentSessionId: worker.resourceId, model: 'not-in-provider-catalog', effort: 'high' }, /exact model/i)
  const invalidAfter = await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId)
  assert.deepEqual(invalidAfter.settings, invalidBefore.settings)
  check('Invalid model is refused without changing durable settings')

  const configured = await call(owner, 'agents.configure', { agentSessionId: worker.resourceId, model: 'gpt-5.6-sol', effort: 'high' })
  assert.equal(configured.provider, 'codex')
  assert.equal(configured.model, 'gpt-5.6-sol')
  assert.equal(configured.effort, 'high')
  assert.equal(configured.effective, 'next-turn')
  const snapshot = await call(owner, 'agents.snapshot', { agentSessionId: worker.resourceId })
  assert.equal(snapshot.settings.model, 'gpt-5.6-sol')
  assert.equal(snapshot.settings.effort, 'high')
  assert.equal(snapshot.settings.permission, guarded.permission)
  assert.equal(snapshot.settings.sandbox, guarded.sandbox)
  assert.equal(snapshot.settings.browserMcp, guarded.browserMcp)
  const state = await call(owner, 'app.state')
  const visible = state.tabs.find(tab => tab.resourceId === worker.resourceId)
  assert.equal(visible.state.model, 'gpt-5.6-sol')
  assert.equal(visible.state.effort, 'high')
  await page.evaluate(scope => window.conductor.agentControl.focusTab(scope.projectId, scope.sessionId, scope.tabId), { projectId: project.id, sessionId: state.workspace.id, tabId: worker.id })
  const workerPane = page.locator('[data-structured-session="' + worker.resourceId + '"]')
  await expect(workerPane).toBeVisible()
  const controls = workerPane.locator('.agent-prompt-controls')
  const modelControl = workerPane.getByRole('combobox', { name: 'Model' })
  const effortControl = workerPane.getByRole('slider', { name: 'Reasoning effort' })
  await controls.scrollIntoViewIfNeeded()
  await expect(controls).toBeVisible()
  await expect(modelControl).toBeVisible()
  await expect(modelControl).toContainText(/GPT[- ]5\.6 Sol/)
  await expect(effortControl).toBeVisible()
  await expect(effortControl).toHaveAttribute('aria-valuetext', /^high$/i)
  await captureVisibleControls('configured', controls, modelControl, effortControl, 'configured-model-effort-controls.png')
  await page.screenshot({ path: join(output, 'configured-coworker-full-page.png'), fullPage: true })
  check('Successful configure agrees across picker, snapshot, layout, and unchanged authority settings')

  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.agentControl))
  await page.locator('.project-row').filter({ hasText: 'Agent settings fixer' }).click()
  await page.evaluate(scope => window.conductor.agentControl.focusTab(scope.projectId, scope.sessionId, scope.tabId), { projectId: project.id, sessionId: state.workspace.id, tabId: worker.id })
  const reloadedPane = page.locator('[data-structured-session="' + worker.resourceId + '"]')
  const reloadedControls = reloadedPane.locator('.agent-prompt-controls')
  const reloadedModelControl = reloadedPane.getByRole('combobox', { name: 'Model' })
  const reloadedEffortControl = reloadedPane.getByRole('slider', { name: 'Reasoning effort' })
  await reloadedControls.scrollIntoViewIfNeeded()
  await expect(reloadedControls).toBeVisible()
  await expect(reloadedModelControl).toBeVisible()
  await expect(reloadedModelControl).toContainText(/GPT[- ]5\.6 Sol/)
  await expect(reloadedEffortControl).toBeVisible()
  await expect(reloadedEffortControl).toHaveAttribute('aria-valuetext', /^high$/i)
  await captureVisibleControls('reloaded', reloadedControls, reloadedModelControl, reloadedEffortControl, 'reloaded-model-effort-controls.png')
  const reloaded = await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId)
  assert.equal(reloaded.settings.model, 'gpt-5.6-sol')
  assert.equal(reloaded.settings.effort, 'high')
  check('Configured model and effort survive a real renderer reload')

  await call(owner, 'agents.submit', { agentSessionId: worker.resourceId, prompt: 'synthetic:context' })
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId))?.phase).toBe('completed')
  const native = await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId)
  assert.equal(native.capabilities.effectiveSettings.model, 'gpt-5.6-sol')
  assert.equal(native.capabilities.effectiveSettings.effort, 'high')
  assert.equal(native.settings.permission, guarded.permission)
  assert.equal(native.settings.browserMcp, guarded.browserMcp)
  check('Next accepted native turn carries the configured model and reasoning effort')

  await call(owner, 'agents.submit', { agentSessionId: worker.resourceId, prompt: 'synthetic:steer' })
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId))?.phase).toBe('running')
  await refuse(owner, 'agents.configure', { agentSessionId: worker.resourceId, model: 'gpt-6-astra', effort: 'xhigh' }, /idle|current turn/i)
  const running = await page.evaluate(id => window.conductor.structured.snapshot(id), worker.resourceId)
  assert.equal(running.settings.model, 'gpt-5.6-sol')
  assert.equal(running.settings.effort, 'high')
  await call(owner, 'agents.interrupt', { agentSessionId: worker.resourceId })
  check('Running coworker is refused without interruption or settings drift')

  await page.screenshot({ path: join(output, 'configured-coworker.png') })
  assert.deepEqual(errors, [])
} catch (error) {
  failure = error
  process.exitCode = 1
  failureStamp = new Date().toISOString().replace(/[:.]/g, '-')
  try { await page.screenshot({ path: join(output, `failure-${failureStamp}.png`), fullPage: true }) }
  catch (captureError) { errors.push('Failure screenshot: ' + (captureError instanceof Error ? captureError.message : String(captureError))) }
} finally {
  // Both fixture scenarios intentionally leave a native turn running. Stop only the exact
  // sessions created above; never depend on the global close guard to discard their work.
  try {
    const stopped = await page.evaluate(async ids => {
      const active = new Set(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
      const result = []
      for (const id of ids.filter(Boolean)) {
        const before = await window.conductor.structured.snapshot(id)
        let interrupted = false
        if (before && active.has(before.phase)) { await window.conductor.structured.interrupt(id); interrupted = true }
        result.push({ id, phase: before?.phase ?? null, interrupted })
      }
      return result
    }, [workerId, sourceId])
    cleanup.push(...stopped)
    for (const id of [workerId, sourceId].filter(Boolean)) {
      await expect.poll(async () => page.evaluate(sessionId => window.conductor.structured.snapshot(sessionId).then(state => state?.phase ?? null), id)).not.toMatch(/^(starting|running|waiting_approval|waiting_input|interrupting)$/)
    }
  } catch (cleanupError) {
    errors.push('Session cleanup: ' + (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)))
    if (!failure) { failure = cleanupError; process.exitCode = 1 }
  }
  try {
    // Global close confirmation uses response 0 for the affirmative synthetic quit action.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    const child = app.process()
    const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
    await app.close()
    cleanup.push({ appExited: true, ...(child.exitCode === null ? await exited : { code: child.exitCode, signal: child.signalCode }) })
  } catch (cleanupError) {
    errors.push('Electron cleanup: ' + (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)))
    if (!failure) { failure = cleanupError; process.exitCode = 1 }
  }
  const report = { checks, errors, failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack } : failure === null ? null : String(failure), cleanup, targetCatalog, visualEvidence, inference: 'none', providerBoundary: 'synthetic Codex app server' }
  try {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
    if (failureStamp) await writeFile(join(output, `failure-${failureStamp}.json`), JSON.stringify(report, null, 2), { flag: 'wx' })
  } catch (reportError) {
    if (!failure) { failure = reportError; process.exitCode = 1 }
  }
}

if (failure) throw failure
