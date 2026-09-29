import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROJECT_AUDIT_STATES, type GateState, type ProductionProjectSnapshot, type ProjectAuditState } from '../../../../shared/production'
import {
  FakeProductionBridge, fakeControlResult, fakeEnvironment, fakeFingerprint, fakeFinding, fakeGate, fakeProfile, fakeQuestion, fakeRun
} from '../../../../shared/production-fake'
import { ProductionPane, ProductionView, type ProductionViewProps } from '../ProductionPane'
import { ProductionQueueView } from '../../panes/ProductionQueuePane'
import { GateBadge } from './GateBadge'
import { QuestionList } from './QuestionList'
import { WaiverForm } from './WaiverForm'
import { DriftSettingsForm } from './DriftSettingsForm'
import { WriteAuthorizations } from './WriteAuthorizations'
import { ReasonForm } from './ReasonForm'
import { ReviewItems } from './ReviewItems'
import { ControlTable } from './ControlTable'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  answerQuestion, answerReview, GATE_LABELS, reviewCounts, validateReason, orderQueue, progressText, runControls, validateEnvironment, validateWaiver, validateWrites, waiveFinding
} from './production-model'

const NOW = Date.parse('2026-09-29T09:00:00.000Z')
const noop = (): void => {}

const handlers = (): Omit<ProductionViewProps, 'snapshot' | 'environmentId' | 'selected' | 'openFindingId' | 'waivingFindingId' | 'driftOpen' | 'busy' | 'failure' | 'notice' | 'now'> => ({
  onEnvironment: noop, onDesignate: noop, onAudit: noop, onRetest: noop, onVerify: noop, onCreateTasks: noop, onOpenEvidence: noop,
  onOpenReport: noop, onOpenQueue: noop, onOpenTasks: noop, onAnswer: noop, onAnswerReview: noop, onChangeReview: noop, onPending: noop, onDismiss: noop, onToggleFinding: noop, onOpenFinding: noop,
  onStartWaive: noop, onWaive: noop, onRevokeWaiver: noop, onPause: noop, onResume: noop, onCancel: noop, onAddEnvironment: noop,
  onRemoveEnvironment: noop, onDriftForm: noop, onSaveDrift: noop, onGrantWrites: noop, onRevokeWrites: noop
})

const view = (snapshot: ProductionProjectSnapshot, overrides: Partial<ProductionViewProps> = {}): string => renderToStaticMarkup(createElement(ProductionView, {
  snapshot, environmentId: null, selected: new Set<string>(), openFindingId: null, waivingFindingId: null, driftOpen: false, busy: '',
  failure: null, notice: '', now: NOW, ...handlers(), ...overrides
}))

/** A designated shop with an open high finding, an open question, a waived finding, a live run and a staging sandbox. */
function story(): { bridge: FakeProductionBridge; snapshot: () => Promise<ProductionProjectSnapshot> } {
  const bridge = new FakeProductionBridge({ now: () => NOW })
  const staging = fakeEnvironment({ id: 'env-staging', kind: 'staging', label: 'Staging', baseUrl: 'https://staging.example.com', allowedOrigins: ['https://staging.example.com'] })
  const profile = fakeProfile('shop', {
    designation: { productionReady: true, by: 'owner', at: '2026-09-28T10:00:00.000Z', note: '', environmentId: 'env-prod' },
    environments: [fakeEnvironment(), staging],
    questions: [fakeQuestion(), fakeQuestion({ id: 'q-entity', factKey: 'legalEntity', question: 'What is the legal entity?', blocksControls: ['C01', 'C02'], status: 'answered', answer: 'Hash and Flowers s.r.o.', answeredAt: '2026-09-28T10:00:00.000Z', answeredBy: 'owner' })],
    writeAuthorizations: [{ id: 'w-1', environmentId: 'env-staging', mutations: ['form-submit', 'checkout'], grantedBy: { kind: 'owner', agentSessionId: null }, grantedAt: '2026-09-28T10:00:00.000Z', expiresAt: '2026-10-28T10:00:00.000Z', note: 'Woo test mode' }]
  })
  bridge.seed('shop', {
    profile,
    gate: fakeGate({ projectId: 'shop', state: 'NEEDS_REVIEW', reasons: ['C03 FAIL: Google Analytics fires before consent (high, confirmed)', 'Owner question open: analytics'], runId: 'run-1', fingerprint: fakeFingerprint(), unverifiedControls: ['C05'], results: [{ controlId: 'C03', status: 'FAIL' }, { controlId: 'C13', status: 'PASS' }] }),
    runs: [fakeRun({ ledger: { tokens: 12_345, modelCalls: 3, requests: 211, elapsedMs: 5 * 60_000, byRole: { classify: { calls: 2, tokens: 2_000 }, interpret: { calls: 1, tokens: 10_345 }, 'verify-review': { calls: 0, tokens: 0 } }, exhausted: null } })],
    findings: [
      fakeFinding({ projectId: 'shop' }),
      fakeFinding({ id: 'f-font', projectId: 'shop', controlId: 'C05', checkId: 'remote-fonts', key: 'font:fonts.googleapis.com', title: 'Google Fonts loaded from Google', severity: 'low', category: 'internal-quality', status: 'waived', waiverId: 'waiver-1', legal: null }),
      fakeFinding({ id: 'f-staging', projectId: 'shop', environmentId: 'env-staging', title: 'Staging-only finding' })
    ],
    waivers: [{ id: 'waiver-1', projectId: 'shop', findingId: 'f-font', reason: 'Self-hosting fonts next sprint', scope: 'site', owner: 'Juraj', grantedBy: { kind: 'owner', agentSessionId: null, title: null }, grantedAt: '2026-09-28T10:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z', revokedAt: null, revokedReason: null }],
    results: [
      fakeControlResult('C13', { coverage: { tested: [{ path: '/', devices: ['desktop'], consentStates: ['clean'], authStates: ['guest'] }], sampled: [{ path: '/product/a', standsFor: 'product pages' }], excluded: [], unobservable: [] }, humanReview: [{ id: 'hr-1', controlId: 'C13', question: 'Check screen reader order on checkout', why: 'axe cannot judge reading order', route: '/checkout', evidence: [] }] }),
      fakeControlResult('C03', { status: 'FAIL', rationale: 'Tracker before consent', findingIds: ['f-tracker'] }),
      fakeControlResult('C14', { status: 'NOT_APPLICABLE', applicability: { status: 'not-applicable', rationale: 'Audience is general and no age-restricted products', factsUsed: [], ruleIndex: 1 } })
    ],
    browser: { available: true, engine: 'playwright-chromium', reason: null }
  }, 'Haftheme')
  return { bridge, snapshot: () => bridge.snapshot('shop') }
}

