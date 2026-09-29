import { afterEach, describe, expect, it } from 'vitest'
import type { MutationKind, NetworkPolicy } from '../../../shared/production'
import { createWooFake, type WooFake } from '../fixtures/woo-fake'
import { createWooCommerceAdapter } from './woocommerce'

const policy = (mutations: MutationKind[]): NetworkPolicy => ({
  environmentId: 'env', environmentKind: 'sandbox', allowedOrigins: [], readOnly: mutations.length === 0, maxRequests: 10, requestsPerSecondPerOrigin: 0, allowPrivateAddresses: true,
  writeAuthorization: mutations.length ? { id: 'a', environmentId: 'env', mutations, grantedBy: { kind: 'owner', agentSessionId: null }, grantedAt: '2026-09-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', note: '' } : null,
})
const CREDENTIAL = { id: 'woo', source: 'env' as const, key: 'WOO_KEYS', purpose: 'rest' }
const ACCOUNT = { id: 'acct', label: 'Subscriber', role: 'subscriber' as const, usernameRef: { id: 'u', source: 'env' as const, key: 'SUB_USER', purpose: '' }, passwordRef: { id: 'p', source: 'env' as const, key: 'SUB_PASS', purpose: '' } }
const resolve = (ref: { key: string }): string | null => ({ WOO_KEYS: 'ck_1:cs_1', SUB_USER: 'sub@shop.test' } as Record<string, string>)[ref.key] ?? null

let woo: WooFake | null = null
afterEach(async () => { await woo?.close(); woo = null })

async function fake(): Promise<WooFake> {
  woo = await createWooFake({
    credential: 'ck_1:cs_1',
    customers: [{ id: 7, email: 'sub@shop.test' }],
    subscriptions: [{ id: '31', customer_id: 7, status: 'active', total: '9.90', billing_interval: '1', billing_period: 'month', next_payment_date_gmt: '2026-11-01T00:00:00Z' }],
    orders: [{
      id: 4001, status: 'completed', currency: 'EUR', total: '26.40', date_created_gmt: '2026-09-20T10:00:00Z', prices_include_tax: false, total_tax: '2.00',
      billing: { email: 'buyer@shop.test' }, line_items: [{ name: 'Vase', total: '19.90' }], fee_lines: [{ name: 'Service fee', total: '1.00' }], shipping_lines: [{ method_title: 'Courier', total: '3.50' }],
    }],
  })
  return woo
}

describe('WooCommerce adapter', () => {
  it('reads orders with fees, shipping and tax added on top, over Basic auth', async () => {
    const shop = await fake()
    const adapter = createWooCommerceAdapter({ endpoint: shop.restBase, policy: policy([]), credentialRef: CREDENTIAL, resolveCredential: resolve })
    expect(await adapter.orders(null)).toEqual([{
      id: '4001', total: '26.40', currency: 'EUR', status: 'completed', lines: [{ label: 'Vase', amount: '19.90' }],
      fees: [{ label: 'Service fee', amount: '1.00' }, { label: 'Courier', amount: '3.50' }, { label: 'Tax', amount: '2.00' }],
    }])
    const anonymous = createWooCommerceAdapter({ endpoint: shop.restBase, policy: policy([]) })
    await expect(anonymous.orders(null)).rejects.toThrow(/HTTP 401 \(Sorry, you cannot list resources\.\)/)
  })

  it('finds the test account\'s subscriptions by its email and cancels only under an authorization', async () => {
    const shop = await fake()
    const readOnly = createWooCommerceAdapter({ endpoint: shop.restBase, policy: policy([]), credentialRef: CREDENTIAL, resolveCredential: resolve })
    expect(await readOnly.subscriptions(ACCOUNT)).toEqual([{ id: '31', status: 'active', amount: '9.90', interval: '1 month', nextPaymentAt: '2026-11-01T00:00:00Z', cancelledAt: null }])
    const before = shop.calls().length
    await expect(readOnly.cancelSubscription('31')).rejects.toThrow(/sandbox write authorization required for subscription-cancel/)
    expect(shop.calls()).toHaveLength(before)
    const allowed = createWooCommerceAdapter({ endpoint: shop.restBase, policy: policy(['subscription-cancel']), credentialRef: CREDENTIAL, resolveCredential: resolve })
    expect(await allowed.cancelSubscription('31')).toMatchObject({ id: '31', status: 'cancelled', nextPaymentAt: null })
    expect(shop.calls().at(-1)).toBe('PUT /wp-json/wc/v3/subscriptions/31')
  })

  it('records a refund with api_refund false (never a gateway refund) and reports a refusal as not accepted', async () => {
    const shop = await fake()
    const adapter = createWooCommerceAdapter({ endpoint: shop.restBase, policy: policy(['refund-request']), credentialRef: CREDENTIAL, resolveCredential: resolve })
    expect(await adapter.requestRefund('4001', 'audit')).toEqual({ accepted: true, detail: 'refund 9001 recorded for 26.40' })
    expect(shop.refunds()).toEqual([{ orderId: 4001, amount: '26.40', reason: 'audit', apiRefund: false }])
    await expect(adapter.requestRefund('999', 'audit')).rejects.toThrow(/HTTP 404/)
  })

  it('lists the records a data subject still has and refuses a non-http endpoint', async () => {
    const shop = await fake()
    const adapter = createWooCommerceAdapter({ endpoint: shop.restBase, policy: policy([]), credentialRef: CREDENTIAL, resolveCredential: resolve })
    expect(await adapter.records('buyer@shop.test')).toEqual([{ store: 'woocommerce', kind: 'order', id: '4001', retainedBecause: null }])
    expect(await adapter.records('sub@shop.test')).toEqual([{ store: 'woocommerce', kind: 'customer', id: '7', retainedBecause: null }])
    expect(() => createWooCommerceAdapter({ endpoint: 'file:///etc/passwd', policy: policy([]) })).toThrow(/must be http/)
  })
})
