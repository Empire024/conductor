import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuditBrowser, CheckOutcome } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { analyseTraversal, createAccessibilityCheck, severityOfImpact, type FocusStep } from './accessibility'
import { createTechnicalContext, type TechnicalContext } from './technical-testkit'

const engine = await resolveEngine()
const BROWSER_TIMEOUT = 30_000
const check = createAccessibilityCheck({ maxRoutes: 1, maxTabs: 30, settleMs: 0 })

let server: FixtureServer
let scratch: string
const contexts: TechnicalContext[] = []

const contextFor = (site: string, browser?: AuditBrowser): TechnicalContext => {
  const made = createTechnicalContext({ server, site, controlId: 'C13', scratch, routes: ['/'], scope: { devices: ['desktop', 'mobile'] }, browser })
  contexts.push(made)
  return made
}
const keys = (result: CheckOutcome): string[] => result.findings.map(finding => finding.key).sort()

const step = (focusedSelector: string | null, patch: Partial<FocusStep> = {}): FocusStep =>
  ({ key: 'Tab', focusedSelector, focusVisible: true, tag: focusedSelector ? 'A' : null, dialogOpen: false, inDialog: false, ...patch })

describe('accessibility traversal analysis', () => {
  it('finds invisible focus stops, a stuck element, a two-element cycle and dialog escapes, and nothing in a clean trace', () => {
    const clean = analyseTraversal([step('#a'), step('#b'), step('#c'), step(null), step('#a')], 3)
    expect(clean).toEqual({ invisible: [], trap: null, escapes: [] })

    expect(analyseTraversal([step('#a', { focusVisible: false }), step('#b'), step('#a', { focusVisible: false })], 3).invisible).toEqual(['#a'])
    expect(analyseTraversal([step('#a'), step('#trap'), step('#trap'), step('#trap')], 5).trap).toMatch(/#trap kept focus for 3/)
    expect(analyseTraversal([step('#a'), step('#b'), step('#a'), step('#b'), step('#a'), step('#b')], 5).trap).toMatch(/cycled among #a and #b/)
    // Two tabbable elements cycling is the page, not a trap; a modal dialog may hold focus; an iframe is not a stop of its own.
    expect(analyseTraversal([step('#a'), step('#b'), step('#a'), step('#b'), step('#a'), step('#b')], 2).trap).toBeNull()
    expect(analyseTraversal([step('#x', { dialogOpen: true, inDialog: true }), step('#x', { dialogOpen: true, inDialog: true }), step('#x', { dialogOpen: true, inDialog: true })], 5).trap).toBeNull()
    expect(analyseTraversal([step('iframe', { tag: 'IFRAME' }), step('iframe', { tag: 'IFRAME' }), step('iframe', { tag: 'IFRAME' })], 5).trap).toBeNull()

    const escapes = analyseTraversal([step('#in', { dialogOpen: true, inDialog: true }), step(null, { dialogOpen: true }), step('#nav', { dialogOpen: true })], 5)
    expect(escapes.escapes).toEqual(['#nav'])
    expect([severityOfImpact('critical'), severityOfImpact('serious'), severityOfImpact('moderate'), severityOfImpact('minor'), severityOfImpact(null)]).toEqual(['high', 'high', 'medium', 'low', 'medium'])
  })
})

describe.skipIf(!engine.available)('accessibility check (C13)', () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'prod-a11y-'))
    server = await createFixtureServer({ sites: ['a11y-good', 'a11y-defects'] })
  })
  afterAll(async () => {
    await Promise.all(contexts.map(context => context.close()))
    await server?.close()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('passes a well-built site for the automated portion and lists the manual checks', async () => {
    const { context } = contextFor('a11y-good')
    const result = await check.run(context)
    expect(result.reason).toBeNull()
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.observations[0]).toBe('PASS for the automated portion; 6 manual checks listed for human review')
    const manual = result.humanReview.filter(item => item.id.startsWith('C13:manual:'))
    expect(manual.map(item => item.id)).toEqual([
      'C13:manual:focus-order', 'C13:manual:media-alternatives', 'C13:manual:form-errors', 'C13:manual:text-alternatives', 'C13:manual:consistency', 'C13:manual:motion-timing',
    ])
    for (const item of manual) { expect(item.why.length).toBeGreaterThan(40); expect(item.route).toBeNull() }
    for (const item of result.humanReview.filter(entry => entry.id.startsWith('C13:axe-incomplete:'))) expect(item.evidence.length).toBe(1)
    // Both consent states were scanned on desktop, and the mobile layout was checked.
    expect(result.coverage.tested).toEqual([{ path: '/', devices: ['desktop', 'mobile'], consentStates: ['clean', 'accepted'], authStates: ['guest'] }])
    expect(result.observations.some(line => /^\/ \(accepted\): axe-core/.test(line))).toBe(true)
    // The keyboard parts ran: the dialog opened (and held focus), and Tab reached both cookie choices.
    expect(result.observations).toContainEqual(expect.stringMatching(/^\/: \d+ Tab press\(es\) .* 1 dialog opener\(s\) exercised, 1 opened a modal dialog; cookie choices reached by Tab: accept, reject$/))
    // axe (clean, accepted), the keyboard trace, the 200 % and the mobile screenshots.
    expect(result.evidence.length).toBe(5)
  }, BROWSER_TIMEOUT)

  it('fails a defective site with axe, focus, reflow, mobile and cookie-choice findings backed by evidence', async () => {
    const { context } = contextFor('a11y-defects')
    const result = await check.run(context)
    expect(result.status).toBe('FAIL')
    expect(result.reason).toBeNull()
    const found = keys(result)
    for (const key of ['axe:image-alt', 'axe:label', 'axe:color-contrast', 'focus-not-visible', 'reflow-200', 'mobile-overflow', 'cookie-choice-not-keyboard-reachable', 'dialog-focus-escapes']) {
      expect(found, key).toContain(key)
    }
    expect(found).not.toContain('keyboard-trap')
    for (const finding of result.findings) {
      expect(finding.evidence.length, finding.key).toBeGreaterThan(0)
      for (const id of finding.evidence) expect(result.evidence).toContain(id)
      expect(finding.route).toBe('/')
      expect(finding.category).toBe('technical')
    }
    const byKey = (key: string) => result.findings.find(finding => finding.key === key)!
    expect(byKey('axe:image-alt')).toMatchObject({ severity: 'high', confidence: 'confirmed' })
    expect(byKey('axe:image-alt').observed).toMatch(/img/)
    expect(byKey('focus-not-visible')).toMatchObject({ severity: 'medium', confidence: 'likely' })
    expect(byKey('focus-not-visible').observed).toMatch(/outline and box-shadow only/)
    expect(byKey('cookie-choice-not-keyboard-reachable')).toMatchObject({ severity: 'high' })
    expect(byKey('cookie-choice-not-keyboard-reachable').observed).toMatch(/reject is shown but never received focus/)
    expect(byKey('reflow-200').observed).toMatch(/\.page \(1400px wide\)/)
    expect(byKey('mobile-overflow').observed).toMatch(/412px/)
    expect(result.humanReview.filter(item => item.id.startsWith('C13:manual:')).length).toBe(6)
    expect(result.observations[0]).not.toMatch(/^PASS/)
    expect(result.observations).toContainEqual(expect.stringMatching(/1 opened a modal dialog; cookie choices reached by Tab: accept$/))
    expect(byKey('dialog-focus-escapes').observed).toMatch(/after opening #open-offer/)
  }, BROWSER_TIMEOUT)

  it('is UNVERIFIED, never PASS, when the audit browser is unavailable', async () => {
    const real = contextFor('a11y-good').browser
    const unavailable: AuditBrowser = { ...real, availability: async () => ({ available: false, engine: null, reason: 'no browser on this machine' }) }
    const { context } = contextFor('a11y-good', unavailable)
    const result = await check.run(context)
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/no audit browser: no browser on this machine/)
    expect(result.findings).toEqual([])
    expect(result.humanReview.length).toBe(6)
  }, BROWSER_TIMEOUT)
})
