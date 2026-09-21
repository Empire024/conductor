import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Real Electron main/preload/renderer and the real loopback control broker; only the provider
// process is synthetic, so no inference happens. CONDUCTOR_TEST_USER_DATA parks the window off
// every display, which is why this never lands over the owner's screen.
const root = await mkdtemp(join(tmpdir(), 'conductor-handoff-smoke-'))
const output = resolve('artifacts/swarm-2026-09-21/handoff')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

// The bounded handoff format of docs/token-thrift-policy.md. The SYNTHETIC prefix is what the
// offline Claude fixture requires of every prompt; the six sections below are what agents.handoff
// requires, and the prefix line is deliberately not one of them.
const sections = [
  ['Objective', 'Finish the agents.handoff control method and leave it verified.'],
  ['Constraints', 'Additive edits only; the controller commits and publishes the batch.'],
  ['Owned files', 'src/main/agent-control.ts, src/main/agent-control.test.ts, docs/agent-control.md.'],
  ['Verified findings', 'npx tsc --noEmit is clean and all agent-control unit tests pass.'],
  ['Remaining work', 'Run this parked smoke once and record its report; then stop.'],
  ['Artifact references', 'artifacts/swarm-2026-09-21/handoff/report.json']
]
const body = (list) => 'SYNTHETIC Bounded handoff for the receiving conversation.\n\n' + list.map(([heading, line]) => heading + '\n- ' + line).join('\n\n')
const handoff = body(sections)
const missingOwnedFiles = body(sections.filter(([heading]) => heading !== 'Owned files'))

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Native provider must receive the protocol briefing')
  return { endpoint, token }
}
const raw = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return { status: response.status, payload: await response.json() }
}
const call = async (auth, method, args = {}) => {
  const { status, payload } = await raw(auth, method, args)
  assert.equal(status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)

try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  const project = await page.evaluate(() => window.conductor.projects.create('Handoff smoke'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Handoff smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const callerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B open the conversation that will hand its work over', { ...state.settings, model: 'synthetic-claude', effort: 'low' }, [])
  }, callerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const caller = await credentials()
  const tools = await call(caller, 'tools.list')
  assert.ok(tools['agents.handoff'], 'agents.handoff must be discoverable through tools.list')
  const before = await call(caller, 'tabs.list')
  const callerTab = before.find(tab => tab.resourceId === callerId)
  assert.ok(callerTab, 'The calling conversation must have a visible tab')
  check('A synthetic native tab receives its control credential and discovers agents.handoff')

  // A handoff that is not the bounded format is refused by name, and opens nothing.
  const refused = await raw(caller, 'agents.handoff', { handoff: missingOwnedFiles })
  assert.equal(refused.status, 400, JSON.stringify(refused.payload))
  assert.match(refused.payload.error, /Owned files/)
  const refusedAgentSessionId = await raw(caller, 'agents.handoff', { handoff, agentSessionId: callerId })
  assert.match(refusedAgentSessionId.payload.error, /takes no agentSessionId/)
  assert.equal((await call(caller, 'tabs.list')).length, before.length, 'A refused handoff must not open a tab')
  check('A malformed handoff, and any attempt to hand off another conversation, is refused without opening a tab')

  const result = await call(caller, 'agents.handoff', { handoff })
  assert.equal(result.handedOff, true)
  assert.ok(result.agentSessionId && result.tabId && result.uri, 'A handoff returns the new tab identifiers: ' + JSON.stringify(result))
  assert.notEqual(result.agentSessionId, callerId)
  assert.match(result.note, /stop/)
  // The new tab is really on screen, carrying the caller's own provider and model.
  await expect(page.locator('[data-structured-session="' + result.agentSessionId + '"]')).toBeVisible()
  const opened = (await call(caller, 'tabs.list')).find(tab => tab.id === result.tabId)
  assert.ok(opened, 'The handoff tab must appear in tabs.list')
  assert.equal(opened.state.provider, callerTab.state.provider)
  // The caller's *effective* settings, not the label the launcher wrote into its tab state: a
  // tab opened from the launcher still says "default" there after the runtime resolved a model.
  const callerSettings = (await snapshot(callerId)).settings
  assert.equal(opened.state.model, callerSettings.model)
  assert.equal(result.model, callerSettings.model)
  assert.equal(result.permission, callerSettings.permission)
  const receivedSettings = (await snapshot(result.agentSessionId)).settings
  assert.equal(receivedSettings.model, callerSettings.model)
  assert.equal(receivedSettings.permission, callerSettings.permission)
  check('agents.handoff opens a visible fresh tab on the caller’s own provider, model and permission mode')

  // The handoff is that conversation's first message, and it arrived through the ordinary submit
  // path, so the receiver also got the normal first-turn briefing with its own credential.
  await expect.poll(async () => (await snapshot(result.agentSessionId))?.items?.length ?? 0).toBeGreaterThan(0)
  const received = await snapshot(result.agentSessionId)
  const first = received.items.find(item => item.data.type === 'text' && item.data.role === 'user')
  assert.ok(first, 'The handoff tab must hold a user message')
  assert.ok(first.data.text.includes('Objective') && first.data.text.includes('Artifact references'), 'The first user message is the handoff itself: ' + first.data.text.slice(0, 200))
  assert.ok(first.data.text.startsWith('SYNTHETIC Bounded handoff'), 'The handoff is submitted unaltered')
  const receiverPrompt = await readFile(capture, 'utf8')
  assert.ok(receiverPrompt.includes('Remaining work'), 'The receiving runtime is sent the handoff')
  assert.ok(receiverPrompt.includes('Conductor app control:'), 'The receiving runtime still gets its normal first-turn briefing')
  await expect.poll(async () => (await snapshot(result.agentSessionId))?.phase).toBe('completed')
  check('The handoff is the receiving tab’s first user message and it still receives the normal first-turn briefing')

  // The caller is left alone: same tab, same history, not interrupted.
  const callerState = await snapshot(callerId)
  assert.notEqual(callerState.phase, 'interrupted')
  assert.ok((await call(caller, 'tabs.list')).some(tab => tab.resourceId === callerId), 'The caller keeps its own tab')
  // And it may still steer what it opened, exactly as with tabs.open.
  const listed = await call(caller, 'agents.list')
  assert.ok(listed.some(agent => agent.agentSessionId === result.agentSessionId), 'The caller can see the tab it handed to')
  check('The calling conversation keeps its tab and history and retains steering rights over the new one')

  await page.screenshot({ path: join(output, 'context-handoff.png') })
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process', callerAgentSessionId: callerId, handoffAgentSessionId: result.agentSessionId, handoffCharacters: handoff.length }, null, 2))
  console.log('\nsmoke-context-handoff: ' + checks.length + ' checks passed')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(capture, { force: true })
}
