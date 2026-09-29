import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The Production drawer and the production queue pane in the built app (docs/production-agent.md
// section 9, module M3), parked off-screen under CONDUCTOR_TEST_USER_DATA. The audit engine and its
// IPC handlers (M7/M8) may not exist yet, so the smoke installs a small in-main fixture behind the
// real PRODUCTION_IPC channels unless a handler is already registered; the renderer, preload bridge
// and registrations under test are the real ones.
//
//   node scripts/smoke-lock.mjs -- node scripts/smoke-production-panel.mjs
//   CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-production-panel-smoke-'))
const output = resolve('artifacts/production-panel-smoke')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_LOCAL_ROOT: 'D:\\conductor-production-smoke-no-local-models'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_UPDATE_DEV
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
const result = { actualElectron: true, fixture: null, checks: [], errors: [] }
const check = label => { result.checks.push(label); console.log('PASS ' + label) }

/** Installs the fixture handlers in the main process; returns 'fixture' or 'real' (handlers already there). */
const installFixture = projectId => app.evaluate(({ ipcMain, BrowserWindow }, projectId) => {
  const T = '2026-09-29T08:00:00.000Z'
  const fp = { environmentId: 'env-prod', commit: '0123456789abcdef0123456789abcdef01234567', build: 'build-42', configHash: 'c', policyHash: 'p', dependencyHash: 'd', routesHash: 'r', profileVersion: 3, registryVersion: 1, computedAt: T }
  const ledger = { tokens: 12345, modelCalls: 3, requests: 211, elapsedMs: 300000, byRole: { classify: { calls: 2, tokens: 2000 }, interpret: { calls: 1, tokens: 10345 }, 'verify-review': { calls: 0, tokens: 0 } }, exhausted: null }
  const cov = { tested: [{ path: '/', devices: ['desktop'], consentStates: ['clean'], authStates: ['guest'] }], sampled: [], excluded: [], unobservable: [] }
  const facts = Object.fromEntries(['legalEntity', 'targetCountries', 'businessModel', 'products', 'accountFeatures', 'subscriptions', 'userUploads', 'aiRuntime', 'analytics', 'sessionReplay', 'emailMarketing', 'dataCategories', 'audience', 'ageRestrictedProducts', 'paymentProviders', 'processors', 'safeHarborReliance'].map(key => [key, { value: null, status: 'unknown', source: null, at: null }]))
  const environment = { id: 'env-prod', kind: 'production', label: 'Production', baseUrl: 'https://shop.example.com', allowedOrigins: ['https://shop.example.com'], accounts: [], capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null }
  const gate = (id, state, reasons) => ({ projectId: id, environmentId: 'env-prod', state, reasons, runId: 'run-1', fingerprint: fp, staleControls: [], openCriticalOrHigh: 0, unverifiedControls: [], humanReviewPending: 0, openQuestions: 0, activeWaivers: 0, results: [], computedAt: T })
  const snapshot = {
    projectId, registryVersion: 1, browser: { available: true, engine: 'playwright-chromium', reason: null }, activeRun: null,
    profile: {
      projectId, version: 3, updatedAt: T, updatedBy: 'owner', designation: { productionReady: true, by: 'owner', at: T, note: '', environmentId: 'env-prod' },
      facts, environments: [environment], writeAuthorizations: [],
      scope: { routes: [], journeys: [], devices: ['desktop', 'mobile'], locales: [], regionSelection: 'none', authStates: ['guest'], consentStates: ['clean'], disabledControls: [] },
      stack: null, budget: { maxTokens: 120000, maxModelCalls: 40, maxRequests: 2000, maxDurationMs: 2700000, requestsPerSecondPerOrigin: 4, maxCostUsdPerCall: 0.5 },
      drift: { enabled: false, everyMinutes: 1440, onChange: 'mark-stale' },
      questions: [{ id: 'q-analytics', factKey: 'analytics', question: 'Are analytics, advertising pixels or other tracking intended on the site? (yes/no)', why: 'Decides whether consent is required before tracking.', blocksControls: ['C03', 'C05'], status: 'open', answer: null, answeredAt: null, answeredBy: null, createdAt: T }]
    },
    gate: { ...gate(projectId, 'NEEDS_REVIEW', ['C03 FAIL: Google Analytics fires before consent (high, confirmed)', 'Owner question open: analytics']), openCriticalOrHigh: 1, openQuestions: 1, results: [{ controlId: 'C03', status: 'FAIL' }, { controlId: 'C13', status: 'PASS' }] },
    runs: [{ id: 'run-1', kind: 'audit', environmentId: 'env-prod', status: 'completed', statusReason: null, trigger: { kind: 'manual', by: { kind: 'owner', agentSessionId: null, title: null }, at: T, changes: [], detail: '' }, fingerprint: fp, progress: { done: 21, total: 21, currentStep: null }, ledger, createdAt: T, finishedAt: '2026-09-29T08:20:00.000Z', reportPaths: { markdown: 'report.md', json: 'report.json' } }],
    findings: [{
      id: 'f-tracker', projectId, environmentId: 'env-prod', controlId: 'C03', checkId: 'consent-before-interaction', key: 'tracker-before-consent:ga4', route: '/', component: null, scope: 'page', category: 'legal', severity: 'high', confidence: 'confirmed',
      title: 'Google Analytics fires before consent', expected: 'No analytics request before the visitor chooses', observed: 'GET https://www.google-analytics.com/g/collect on first load',
      reproduction: ['Open / in a clean profile', 'Do not interact with the banner'], evidence: ['ev-requests-1'], proposedFix: 'Load gtag only after consent grants analytics.', owner: 'engineering',
      legal: { sources: [{ kind: 'primary-law', title: 'ePrivacy Directive art. 5(3)', jurisdiction: 'EU', url: null, effectiveDate: '2002-07-31', retrievedAt: null, reviewBy: '2027-01-01' }], effectiveDate: '2002-07-31', reviewBy: '2027-01-01' },
      sources: ['V2-01'], applicability: { status: 'applicable', rationale: 'Analytics is intended', factsUsed: [], ruleIndex: 0 }, status: 'open', verification: null,
      firstSeenRunId: 'run-1', lastSeenRunId: 'run-1', lastSeenFingerprint: fp, occurrences: 1, taskId: null, waiverId: null, createdAt: T, updatedAt: T
    }],
    waivers: [],
    results: [
      { runId: 'run-1', controlId: 'C03', status: 'FAIL', applicability: { status: 'applicable', rationale: 'Analytics is intended', factsUsed: [], ruleIndex: 0 }, rationale: 'Tracker before consent', evidence: [], findingIds: ['f-tracker'], humanReview: [], checks: [], coverage: cov, provenance: [] },
      { runId: 'run-1', controlId: 'C13', status: 'PASS', applicability: { status: 'applicable', rationale: 'Always applies to a public site', factsUsed: [], ruleIndex: null }, rationale: '', evidence: [], findingIds: [], humanReview: [{ id: 'hr-1', controlId: 'C13', question: 'Check screen reader order on checkout', why: 'axe cannot judge reading order', route: '/checkout', evidence: [] }], checks: [], coverage: cov, provenance: [] }
    ]
  }
  const others = [
    { projectId: 'other-verified', projectName: 'Settled shop', state: 'VERIFIED', reasons: [] },
    { projectId: 'other-blocked', projectName: 'Blocked shop', state: 'BLOCKED', reasons: ['No audit browser available'] }
  ]
  const state = { snapshot, calls: [] }
  globalThis.__productionSmoke = state
  const changed = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('production:changed', projectId) }
  const clone = value => JSON.parse(JSON.stringify(value))
  const handlers = {
    'production:snapshot': id => id === projectId ? clone(state.snapshot) : { ...clone(state.snapshot), projectId: id, profile: null, findings: [], runs: [], results: [], gate: gate(id, 'NOT_AUDITED', ['No completed audit']) },
    'production:queue': () => [
      ...others.map(other => ({ projectId: other.projectId, projectName: other.projectName, designation: state.snapshot.profile.designation, gate: gate(other.projectId, other.state, other.reasons), activeRun: null, openFindings: { critical: 0, high: 0, other: 0 }, openQuestions: 0, lastCompletedAt: T })),
      { projectId, projectName: 'Production smoke', designation: state.snapshot.profile.designation, gate: clone(state.snapshot.gate), activeRun: null, openFindings: { critical: 0, high: state.snapshot.findings.filter(f => f.status === 'open').length, other: 0 }, openQuestions: state.snapshot.profile.questions.filter(q => q.status === 'open').length, lastCompletedAt: '2026-09-29T08:20:00.000Z' }
    ],
    'production:answer-question': (id, questionId, answer) => {
      const question = state.snapshot.profile.questions.find(item => item.id === questionId)
      if (!question || question.status !== 'open') throw new Error('No open question ' + questionId)
      if (!/^(yes|no)$/i.test(answer)) throw new Error('Answer analytics with yes or no')
      Object.assign(question, { status: 'answered', answer, answeredAt: new Date().toISOString(), answeredBy: 'owner' })
      state.snapshot.profile.facts.analytics = { value: /^yes$/i.test(answer), status: 'evidenced', source: 'owner', at: new Date().toISOString() }
      state.snapshot.profile.version += 1
      state.snapshot.gate.openQuestions = 0
      state.snapshot.gate.reasons = state.snapshot.gate.reasons.filter(reason => !reason.startsWith('Owner question'))
      changed(); return clone(state.snapshot.profile)
    },
    'production:waive': (id, request) => {
      if (!request.expiresAt || !(Date.parse(request.expiresAt) > Date.now())) throw new Error('A waiver needs a future expiry')
      const waiver = { id: 'waiver-1', projectId: id, findingId: request.findingId, reason: request.reason, scope: request.scope, owner: request.owner, grantedBy: { kind: 'owner', agentSessionId: null, title: null }, grantedAt: new Date().toISOString(), expiresAt: request.expiresAt, revokedAt: null, revokedReason: null }
      state.snapshot.waivers.unshift(waiver)
      const finding = state.snapshot.findings.find(item => item.id === request.findingId)
      finding.status = 'waived'; finding.waiverId = waiver.id
      changed(); return clone(waiver)
    },
    'production:open-evidence': () => undefined,
    'production:open-report': () => undefined
  }
  let installed = 'fixture'
  for (const [channel, handler] of Object.entries(handlers)) {
    try { ipcMain.handle(channel, (_event, ...args) => { state.calls.push({ channel, args }); return handler(...args) }) }
    catch { installed = 'real' }
  }
  return installed
}, projectId)

