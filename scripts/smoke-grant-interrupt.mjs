// H06 renderer half: an approval given while the conversation's turn keeps running interrupts that
// turn at once (owner 2026-09-29: any approval, owner or wizard; the 2-min wait and its "Interrupt and
// retry" card action only remain for an interrupt that fails), the tab says so, and the retry runs as
// a turn of its own instead of after the busy turn.
// Real Electron main/preload/renderer; only the Claude process is the synthetic fixture
// (scripts/fixtures/fake-claude.mjs, CONDUCTOR_TEST_CLASSIFIER=approval-turn). The busy turn runs 90 s
// (CONDUCTOR_TEST_BUSY_MS), so a retry that ran within 30 s of the approval ran because of the interrupt.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-grant-interrupt.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-grant-interrupt-'))
const output = resolve('artifacts/h06/grant-interrupt')
await mkdir(output, { recursive: true })
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLASSIFIER: 'approval-turn',
  CONDUCTOR_TEST_BUSY_MS: '90000',
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const grantsState = () => page.evaluate(() => window.conductor.permissionGrants.state())
const denials = async id => (await snapshot(id)).items.filter(item => item.data.type === 'notice' && item.data.payload?.autoModeDenial)
const submit = (id, text) => page.evaluate(async ([value, prompt]) => {
  const state = await window.conductor.structured.snapshot(value)
  await window.conductor.structured.submit(value, prompt, state.settings, [])
}, [id, text])
const card = nativeItemId => page.locator(`article[data-native-item-id="${nativeItemId}"] .sa-grant-card`)
const ran = async (id, rule) => (await snapshot(id)).items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text === 'SYNTHETIC classified call ran: ' + rule)

try {
  await page.waitForFunction(() => Boolean(window.conductor?.permissionGrants?.interrupt))
  await page.evaluate(() => window.conductor.projects.create('Grant interrupt'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Grant interrupt' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first().click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async value => {
    await window.conductor.structured.connect(value)
    const state = await window.conductor.structured.snapshot(value)
    await window.conductor.structured.saveSettings(value, { ...state.settings, permission: 'auto' })
  }, id)

  // 1. A refused call in a turn that keeps working; the owner approves meanwhile.
  await submit(id, 'SYNTHETIC CLASSIFIER BUSY PROBE read the pool config')
  await expect.poll(async () => (await denials(id)).length).toBe(1)
  const [denial] = await denials(id)
  const rule = denial.data.payload.autoModeDenial.request.rule
  const grantCard = card(denial.nativeItemId)
  assert.equal((await snapshot(id)).phase, 'running')
  const clicked = Date.now()
  await grantCard.getByRole('button', { name: 'Approve once' }).click()
  check('The owner approves once while the turn that hit the refusal is still running')

  // 2. Conductor interrupts that turn at once and says so in the tab; no card action is needed.
  const interrupted = async () => (await snapshot(id)).items.find(item => item.data.type === 'notice' && /^The owner approved .*, so Conductor interrupted the running turn; the retry runs now as a message of its own.$/.test(item.data.text ?? item.data.message ?? ''))
  await expect.poll(async () => Boolean(await interrupted()), { timeout: 15000 }).toBe(true)
  const noticeMs = Date.now() - clicked
  const notice = await interrupted()
  assert.equal(notice.data.payload?.permissionGrantWaiting?.interrupted, true)
  assert.ok(!(await snapshot(id)).items.some(item => item.data.type === 'notice' && /queued behind a running turn/.test(item.data.text ?? item.data.message ?? '')), 'no "queued behind" fallback notice')
  await expect(grantCard.getByRole('button', { name: 'Interrupt and retry' })).toHaveCount(0)
  await page.screenshot({ path: join(output, 'interrupted-notice.png') })
  check(`The tab shows "${(notice.data.text ?? notice.data.message).slice(0, 60)}…" ${noticeMs} ms after the approval; no fallback notice, no "Interrupt and retry"`)

  // 3. The retry runs now as a turn of its own, not after the 90 s busy turn.
  await expect.poll(() => ran(id, rule), { timeout: 30000 }).toBe(true)
  const tookMs = Date.now() - clicked
  assert.ok(tookMs < 30000, `The retry ran ${tookMs} ms after the approval`)
  await expect.poll(async () => (await grantsState()).waiting, { timeout: 10000 }).toBe(undefined)
  await expect.poll(async () => (await snapshot(id)).phase, { timeout: 20000 }).toMatch(/^(completed|idle)$/)
  // Since the exact-execution cards (19ba9c9) a spent grant reads "Action succeeded".
  await expect(grantCard).toHaveAttribute('data-grant-status', 'used')
  await expect(grantCard).toContainText('Action succeeded')
  await page.screenshot({ path: join(output, 'after-interrupt.png') })
  check(`The approved call ran ${tookMs} ms after the approval (the busy turn would have run 90 s), and the card is used: "Action succeeded"`)

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw Claude process (approval-turn classifier)' }, null, 2))
  console.log('\nsmoke-grant-interrupt: ' + checks.length + ' checks passed')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close().catch(() => {})
}