describe('production gate badge', () => {
  it.each(PROJECT_AUDIT_STATES.map(state => [state] as [ProjectAuditState]))('renders %s with its label and every reason', (state) => {
    const gate: GateState = fakeGate({ state, reasons: state === 'VERIFIED' ? [] : [`reason one for ${state}`, `reason two for ${state}`], fingerprint: fakeFingerprint(), activeWaivers: 1, staleControls: state === 'STALE' ? ['C03', 'C05'] : [] })
    const html = renderToStaticMarkup(createElement(GateBadge, { gate }))
    expect(html).toContain(`data-state="${state}"`)
    expect(html).toContain(`>${GATE_LABELS[state].label}<`)
    for (const reason of gate.reasons) expect(html).toContain(reason)
    expect(html).toContain('commit 0123456789')
    expect(html).not.toMatch(/certif|secure|%/i)
  })

  it('says VERIFIED passed the configured audit scope at the fingerprint, never more', () => {
    const html = renderToStaticMarkup(createElement(GateBadge, { gate: fakeGate({ state: 'VERIFIED', reasons: [], fingerprint: fakeFingerprint() }) }))
    expect(html).toContain('Passed the configured audit scope at 0123456789.')
    const waived = renderToStaticMarkup(createElement(GateBadge, { gate: fakeGate({ state: 'VERIFIED_WITH_WAIVERS', reasons: ['1 finding waived'], fingerprint: fakeFingerprint(), activeWaivers: 2 }) }))
    expect(waived).toContain('with 2 waived findings')
    expect(renderToStaticMarkup(createElement(GateBadge, { gate: fakeGate({ state: 'STALE', staleControls: ['C03'] }) }))).toContain('1 control need a re-test')
  })

  it('renders every gate state through the whole panel too', async () => {
    const { bridge, snapshot } = story()
    for (const state of PROJECT_AUDIT_STATES) {
      bridge.update('shop', current => { current.gate.state = state })
      const html = view(await snapshot())
      expect(html).toContain(`data-state="${state}"`)
      expect(html).toContain(GATE_LABELS[state].label)
    }
  })
})

