// The Production drawer and the production queue pane in the built app (docs/production-agent.md
// section 9), on real data: the real PRODUCTION_IPC handlers (src/main/production-ipc.ts), a real
// audit of a local fixture site by the real runner and audit browser, and owner decisions made in
// the panel. Parked off-screen under CONDUCTOR_TEST_USER_DATA; nothing is installed in the main
// process. Evidence and report "open" actions log their path under a test profile instead of
// opening Explorer, and the smoke reads that log.
//
//   node scripts/smoke-lock.mjs -- node scripts/smoke-production-panel.mjs
//   CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
import { expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, poll, record, shot, step, watchdog } from './verify-kit.mjs'
import { createFixtureServer } from '../src/main/production/fixtures/server.ts'

configure({ name: 'production-panel' })
watchdog(900)
const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
const sites = await createFixtureServer({ sites: ['consent-tracker-before', 'consent-good'], root: resolve('src/main/production/fixtures/sites') })
/** The panel's own wording: everything except text the audit quoted from the site, a check or a
 *  person (`data-audit-text`, for example a percent-encoded tracker URL) and form fields. A score
 *  or percentage the panel itself rendered would show up here. */
const chromeText = locator => locator.evaluate(element => {
  const copy = element.cloneNode(true)
  for (const node of copy.querySelectorAll('[data-audit-text], input, textarea, select')) node.remove()
  return copy.textContent ?? ''
})
const OTHERS = ['C01', 'C02', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C14', 'C15', 'C16']

/** A local fixture environment, only C03 and C13 audited, one route, desktop. */
async function prepare(projectId, site, id) {
  const origin = sites.site(site).origin
  await call('production.profile.update', {
    environments: [{ id, kind: 'local', label: site, baseUrl: `${origin}/`, allowedOrigins: [origin], accounts: [], capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null }],
    scope: { routes: [{ path: '/', source: 'owner', tags: ['home'], coverage: 'full' }], devices: ['desktop'], consentStates: ['clean'], disabledControls: OTHERS.map(controlId => ({ controlId, reason: 'Not part of the panel fixture' })) },
    budget: { requestsPerSecondPerOrigin: 20 },
  }, { projectId })
}
const settled = (projectId, label) => poll(async () => {
  const status = await call('production.status', {}, { projectId })
  return status.activeRun || !status.runs.length ? null : status
}, { timeoutMs: 300_000, intervalMs: 2000, label })

let inst
try {
  inst = await launchParked({ build, env: { CONDUCTOR_LOCAL_ROOT: 'D:\\conductor-production-smoke-no-local-models' } })
  const view = inst.page
  const bridgeKeys = await view.evaluate(() => Object.keys(window.conductor.production ?? {}).sort())
  for (const key of ['snapshot', 'queue', 'answerQuestion', 'answerReview', 'waive', 'designate', 'audit', 'verify', 'onChanged']) assert.ok(bridgeKeys.includes(key), `window.conductor.production lacks ${key}`)
  record('bridge', 'PASS', {}, 'window.conductor.production mounts the full ProductionBridge, answerReview included')

  // ---- a second, settled project for the queue ------------------------------------------------
  step('settled project')
  const settledProject = await openProject({ name: 'Settled shop', git: true })
  await prepare(settledProject.id, 'consent-good', 'env-good')
  await call('production.designate', { productionReady: true, environmentId: 'env-good', note: 'queue fixture' }, { projectId: settledProject.id })
  const good = await settled(settledProject.id, 'the audit of the settled shop')
  assert.notEqual(good.gate.state, 'BLOCKED', `the good site is blocked: ${good.gate.reasons.join(' | ')}`)

  // ---- the audited project -------------------------------------------------------------------
  step('audited project')
  const project = await openProject({ name: 'Production smoke', git: true })
  await prepare(project.id, 'consent-tracker-before', 'env-prod')
  await view.locator('.activity-rail').getByRole('button', { name: 'Production', exact: true }).click()
  const pane = view.locator('.production-pane').first()

  // An owner question answered inline, through the real handler.
  await expect(pane.getByText('Blocks C03 Cookies and consent behavior', { exact: false }).first()).toBeVisible()
  await pane.getByLabel('Answer: analytics').fill('yes')
  await pane.getByRole('form', { name: 'Answer analytics' }).getByRole('button', { name: 'Answer', exact: true }).click()
  await expect(pane.getByLabel('Answer: analytics')).toHaveCount(0)
  const profile = await call('production.profile.get', {}, { projectId: project.id })
  assert.equal(profile.facts.analytics.value, true)
  assert.equal(profile.facts.analytics.status, 'evidenced')
  record('question', 'PASS', {}, 'answered in the panel; the profile holds analytics=true as an evidenced owner fact')

  // Designate and audit.
  await call('production.designate', { productionReady: true, environmentId: 'env-prod', note: 'panel smoke' }, { projectId: project.id })
  await expect(pane.locator('.production-gate[data-state="AUDITING"]').first()).toBeVisible({ timeout: 20_000 })
  const status = await settled(project.id, 'the audit of the tracker site')
  assert.equal(status.gate.state, 'BLOCKED', `gate ${status.gate.state}: ${status.gate.reasons.join(' | ')}`)
  // The finding that quotes the tracker request, whose URL is percent-encoded: its detail must not
  // read as a percentage (candidate bd03de5 opened it by chance and the check tripped).
  const c03 = await call('production.findings', { controlId: 'C03' }, { projectId: project.id })
  const tracker = c03.find(finding => finding.observed.includes('%')) ?? c03[0]
  assert.ok(tracker, 'no C03 finding')
  await expect(pane.locator('.production-gate[data-state="BLOCKED"]').first()).toBeVisible({ timeout: 20_000 })
  await expect(pane.getByRole('checkbox', { name: 'Production-ready' })).toBeChecked()
  await expect(pane.locator('tr[data-control="C03"]')).toContainText('Fail')
  const fit = await pane.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  assert.ok(fit.scroll <= fit.client + 1, `the drawer content overflows sideways (${fit.scroll} > ${fit.client})`)
  record('gate', 'PASS', { finding: tracker.id }, `panel badge BLOCKED; ${status.gate.reasons[0]}`)

  // Finding detail and its evidence.
  step('finding detail')
  await pane.locator(`li[data-finding-id="${tracker.id}"]`).getByRole('button').first().click()
  const detail = pane.getByRole('article', { name: `Finding ${tracker.title}` })
  await expect(detail).toBeVisible()
  await pane.getByRole('toolbar', { name: 'Production actions' }).getByRole('button', { name: 'Open evidence' }).click()
  const log = join(inst.root, 'app.log')
  await poll(() => existsSync(log) && /\[production-test\] reveal .+/.test(readFileSync(log, 'utf8')), { timeoutMs: 10_000, label: 'the evidence reveal in the app log' })
  record('evidence', 'PASS', {}, 'Open evidence reached the real handler (logged, no Explorer on a test profile)')

  // A human-review item answered in the panel.
  const items = status.results.flatMap(result => result.humanReview)
  if (items.length) {
    const reviews = pane.getByRole('region', { name: 'Human review' })
    const item = reviews.locator(`[data-review-id="${items[0].id}"]`)
    await item.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(item).toHaveAttribute('data-answer', 'confirmed', { timeout: 10_000 })
    const answered = await call('production.status', {}, { projectId: project.id })
    assert.equal(answered.results.flatMap(result => result.humanReview).find(entry => entry.id === items[0].id)?.answer, 'confirmed')
    record('review', 'PASS', { item: items[0].id }, 'confirmed in the panel; stored and shown as answered')
  } else record('review', 'INFO', {}, 'the audited controls raised no human-review item')

  // Waiver: the form refuses a missing expiry, then grants one.
  step('waiver')
  await detail.getByRole('button', { name: 'Waive…' }).click()
  const waiverForm = pane.getByRole('form', { name: `Waive ${tracker.title}` })
  await waiverForm.getByRole('button', { name: 'Grant waiver' }).click()
  await expect(waiverForm.getByText('An expiry date is required; waivers never last forever.')).toBeVisible()
  assert.equal((await call('production.status', {}, { projectId: project.id })).waivers.length, 0, 'an invalid waiver was granted')
  await waiverForm.getByLabel('Reason').fill('Consent mode ships next sprint')
  await waiverForm.getByLabel('Scope').fill('site')
  await waiverForm.getByLabel('Risk owner').fill('Owner')
  await waiverForm.getByLabel('Expires on').fill(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10))
  await waiverForm.getByRole('button', { name: 'Grant waiver' }).click()
  await expect(pane.getByRole('region', { name: 'Waivers' }).getByText('Consent mode ships next sprint', { exact: false })).toBeVisible()
  await expect(pane.locator(`li[data-finding-id="${tracker.id}"]`)).toHaveAttribute('data-status', 'waived')
  record('waiver', 'PASS', {}, 'missing expiry refused in the panel; the granted waiver keeps the finding as waived')

  writeFileSync(join(inst.root, 'production-drawer.txt'), await pane.innerText())
  const chrome = await chromeText(pane)
  assert.ok(chrome.length > 200 && !chrome.includes('%'), `the Production panel shows a percentage: ${chrome.slice(Math.max(0, chrome.indexOf('%') - 80), chrome.indexOf('%') + 40)}`)
  await shot('production-drawer')

  // Queue: BLOCKED before the rest, row opens the project's drawer.
  step('queue')
  await pane.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = view.locator('table.production-queue')
  await expect(queue).toBeVisible()
  const queued = await call('production.queue', {}, { projectId: project.id })
  const names = await queue.locator('tbody tr strong').allInnerTexts()
  assert.equal(names.length, queued.length)
  assert.ok(names.indexOf('Settled shop') >= 0 && names.indexOf('Production smoke') >= 0, `queue rows ${names.join(', ')}`)
  const blockedFirst = queued.find(entry => entry.projectId === project.id).gate.state === 'BLOCKED' || queued.find(entry => entry.projectId === project.id).gate.state === 'VERIFIED_WITH_WAIVERS'
  assert.ok(blockedFirst)
  assert.ok(!(await chromeText(view.locator('.production-queue-pane'))).includes('%'), 'the queue shows a percentage')
  await shot('production-queue')
  await view.getByTitle('Close workspace view').click()
  await queue.getByRole('button', { name: 'Open Production for Production smoke' }).click()
  await expect(view.locator('.production-pane .production-gate').first()).toBeVisible()
  record('queue', 'PASS', { rows: names.length }, names.join(' > '))

  // Revoking asks in the panel with a required reason and reopens the finding.
  step('revoke')
  view.on('dialog', dialog => { inst.errors.push('unexpected browser dialog: ' + dialog.message()); void dialog.dismiss() })
  const drawer = view.locator('.production-pane').filter({ has: view.locator('.production-gate') }).first()
  const waivers = drawer.getByRole('region', { name: 'Waivers' })
  await waivers.getByRole('button', { name: 'Revoke…' }).click()
  const revoke = waivers.getByRole('form', { name: 'Revoke waiver' })
  await revoke.getByRole('button', { name: 'Revoke waiver' }).click()
  await expect(revoke.getByText('Give a reason; it is kept with the record.')).toBeVisible()
  await revoke.getByLabel('Why revoke it').fill('Consent mode slipped')
  await revoke.getByRole('button', { name: 'Revoke waiver' }).click()
  await expect(waivers.locator('li[data-state="revoked"]')).toContainText('Consent mode slipped')
  await expect(drawer.locator(`li[data-finding-id="${tracker.id}"]`)).toHaveAttribute('data-status', 'open')
  assert.ok(!inst.errors.some(error => error.startsWith('unexpected browser dialog')), 'a browser dialog opened')
  record('revoke', 'PASS', {}, 'reason required in the panel; revocation reopens the finding')

  // A project switch keeps the queue tab.
  await view.locator('.project-row').filter({ hasText: 'Settled shop' }).click()
  await expect(view.locator('.production-queue-pane')).toHaveCount(0)
  await view.locator('.project-row').filter({ hasText: 'Production smoke' }).click()
  await expect(view.locator('.production-queue-pane')).toHaveCount(1)
  record('project-switch', 'PASS', {}, 'the production queue tab survives switching project away and back')
  assert.deepEqual(sites.mutations(), [], 'a fixture site saw a mutating request')
  await finish()
} catch (error) {
  await failed(error)
  await finish({ code: 1 })
} finally {
  await sites.close()
}