try {
  await page.waitForFunction(() => Boolean(window.conductor?.projects))
  const bridgeKeys = await page.evaluate(() => Object.keys(window.conductor.production ?? {}).sort())
  for (const key of ['snapshot', 'queue', 'answerQuestion', 'waive', 'designate', 'audit', 'verify', 'onChanged']) assert.ok(bridgeKeys.includes(key), `window.conductor.production lacks ${key}`)
  check('The preload mounts window.conductor.production with the full ProductionBridge')

  const project = await page.evaluate(() => window.conductor.projects.create('Production smoke'))
  result.fixture = await installFixture(project.id)
  assert.equal(result.fixture, 'fixture', 'real production IPC handlers are registered; this smoke assumes the fixture (update it for M8)')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()
  await page.locator('.activity-rail').getByRole('button', { name: 'Production', exact: true }).click()
  const pane = page.locator('.production-pane').first()
  await expect(pane.locator('.production-gate[data-state="NEEDS_REVIEW"]')).toBeVisible()
  await expect(pane.getByText('C03 FAIL: Google Analytics fires before consent (high, confirmed)')).toBeVisible()
  await expect(pane.getByText('commit 0123456789 · build build-42', { exact: false })).toBeVisible()
  await expect(pane.getByRole('checkbox', { name: 'Production-ready' })).toBeChecked()
  await expect(pane.locator('tr[data-control="C03"]')).toContainText('Fail')
  await expect(pane.getByText('Check screen reader order on checkout', { exact: false })).toBeAttached()
  const fit = await pane.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  assert.ok(fit.scroll <= fit.client + 1, `the drawer content overflows sideways (${fit.scroll} > ${fit.client})`)
  await expect(page.getByTitle('Close workspace view')).toBeInViewport()
  check('The rail opens the Production drawer with the gate, its reasons, the fingerprint, designation and control table')

  await expect(pane.getByText('Blocks C03 Cookies and consent behavior, C05 Vendors, external fonts and AI')).toBeVisible()
  await pane.getByLabel('Answer: analytics').fill('yes')
  await pane.getByRole('button', { name: 'Answer', exact: true }).click()
  await expect(pane.getByText('No open owner questions.')).toBeVisible()
  await expect(pane.getByText('Owner question open: analytics')).toHaveCount(0)
  check('An owner question is answered inline and the panel reloads on production:changed')

  await pane.getByRole('button', { name: /Google Analytics fires before consent/ }).click()
  const detail = pane.getByRole('article', { name: 'Finding Google Analytics fires before consent' })
  await expect(detail.getByText('No analytics request before the visitor chooses')).toBeVisible()
  await detail.getByRole('button', { name: 'ev-requests-1' }).click()
  await expect.poll(() => app.evaluate(() => globalThis.__productionSmoke.calls.filter(call => call.channel === 'production:open-evidence').length)).toBe(1)
  check('A finding opens its detail and its evidence link reaches production:open-evidence')

  await detail.getByRole('button', { name: 'Waive…' }).click()
  const waiverForm = pane.getByRole('form', { name: 'Waive Google Analytics fires before consent' })
  await waiverForm.getByRole('button', { name: 'Grant waiver' }).click()
  await expect(waiverForm.getByText('An expiry date is required; waivers never last forever.')).toBeVisible()
  assert.equal(await app.evaluate(() => globalThis.__productionSmoke.calls.filter(call => call.channel === 'production:waive').length), 0, 'an invalid waiver reached the bridge')
  await waiverForm.getByLabel('Reason').fill('Consent mode ships next sprint')
  await waiverForm.getByLabel('Scope').fill('site')
  await waiverForm.getByLabel('Risk owner').fill('Owner')
  await waiverForm.getByLabel('Expires on').fill('2027-01-31')
  await waiverForm.getByRole('button', { name: 'Grant waiver' }).click()
  await expect(pane.getByRole('region', { name: 'Waivers' }).getByText('Consent mode ships next sprint', { exact: false })).toBeVisible()
  await expect(pane.locator('li[data-finding-id="f-tracker"]')).toHaveAttribute('data-status', 'waived')
  check('The waiver form refuses a missing expiry, then grants a waiver that keeps the finding as waived')

  const text = await pane.innerText()
  assert.ok(!text.includes('%'), 'the Production panel shows a percentage')
  await writeFile(join(output, 'production-drawer.png'), await page.screenshot())

  await pane.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = page.locator('table.production-queue')
  await expect(queue).toBeVisible()
  const names = await queue.locator('tbody tr strong').allInnerTexts()
  assert.deepEqual(names, ['Blocked shop', 'Production smoke', 'Settled shop'])
  assert.ok(!(await page.locator('.production-queue-pane').innerText()).includes('%'), 'the queue shows a percentage')
  await writeFile(join(output, 'production-queue.png'), await page.screenshot())
  check('The drawer header opens the production queue tab, ordered BLOCKED before NEEDS_REVIEW before VERIFIED')

  await page.getByTitle('Close workspace view').click()
  await expect(page.locator('.production-gate')).toHaveCount(0)
  await queue.getByRole('button', { name: 'Open Production for Production smoke' }).click()
  await expect(page.locator('.production-pane .production-gate').first()).toBeVisible()
  check('A queue row opens that project’s Production drawer')

} catch (error) {
  result.errors.push(error.stack ?? String(error)); process.exitCode = 1
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined)
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2))
  await app.close().catch(() => undefined)
  console.log(process.exitCode ? 'FAIL production panel smoke' : `PASS production panel smoke (${result.checks.length} checks)`)
}