describe('production panel', () => {
  it('renders every section of the design from one snapshot', async () => {
    const { snapshot } = story()
    const html = view(await snapshot(), { openFindingId: 'f-tracker' })
    for (const section of ['Owner questions', 'Human review', 'Controls', 'Findings', 'Waivers', 'Runs', 'Environments', 'Sandbox write authorizations']) expect(html).toContain(`aria-label="${section}"`)
    for (const action of ['Audit', 'Re-test', 'Verify', 'Create fix tasks', 'Open evidence', 'Open report', 'Enable drift checks', 'Queue']) expect(html).toContain(action)
    // Header: designation, environment picker, gate, fingerprint.
    expect(html).toMatch(/<input type="checkbox" aria-label="Production-ready" checked=""/)
    expect(html).toContain('<option value="env-prod" selected="">Production (production)</option>')
    expect(html).toContain('Owner question open: analytics')
    expect(html).toContain('commit 0123456789 · build build-42')
    // Question names the controls it blocks.
    expect(html).toContain('Blocks C03 Cookies and consent behavior, C05 Vendors, external fonts and AI')
    // Controls: status, applicability rationale, coverage counts, human review.
    expect(html).toContain('Audience is general and no age-restricted products')
    expect(html).toContain('1 tested · 1 sampled · 0 excluded')
    expect(html).toContain('Check screen reader order on checkout')
    expect(html.indexOf('data-control="C03"')).toBeLessThan(html.indexOf('data-control="C13"'))
    // Findings of the chosen environment only, with the open one's detail.
    expect(html).toContain('Google Analytics fires before consent')
    expect(html).not.toContain('Staging-only finding')
    expect(html).toContain('No analytics request before the visitor chooses')
    expect(html).toContain('Open / in a clean profile')
    expect(html).toContain('ev-requests-1')
    expect(html).toContain('Load gtag only after the consent callback grants analytics.')
    expect(html).toContain('not independently verified')
    expect(html).toContain('ePrivacy Directive art. 5(3) (EU)')
    expect(html).toContain('Waive…')
    // Waivers, runs with ledger, write authorizations.
    expect(html).toContain('Self-hosting fonts next sprint')
    expect(html).toContain('12,345 tokens · 3 model calls · 211 requests · 5 min 00 s')
    expect(html).toContain('21 of 21 steps')
    expect(html).toContain('form-submit, checkout')
  })

  it('shows a staging environment with its own findings, and the gate note when the gate is for another environment', async () => {
    const { snapshot } = story()
    const html = view(await snapshot(), { environmentId: 'env-staging' })
    expect(html).toContain('Staging-only finding')
    expect(html).not.toContain('data-finding-id="f-tracker"')
    expect(html).toContain('The gate above is for Production.')
    expect(html).toMatch(/aria-label="Production-ready"(?! checked)/)
  })

  it('enables Re-test, Verify and Create fix tasks only with a selection, and Audit only without an active run', async () => {
    const { bridge, snapshot } = story()
    const idle = view(await snapshot())
    expect(idle).toMatch(/<button type="button" disabled=""[^>]*><svg[^>]*>.*?<\/svg>Re-test<\/button>/)
    expect(idle).toMatch(/<button type="button" class="primary"[^>]*><svg[^>]*>.*?<\/svg>Audit<\/button>/)
    expect(idle).not.toMatch(/class="primary" disabled=""[^>]*><svg[^>]*>.*?<\/svg>Audit/)
    const chosen = view(await snapshot(), { selected: new Set(['f-tracker']) })
    expect(chosen).toContain('Re-test (1)')
    expect(chosen).toContain('Verify (1)')
    await bridge.audit('shop', {})
    const active = view(await snapshot())
    expect(active).toMatch(/class="primary" disabled=""[^>]*><svg[^>]*>.*?<\/svg>Audit/)
    expect(active).toContain('data-status="queued"')
  })

  it('offers only the run controls the transition table allows', () => {
    expect(runControls('running')).toEqual({ pause: true, resume: false, cancel: true })
    expect(runControls('paused')).toEqual({ pause: false, resume: true, cancel: true })
    expect(runControls('blocked')).toEqual({ pause: false, resume: true, cancel: true })
    expect(runControls('completed')).toEqual({ pause: false, resume: false, cancel: false })
  })

  it('starts with an environment form when the project has no profile, and says why designation is disabled', () => {
    const bridge = new FakeProductionBridge({ now: () => NOW })
    const html = view(bridge.seed('fresh'))
    expect(html).toContain('aria-label="Get started"')
    expect(html).toContain('aria-label="Add environment"')
    expect(html).toMatch(/title="Add an environment first; readiness always names one"><input type="checkbox" aria-label="Production-ready" disabled=""/)
    expect(html).toContain('Not audited')
  })

  it('disables designation with a reason for a caller without owner authority', async () => {
    const { snapshot } = story()
    expect(view(await snapshot(), { canDesignate: false })).toMatch(/title="Only the owner or a wizard tab can change production readiness"><input type="checkbox" aria-label="Production-ready" disabled="" checked=""/)
  })

  it('warns when no audit browser is available', async () => {
    const { bridge, snapshot } = story()
    bridge.update('shop', current => { current.browser = { available: false, engine: null, reason: 'No Chromium, Edge or Chrome found' } })
    expect(view(await snapshot())).toContain('No audit browser: No Chromium, Edge or Chrome found')
  })

  it('renders a loading state before the first snapshot', () => {
    const bridge = new FakeProductionBridge()
    expect(renderToStaticMarkup(createElement(ProductionPane, { projectId: 'shop', bridge }))).toContain('Loading production audit')
  })

  it('never shows a percentage anywhere', async () => {
    const { bridge, snapshot } = story()
    await bridge.audit('shop', {})
    bridge.update('shop', current => { current.runs[0]!.status = 'running'; current.runs[0]!.progress = { done: 7, total: 20, currentStep: 'control C05' } })
    const html = view(await snapshot(), { openFindingId: 'f-tracker', waivingFindingId: 'f-tracker', driftOpen: true })
    const queue = renderToStaticMarkup(createElement(ProductionQueueView, { entries: await bridge.queue(), currentProjectId: 'shop', onOpen: noop }))
    for (const markup of [html, queue]) {
      expect(markup).not.toContain('%')
      expect(markup).not.toMatch(/percent|<progress|role="progressbar"|aria-valuenow|score/i)
    }
    expect(html).toContain('7 of 20 steps · control C05')
    expect(progressText({ ...(await snapshot()).runs[0]!, progress: { done: 3, total: 4, currentStep: null } })).toBe('3 of 4 steps')
  })
})

