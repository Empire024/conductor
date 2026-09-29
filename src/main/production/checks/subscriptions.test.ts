import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CheckOutcome, RouteEntry } from '../../../shared/production'
import { createWooCommerceAdapter } from '../adapters/woocommerce'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createWooFake, type WooFake, type WooFakeOptions } from '../fixtures/woo-fake'
import { createCommerceContext, testAccount, type CommerceContextOptions, type JournalEntry } from './commerce-testkit'
import { subscriptionsCheck } from './subscriptions'

const engine = await resolveEngine()

let scratch: string
const open: Array<{ close(): Promise<void> }> = []
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'prod-subs-')) })
afterEach(async () => { await Promise.all(open.splice(0).map(item => item.close())) })
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const ROUTES: RouteEntry[] = [
  { path: '/product/monthly-box/', source: 'owner', tags: ['product', 'subscription'], coverage: 'full' },
  { path: '/my-account/subscriptions/', source: 'owner', tags: ['account', 'subscriptions'], coverage: 'full' },
]
const SUBSCRIBER = 'subscriber@shop.test'

async function world(site: string, options: WooFakeOptions = {}): Promise<{ server: FixtureServer; woo: WooFake }> {
  const woo = await createWooFake({
    customers: [{ id: 7, email: SUBSCRIBER }],
    subscriptions: [
      { id: 'sub-1001', customer_id: 7, status: 'active', total: '19.90', billing_interval: '1', billing_period: 'month', next_payment_date_gmt: '2026-11-01T00:00:00Z' },
      { id: 'sub-1002', customer_id: 7, status: 'active', total: '9.90', billing_interval: '1', billing_period: 'month', next_payment_date_gmt: '2026-11-05T00:00:00Z' },
    ],
    ...options,
  })
  const server = await createFixtureServer({ sites: [site], placeholders: { woo: woo.origin } })
  open.push(server, woo)
  return { server, woo }
}

async function run(server: FixtureServer, woo: WooFake, options: Partial<CommerceContextOptions> & { site: string }): Promise<{ result: CheckOutcome; operations: JournalEntry[] }> {
  const harness = createCommerceContext({
    server, scratch, controlId: 'C10', facts: { subscriptions: true, targetCountries: ['SK'] }, routes: ROUTES, extraOrigins: [woo.origin],
    accounts: [testAccount('subscriber', SUBSCRIBER)],
    adapters: policy => ({ commerce: createWooCommerceAdapter({ endpoint: woo.restBase, policy, resolveCredential: ref => ref.key === 'TEST_SUBSCRIBER_USER' ? SUBSCRIBER : null }) }),
    ...options,
  })
  try { return { result: await subscriptionsCheck.run(harness.context), operations: harness.operations } } finally { await harness.close() }
}

describe('C10 applicability', () => {
  it('is NOT_APPLICABLE when no subscriptions are sold, and opens nothing (negative control)', async () => {
    const { server, woo } = await world('subs-na')
    const { result } = await run(server, woo, { site: 'subs-na', facts: { subscriptions: false } })
    expect(result).toMatchObject({ status: 'NOT_APPLICABLE', findings: [] })
    expect(result.reason).toMatch(/No subscriptions or automatic renewals are offered/)
    expect(server.requests('subs-na')).toEqual([])
    expect(woo.calls()).toEqual([])
  })

  it('is UNVERIFIED while it is unknown whether subscriptions are sold', async () => {
    const { server, woo } = await world('subs-na')
    const { result } = await run(server, woo, { site: 'subs-na', facts: {} })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/until the owner answers: subscriptions/)
  })
})

