// feature-list conductor-task:3a590e76: the owner was typing into a wizard tab when it handed itself
// on (agents.handoff successor:true). The composer froze (it was disabled the moment the
// "Continued in" notice arrived) and the half-typed message had to be copied over by hand. Now the
// open tab takes the owner to the successor, the unsent draft and caret go along, and typing
// simply continues there.
//
// Real Electron main/preload/renderer and the real loopback control broker; only the Claude
// process is the synthetic fixture (scripts/fixtures/fake-claude.mjs, SYNTHETIC WATCH LOOPS keeps
// the predecessor's step running), so no inference happens. CONDUCTOR_TEST_USER_DATA parks the
// window off every display. Playwright's keyboard sends keys to whatever has focus, so a key that
// lands nowhere during the switch is a key missing from the successor's composer.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-handoff-draft.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

const root = await mkdtemp(join(tmpdir(), 'conductor-handoff-draft-'))
const output = resolve('artifacts/handoff-draft')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt'), stopLog = join(root, 'stop-task.log')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable',
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_STOP_TASK_LOG: stopLog, CONDUCTOR_SMOKE_STEP_MS: '8000',
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const handoff = 'SYNTHETIC WATCH LOOPS successor: continue the swarm.\n\n' + [
  ['Objective', 'Continue controlling the swarm as the wizard.'],
  ['Constraints', 'Local commits only; the controller publishes once.'],
  ['Owned files', 'None; this tab coordinates.'],
  ['Verified findings', 'The owner was typing when this handoff happened.'],
  ['Remaining work', 'Keep going.'],
  ['Artifact references', 'artifacts/handoff-draft/report.json']
].map(([heading, line]) => heading + '\n- ' + line).join('\n\n')

const app = await electron.launch({ args: [process.env.CONDUCTOR_SMOKE_MAIN ?? resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const call = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const payload = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}
const composerOf = id => page.locator(`.structured-agent-pane[data-structured-session="${id}"] textarea[aria-label^="Message"]`)
const report = {}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  await page.evaluate(() => window.conductor.projects.create('Handoff draft'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Handoff draft' }).click()
  await launcherTile(page, 'Claude').first().click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const callerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1', effort: 'high' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'SYNTHETIC WATCH LOOPS keep this step running, then hand off', settings, [])
  }, callerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const caller = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  assert.ok(caller.endpoint && caller.token, 'The wizard must receive its control credential')
  await expect.poll(async () => (await call(caller, 'app.state').catch(() => null))?.wizard, { timeout: 15000 }).toBe(true)
  check('A wizard tab is inside a running step')

  // Watch the predecessor's composer from inside the page: any moment it is disabled is recorded,
  // and so is every key that lands anywhere but a composer textarea.
  const old = composerOf(callerId)
  await expect(old).toBeEnabled()
  await page.evaluate(id => {
    const node = document.querySelector(`.structured-agent-pane[data-structured-session="${id}"] textarea[aria-label^="Message"]`)
    window.__handoffDraft = { disabledSeen: node.disabled, strayKeys: [] }
    new MutationObserver(() => { if (node.disabled) window.__handoffDraft.disabledSeen = true }).observe(node, { attributes: true, attributeFilter: ['disabled'] })
    document.addEventListener('keydown', event => {
      const target = event.target
      if (!(target instanceof HTMLTextAreaElement && target.closest('.structured-agent-pane'))) window.__handoffDraft.strayKeys.push({ key: event.key, target: target?.tagName ?? null })
    }, true)
  }, callerId)
  await old.click()
  const before = 'Half a thought typed before the handoff, '
  await page.keyboard.type(before, { delay: 15 })
  check('The owner is typing into the wizard composer')

  // The handoff happens while the owner keeps typing, a key every 25 ms, straight through the
  // notice, the tab switch and the successor pane's mount.
  const during = 'and these keys arrive while the wizard hands itself on to its successor tab; '
  const handoffCall = call(caller, 'agents.handoff', { handoff, successor: true })
  await page.keyboard.type(during, { delay: 25 })
  const result = await handoffCall
  assert.equal(result.successor, true, JSON.stringify(result))
  const successorId = result.agentSessionId
  await expect.poll(async () => page.locator('.structured-agent-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-structured-session'))), { timeout: 15000 }).toContain(successorId)
  check('The open wizard tab took the owner to its successor by itself')

  const after = 'and this continues in the successor.'
  await page.keyboard.type(after, { delay: 15 })
  const expected = before + during + after
  const next = composerOf(successorId)
  await expect(next).toBeEnabled()
  await expect(next).toBeFocused()
  await expect.poll(async () => next.inputValue()).toBe(expected)
  const caret = await next.evaluate(node => [node.selectionStart, node.selectionEnd])
  assert.deepEqual(caret, [expected.length, expected.length])
  check('The successor composer holds the whole draft, keys typed mid-switch included, and typing continues into it')

  const watch = await page.evaluate(() => window.__handoffDraft)
  report.watch = watch
  assert.equal(watch.disabledSeen, false, 'The predecessor composer was disabled during the handoff')
  assert.deepEqual(watch.strayKeys, [], 'Keys landed outside a composer: ' + JSON.stringify(watch.strayKeys))
  check('The predecessor composer was never disabled and no key landed outside a composer')

  // The old conversation no longer holds the words, so nothing is sent twice or left behind.
  const leftBehind = await page.evaluate(([projectKey, id]) => {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith('conductor.structured.draft.') && key.endsWith(JSON.stringify(id) + ']')) return localStorage.getItem(key)
    }
    return null
  }, [null, callerId])
  assert.equal(leftBehind, null, 'The predecessor still holds a draft: ' + leftBehind)
  check('The predecessor keeps no copy of the moved draft')
  await page.screenshot({ path: join(output, 'successor-composer.png') })

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', callerAgentSessionId: callerId, successorAgentSessionId: successorId, ...report }, null, 2))
  console.log('\nsmoke-handoff-draft: ' + checks.length + ' checks passed')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close().catch(() => {})
}