describe('owner questions', () => {
  it('answers a question over the bridge: the fact becomes an owner fact and the question leaves the open list', async () => {
    const { bridge, snapshot } = story()
    const changed: string[] = []
    bridge.onChanged(projectId => changed.push(projectId))
    await expect(answerQuestion(bridge, 'shop', 'q-analytics', '   ')).rejects.toThrow('Type an answer first.')
    expect(bridge.calls.some(call => call.method === 'answerQuestion')).toBe(false)
    await answerQuestion(bridge, 'shop', 'q-analytics', ' yes ')
    expect(bridge.calls.at(-1)).toEqual({ method: 'answerQuestion', args: ['shop', 'q-analytics', 'yes'] })
    expect(changed).toEqual(['shop'])
    const after = await snapshot()
    expect(after.profile!.facts.analytics).toMatchObject({ value: true, status: 'evidenced', source: 'owner' })
    expect(after.profile!.version).toBe(2)
    expect(after.gate.openQuestions).toBe(0)
    const html = renderToStaticMarkup(createElement(QuestionList, { questions: after.profile!.questions, busy: '', error: '', onAnswer: noop, onDismiss: noop }))
    expect(html).toContain('No open owner questions.')
    expect(html).toContain('Answered or dismissed (2)')
    expect(html).toContain('Answered: yes')
    await expect(answerQuestion(bridge, 'shop', 'q-analytics', 'no')).rejects.toThrow('already settled')
  })

  it('renders an open question with its answer field and the reason the bridge refused an answer', () => {
    const html = renderToStaticMarkup(createElement(QuestionList, { questions: [fakeQuestion()], busy: '', error: 'Answer analytics with yes or no', onAnswer: noop, onDismiss: noop }))
    expect(html).toContain('aria-label="Answer: analytics"')
    expect(html).toContain('Answer analytics with yes or no')
    expect(html).toMatch(/<button type="submit" class="primary" disabled="">Answer<\/button>/)
  })
})

