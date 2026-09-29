import type {
  CommerceOrder, CommerceSandboxAdapter, CommerceSubscription, CredentialRef, DataRecordsAdapter, MutationKind, NetworkPolicy, TestAccountRef,
} from '../../../shared/production'
import type { DataRecord } from '../checks/commerce-support'
import { REFUND_MUTATION } from '../checks/commerce-support'
import { assertMutationAllowed } from '../netpolicy'

/**
 * Commerce sandbox adapter over the WooCommerce REST API v3 (plus WooCommerce Subscriptions'
 * `/subscriptions`), docs/production-agent.md M6. `endpoint` is the REST base
 * (`https://shop.example/wp-json/wc/v3`); the credential is `consumer_key:consumer_secret`, sent as
 * HTTP Basic auth and never logged. Reads are bounded (page size, response bytes, timeout). The two
 * mutations check the write authorization before any request, and a refund is recorded with
 * `api_refund: false`, so the payment gateway is never asked to move money.
 */

export const WOO_TIMEOUT_MS = 20_000
export const MAX_WOO_RESPONSE = 2 * 1024 * 1024
const PAGE_SIZE = 50

export interface WooCommerceOptions {
  endpoint: string
  policy: NetworkPolicy
  credentialRef?: CredentialRef | null
  resolveCredential?: (ref: CredentialRef) => string | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export type WooCommerceAdapter = CommerceSandboxAdapter & DataRecordsAdapter

export class WooRequestFailed extends Error {
  constructor(readonly status: number | null, message: string) { super(message); this.name = 'WooRequestFailed' }
}

type Json = Record<string, unknown>

export function createWooCommerceAdapter(options: WooCommerceOptions): WooCommerceAdapter {
  let base: URL
  try { base = new URL(options.endpoint.replace(/\/+$/, '') + '/') } catch { throw new Error(`WooCommerce endpoint ${options.endpoint} is not a URL`) }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`WooCommerce endpoint ${options.endpoint} must be http(s)`)
  const doFetch = options.fetch ?? fetch
  const resolve = options.resolveCredential ?? (() => null)

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = new URL(path.replace(/^\/+/, ''), base)
    const headers: Record<string, string> = { accept: 'application/json' }
    const credential = options.credentialRef ? resolve(options.credentialRef) : null
    if (credential) headers.authorization = `Basic ${Buffer.from(credential).toString('base64')}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? WOO_TIMEOUT_MS) })
    } catch (error) {
      throw new WooRequestFailed(null, `${method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await boundedText(response)
    let value: unknown = null
    try { value = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'message' in value ? String((value as Json).message) : text.slice(0, 200)
      throw new WooRequestFailed(response.status, `${method} ${url.pathname}: HTTP ${response.status}${message ? ` (${message})` : ''}`)
    }
    return value
  }
  const guard = (mutation: MutationKind): void => { assertMutationAllowed(options.policy, mutation) }
  const customerId = async (account: TestAccountRef): Promise<string> => {
    const email = resolve(account.usernameRef)
    if (!email) throw new WooRequestFailed(null, `the username of test account ${account.label} could not be resolved (${account.usernameRef.source}:${account.usernameRef.key})`)
    const customers = array(await request('GET', `customers?email=${encodeURIComponent(email)}&per_page=5`))
    const id = customers[0]?.id
    if (id === undefined || id === null) throw new WooRequestFailed(404, `no WooCommerce customer for test account ${account.label}`)
    return String(id)
  }

  return {
    async orders(since) {
      const query = `orders?per_page=${PAGE_SIZE}&orderby=date&order=desc${since ? `&after=${encodeURIComponent(since)}` : ''}`
      return array(await request('GET', query)).map(toOrder)
    },
    async subscriptions(account) {
      const id = await customerId(account)
      return array(await request('GET', `subscriptions?customer=${encodeURIComponent(id)}&per_page=${PAGE_SIZE}`)).map(toSubscription)
    },
    async cancelSubscription(id) {
      guard('subscription-cancel')
      return toSubscription(object(await request('PUT', `subscriptions/${encodeURIComponent(id)}`, { status: 'cancelled' })))
    },
    async requestRefund(orderId, reason) {
      guard(REFUND_MUTATION)
      const current = object(await request('GET', `orders/${encodeURIComponent(orderId)}`))
      try {
        const refund = object(await request('POST', `orders/${encodeURIComponent(orderId)}/refunds`, { amount: String(current.total ?? '0'), reason, api_refund: false }))
        return { accepted: true, detail: `refund ${String(refund.id ?? '')} recorded for ${String(refund.amount ?? current.total ?? '')}`.trim() }
      } catch (error) {
        if (error instanceof WooRequestFailed && error.status !== null && error.status >= 400 && error.status < 500) return { accepted: false, detail: error.message }
        throw error
      }
    },
    async records(subject) {
      const found: DataRecord[] = []
      for (const customer of array(await request('GET', `customers?email=${encodeURIComponent(subject)}&per_page=5`))) {
        found.push({ store: 'woocommerce', kind: 'customer', id: String(customer.id ?? ''), retainedBecause: null })
      }
      for (const item of array(await request('GET', `orders?search=${encodeURIComponent(subject)}&per_page=${PAGE_SIZE}`))) {
        found.push({ store: 'woocommerce', kind: 'order', id: String(item.id ?? ''), retainedBecause: null })
      }
      return found
    },
  }
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_WOO_RESPONSE) throw new WooRequestFailed(response.status, `response of ${length} bytes is over the ${MAX_WOO_RESPONSE}-byte limit`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_WOO_RESPONSE) throw new WooRequestFailed(response.status, `response is over the ${MAX_WOO_RESPONSE}-byte limit`)
  return buffer.toString('utf8')
}

function array(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new WooRequestFailed(null, 'expected a JSON array')
  return value.filter((item): item is Json => !!item && typeof item === 'object').slice(0, 500)
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WooRequestFailed(null, 'expected a JSON object')
  return value as Json
}

const text = (value: unknown): string => value === null || value === undefined ? '' : String(value)
const nullable = (value: unknown): string | null => value === null || value === undefined || value === '' ? null : String(value)
const items = (value: unknown): Json[] => Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === 'object').slice(0, 200) : []

function toOrder(item: Json): CommerceOrder {
  const fees = [
    ...items(item.fee_lines).map(fee => ({ label: text(fee.name), amount: text(fee.total) })),
    ...items(item.shipping_lines).map(line => ({ label: text(line.method_title) || 'Shipping', amount: text(line.total) })),
  ]
  // Prices that exclude tax add it on top: a charge the customer must have seen before paying.
  if (item.prices_include_tax === false && Number(item.total_tax ?? 0) > 0) fees.push({ label: 'Tax', amount: text(item.total_tax) })
  return {
    id: text(item.id), total: text(item.total), currency: text(item.currency), status: text(item.status),
    lines: items(item.line_items).map(line => ({ label: text(line.name), amount: text(line.total) })),
    fees,
  }
}

function toSubscription(item: Json): CommerceSubscription {
  return {
    id: text(item.id), status: text(item.status), amount: text(item.total),
    interval: `${text(item.billing_interval) || '1'} ${text(item.billing_period)}`.trim(),
    nextPaymentAt: nullable(item.next_payment_date_gmt),
    cancelledAt: nullable(item.cancelled_date_gmt) ?? nullable(item.end_date_gmt),
  }
}
