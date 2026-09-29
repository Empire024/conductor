import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FakeMail } from './mailpit-fake'

/**
 * A loopback fake of a WooCommerce sandbox for the M6 tests (docs/production-agent.md): the REST
 * API v3 subset the adapter uses (`orders`, `orders/{id}`, `orders/{id}/refunds`, `customers`,
 * WooCommerce Subscriptions' `subscriptions`) plus the two storefront endpoints the fixture sites'
 * forms post to, standing in for the shop's own backend:
 *
 * - `POST /store/checkout` (form fields `line=Label|19.90`, `fee=Label|3.50`, `currency`,
 *   `billing_email`) creates an order from what the page submitted and answers an order-received
 *   page; with `receipts` set it also delivers a receipt email.
 * - `POST /store/subscriptions/{id}/cancel` cancels a subscription as the UI would.
 *
 * `cancelKeepsNextPayment` is the broken backend that marks a subscription cancelled but keeps its
 * next payment scheduled; `refusesRefunds` answers every refund with a 400.
 */

export interface WooFakeCustomer { id: number; email: string }
export interface WooFakeSubscription {
  id: string
  customer_id: number
  status: string
  total: string
  billing_interval: string
  billing_period: string
  next_payment_date_gmt: string | null
  cancelled_date_gmt?: string | null
}
export interface WooFakeOrder {
  id: number
  status: string
  currency: string
  total: string
  date_created_gmt: string
  prices_include_tax: boolean
  total_tax: string
  billing: { email: string }
  line_items: Array<{ name: string; total: string }>
  fee_lines: Array<{ name: string; total: string }>
  shipping_lines: Array<{ method_title: string; total: string }>
}

export interface WooFakeOptions {
  customers?: WooFakeCustomer[]
  subscriptions?: WooFakeSubscription[]
  orders?: WooFakeOrder[]
  /** `consumer_key:consumer_secret` the REST API requires as Basic auth; unset accepts any. */
  credential?: string
  cancelKeepsNextPayment?: boolean
  refusesRefunds?: boolean
  receipts?: { deliver(mail: FakeMail): unknown } | null
}

export interface WooFake {
  origin: string
  restBase: string
  orders(): WooFakeOrder[]
  subscriptions(): WooFakeSubscription[]
  refunds(): Array<{ orderId: number; amount: string; reason: string; apiRefund: boolean }>
  /** Every request as `METHOD /path`, in order. */
  calls(): string[]
  close(): Promise<void>
}

const REST = '/wp-json/wc/v3/'