describe('human review', () => {
  /** A control held at NEEDS_HUMAN_REVIEW by two items, beside the story's C13 item. */
  function reviewStory(): ReturnType<typeof story> {
    const built = story()
    built.bridge.update('shop', current => {
      current.results.push(fakeControlResult('C12', {
        status: 'NEEDS_HUMAN_REVIEW', rationale: 'Pricing copy needs a human read',
        humanReview: [
          { id: 'hr-price', controlId: 'C12', question: 'Is the shown price the final price?', why: 'Taxes are added in a script', route: '/product/a', evidence: ['ev-price-1'] },
          { id: 'hr-ship', controlId: 'C12', question: 'Are shipping costs shown before checkout?', why: 'Only the cart page states them', route: null, evidence: [] }
        ]
      }))
      current.gate.results.push({ controlId: 'C12', status: 'NEEDS_HUMAN_REVIEW' })
    })
    return built
  }
  const items = (snapshot: ProductionProjectSnapshot, changingId: string | null = null, error = '', errorId: string | null = null): string =>
    renderToStaticMarkup(createElement(ReviewItems, { results: snapshot.results, busy: '', error, errorId, changingId, onAnswer: noop, onChange: noop }))

  it('shows each unanswered item with its question, why, route and a Confirm / Reject form', async () => {
    const { snapshot } = reviewStory()
    const html = items(await snapshot())
    expect(html).toContain('data-review-id="hr-price" data-answer="none"')
    expect(html).toContain('Is the shown price the final price?')
    expect(html).toContain('Taxes are added in a script')
    expect(html).toContain('Route /product/a')
    expect(html).toContain('Evidence ev-price-1')
    expect(html).toContain('aria-label="Review Is the shown price the final price?"')
    expect(html).toContain('aria-label="Note (optional)"')
    expect(html).toMatch(/class="primary"[^>]*>Confirm<\/button>/)
    expect(html).toMatch(/class="danger"[^>]*>Reject<\/button>/)
    expect(html).not.toContain('Change answer')
    // NEEDS_HUMAN_REVIEW sorts before PASS.
    expect(html.indexOf('data-review-control="C12"')).toBeLessThan(html.indexOf('data-review-control="C13"'))
    const panel = view(await snapshot())
    expect(panel).toMatch(/aria-label="Human review"><h3>Human review<span class="production-count">3<\/span>/)
    expect(panel).toContain('2 human-review items, 0 answered (answer under Human review)')
    // The question text appears once (the form names it only in its aria-label), so a smoke's getByText stays unambiguous.
    expect(panel.match(/>Is the shown price the final price\?</g)).toHaveLength(1)
  })

  it('answers an item confirmed over the bridge and shows it answered, with the note, who and when', async () => {
    const { bridge, snapshot } = reviewStory()
    const changed: string[] = []
    bridge.onChanged(projectId => changed.push(projectId))
    const record = await answerReview(bridge, 'shop', 'hr-1', 'confirmed', '  Reading order matches the visual order  ')
    expect(bridge.calls.at(-1)).toEqual({ method: 'answerReview', args: ['shop', 'hr-1', 'confirmed', 'Reading order matches the visual order'] })
    expect(record).toMatchObject({ projectId: 'shop', environmentId: 'env-prod', itemId: 'hr-1', controlId: 'C13', answer: 'confirmed', note: 'Reading order matches the visual order', answeredBy: 'owner', runId: 'run-1' })
    expect(changed).toEqual(['shop'])
    const after = await snapshot()
    expect(after.results.find(result => result.controlId === 'C13')!.humanReview[0]).toMatchObject({ answer: 'confirmed', answeredBy: 'owner', answeredAt: '2026-09-29T09:00:00.000Z' })
    const html = items(after)
    expect(html).toContain('data-review-id="hr-1" data-answer="confirmed"')
    expect(html).toContain('>Confirmed<')
    expect(html).toContain('Note: Reading order matches the visual order')
    expect(html).toContain('By owner · 2026-09-29 09:00 UTC')
    expect(html).toContain('>Change answer</button>')
    expect(html).not.toContain('aria-label="Review Check screen reader order on checkout"')
    expect(reviewCounts(after.results)).toEqual({ total: 3, answered: 1, unanswered: 2 })
    // Changing the answer reopens the form for that item, with a way back.
    const changing = items(after, 'hr-1')
    expect(changing).toContain('aria-label="Review Check screen reader order on checkout"')
    expect(changing).toContain('>Keep answer</button>')
    expect(changing).not.toContain('>Change answer</button>')
    // Answering again replaces the answer.
    await answerReview(bridge, 'shop', 'hr-1', 'rejected', '')
    const again = (await snapshot()).results.find(result => result.controlId === 'C13')!
    expect(again.humanReview[0]).toMatchObject({ answer: 'rejected', note: null })
    expect(again.status).toBe('FAIL')
  })

  it('lifts a NEEDS_HUMAN_REVIEW control once every item is confirmed', async () => {
    const { bridge, snapshot } = reviewStory()
    await answerReview(bridge, 'shop', 'hr-price', 'confirmed', '')
    let c12 = (await snapshot()).results.find(result => result.controlId === 'C12')!
    expect(c12.status).toBe('NEEDS_HUMAN_REVIEW')
    await answerReview(bridge, 'shop', 'hr-ship', 'confirmed', 'Shown on the product page too')
    const after = await snapshot()
    c12 = after.results.find(result => result.controlId === 'C12')!
    expect(c12.status).toBe('PASS')
    expect(after.gate.results.find(result => result.controlId === 'C12')!.status).toBe('PASS')
    expect(after.gate.humanReviewPending).toBe(1)
    const table = renderToStaticMarkup(createElement(ControlTable, { results: after.results, gate: after.gate }))
    expect(table).toMatch(/data-control="C12" data-status="PASS"/)
    expect(table).toContain('2 human-review items, 2 answered<')
  })

  it('fails the control when an item is rejected', async () => {
    const { bridge, snapshot } = reviewStory()
    await answerReview(bridge, 'shop', 'hr-price', 'rejected', 'Tax is added at checkout')
    await answerReview(bridge, 'shop', 'hr-ship', 'confirmed', '')
    const after = await snapshot()
    expect(after.results.find(result => result.controlId === 'C12')!.status).toBe('FAIL')
    const html = items(after)
    expect(html).toContain('data-review-id="hr-price" data-answer="rejected"')
    expect(html).toContain('>Rejected<')
    expect(html).toContain('data-review-control="C12" data-status="FAIL"')
    expect(view(after)).not.toContain('%')
  })

  it('refuses an unknown item and shows the refusal inline', async () => {
    const { bridge, snapshot } = reviewStory()
    await expect(answerReview(bridge, 'shop', 'hr-nope', 'confirmed', '')).rejects.toThrow('No human-review item hr-nope')
    await expect(answerReview(bridge, 'shop', 'hr-1', 'confirmed', 'x'.repeat(501))).rejects.toThrow('Keep the note under 500 characters.')
    const before = await snapshot()
    const onItem = items(before, null, 'The run was superseded', 'hr-price')
    const itemStart = onItem.indexOf('data-review-id="hr-price"')
    expect(onItem.indexOf('The run was superseded')).toBeGreaterThan(itemStart)
    expect(onItem.indexOf('The run was superseded')).toBeLessThan(onItem.indexOf('data-review-id="hr-ship"'))
    const unknown = items(before, null, 'No human-review item hr-nope', 'hr-nope')
    expect(unknown).toMatch(/^<div class="production-questions production-reviews"><p class="production-error" role="alert">No human-review item hr-nope<\/p>/)
    expect(view(before, { failure: { scope: 'review:hr-price', message: 'The run was superseded' } })).toContain('The run was superseded')
    expect(renderToStaticMarkup(createElement(ReviewItems, { results: [], busy: '', error: '', onAnswer: noop, onChange: noop }))).toContain('No human-review items in the last run.')
  })
})

