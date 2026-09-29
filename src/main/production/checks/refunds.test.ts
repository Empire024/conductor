import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CheckOutcome, RouteEntry } from '../../../shared/production'
import { createWooCommerceAdapter } from '../adapters/woocommerce'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createWooFake, type WooFake, type WooFakeOptions } from '../fixtures/woo-fake'
import { createCommerceContext, type CommerceContextOptions, type JournalEntry } from './commerce-testkit'
import { refundsCheck } from './refunds'

const engine = await resolveEngine()

let scratch: string
const open: Array<{ close(): Promise<void> }> = []
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'prod-refunds-')) })
afterEach(async () => { await Promise.all(open.splice(0).map(item => item.close())) })
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const ROUTES: RouteEntry[] = [
  { path: '/refund-policy/', source: 'sitemap', tags: ['policy', 'refunds'], coverage: 'full' },
  { path: '/product/alpha/', source: 'sitemap', tags: ['product'], coverage: 'full' },
  { path: '/checkout/', source: 'sitemap', tags: ['checkout'], coverage: 'full' },
]
const EU_B2C = { businessModel: 'b2c', products: ['vases'], targetCountries: ['SK', 'CZ'] }
const ORDER = {
  id: 4001, status: 'completed', currency: 'EUR', total: '23.40', date_created_gmt: '2026-09-20T10:00:00Z', prices_include_tax: true, total_tax: '0.00',
  billing: { email: 'buyer@shop.test' }, line_items: [{ name: 'Alpha vase', total: '19.90' }], fee_lines: [], shipping_lines: [{ method_title: 'Courier', total: '3.50' }],
}

async function world(site: string, options: WooFakeOptions = {}): Promise<{ server: FixtureServer; woo: WooFake }> {
  const woo = await createWooFake({ orders: [ORDER], ...options })
  const server = await createFixtureServer({ sites: [site], placeholders: { woo: woo.origin } })
  open.push(server, woo)
  return { server, woo }
}

async function run(server: FixtureServer, woo: WooFake, options: Partial<CommerceContextOptions> & { site: string }): Promise<{ result: CheckOutcome; operations: JournalEntry[] }> {
  const harness = createCommerceContext({
    server, scratch, controlId: 'C11', facts: EU_B2C, routes: ROUTES,
    adapters: policy => ({ commerce: createWooCommerceAdapter({ endpoint: woo.restBase, policy }) }),
    ...options,
  })
  try { return { result: await refundsCheck.run(harness.context), operations: harness.operations } } finally { await harness.close() }
}

describe('C11 applicability', () => {
  it('is NOT_APPLICABLE for B2B-only sales and opens nothing (negative control)', async () => {
    const { server, woo } = await world('refunds-good')
    const { result } = await run(server, woo, { site: 'refunds-good', facts: { businessModel: 'b2b', products: ['vases'] } })
    expect(result).toMatchObject({ status: 'NOT_APPLICABLE', findings: [] })
    expect(server.requests('refunds-good')).toEqual([])
  })

  it('is UNVERIFIED while the products are unknown', async () => {
    const { server, woo } = await world('refunds-good')
    const { result } = await run(server, woo, { site: 'refunds-good', facts: { businessModel: 'b2c' } })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/until the owner answers: products/)
  })
})

describe.skipIf(!engine.available)('C11 refunds check (read-only parts)', { timeout: 60_000 }, () => {
  it('finds a checkout without the policy, contradicting periods and a period below 14 days (broken)', async () => {
    const { server, woo } = await world('refunds-inconsistent')
    const { result } = await run(server, woo, { site: 'refunds-inconsistent' })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['inconsistent-refund-periods', 'refund-policy-not-before-purchase', 'withdrawal-period-below-14-days'])
    expect(result.findings.find(finding => finding.key === 'inconsistent-refund-periods')!.observed).toMatch(/\/refund-policy\/: .*30 days.*\/product\/alpha\/: .*7 days/)
    expect(result.findings.find(finding => finding.key === 'withdrawal-period-below-14-days')).toMatchObject({ route: '/product/alpha/', confidence: 'likely' })
    expect(result.humanReview.map(item => item.id)).toEqual(['C11:legal-adequacy'])
  })

  it('stops the refund request without a write authorization: UNVERIFIED with the reason, nothing requested', async () => {
    const { server, woo } = await world('refunds-good')
    const { result, operations } = await run(server, woo, { site: 'refunds-good' })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.findings).toEqual([])
    expect(result.reason).toMatch(/sandbox write authorization required for refund-request/)
    expect(operations).toEqual([])
    expect(woo.refunds()).toEqual([])
    expect(woo.calls().filter(call => !call.startsWith('GET'))).toEqual([])
    expect(server.mutations('refunds-good')).toEqual([])
  })

  it('never requests a refund on production, even with a stray authorization', async () => {
    const { server, woo } = await world('refunds-good')
    const { result, operations } = await run(server, woo, { site: 'refunds-good', environmentKind: 'production', authorize: ['refund-request'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/sandbox write authorization required for refund-request: .*production/)
    expect(operations).toEqual([])
    expect(woo.calls()).toEqual([])
  })

  it('does not treat another mutation kind as permission to request a refund', async () => {
    const { server, woo } = await world('refunds-good')
    const { result, operations } = await run(server, woo, { site: 'refunds-good', authorize: ['checkout', 'subscription-cancel'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(operations).toEqual([])
    expect(woo.refunds()).toEqual([])
  })
})

describe.skipIf(!engine.available)('C11 sandbox refund request', { timeout: 60_000 }, () => {
  it('passes a consistent 14-day policy linked from checkout with an accepted sandbox refund (known-good)', async () => {
    const { server, woo } = await world('refunds-good')
    const { result, operations } = await run(server, woo, { site: 'refunds-good', authorize: ['refund-request'] })
    expect(result.reason).toBeNull()
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(operations.map(entry => `${entry.mutation}:${entry.status}`)).toEqual(['refund-request:done'])
    // Recorded in the sandbox only: never a gateway refund.
    expect(woo.refunds()).toEqual([{ orderId: 4001, amount: '23.40', reason: expect.stringMatching(/sandbox refund request/), apiRefund: false }])
    expect(result.observations.join('\n')).toMatch(/Stated periods: \/refund-policy\/ 14 days; \/product\/alpha\/ 14 days/)
    expect(result.humanReview.map(item => item.id)).toEqual(['C11:legal-adequacy'])
  })

  it('sends a blanket "no refunds" to human review instead of deciding it (broken, review)', async () => {
    const { server, woo } = await world('refunds-blanket-no', { refusesRefunds: true })
    const { result } = await run(server, woo, { site: 'refunds-blanket-no', authorize: ['refund-request'] })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('NEEDS_HUMAN_REVIEW')
    const blanket = result.humanReview.find(item => item.id === 'C11:blanket-no-refunds')!
    expect(blanket.question).toMatch(/All sales are final/)
    expect(result.observations.join('\n')).toMatch(/Sandbox refund request for order 4001: refused/)
  })

  it('finds a refund refused although the policy promises one', async () => {
    const { server, woo } = await world('refunds-good', { refusesRefunds: true })
    const { result } = await run(server, woo, { site: 'refunds-good', authorize: ['refund-request'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key)).toEqual(['refund-request-refused'])
  })
})