export async function createWooFake(options: WooFakeOptions = {}): Promise<WooFake> {
  const customers = [...(options.customers ?? [])]
  const subscriptions = (options.subscriptions ?? []).map(item => ({ ...item }))
  const orders = (options.orders ?? []).map(item => structuredClone(item))
  const refunds: Array<{ orderId: number; amount: string; reason: string; apiRefund: boolean }> = []
  const calls: string[] = []
  let nextOrder = 5001
  let origin = ''

  const cancel = (subscription: WooFakeSubscription): void => {
    subscription.status = 'cancelled'
    subscription.cancelled_date_gmt = new Date().toISOString()
    if (!options.cancelKeepsNextPayment) subscription.next_payment_date_gmt = null
  }

  const handle = (request: IncomingMessage, response: ServerResponse, body: string): void => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid')
    const method = (request.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${url.pathname}${url.search}`)

    if (url.pathname === '/store/checkout' && method === 'POST') {
      const form = new URLSearchParams(body)
      const pairs = (name: string) => form.getAll(name).map(entry => { const [label, amount] = entry.split('|'); return { label: label ?? '', amount: Number(amount ?? 0) } })
      const lines = pairs('line')
      const fees = pairs('fee')
      const total = [...lines, ...fees].reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100
      const order: WooFakeOrder = {
        id: nextOrder++, status: 'processing', currency: form.get('currency') ?? 'EUR', total: total.toFixed(2),
        date_created_gmt: new Date().toISOString(), prices_include_tax: true, total_tax: '0.00', billing: { email: form.get('billing_email') ?? '' },
        line_items: lines.map(line => ({ name: line.label, total: line.amount.toFixed(2) })),
        fee_lines: fees.filter(fee => !/shipping|courier|delivery|post/i.test(fee.label)).map(fee => ({ name: fee.label, total: fee.amount.toFixed(2) })),
        shipping_lines: fees.filter(fee => /shipping|courier|delivery|post/i.test(fee.label)).map(fee => ({ method_title: fee.label, total: fee.amount.toFixed(2) })),
      }
      orders.push(order)
      const money = (amount: string) => `${amount.replace('.', ',')}&nbsp;€`
      if (options.receipts && order.billing.email) {
        options.receipts.deliver({
          from: 'Shop <orders@shop.test>', to: [order.billing.email], subject: `Your order #${order.id} has been received`,
          text: `Thank you for your order #${order.id}.\n${order.line_items.map(line => `${line.name}: ${line.total} ${order.currency}`).join('\n')}\n${[...order.fee_lines.map(fee => `${fee.name}: ${fee.total}`), ...order.shipping_lines.map(line => `${line.method_title}: ${line.total}`)].join('\n')}\nTotal: ${order.total} ${order.currency}\n`,
        })
      }
      return send(response, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Order received</title></head><body class="woocommerce-order-received"><main>
<h1>Order received</h1><p>Thank you. Your order number is <strong class="order-number">${order.id}</strong>.</p>
<table class="woocommerce-table order_details"><tbody>
${order.line_items.map(line => `<tr class="order_item"><td>${line.name}</td><td><span class="woocommerce-Price-amount amount">${money(line.total)}</span></td></tr>`).join('\n')}
${[...order.fee_lines.map(fee => [fee.name, fee.total]), ...order.shipping_lines.map(line => [line.method_title, line.total])].map(([label, amount]) => `<tr class="fee"><th>${label}</th><td><span class="woocommerce-Price-amount amount">${money(amount!)}</span></td></tr>`).join('\n')}
<tr class="order-total"><th>Total</th><td><span class="woocommerce-Price-amount amount">${money(order.total)}</span></td></tr>
</tbody></table></main></body></html>`)
    }
    const storefrontCancel = /^\/store\/subscriptions\/([^/]+)\/cancel$/.exec(url.pathname)
    if (storefrontCancel && method === 'POST') {
      const subscription = subscriptions.find(item => item.id === decodeURIComponent(storefrontCancel[1]!))
      if (!subscription) return send(response, 404, 'text/html; charset=utf-8', '<!doctype html><title>Not found</title><h1>No such subscription</h1>')
      cancel(subscription)
      return send(response, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><title>Subscription cancelled</title><main><h1>Subscription cancelled</h1><p>Your subscription ${subscription.id} has been cancelled.</p></main></html>`)
    }

    if (!url.pathname.startsWith(REST)) return send(response, 404, 'application/json', JSON.stringify({ code: 'rest_no_route', message: 'No route' }))
    if (options.credential) {
      const expected = `Basic ${Buffer.from(options.credential).toString('base64')}`
      if (request.headers.authorization !== expected) return send(response, 401, 'application/json', JSON.stringify({ code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' }))
    }
    const path = url.pathname.slice(REST.length).replace(/\/+$/, '')
    const json = (status: number, value: unknown) => send(response, status, 'application/json', JSON.stringify(value))
    let payload: Record<string, unknown> = {}
    try { payload = body ? JSON.parse(body) as Record<string, unknown> : {} } catch { return json(400, { code: 'rest_invalid_json', message: 'Invalid JSON body' }) }

    if (path === 'customers' && method === 'GET') {
      const email = (url.searchParams.get('email') ?? '').toLowerCase()
      return json(200, customers.filter(customer => !email || customer.email.toLowerCase() === email))
    }
    if (path === 'orders' && method === 'GET') {
      const after = url.searchParams.get('after')
      const search = (url.searchParams.get('search') ?? '').toLowerCase()
      return json(200, [...orders].reverse()
        .filter(order => !after || Date.parse(order.date_created_gmt) > Date.parse(after))
        .filter(order => !search || order.billing.email.toLowerCase().includes(search)))
    }
    const single = /^orders\/(\d+)$/.exec(path)
    if (single && method === 'GET') {
      const order = orders.find(item => item.id === Number(single[1]))
      return order ? json(200, order) : json(404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' })
    }
    const refund = /^orders\/(\d+)\/refunds$/.exec(path)
    if (refund && method === 'POST') {
      const order = orders.find(item => item.id === Number(refund[1]))
      if (!order) return json(404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' })
      if (options.refusesRefunds) return json(400, { code: 'woocommerce_rest_cannot_create_order_refund', message: 'Refunds are not accepted for this order.' })
      const entry = { orderId: order.id, amount: String(payload.amount ?? order.total), reason: String(payload.reason ?? ''), apiRefund: payload.api_refund !== false }
      refunds.push(entry)
      order.status = 'refunded'
      return json(201, { id: 9000 + refunds.length, amount: entry.amount, reason: entry.reason })
    }
    if (path === 'subscriptions' && method === 'GET') {
      const customer = url.searchParams.get('customer')
      return json(200, subscriptions.filter(item => !customer || String(item.customer_id) === customer))
    }
    const subscription = /^subscriptions\/([^/]+)$/.exec(path)
    if (subscription && (method === 'PUT' || method === 'POST')) {
      const item = subscriptions.find(entry => entry.id === decodeURIComponent(subscription[1]!))
      if (!item) return json(404, { code: 'woocommerce_rest_shop_subscription_invalid_id', message: 'Invalid ID.' })
      if (payload.status === 'cancelled') cancel(item)
      return json(200, item)
    }
    return json(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' })
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => handle(request, response, Buffer.concat(chunks).toString('utf8')))
  })
  server.keepAliveTimeout = 1000
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => done()) })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    get origin() { return origin },
    get restBase() { return `${origin}${REST.slice(0, -1)}` },
    orders: () => orders.map(order => structuredClone(order)),
    subscriptions: () => subscriptions.map(item => ({ ...item })),
    refunds: () => [...refunds],
    calls: () => [...calls],
    close: async () => { await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }) },
  }
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(body)
}