describe('waiver form', () => {
  const draft = { reason: 'Fonts are self-hosted next sprint', scope: 'site', owner: 'Juraj', expiresOn: '2026-11-01' }

  it('requires an expiry, and a future one', () => {
    expect(validateWaiver('f-1', { ...draft, expiresOn: '' }, NOW)).toEqual({ request: null, errors: { expiresOn: 'An expiry date is required; waivers never last forever.' } })
    expect(validateWaiver('f-1', { ...draft, expiresOn: '2026-09-01' }, NOW).errors.expiresOn).toBe('The expiry must be in the future.')
    expect(validateWaiver('f-1', { ...draft, expiresOn: 'next week' }, NOW).errors.expiresOn).toBe('Use a date (YYYY-MM-DD).')
    expect(Object.keys(validateWaiver('f-1', { reason: ' ', scope: '', owner: '', expiresOn: '' }, NOW).errors).sort()).toEqual(['expiresOn', 'owner', 'reason', 'scope'])
    expect(validateWaiver('f-1', draft, NOW)).toEqual({ request: { findingId: 'f-1', reason: draft.reason, scope: 'site', owner: 'Juraj', expiresAt: '2026-11-01T23:59:59.000Z' }, errors: {} })
  })

  it('only reaches the bridge with a valid waiver, which keeps the finding and marks it waived', async () => {
    const { bridge, snapshot } = story()
    expect(await waiveFinding(bridge, 'shop', 'f-tracker', { ...draft, expiresOn: '' }, NOW)).toHaveProperty('expiresOn')
    expect(bridge.calls.some(call => call.method === 'waive')).toBe(false)
    expect(await waiveFinding(bridge, 'shop', 'f-tracker', draft, NOW)).toEqual({})
    const after = await snapshot()
    const finding = after.findings.find(item => item.id === 'f-tracker')!
    expect(finding.status).toBe('waived')
    expect(after.waivers[0]).toMatchObject({ findingId: 'f-tracker', owner: 'Juraj', expiresAt: '2026-11-01T23:59:59.000Z' })
    await expect(bridge.waive('shop', { findingId: 'f-font', reason: 'r', scope: 's', owner: 'o', expiresAt: '' })).rejects.toThrow('expiry')
  })

  it('shows each field error and marks the expiry field required', () => {
    const html = renderToStaticMarkup(createElement(WaiverForm, {
      finding: { id: 'f-1', title: 'Tracker before consent' }, busy: false, error: '', now: NOW,
      initialDraft: { reason: 'r', scope: 's', owner: 'o' }, initialErrors: { expiresOn: 'An expiry date is required; waivers never last forever.' }, onSubmit: noop, onCancel: noop
    }))
    expect(html).toContain('aria-label="Waive Tracker before consent"')
    expect(html).toContain('<input type="date" required=""')
    expect(html).toContain('An expiry date is required; waivers never last forever.')
    expect(html).toContain('class="invalid"')
  })
})

