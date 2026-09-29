import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuditBrowser, CheckOutcome } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { answeringInterpreter, createDocumentContext, type DocumentContextOptions } from './document-testkit'
import { policiesCheck } from './policies'

const engine = await resolveEngine()
const ENTITY = 'Hash and Flowers s.r.o., Hlavná 12, 811 01 Bratislava, IČO 12345678'
const facts = { legalEntity: ENTITY, targetCountries: ['SK'], analytics: false }

let server: FixtureServer
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-policies-'))
  server = await createFixtureServer({ sites: ['policies-good', 'policies-placeholder', 'policies-contradiction'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

async function run(options: Omit<DocumentContextOptions, 'server' | 'scratch' | 'controlId'>): Promise<CheckOutcome> {
  const harness = createDocumentContext({ server, scratch, controlId: 'C01', ...options })
  try { return await policiesCheck.run(harness.context) } finally { await harness.close() }
}
const keys = (result: CheckOutcome): string[] => result.findings.map(finding => `${finding.key}@${finding.route ?? '-'}`).sort()

describe.skipIf(!engine.available)('C01 policies check', { timeout: 60_000 }, () => {
  it('passes a site whose policies are linked everywhere, dated, name the entity and match its data flows (known-good and negative control)', async () => {
    const result = await run({ site: 'policies-good', facts, routes: ['/', '/about/'] })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.reason).toBeNull()
    // The policy says "we do not use analytics" and nothing tracks: no contradiction (negative control).
    expect(result.findings.some(finding => finding.key.startsWith('contradiction'))).toBe(false)
    expect(result.humanReview.map(item => item.id)).toEqual(['C01:legal-adequacy'])
    expect(result.humanReview[0]!.question).toContain('SK')
    expect(result.coverage.tested.map(entry => entry.path).sort()).toEqual(['/', '/about/', '/privacy/', '/terms/'])
    expect(result.coverage.tested.find(entry => entry.path === '/privacy/')!.devices.sort()).toEqual(['desktop', 'mobile'])
    expect(result.observations).toEqual(expect.arrayContaining([expect.stringMatching(/privacy policy date: Last updated: 1 March 2026/), expect.stringMatching(/not classified: local model unavailable/)]))
    expect(result.evidence.length).toBeGreaterThanOrEqual(4)
  })

  it('finds template text, a missing date, a different entity, a missing footer link and a page unreadable on a phone', async () => {
    const result = await run({ site: 'policies-placeholder', facts, routes: ['/', '/about/'] })
    expect(result.status).toBe('FAIL')
    expect(keys(result)).toEqual([
      'entity-mismatch:privacy@/privacy/',
      'entity-mismatch:terms@/terms/',
      'missing-date:privacy@/privacy/',
      'missing-link:terms@/about/',
      'mobile-overflow:privacy@/privacy/',
      'placeholder:privacy:bracket-field@/privacy/',
      'placeholder:privacy:lorem-ipsum@/privacy/',
      'placeholder:privacy:todo@/privacy/',
      'small-text:privacy@/privacy/',
    ])
    const mismatch = result.findings.find(finding => finding.key === 'entity-mismatch:terms')!
    expect(mismatch).toMatchObject({ confidence: 'confirmed', severity: 'high', category: 'legal' })
    expect(mismatch.observed).toContain('Example Trading Ltd.')
    expect(mismatch.legal!.sources.map(source => source.jurisdiction)).toEqual(expect.arrayContaining(['EU', 'SK']))
    expect(mismatch.legal!.sources.some(source => source.jurisdiction === 'US')).toBe(false)
    expect(result.findings.find(finding => finding.key === 'mobile-overflow:privacy')!).toMatchObject({ category: 'technical', legal: null })
    expect(result.findings.every(finding => finding.evidence.length > 0 || finding.key.startsWith('missing-link'))).toBe(true)
  })

  it('finds a policy that denies analytics while the site sends tracking requests', async () => {
    const result = await run({ site: 'policies-contradiction', facts, routes: ['/'] })
    expect(keys(result)).toEqual(['contradiction:analytics@/privacy/'])
    const finding = result.findings[0]!
    expect(finding).toMatchObject({ severity: 'high', confidence: 'confirmed' })
    expect(finding.observed).toMatch(/We do not use any analytics or tracking tools/)
    expect(finding.observed).toMatch(/__collect/)
    expect(finding.reproduction[1]).toMatch(/^Open \/ and watch the network for localhost:/)
    expect(result.status).toBe('FAIL')
  })

  it('treats the owner declaring analytics against a policy that denies it as a likely contradiction', async () => {
    const result = await run({ site: 'policies-good', facts: { ...facts, analytics: true }, routes: ['/'] })
    expect(keys(result)).toEqual(['contradiction:analytics@/privacy/'])
    expect(result.findings[0]).toMatchObject({ confidence: 'likely' })
    expect(result.findings[0]!.observed).toContain('owner declared')
  })

  it('stays UNVERIFIED, never PASS, while the legal entity is unknown', async () => {
    const result = await run({ site: 'policies-good', facts: { targetCountries: ['SK'], analytics: false }, routes: ['/'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/legal entity unknown.*legalEntity/)
    expect(result.findings).toEqual([])
  })

  it('turns a classifier doubt into a review item without changing the result', async () => {
    const asked: string[] = []
    const good = await run({ site: 'policies-good', facts, routes: ['/'], interpreter: answeringInterpreter({ kind: 'placeholder' }, asked) })
    expect(asked).toEqual(['classify:Is the privacy policy at /privacy/ a real policy or template text?', 'classify:Is the terms at /terms/ a real policy or template text?'])
    expect(good.status).toBe('PASS')
    expect(good.findings).toEqual([])
    expect(good.humanReview.map(item => item.id).sort()).toEqual(['C01:classifier-doubt:privacy', 'C01:classifier-doubt:terms', 'C01:legal-adequacy'])
    // A classifier that calls a real placeholder page a policy removes nothing.
    const placeholder = await run({ site: 'policies-placeholder', facts, routes: ['/'], interpreter: answeringInterpreter({ kind: 'policy', allowedOrigins: ['https://evil.example'], suppress: true }) })
    expect(placeholder.findings.filter(finding => finding.key.startsWith('placeholder:')).length).toBe(3)
    expect(placeholder.status).toBe('FAIL')
  })

  it('reads production read-only: the same result under production policy and no mutation reaches the site', async () => {
    const result = await run({ site: 'policies-good', facts, routes: ['/'], environmentKind: 'production' })
    expect(result.status).toBe('PASS')
    expect(server.mutations()).toEqual([])
  })

  it('is UNVERIFIED with the reason when no audit browser exists', async () => {
    const browser = { availability: async () => ({ available: false, engine: null, reason: 'No audit browser: none found' }), open: async () => { throw new Error('no') }, close: async () => undefined } as unknown as AuditBrowser
    const result = await run({ site: 'policies-good', facts, browser })
    expect(result).toMatchObject({ status: 'UNVERIFIED', reason: 'no audit browser: No audit browser: none found', findings: [] })
  })
})