describe.skipIf(!engine.available)('C10 subscriptions check', { timeout: 60_000 }, () => {
  it('passes with renewal terms at the subscribe button and cancellation that clears the next payment by UI and adapter (known-good)', async () => {
    const { server, woo } = await world('subs-good')
    const { result, operations } = await run(server, woo, { site: 'subs-good', authorize: ['subscription-cancel'] })
    expect(result.reason).toBeNull()
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(operations.map(entry => `${entry.mutation}:${entry.status}:${entry.target}`)).toEqual([
      'subscription-cancel:done:cancel through the UI on /my-account/subscriptions/',
      'subscription-cancel:done:cancel sub-1002 through the adapter',
    ])
    expect(woo.subscriptions().map(item => `${item.id}:${item.status}:${item.next_payment_date_gmt}`)).toEqual(['sub-1001:cancelled:null', 'sub-1002:cancelled:null'])
    const observed = result.observations.join('\n')
    expect(observed).toMatch(/Renewal terms next to "Subscribe" on \/product\/monthly-box\//)
    expect(observed).toMatch(/"Cancel subscription" on \/my-account\/subscriptions\/ is reached by keyboard after \d+ Tab presses/)
    expect(observed).toMatch(/sub-1001 cancelled through the ui: status cancelled, next payment cleared/)
    expect(observed).toMatch(/sub-1002 cancelled through the adapter: status cancelled, next payment cleared/)
    // Cancellation is its own journey: no refund, no account deletion.
    expect(woo.refunds()).toEqual([])
    expect(woo.calls().filter(call => /refund|DELETE/i.test(call))).toEqual([])
    expect(result.coverage.tested.find(item => item.path === '/my-account/subscriptions/')?.authStates).toEqual(['authenticated'])
  })

  it('finds renewal terms away from the button and billing that continues after cancellation (broken)', async () => {
    const { server, woo } = await world('subs-billing-continues', { cancelKeepsNextPayment: true })
    const { result } = await run(server, woo, { site: 'subs-billing-continues', authorize: ['subscription-cancel'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['billing-continues-after-cancel:adapter', 'billing-continues-after-cancel:ui', 'renewal-terms-not-at-consent'])
    const terms = result.findings.find(finding => finding.key === 'renewal-terms-not-at-consent')!
    expect(terms.observed).toMatch(/missing .*renews automatically.*how to cancel/)
    const billing = result.findings.find(finding => finding.key === 'billing-continues-after-cancel:ui')!
    expect(billing).toMatchObject({ severity: 'critical', confidence: 'confirmed', route: '/my-account/subscriptions/' })
    expect(billing.observed).toMatch(/sub-1001 is cancelled but its next payment is still scheduled for 2026-11-01/)
  })

  it('stops before the first mutation without a write authorization: UNVERIFIED with the reason, nothing cancelled', async () => {
    const { server, woo } = await world('subs-good')
    const { result, operations } = await run(server, woo, { site: 'subs-good' })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/sandbox write authorization required for subscription-cancel/)
    expect(result.findings).toEqual([])
    expect(operations).toEqual([])
    expect(server.mutations('subs-good')).toEqual([])
    expect(woo.subscriptions().every(item => item.status === 'active' && item.next_payment_date_gmt)).toBe(true)
    expect(woo.calls().filter(call => !call.startsWith('GET'))).toEqual([])
    // The read-only parts still ran.
    expect(result.observations.join('\n')).toMatch(/reached by keyboard/)
  })

  it('never cancels on production, even with a stray authorization', async () => {
    const { server, woo } = await world('subs-good')
    const { result, operations } = await run(server, woo, { site: 'subs-good', environmentKind: 'production', authorize: ['subscription-cancel'], accounts: [] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/sandbox write authorization required for subscription-cancel: .*production/)
    expect(operations).toEqual([])
    expect(woo.calls().filter(call => !call.startsWith('GET'))).toEqual([])
  })

  it('refuses an adapter cancellation outside the authorization before any request', async () => {
    const { woo } = await world('subs-good')
    const readOnly = { environmentId: 'env', environmentKind: 'sandbox' as const, allowedOrigins: [], readOnly: true, writeAuthorization: null, maxRequests: 10, requestsPerSecondPerOrigin: 0, allowPrivateAddresses: true }
    const adapter = createWooCommerceAdapter({ endpoint: woo.restBase, policy: readOnly })
    await expect(adapter.cancelSubscription('sub-1001')).rejects.toThrow(/sandbox write authorization required for subscription-cancel/)
    await expect(adapter.requestRefund('1', 'test')).rejects.toThrow(/refused/)
    expect(woo.calls()).toEqual([])
  })
})
