import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CheckOutcome } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { childrenCheck } from './children'
import { createDocumentContext, type DocumentContextOptions } from './document-testkit'

const engine = await resolveEngine()

let server: FixtureServer
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-children-'))
  server = await createFixtureServer({ sites: ['children-na', 'children-directed', 'children-good'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

async function run(options: Omit<DocumentContextOptions, 'server' | 'scratch' | 'controlId'>): Promise<CheckOutcome> {
  const harness = createDocumentContext({ server, scratch, controlId: 'C14', ...options })
  try { return await childrenCheck.run(harness.context) } finally { await harness.close() }
}

describe('C14 applicability', () => {
  it('is NOT_APPLICABLE for a general audience without age-restricted products, and opens nothing (negative control)', async () => {
    const before = server.requests('children-na').length
    const result = await run({ site: 'children-na', facts: { audience: 'general', ageRestrictedProducts: false } })
    expect(result).toMatchObject({ status: 'NOT_APPLICABLE', findings: [], humanReview: [] })
    expect(result.reason).toMatch(/Not applicable for the recorded facts \(audience = general; ageRestrictedProducts = false\)/)
    expect(server.requests('children-na').length).toBe(before)
  })

  it('is UNVERIFIED, never NOT_APPLICABLE, while the audience is unknown', async () => {
    const result = await run({ site: 'children-na', facts: { ageRestrictedProducts: false } })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/until the owner answers: audience/)
  })
})

describe.skipIf(!engine.available)('C14 children check', { timeout: 60_000 }, () => {
  it('passes a child-directed site with a notice for parents and no tracking (known-good)', async () => {
    const result = await run({ site: 'children-good', facts: { audience: 'child-directed', ageRestrictedProducts: false }, routes: ['/', '/games/'] })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.humanReview.map(item => item.id)).toEqual(['C14:legal-adequacy'])
    expect(result.observations[0]).toMatch(/directed at children/)
  })

  it('finds a missing parental notice, tracking on child pages and a name form (broken)', async () => {
    const result = await run({ site: 'children-directed', facts: { audience: 'child-directed', ageRestrictedProducts: false }, routes: ['/', '/games/'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => `${finding.key}@${finding.route}`).sort()).toEqual(['child-data-form@/games/', 'child-route-tracking@/', 'missing-parental-notice@/privacy/'])
    const tracking = result.findings.find(finding => finding.key === 'child-route-tracking')!
    expect(tracking).toMatchObject({ severity: 'high', confidence: 'confirmed' })
    expect(tracking.observed).toMatch(/\/: .*__collect.*; \/games\/: .*__collect/)
    expect(tracking.legal!.sources.map(source => source.title)).toEqual(expect.arrayContaining([expect.stringMatching(/GDPR/), expect.stringMatching(/COPPA|Children's Online/)]))
    expect(server.mutations()).toEqual([])
  })

  it('asks a mixed-audience site for age screening on its child routes', async () => {
    const result = await run({ site: 'children-good', facts: { audience: 'mixed', ageRestrictedProducts: false }, routes: [{ path: '/games/', source: 'owner', tags: ['kids'], coverage: 'full' }, '/'] })
    expect(result.findings.map(finding => finding.key)).toEqual(['missing-age-screening'])
    expect(result.coverage.tested.map(entry => entry.path)).toEqual(['/games/', '/privacy/'])
  })

  it('requires an age gate for age-restricted products and always asks for eligibility evidence', async () => {
    const facts = { audience: 'general', ageRestrictedProducts: true }
    const ungated = await run({ site: 'children-na', facts, routes: ['/'] })
    expect(ungated.findings.map(finding => finding.key)).toEqual(['missing-age-gate'])
    expect(ungated.status).toBe('FAIL')
    const gated = await run({ site: 'children-na', facts, routes: ['/adult/'] })
    expect(gated.findings).toEqual([])
    expect(gated.status).toBe('PASS')
    expect(gated.observations).toContain('age gate found on /adult/')
    expect(gated.humanReview.map(item => item.id)).toEqual(['C14:eligibility-evidence', 'C14:legal-adequacy'])
  })
})
