// FX32: a classifier denial becomes one narrow owner approval, and the tab carries on by itself.
// Replays the auto-mode classifier denial recorded in the haftheme controller's session on
// 2026-09-25 (scripts/fixtures/haftheme-denial-2026-09-25.json) with harmless stand-ins:
//   local write unaffected -> denial -> card with exact action/resource/category/rule ->
//   Approve once -> the tab is handed exactly that rule and retries by itself -> the once-grant is
//   spent -> a different sensitive action is still refused -> Deny keeps it blocked -> Approve for
//   this session -> the grant is gone when the tab closes.
// Real Electron main/preload/renderer; only the Claude process is the synthetic fixture
// (scripts/fixtures/fake-claude.mjs, SYNTHETIC CLASSIFIER), so no inference happens and nothing is
// executed. What it cannot show is whether the real CLI lets the rule decide before its classifier:
// that stays UNCONFIRMED in docs/permissions-classifier.md. CONDUCTOR_TEST_USER_DATA parks the window.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-permission-grant.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-permission-grant-'))
const output = resolve('artifacts/fx32/permission-grant')
await mkdir(output, { recursive: true })
const flagLog = join(root, 'flag-settings.log')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_FLAG_SETTINGS_LOG: flagLog,
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const grantsState = () => page.evaluate(() => window.conductor.permissionGrants.state())
const flags = async () => (await readFile(flagLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const denials = async id => (await snapshot(id)).items.filter(item => item.data.type === 'notice' && item.data.payload?.autoModeDenial)
const settled = async id => expect.poll(async () => (await snapshot(id))?.phase, { timeout: 20000 }).toMatch(/^(completed|idle)$/)
const submit = (id, text) => page.evaluate(async ([value, prompt]) => {
  const state = await window.conductor.structured.snapshot(value)
  await window.conductor.structured.submit(value, prompt, state.settings, [])
}, [id, text])
const card = nativeItemId => page.locator(`article[data-native-item-id="${nativeItemId}"] .sa-grant-card`)

try {
  await page.waitForFunction(() => Boolean(window.conductor?.permissionGrants))
  await page.evaluate(() => window.conductor.projects.create('Permission grant'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Permission grant' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first().click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async value => {
    await window.conductor.structured.connect(value)
    const state = await window.conductor.structured.snapshot(value)
    await window.conductor.structured.saveSettings(value, { ...state.settings, permission: 'auto' })
  }, id)
  const cwd = (await page.evaluate(value => window.conductor.structured.snapshot(value), id)).cwd ?? null

  // 1. Ordinary local work is untouched: no card, no grant, the file is written.
  await submit(id, 'SYNTHETIC CLASSIFIER LOCAL write a note')
  await settled(id)
  assert.equal((await denials(id)).length, 0)
  assert.deepEqual((await grantsState()).grants, [])
  check('A local project write runs in Auto with no denial, no card and no grant')

  // 2. The recorded denial, replayed: one structured card with the exact call.
  await submit(id, 'SYNTHETIC CLASSIFIER WRITE the pool fix script')
  await settled(id)
  const [writeDenial] = await denials(id)
  assert.ok(writeDenial, 'The replayed denial must become a notice')
  const request = writeDenial.data.payload.autoModeDenial.request
  assert.equal(writeDenial.data.payload.autoModeDenial.reason, 'Modify Shared Resources')
  assert.equal(request.action, 'Write a file')
  assert.match(request.resource, /app[\\/]prod[\\/]fix-pool\.sh$/)
  assert.equal(request.class, 'local')
  assert.match(request.rule, /^Edit\(\/\/[a-z]\/.*\/app\/prod\/fix-pool\.sh\)$/)
  assert.equal(request.category, 'Modify Shared Resources')
  assert.ok((await snapshot(id)).items.some(item => item.data.type === 'tool' && item.data.name === 'Write' && item.data.status === 'failed'))
  const writeCard = card(writeDenial.nativeItemId)
  await expect(writeCard).toBeVisible()
  await expect(writeCard).toContainText('Modify Shared Resources')
  await expect(writeCard).toContainText(request.rule)
  await expect(writeCard.getByRole('button', { name: 'Approve once' })).toBeEnabled()
  await expect(writeCard.getByRole('button', { name: 'Approve for this session' })).toBeEnabled()
  await expect(writeCard.getByRole('button', { name: 'Deny' })).toBeEnabled()
  await page.screenshot({ path: join(output, 'denial-card.png') })
  check(`The replayed denial shows one card: ${request.action}, ${request.resource}, ${request.category}, ${request.class}, ${request.rule}`)

  // 3. Approve once: exactly that rule reaches the live CLI, the tab retries by itself, and the grant is spent.
  await writeCard.getByRole('button', { name: 'Approve once' }).click()
  await expect.poll(async () => (await flags()).some(entry => entry.applied?.length === 1 && entry.applied[0] === request.rule)).toBe(true)
  await expect.poll(async () => (await snapshot(id)).items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.startsWith('[Conductor] approved: ' + request.rule))).toBe(true)
  await expect.poll(async () => (await snapshot(id)).items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text === 'SYNTHETIC classified call ran: ' + request.rule), { timeout: 20000 }).toBe(true)
  await settled(id)
  assert.ok((await stat(request.resource)).isFile(), 'The retried write created the stand-in script')
  await expect.poll(async () => (await grantsState()).grants.length).toBe(0)
  await expect.poll(async () => (await flags()).at(-1)?.applied?.length).toBe(0)
  await expect.poll(async () => (await grantsState()).requests.find(entry => entry.id === writeDenial.nativeItemId)?.status).toBe('used')
  await expect(writeCard).toContainText('Approved once, and used')
  check('Approve once handed the live tab exactly that rule, the tab retried and wrote the script, and the grant was spent and withdrawn')

  // 4. A different sensitive action is still refused; Deny keeps it blocked.
  await submit(id, 'SYNTHETIC CLASSIFIER OTHER restart the web server')
  await settled(id)
  const other = (await denials(id)).at(-1)
  const otherRequest = other.data.payload.autoModeDenial.request
  assert.notEqual(other.nativeItemId, writeDenial.nativeItemId)
  assert.equal(otherRequest.class, 'external')
  assert.equal(otherRequest.host, '192.0.2.10')
  const otherCard = card(other.nativeItemId)
  await expect(otherCard).toContainText('External: reaches another machine or service')
  check('A different sensitive action (ssh to another host) is still refused, and its card names it external with its host')
  await otherCard.getByRole('button', { name: 'Deny' }).click()
  await expect.poll(async () => (await snapshot(id)).items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text === 'SYNTHETIC: understood; not retrying it.')).toBe(true)
  await settled(id)
  await submit(id, 'SYNTHETIC CLASSIFIER RETRY the same call')
  await settled(id)
  const again = (await denials(id)).at(-1)
  assert.notEqual(again.nativeItemId, other.nativeItemId, 'The retry after Deny is refused again, as a new denial')
  assert.equal((await grantsState()).grants.length, 0)
  await expect(otherCard).toContainText('Denied')
  check('Deny kept it blocked: the tab was told not to retry, and a retry was refused again with no grant in force')

  // 5. Approve for this session, then close the tab: the grant ends with it.
  await card(again.nativeItemId).getByRole('button', { name: 'Approve for this session' }).click()
  await expect.poll(async () => (await snapshot(id)).items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text === 'SYNTHETIC classified call ran: ' + otherRequest.rule), { timeout: 20000 }).toBe(true)
  await settled(id)
  assert.equal((await grantsState()).grants.filter(grant => grant.agentSessionId === id && grant.scope === 'session').length, 1)
  await expect(card(again.nativeItemId)).toContainText('Approved for this session · in force now')
  await expect(card(again.nativeItemId).getByRole('button', { name: 'Revoke' })).toBeVisible()
  await page.screenshot({ path: join(output, 'session-grant.png') })
  await page.locator('.pane-tab').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click()
  // Closing only changes the layout; the grant service notices the tab is gone (two sweeps) and
  // hands the runtime, which may still run for the undo window, an empty rule set.
  await expect.poll(async () => (await grantsState()).grants.filter(grant => grant.agentSessionId === id).length, { timeout: 15000 }).toBe(0)
  await expect.poll(async () => (await flags()).at(-1)?.applied?.length, { timeout: 10000 }).toBe(0)
  check('Approve for this session let the tab run it; closing the tab ended the grant and took the rule back out of the runtime')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw Claude process replaying the recorded haftheme denial', cwd, flagSettings: await flags() }, null, 2))
  console.log('\nsmoke-permission-grant: ' + checks.length + ' checks passed')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close().catch(() => {})
}
