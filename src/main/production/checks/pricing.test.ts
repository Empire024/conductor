import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CheckOutcome, RouteEntry } from '../../../shared/production'
import { createCapturedMailAdapter } from '../adapters/mailpit'
import { createWooCommerceAdapter } from '../adapters/woocommerce'
import { resolveEngine } from '../browser'
import { createMailpitFake, type MailpitFake } from '../fixtures/mailpit-fake'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createWooFake, type WooFake } from '../fixtures/woo-fake'
import { formatMoney, parseMoney } from './commerce-support'
import { createCommerceContext, type CommerceContextOptions, type JournalEntry } from './commerce-testkit'
import { pricingCheck } from './pricing'

const engine = await resolveEngine()

let server: FixtureServer
let woo: WooFake
let mail: MailpitFake
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-pricing-'))
  mail = await createMailpitFake()
  woo = await createWooFake({ credential: 'ck_test:cs_test', receipts: mail })
  server = await createFixtureServer({ sites: ['pricing-good', 'pricing-fee-mismatch'], placeholders: { woo: woo.origin } })
})
afterAll(async () => {
  await server?.close()
  await woo?.close()
  await mail?.close()
  rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => server.reset())

const ROUTES: RouteEntry[] = [
  { path: '/product/alpha/', source: 'sitemap', tags: ['product'], coverage: 'full' },
  { path: '/cart/', source: 'sitemap', tags: ['cart'], coverage: 'full' },
  { path: '/checkout/', source: 'sitemap', tags: ['checkout'], coverage: 'full' },
]
const B2C = { businessModel: 'b2c', products: ['vases'], targetCountries: ['SK'] }

async function run(options: Partial<CommerceContextOptions> & { site: string }): Promise<{ result: CheckOutcome; operations: JournalEntry[] }> {
  const harness = createCommerceContext({
    server, scratch, controlId: 'C09', facts: B2C, routes: ROUTES, extraOrigins: [woo.origin],
    adapters: policy => ({
      commerce: createWooCommerceAdapter({ endpoint: woo.restBase, policy, credentialRef: { id: 'woo', source: 'env', key: 'WOO', purpose: 'rest' }, resolveCredential: () => 'ck_test:cs_test' }),
      mail: createCapturedMailAdapter({ kind: 'mailpit', location: mail.origin }),
    }),
    ...options,
  })
  try { return { result: await pricingCheck.run(harness.context), operations: harness.operations } } finally { await harness.close() }
}

describe('money parsing', () => {
  it('reads European, symbol-first and code amounts', () => {
    expect(parseMoney('19,90 €')).toEqual({ cents: 1990, currency: 'EUR' })
    expect(parseMoney('€19.90')).toEqual({ cents: 1990, currency: 'EUR' })
    expect(parseMoney('Total: 1 234,50 Kč')).toEqual({ cents: 123450, currency: 'CZK' })
    expect(parseMoney('1,234.50 USD')).toEqual({ cents: 123450, currency: 'USD' })
    expect(parseMoney('24.90')).toEqual({ cents: 2490, currency: null })
    expect(parseMoney('no price')).toBeNull()
    expect(formatMoney({ cents: 2340, currency: 'EUR' })).toBe('23.40 EUR')
  })
})

describe('C09 applicability', () => {
  it('is NOT_APPLICABLE for B2B-only sales and opens nothing (negative control)', async () => {
    const { result } = await run({ site: 'pricing-good', facts: { businessModel: 'b2b', products: ['vases'] } })
    expect(result).toMatchObject({ status: 'NOT_APPLICABLE', findings: [] })
    expect(server.requests('pricing-good')).toEqual([])
  })

  it('is UNVERIFIED while the business model is unknown', async () => {
    const { result } = await run({ site: 'pricing-good', facts: { products: ['vases'] } })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/until the owner answers: businessModel/)
  })
})

describe.skipIf(!engine.available)('C09 pricing check', { timeout: 60_000 }, () => {
  it('passes when advertised, cart, checkout, order and receipt totals agree and shipping is disclosed (known-good)', async () => {
    const before = woo.orders().length
    const { result, operations } = await run({ site: 'pricing-good', authorize: ['checkout'] })
    expect(result.reason).toBeNull()
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(operations.map(entry => `${entry.mutation}:${entry.status}`)).toEqual(['checkout:done', 'checkout:done'])
    const orders = woo.orders()
    expect(orders).toHaveLength(before + 1)
    expect(orders.at(-1)).toMatchObject({ total: '23.40', currency: 'EUR' })
    expect(result.observations.join('\n')).toMatch(/advertised 19\.90 EUR, cartLine 19\.90 EUR, .*checkoutTotal 23\.40 EUR, orderTotal 23\.40 EUR, receiptPage 23\.40 EUR, receiptEmail 23\.40 EUR/)
    expect(result.coverage.tested.map(item => item.path)).toEqual(['/product/alpha/', '/cart/', '/checkout/'])
    expect(result.evidence.length).toBeGreaterThanOrEqual(3)
  })

  it('finds a fee charged at order time that checkout never showed (broken)', async () => {
    const { result } = await run({ site: 'pricing-fee-mismatch', authorize: ['checkout'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['fee-undisclosed:service-fee', 'order-differs-from-checkout'])
    const fee = result.findings.find(finding => finding.key === 'fee-undisclosed:service-fee')!
    expect(fee).toMatchObject({ controlId: 'C09', route: '/checkout/', severity: 'high', confidence: 'confirmed', category: 'legal' })
    expect(fee.observed).toMatch(/charged Service fee 1\.50 EUR/)
    expect(fee.legal?.sources.length).toBeGreaterThan(0)
    const total = result.findings.find(finding => finding.key === 'order-differs-from-checkout')!
    expect(total.expected).toMatch(/23\.40 EUR/)
    expect(total.observed).toMatch(/24\.90 EUR/)
  })

  it('stops before the first mutation without a write authorization: UNVERIFIED with the reason, nothing submitted', async () => {
    const orders = woo.orders().length
    const { result, operations } = await run({ site: 'pricing-good' })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/sandbox write authorization required for checkout/)
    expect(operations).toEqual([])
    expect(server.mutations('pricing-good')).toEqual([])
    expect(woo.orders()).toHaveLength(orders)
    expect(result.observations.join('\n')).toMatch(/Advertised: \/product\/alpha\/ 19\.90 EUR/)
  })

  it('never submits on production, even with a stray authorization', async () => {
    const orders = woo.orders().length
    const { result, operations } = await run({ site: 'pricing-fee-mismatch', environmentKind: 'production', authorize: ['checkout'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/sandbox write authorization required for checkout: .*production/)
    expect(operations).toEqual([])
    expect(server.mutations('pricing-fee-mismatch')).toEqual([])
    expect(woo.orders()).toHaveLength(orders)
  })

  it('is UNVERIFIED, not PASS, without a commerce adapter to read the order back', async () => {
    const { result, operations } = await run({ site: 'pricing-good', authorize: ['checkout'], adapters: {} })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/no commerce sandbox adapter/)
    expect(operations).toEqual([])
    expect(server.mutations('pricing-good')).toEqual([])
  })
})