describe('production queue', () => {
  it('orders BLOCKED, NEEDS_REVIEW and STALE before the rest, then by open critical and high findings', async () => {
    const bridge = new FakeProductionBridge({ now: () => NOW })
    const designated = (id: string) => fakeProfile(id, { designation: { productionReady: true, by: 'owner', at: null, note: '', environmentId: 'env-prod' } })
    const seed = (id: string, name: string, state: ProjectAuditState, criticals = 0) => bridge.seed(id, {
      profile: designated(id), gate: fakeGate({ projectId: id, state, reasons: [`${name} reason`] }),
      findings: Array.from({ length: criticals }, (_, index) => fakeFinding({ id: `${id}-f${index}`, projectId: id, severity: 'critical' }))
    }, name)
    seed('a', 'Alpha', 'VERIFIED')
    seed('b', 'Bravo', 'STALE')
    seed('c', 'Charlie', 'NEEDS_REVIEW', 1)
    seed('d', 'Delta', 'BLOCKED')
    seed('e', 'Echo', 'NEEDS_REVIEW', 3)
    seed('f', 'Foxtrot', 'NOT_AUDITED')
    seed('g', 'Golf', 'AUDITING')
    seed('h', 'Hotel', 'VERIFIED_WITH_WAIVERS')
    bridge.seed('x', { profile: fakeProfile('x') }, 'Not designated')
    const entries = await bridge.queue()
    expect(entries).toHaveLength(8)
    expect(orderQueue(entries).map(entry => entry.projectName)).toEqual(['Delta', 'Echo', 'Charlie', 'Bravo', 'Golf', 'Foxtrot', 'Hotel', 'Alpha'])
    const html = renderToStaticMarkup(createElement(ProductionQueueView, { entries, currentProjectId: 'c', onOpen: noop }))
    const order = ['Delta', 'Echo', 'Charlie', 'Bravo', 'Golf', 'Foxtrot', 'Hotel', 'Alpha'].map(name => html.indexOf(`<strong>${name}</strong>`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(html).toContain('aria-label="Open Production for Echo"')
    expect(html).toMatch(/data-project-id="c" data-state="NEEDS_REVIEW" class="current"/)
    expect(html).toContain('Echo reason')
    expect(html).not.toContain('Not designated')
  })

  it('shows the active run and an empty state that says how to designate', async () => {
    const { bridge } = story()
    await bridge.audit('shop', {})
    const html = renderToStaticMarkup(createElement(ProductionQueueView, { entries: await bridge.queue(), currentProjectId: null, onOpen: noop }))
    expect(html).toContain('audit queued · 0 of 20 steps')
    expect(html).toContain('data-fact="critical-high">0 / 2<')
    expect(renderToStaticMarkup(createElement(ProductionQueueView, { entries: [], currentProjectId: null, onOpen: noop }))).toContain('tick Production-ready')
  })
})

describe('forms', () => {
  it('builds an environment whose base URL origin is always allowed, with a unique id', () => {
    const existing = [fakeEnvironment({ id: 'env-staging' })]
    const { environment } = validateEnvironment({ label: 'Staging', kind: 'staging', baseUrl: 'https://staging.example.com/shop', extraOrigins: 'https://pay.example.com' }, existing)
    expect(environment).toMatchObject({ id: 'env-staging-2', kind: 'staging', allowedOrigins: ['https://staging.example.com', 'https://pay.example.com'] })
    expect(validateEnvironment({ label: '', kind: 'production', baseUrl: 'file:///C:/site', extraOrigins: 'javascript:alert(1)' }, []).errors).toEqual({
      label: 'Name the environment.', baseUrl: 'Use an http(s) URL, for example https://shop.example.com.', extraOrigins: 'javascript:alert(1) is not an http(s) origin.'
    })
  })

  it('never offers production for sandbox writes and needs a mutation and a future expiry', () => {
    const environments = [fakeEnvironment(), fakeEnvironment({ id: 'env-sandbox', kind: 'sandbox', label: 'Sandbox' })]
    expect(validateWrites({ environmentId: 'env-prod', mutations: ['checkout'], expiresOn: '2026-12-01', note: '' }, environments, NOW).error).toBe('A production environment is never authorized for writes.')
    expect(validateWrites({ environmentId: 'env-sandbox', mutations: [], expiresOn: '2026-12-01', note: '' }, environments, NOW).error).toBe('Name at least one kind of mutation.')
    expect(validateWrites({ environmentId: 'env-sandbox', mutations: ['checkout'], expiresOn: '', note: '' }, environments, NOW).error).toBe('Set an expiry date in the future.')
    expect(validateWrites({ environmentId: 'env-sandbox', mutations: ['checkout'], expiresOn: '2026-12-01', note: ' test ' }, environments, NOW).request).toEqual({ environmentId: 'env-sandbox', mutations: ['checkout'], expiresAt: '2026-12-01T23:59:59.000Z', note: 'test' })
    const html = renderToStaticMarkup(createElement(WriteAuthorizations, { authorizations: [], environments, busy: '', now: NOW, onGrant: noop, onRevoke: noop }))
    expect(html).toContain('<option value="env-sandbox" selected="">Sandbox (sandbox)</option>')
    expect(html).not.toContain('<option value="env-prod"')
    expect(renderToStaticMarkup(createElement(WriteAuthorizations, { authorizations: [], environments: [fakeEnvironment()], busy: '', now: NOW, onGrant: noop, onRevoke: noop }))).toContain('Add a staging, sandbox or local environment')
  })

  it('offers drift checks as opt-in with cadence and mark-stale vs audit', () => {
    const html = renderToStaticMarkup(createElement(DriftSettingsForm, { drift: { enabled: false, everyMinutes: 1440, onChange: 'mark-stale' }, busy: false, error: '', onSave: noop, onCancel: noop }))
    expect(html).toContain('value="24"')
    expect(html).toContain('<option value="mark-stale" selected="">Mark the audit stale</option>')
    expect(html).toContain('<option value="audit">Mark stale and start an audit</option>')
  })
})

describe('in-panel confirmations', () => {
  const inside = (html: string, container: string, form: string): boolean => {
    const start = html.indexOf(container)
    const next = html.indexOf('</li>', start) === -1 ? html.length : html.indexOf('</li>', start)
    const div = html.indexOf('</div></div>', start)
    const end = Math.max(next, div)
    const at = html.indexOf(form)
    return start !== -1 && at > start && at < end
  }

  it('confirms a question dismissal under that question with a required reason, beside (not inside) the answer form', async () => {
    const { snapshot } = story()
    const idle = view(await snapshot())
    expect(idle).toContain('>Dismiss…</button>')
    expect(idle).not.toContain('aria-label="Dismiss question"')
    const html = view(await snapshot(), { pending: { kind: 'dismiss', questionId: 'q-analytics' } })
    expect(inside(html, 'data-question-id="q-analytics"', 'aria-label="Dismiss question"')).toBe(true)
    expect(html).toContain('the controls this question blocks stay unverified')
    expect(html).toMatch(/aria-label="Dismiss question"[^]*?<span>Why dismiss it<\/span><input required=""/)
    // No form is nested in another: every <form> closes before the next one opens.
    const forms = html.match(/<\/?form\b/g) ?? []
    forms.forEach((tag, index) => expect(tag).toBe(index % 2 === 0 ? '<form' : '</form'))
  })

  it('confirms revoking a waiver, cancelling a run and removing an environment in place', async () => {
    const { bridge, snapshot } = story()
    const revoke = view(await snapshot(), { pending: { kind: 'revoke', waiverId: 'waiver-1' } })
    expect(inside(revoke, 'data-waiver-id="waiver-1"', 'aria-label="Revoke waiver"')).toBe(true)
    expect(revoke).toContain('reopens its finding')
    expect(revoke).not.toContain('>Revoke…</button>')
    const run = await bridge.audit('shop', {})
    const cancel = view(await snapshot(), { pending: { kind: 'cancel', runId: run.id } })
    expect(inside(cancel, `data-run-id="${run.id}"`, 'aria-label="Cancel run"')).toBe(true)
    expect(cancel).toContain('Reason (optional)')
    expect(cancel).toMatch(/Cancel run…<\/button>/)
    const remove = view(await snapshot(), { pending: { kind: 'remove-environment', environmentId: 'env-staging' } })
    expect(inside(remove, 'data-environment-id="env-staging"', 'aria-label="Remove environment"')).toBe(true)
    expect(remove).toContain('keeps its past runs and findings')
  })

  it('validates the reason and shows the bridge error inside the confirmation', () => {
    expect(validateReason('  ', true)).toBe('Give a reason; it is kept with the record.')
    expect(validateReason('', false)).toBe('')
    expect(validateReason('x'.repeat(501), false)).toBe('Keep the reason under 500 characters.')
    const html = renderToStaticMarkup(createElement(ReasonForm, { label: 'Revoke waiver', consequence: 'c', reasonLabel: 'Why revoke it', reasonRequired: true, confirmLabel: 'Revoke waiver', busy: false, error: 'No waiver waiver-9', onSubmit: noop, onCancel: noop }))
    expect(html).toContain('No waiver waiver-9')
    expect(html).toContain('>Keep</button>')
    expect(renderToStaticMarkup(createElement(ReasonForm, { label: 'Remove environment', consequence: 'c', reasonLabel: null, reasonRequired: false, confirmLabel: 'Remove environment', busy: false, error: '', onSubmit: noop, onCancel: noop }))).not.toContain('<input')
  })

  it('settles the confirmed actions over the bridge', async () => {
    const { bridge, snapshot } = story()
    await bridge.dismissQuestion('shop', 'q-analytics', 'Not decided yet')
    await bridge.revokeWaiver('shop', 'waiver-1', 'Fonts still remote')
    const run = await bridge.audit('shop', {})
    await bridge.cancel('shop', run.id, 'Wrong environment')
    const after = await snapshot()
    expect(after.profile!.questions.find(question => question.id === 'q-analytics')).toMatchObject({ status: 'dismissed', answer: 'Not decided yet' })
    expect(after.waivers[0]).toMatchObject({ revokedReason: 'Fonts still remote' })
    expect(after.findings.find(finding => finding.id === 'f-font')!.status).toBe('open')
    expect(after.runs.find(item => item.id === run.id)).toMatchObject({ status: 'cancelled', statusReason: 'Wrong environment' })
  })

  it('uses no browser dialogs anywhere in the Production UI', () => {
    const root = join(__dirname, '..')
    const files = [join(root, 'ProductionPane.tsx'), join(root, '..', 'panes', 'ProductionQueuePane.tsx'), ...readdirSync(__dirname).filter(name => name.endsWith('.tsx')).map(name => join(__dirname, name))]
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/window\.(prompt|confirm|alert)\(/)
  })
})

describe('fake bridge contract rules', () => {
  it('follows the run transition table and refuses production writes', async () => {
    const { bridge, snapshot } = story()
    const run = await bridge.audit('shop', {})
    expect((await bridge.audit('shop', {})).id).toBe(run.id)
    await bridge.pause('shop', run.id)
    await bridge.resume('shop', run.id)
    await bridge.cancel('shop', run.id, 'test')
    await expect(bridge.pause('shop', run.id)).rejects.toThrow('A cancelled run cannot become paused')
    expect((await snapshot()).activeRun).toBeNull()
    await expect(bridge.authorizeWrites('shop', { environmentId: 'env-prod', mutations: ['checkout'], expiresAt: '2026-12-01T00:00:00.000Z', note: '' })).rejects.toThrow('never authorized')
    const tasks = await bridge.createFixTasks('shop', ['f-tracker', 'f-tracker'])
    expect(tasks.map(task => task.created)).toEqual([true, false])
  })
})
