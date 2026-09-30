import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CapturedMailAdapter, CheckOutcome, RouteEntry } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createDocumentContext, type DocumentContextOptions } from './document-testkit'
import { elementsIn, identityCheck, requiredElements } from './identity'

const engine = await resolveEngine()
const ENTITY = 'Hash and Flowers s.r.o., Hlavná 12, 811 01 Bratislava, IČO 12345678'
const facts = { legalEntity: ENTITY, targetCountries: ['SK'] }
const checkout: RouteEntry = { path: '/checkout/', source: 'owner', tags: ['checkout'], coverage: 'full' }
const mailbox = (...texts: string[]): CapturedMailAdapter => ({
  list: async () => texts.map((text, index) => ({ id: `m${index}`, from: 'shop@hashandflowers.example', to: ['audit@example.com'], subject: `Order confirmation ${index + 1}`, receivedAt: '2026-09-29T08:00:00.000Z', text, html: null, headers: {} })),
})

let server: FixtureServer
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-identity-'))
  server = await createFixtureServer({ sites: ['identity-good', 'identity-missing'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

async function run(options: Omit<DocumentContextOptions, 'server' | 'scratch' | 'controlId'>): Promise<CheckOutcome> {
  const harness = createDocumentContext({ server, scratch, controlId: 'C02', ...options })
  try { return await identityCheck.run(harness.context) } finally { await harness.close() }
}
const keys = (result: CheckOutcome): string[] => result.findings.map(finding => finding.key).sort()

describe('identity rules', () => {
  it('requires the elements each target jurisdiction names, and the universal ones otherwise', () => {
    expect([...requiredElements(null).keys()]).toEqual(['name', 'address', 'email'])
    expect([...requiredElements(new Set(['SK', 'EU'])).keys()].sort()).toEqual(['address', 'email', 'name', 'register', 'registration'])
    expect(requiredElements(new Set(['US', 'US-CA'])).get('phone')).toEqual([expect.stringContaining('1789.3')])
    expect(requiredElements(new Set(['SK'])).get('register')).toEqual([expect.stringContaining('22/2004')])
  })

  it('recognises identity elements in Slovak, Czech and English text', () => {
    const sk = 'Hash and Flowers s. r. o., Hlavná 12, 811 01 Bratislava, IČO: 12345678, zapísaná v Obchodnom registri, info@hf.example, +421 900 123 456'
    expect([...elementsIn(sk, 'Hash and Flowers s.r.o.')].sort()).toEqual(['address', 'email', 'name', 'phone', 'register', 'registration'])
    const cz = 'Květiny Praha a.s., Na Příkopě 5, 110 00 Praha 1, IČ 87654321, zapsaná v obchodním rejstříku vedeném Městským soudem v Praze'
    expect([...elementsIn(cz, null)].sort()).toEqual(['address', 'name', 'register', 'registration'])
    const us = 'Flowers Inc., 100 Main Street, Springfield, IL 62701, tel. (217) 555-0100'
    expect([...elementsIn(us, 'Flowers Inc.')].sort()).toEqual(['address', 'name', 'phone'])
    expect([...elementsIn('© 2026 Flower Shop', 'Hash and Flowers s.r.o.')]).toEqual([])
  })
})

describe.skipIf(!engine.available)('C02 identity check', { timeout: 60_000 }, () => {
  it('passes a site showing every required element, consistent across contact, policies and checkout (known-good)', async () => {
    const result = await run({ site: 'identity-good', facts, routes: [checkout] })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.coverage.tested.map(entry => entry.path).sort()).toEqual(['/', '/checkout/', '/contact/', '/privacy/', '/terms/'])
    expect(result.coverage.unobservable).toContain('receipts: no captured mail is configured for this environment')
    expect(result.humanReview.map(item => item.id)).toEqual(['C02:legal-adequacy'])
  })

  it('finds missing required elements and a policy naming another operator with another registration number (broken)', async () => {
    const result = await run({ site: 'identity-missing', facts, routes: [checkout] })
    expect(result.status).toBe('FAIL')
    expect(keys(result)).toEqual([
      'entity-mismatch:policy', 'missing:address', 'missing:email', 'missing:name', 'missing:register', 'missing:registration', 'registration-mismatch:policy',
    ])
    const mismatch = result.findings.find(finding => finding.key === 'entity-mismatch:policy')!
    expect(mismatch).toMatchObject({ route: '/privacy/', confidence: 'confirmed' })
    expect(mismatch.observed).toContain('Flower Trading s.r.o.')
    expect(result.findings.find(finding => finding.key === 'registration-mismatch:policy')!.observed).toContain('87654321')
    expect(result.findings.find(finding => finding.key === 'missing:register')!.expected).toContain('22/2004')
    expect(result.observations).toEqual(expect.arrayContaining([expect.stringMatching(/checkout \/checkout\/ does not name Hash and Flowers s\.r\.o\./)]))
  })

  it('compares receipts from captured mail with the profile entity', async () => {
    const matching = await run({ site: 'identity-good', facts, routes: [checkout], mail: mailbox('Thank you for your order. Hash and Flowers s.r.o., IČO: 12345678') })
    expect(matching.findings).toEqual([])
    expect(matching.coverage.unobservable).toEqual([])
    const wrong = await run({ site: 'identity-good', facts, routes: [checkout], mail: mailbox('Thank you for your order. Bloom Partners s.r.o., IČO: 99999999') })
    expect(keys(wrong)).toEqual(['entity-mismatch:receipt', 'registration-mismatch:receipt'])
    expect(wrong.findings[0]).toMatchObject({ scope: 'email', route: null })
  })

  it('stays UNVERIFIED without the legal entity or the target countries, never PASS', async () => {
    const result = await run({ site: 'identity-good', facts: {}, routes: [checkout] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/legal entity unknown.*target countries unknown/)
  })

  it('finds the checkout through the home page\'s checkout link, never an add-to-cart link that is a mutation', async () => {
    const result = await run({ site: 'identity-good', facts, routes: [] })
    expect(result.coverage.tested.map(entry => entry.path)).toContain('/checkout/')
    expect(JSON.stringify(result)).not.toContain('add-to-cart')
    expect(server.requests('identity-good').some(request => request.path.includes('add-to-cart'))).toBe(false)
  })

  it('requires a telephone number for California and finds it', async () => {
    const result = await run({ site: 'identity-good', facts: { ...facts, targetCountries: ['US-CA'] }, routes: [checkout] })
    expect(result.findings).toEqual([])
    expect(server.mutations()).toEqual([])
  })
})
