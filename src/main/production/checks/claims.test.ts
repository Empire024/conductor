import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CheckOutcome } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { claimsCheck } from './claims'
import { createDocumentContext, type DocumentContextOptions } from './document-testkit'

const engine = await resolveEngine()
const routes = ['/', '/product/', '/checkout/']

let server: FixtureServer
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-claims-'))
  server = await createFixtureServer({ sites: ['claims-good', 'claims-fabricated'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

async function run(options: Omit<DocumentContextOptions, 'server' | 'scratch' | 'controlId'>): Promise<{ result: CheckOutcome; artifacts: string }> {
  const harness = createDocumentContext({ server, scratch, controlId: 'C12', ...options })
  try { return { result: await claimsCheck.run(harness.context), artifacts: harness.evidence.dir } } finally { await harness.close() }
}

describe.skipIf(!engine.available)('C12 claims check', { timeout: 60_000 }, () => {
  it('passes an honest countdown, unique testimonials and unticked extras, and lists unverifiable claims for review (known-good and negative control)', async () => {
    const { result } = await run({ site: 'claims-good', facts: { businessModel: 'b2c' }, routes })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    // The honest countdown was live and kept counting down across the reload.
    expect(result.observations.some(line => /did not count down/.test(line))).toBe(false)
    expect(result.humanReview.map(item => item.id)).toEqual(['C12:claim:the-best-bouquets-in-bratislava-hand-tied-every'])
    expect(result.humanReview[0]!.question).toContain('"The best bouquets in Bratislava, hand-tied every morning" on /')
    expect(result.coverage.tested.map(entry => entry.path)).toEqual(routes)
  })

  it('finds a restarting countdown, a changing stock count, a reused testimonial, a ticked paid extra and confirm-shaming (broken)', async () => {
    const { result, artifacts } = await run({ site: 'claims-fabricated', facts: { businessModel: 'b2c' }, routes })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => `${finding.key}@${finding.route ?? 'site'}`).sort()).toEqual([
      'confirm-shaming:no-thanks-i-don-t-want-fresh-flowers@/checkout/',
      'countdown-reset:0@/',
      'duplicate-testimonial:absolutely-the-best-flowers-i-have-ever-ordered@site',
      'preselected-extra:insurance@/checkout/',
      'scarcity-changes:0@/',
    ])
    const reset = result.findings.find(finding => finding.key === 'countdown-reset:0')!
    expect(reset).toMatchObject({ severity: 'high', confidence: 'confirmed', category: 'legal' })
    expect(reset.observed).toMatch(/after a reload/)
    expect(result.findings.find(finding => finding.key.startsWith('duplicate-testimonial'))!.observed).toMatch(/Maria L\., Susan P\. on \/, \/product\//)
    expect(result.findings.find(finding => finding.key === 'preselected-extra:insurance')!.observed).toContain('Add delivery insurance (+€4.99)')
    // Claims stay review items, never findings or deletions.
    expect(result.humanReview.some(item => item.id.startsWith('C12:claim:the-best-flowers-i-have-ever-ordered'))).toBe(true)
    // The inventory evidence holds the three readings the reset was decided from.
    const inventory = JSON.parse(readFileSync(join(artifacts, 'evidence', '0001-dom.json'), 'utf8'))
    expect(inventory.first.countdowns[0].seconds).toBeGreaterThan(inventory.second.countdowns[0].seconds)
    expect(inventory.afterReload.countdowns[0].seconds).toBeGreaterThan(inventory.second.countdowns[0].seconds)
    // Reading the checkout never submitted anything.
    expect(server.mutations()).toEqual([])
  })

  it('notes a B2B-only project and still judges misleading practices', async () => {
    const { result } = await run({ site: 'claims-fabricated', facts: { businessModel: 'b2b' }, routes: ['/checkout/'] })
    expect(result.observations).toContain('B2B-only: judged as misleading advertising; consumer review rules do not apply')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['confirm-shaming:no-thanks-i-don-t-want-fresh-flowers', 'preselected-extra:insurance'])
  })
})
