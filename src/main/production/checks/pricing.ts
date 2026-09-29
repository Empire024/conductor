import type { AuditPage, CheckContext, CheckOutcome, CommerceOrder, ControlCheck } from '../../../shared/production'
import { decideApplicability } from '../registry'
import {
  browserProblem, draft, formatMoney, markTested, mutate, mutationBlocked, newParts, notRun, outcome, parseMoney, routesTagged, sameMoney,
  throwIfAborted, unobservable, visit, withPage, type Money, type OutcomeParts,
} from './commerce-support'

/**
 * C09 Pricing and hidden fees (docs/production-agent.md, M6). Read-only, the advertised price on
 * the product routes. With a sandbox write authorization for `checkout` and a commerce adapter,
 * one synthetic order is walked through: advertised → cart → checkout → order (adapter) → receipt
 * (order-received page and, when captured mail exists, the receipt email). Every amount must agree,
 * and every fee or shipping charge on the order must be disclosed on the checkout page before the
 * commitment step. Without the authorization the journey stops before adding to the cart.
 */

const CHECK_ID = 'pricing'

export const pricingCheck: ControlCheck = {
  controlId: 'C09',
  checkId: CHECK_ID,
  title: 'Pricing and hidden fees: advertised, cart, checkout, order and receipt totals agree and every fee is disclosed before commitment',
  requires: ['browser', 'sandbox-writes', 'commerce-sandbox'],
  run: runPricing,
}

export interface PriceRow { kind: 'line' | 'subtotal' | 'fee' | 'tax' | 'total'; label: string; amount: string }
export interface PricePage { advertised: string | null; rows: PriceRow[]; text: string }

/** Reads the prices a page shows: the advertised product price and WooCommerce-style order table rows. */
export const PRICE_SCRIPT = `(() => {
  const norm = text => (text || '').replace(/\\s+/g, ' ').trim()
  const priceEl = document.querySelector('.summary .price .woocommerce-Price-amount, .product .price .woocommerce-Price-amount, [itemprop="price"], [data-price], .price')
  let advertised = null
  if (priceEl) {
    const content = priceEl.getAttribute('content') || priceEl.getAttribute('data-price')
    const currency = document.querySelector('[itemprop="priceCurrency"]')
    advertised = content ? (content + ' ' + ((currency && currency.getAttribute('content')) || '')).trim() : norm(priceEl.innerText).slice(0, 80)
  }
  const rows = []
  for (const tr of document.querySelectorAll('tr')) {
    const cls = ' ' + (tr.className || '') + ' '
    let kind = null
    if (/ (cart_item|order_item) /.test(cls)) kind = 'line'
    else if (/ cart-subtotal /.test(cls)) kind = 'subtotal'
    else if (/ (fee|shipping|woocommerce-shipping-totals) /.test(cls)) kind = 'fee'
    else if (/ (tax-rate|tax-total) /.test(cls)) kind = 'tax'
    else if (/ order-total /.test(cls)) kind = 'total'
    if (!kind) continue
    const amounts = tr.querySelectorAll('.woocommerce-Price-amount, .amount')
    const amountEl = amounts[amounts.length - 1]
    const labelEl = tr.querySelector('.product-name') || tr.querySelector('th') || tr.querySelector('td')
    rows.push({ kind, label: norm(labelEl && labelEl.innerText).slice(0, 120), amount: norm(amountEl ? amountEl.innerText : tr.innerText).slice(0, 80) })
  }
  return { advertised, rows, text: norm(document.body ? document.body.innerText : '').slice(0, 20000) }
})()`

/** Marks the add-to-cart form (or the checkout form) with a data attribute and returns its selector, or null. */
const markForm = (target: 'add-to-cart' | 'checkout'): string => `(() => {
  const forms = [...document.querySelectorAll('form')]
  const pick = ${target === 'add-to-cart'
    ? `forms.find(f => f.matches('form.cart')) || forms.find(f => f.querySelector('[name="add-to-cart"]')) || forms.find(f => /add to (cart|basket)|do ko[šs][ií]ka|subscribe|buy now/i.test(f.innerText || ''))`
    : `forms.find(f => f.matches('form.checkout, form.woocommerce-checkout, form[name="checkout"]')) || forms.find(f => f.querySelector('#place_order, [name="woocommerce_checkout_place_order"]'))`}
  if (!pick) return null
  pick.setAttribute('data-conductor-target', '${target}')
  return 'form[data-conductor-target="${target}"]'
})()`

/** Billing fields of the checkout form that a synthetic value fills: name, email, phone and address inputs. */
const BILLING_FIELDS_SCRIPT = `(() => [...document.querySelectorAll('form[data-conductor-target="checkout"] input')]
  .filter(input => ['text', 'email', 'tel', ''].includes(input.type) && input.name && !input.value)
  .map(input => ({ name: input.name, type: input.type, autocomplete: input.getAttribute('autocomplete') || '' })))()`

async function runPricing(context: CheckContext): Promise<CheckOutcome> {
  const decision = decideApplicability(context.control, context.profile.facts, context.profile.scope)
  if (decision.status === 'not-applicable') return notRun(CHECK_ID, 'NOT_APPLICABLE', decision.rationale)
  if (decision.status === 'unknown') return notRun(CHECK_ID, 'UNVERIFIED', decision.rationale)

  const parts = newParts()
  parts.observations.push(decision.rationale)
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { ...parts, unconcluded: [noBrowser] })

  const productRoutes = routesTagged(context, ['product'], parts.coverage, 3)
  const cartRoute = routesTagged(context, ['cart'], parts.coverage, 1)[0] ?? null
  const checkoutRoute = routesTagged(context, ['checkout'], parts.coverage, 1)[0] ?? null
  if (!productRoutes.length) parts.unconcluded.push('no product route in scope (tag `product`): advertised prices not read')

  // Read-only: what the product pages advertise.
  const advertised: Array<{ route: string; money: Money; text: string }> = []
  for (const route of productRoutes) {
    throwIfAborted(context)
    await withPage(context, async page => {
      const loaded = await visit(page, context.url(route.path))
      if (!loaded.ok) { parts.unconcluded.push(`product route ${route.path} could not be read (${loaded.problem})`); return }
      markTested(parts.coverage, route.path, 'desktop')
      const read = await page.evaluate<PricePage>(PRICE_SCRIPT)
      const money = parseMoney(read.advertised)
      if (!money) { parts.unconcluded.push(`no advertised price found on ${route.path}`); return }
      advertised.push({ route: route.path, money, text: read.advertised ?? '' })
    })
  }
  if (advertised.length) parts.observations.push(`Advertised: ${advertised.map(item => `${item.route} ${formatMoney(item.money)}`).join('; ')}`)

  // The journey: every requirement is checked before the first mutation.
  const blocked = mutationBlocked(context, 'checkout', 'the checkout journey (cart, checkout, order, receipt)')
  const adapter = context.adapters.commerce
  const missing = blocked ?? (!adapter ? 'no commerce sandbox adapter: the order total and fees cannot be read back, so the checkout journey was not started'
    : !advertised.length ? 'no advertised price to start the checkout journey from'
    : !cartRoute || !checkoutRoute ? 'no cart or checkout route in scope (tags `cart`, `checkout`): the checkout journey was not started' : null)
  if (missing) {
    parts.unconcluded.push(missing)
    unobservable(parts.coverage, 'cart, checkout, order and receipt totals were not compared')
    return outcome(CHECK_ID, parts)
  }
  await checkoutJourney(context, parts, advertised[0]!, cartRoute!.path, checkoutRoute!.path)
  return outcome(CHECK_ID, parts)
}

async function checkoutJourney(context: CheckContext, parts: OutcomeParts, product: { route: string; money: Money }, cartPath: string, checkoutPath: string): Promise<void> {
  const adapter = context.adapters.commerce!
  let before: Set<string>
  try { before = new Set((await adapter.orders(null)).map(order => order.id)) } catch (error) {
    parts.unconcluded.push(`commerce adapter could not list orders: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const mailSince = new Date(Date.now() - 1000).toISOString()
  const email = context.synthetic('email')
  const reading: { cart?: PricePage; checkout?: PricePage; receipt?: PricePage } = {}

  const finished = await withPage(context, async page => {
    const loaded = await visit(page, context.url(product.route))
    if (!loaded.ok) { parts.unconcluded.push(`product route ${product.route} could not be read (${loaded.problem})`); return false }
    const cartForm = await page.evaluate<string | null>(markForm('add-to-cart'))
    if (!cartForm) { parts.unconcluded.push(`no add-to-cart form on ${product.route}`); return false }
    const added = await mutate(context, 'checkout', `add to cart on ${product.route}`, () => page.submit(cartForm, 'checkout'))
    if (!added.ok) { parts.unconcluded.push(added.reason); return false }

    const cart = await readPage(context, page, cartPath, parts)
    if (!cart) return false
    reading.cart = cart
    const checkout = await readPage(context, page, checkoutPath, parts)
    if (!checkout) return false
    reading.checkout = checkout
    const checkoutForm = await page.evaluate<string | null>(markForm('checkout'))
    if (!checkoutForm) { parts.unconcluded.push(`no checkout form on ${checkoutPath}`); return false }
    parts.evidence.push((await page.screenshot(`checkout page ${checkoutPath} before the commitment step`)).id)
    await fillBilling(context, page, email)
    const placed = await mutate(context, 'checkout', `place order on ${checkoutPath}`, () => page.submit(checkoutForm, 'checkout'))
    if (!placed.ok) { parts.unconcluded.push(placed.reason); return false }
    if (placed.value.outcome !== 'ok') { parts.unconcluded.push(`placing the order ended ${placed.value.outcome}`); return false }
    reading.receipt = await page.evaluate<PricePage>(PRICE_SCRIPT)
    return true
  })
  if (!finished) return

  let order: CommerceOrder | null = null
  try { order = (await adapter.orders(null)).find(item => !before.has(item.id)) ?? null } catch (error) {
    parts.unconcluded.push(`commerce adapter could not list orders after checkout: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!order) { parts.unconcluded.push('the sandbox shows no new order after the checkout journey'); return }

  let emailTotal: Money | null = null
  if (context.adapters.mail) {
    const receipts = (await context.adapters.mail.list(mailSince).catch(() => [])).filter(message => message.to.some(to => to.toLowerCase().includes(email.value.toLowerCase())))
    const receipt = receipts[receipts.length - 1]
    const line = receipt ? /(?:^|\n)\s*(?:order )?total\s*:?\s*([^\n]+)/i.exec(receipt.text)?.[1] ?? null : null
    emailTotal = parseMoney(line)
    if (emailTotal && !emailTotal.currency) emailTotal.currency = order.currency || null
    if (!receipt) parts.unconcluded.push('no receipt email was captured for the synthetic order')
    else if (!emailTotal) parts.unconcluded.push('the receipt email states no total')
  } else {
    unobservable(parts.coverage, 'receipt email not compared: no captured mail configured')
  }
  await compare(context, parts, product, cartPath, checkoutPath, reading as Required<typeof reading>, order, emailTotal)
}

async function readPage(context: CheckContext, page: AuditPage, path: string, parts: OutcomeParts): Promise<PricePage | null> {
  const loaded = await visit(page, context.url(path))
  if (!loaded.ok) { parts.unconcluded.push(`${path} could not be read (${loaded.problem})`); return null }
  markTested(parts.coverage, path, 'desktop')
  const read = await page.evaluate<PricePage>(PRICE_SCRIPT)
  parts.evidence.push((await context.evidence.writeJson('dom', `price rows on ${path}`, read.rows)).id)
  return read
}

async function fillBilling(context: CheckContext, page: AuditPage, email: ReturnType<CheckContext['synthetic']>): Promise<void> {
  const fields = await page.evaluate<Array<{ name: string; type: string; autocomplete: string }>>(BILLING_FIELDS_SCRIPT)
  for (const field of fields.slice(0, 20)) {
    const hint = `${field.name} ${field.autocomplete}`.toLowerCase()
    const value = field.type === 'email' || /mail/.test(hint) ? email
      : field.type === 'tel' || /phone|tel/.test(hint) ? context.synthetic('phone')
      : /address|street|city|postcode|zip/.test(hint) ? context.synthetic('address')
      : /name/.test(hint) ? context.synthetic('name') : null
    if (value) await page.fill(`form[data-conductor-target="checkout"] [name="${field.name.replace(/"/g, '\\"')}"]`, value)
  }
}

const rowMoney = (rows: readonly { kind: string; amount: string }[], kind: string, currency: string | null): Money | null => {
  const money = parseMoney(rows.find(row => row.kind === kind)?.amount)
  if (money && !money.currency) money.currency = currency
  return money
}

async function compare(
  context: CheckContext, parts: OutcomeParts, product: { route: string; money: Money }, cartPath: string, checkoutPath: string,
  reading: { cart: PricePage; checkout: PricePage; receipt: PricePage }, order: CommerceOrder, emailTotal: Money | null,
): Promise<void> {
  const currency = product.money.currency ?? (order.currency || null)
  const orderTotal = parseMoney(order.total)
  if (orderTotal && !orderTotal.currency) orderTotal.currency = order.currency || currency
  const cartLine = rowMoney(reading.cart.rows, 'line', currency)
  const cartTotal = rowMoney(reading.cart.rows, 'subtotal', currency) ?? rowMoney(reading.cart.rows, 'total', currency)
  const checkoutSubtotal = rowMoney(reading.checkout.rows, 'subtotal', currency) ?? rowMoney(reading.checkout.rows, 'line', currency)
  const checkoutTotal = rowMoney(reading.checkout.rows, 'total', currency)
  const receiptTotal = rowMoney(reading.receipt.rows, 'total', currency)
  const table = {
    advertised: formatMoney(product.money), cartLine: formatMoney(cartLine), cartSubtotal: formatMoney(cartTotal), checkoutSubtotal: formatMoney(checkoutSubtotal),
    checkoutTotal: formatMoney(checkoutTotal), orderTotal: formatMoney(orderTotal), receiptPage: formatMoney(receiptTotal), receiptEmail: formatMoney(emailTotal),
    orderFees: order.fees, checkoutRows: reading.checkout.rows,
  }
  parts.evidence.push((await context.evidence.writeJson('log', `price comparison for sandbox order ${order.id}`, table)).id)
  parts.observations.push(`Sandbox order ${order.id}: ${Object.entries(table).filter(([, value]) => typeof value === 'string').map(([key, value]) => `${key} ${value}`).join(', ')}`)

  const mismatch = (key: string, title: string, route: string, expected: string, observed: string): void => {
    parts.findings.push(draft(context, CHECK_ID, {
      key, route, title, expected, observed, severity: 'high', confidence: 'confirmed',
      reproduction: [`Open ${product.route}, add to cart`, `Open ${cartPath}`, `Open ${checkoutPath} and place the order`, `Compare with sandbox order ${order.id}`],
      proposedFix: 'Show the same price at every step; any extra charge must be in the advertised price or disclosed before the order is placed.',
    }))
  }
  const differ = (a: Money | null, b: Money | null): boolean => !!a && !!b && !sameMoney(a, b)
  if (!cartLine || !checkoutTotal || !orderTotal) parts.unconcluded.push(`amounts missing: cart line ${formatMoney(cartLine)}, checkout total ${formatMoney(checkoutTotal)}, order total ${formatMoney(orderTotal)}`)
  if (differ(product.money, cartLine)) mismatch('cart-differs-from-advertised', 'Cart price differs from the advertised price', cartPath, `cart line ${formatMoney(product.money)} as advertised on ${product.route}`, `cart line ${formatMoney(cartLine)}`)
  if (differ(cartTotal, checkoutSubtotal)) mismatch('checkout-differs-from-cart', 'Checkout subtotal differs from the cart', checkoutPath, `checkout subtotal ${formatMoney(cartTotal)} as in the cart`, `checkout subtotal ${formatMoney(checkoutSubtotal)}`)
  if (differ(checkoutTotal, orderTotal)) mismatch('order-differs-from-checkout', 'Order total differs from the total shown at checkout', checkoutPath, `order total ${formatMoney(checkoutTotal)} as shown before placing the order`, `sandbox order ${order.id} total ${formatMoney(orderTotal)}`)
  if (differ(orderTotal, receiptTotal)) mismatch('receipt-page-differs-from-order', 'Order-received page shows a different total', checkoutPath, `receipt total ${formatMoney(orderTotal)}`, `order-received page total ${formatMoney(receiptTotal)}`)
  if (differ(orderTotal, emailTotal)) mismatch('receipt-email-differs-from-order', 'Receipt email shows a different total', checkoutPath, `receipt email total ${formatMoney(orderTotal)}`, `receipt email total ${formatMoney(emailTotal)}`)

  // Fee disclosure: every fee and shipping charge of the order appears on the checkout page before commitment.
  const disclosed = reading.checkout.rows.filter(row => row.kind === 'fee' || row.kind === 'tax').map(row => ({ row, money: parseMoney(row.amount), used: false }))
  for (const fee of order.fees) {
    const money = parseMoney(fee.amount)
    if (!money || money.cents === 0) continue
    const match = disclosed.find(entry => !entry.used && entry.money && entry.money.cents === money.cents)
    if (match) { match.used = true; continue }
    parts.findings.push(draft(context, CHECK_ID, {
      key: `fee-undisclosed:${fee.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, route: checkoutPath,
      title: `Fee "${fee.label}" charged but not disclosed before the order was placed`,
      expected: `"${fee.label}" (${fee.amount} ${order.currency}) listed on ${checkoutPath} before the commitment step`,
      observed: `checkout listed ${disclosed.map(entry => `${entry.row.label} ${entry.row.amount}`).join(', ') || 'no fees'}; sandbox order ${order.id} charged ${fee.label} ${fee.amount} ${order.currency}`,
      severity: 'high', confidence: 'confirmed',
      reproduction: [`Add ${product.route} to the cart`, `Open ${checkoutPath}: the fee is not listed`, `Place the order: sandbox order ${order.id} includes it`],
      proposedFix: 'List every mandatory fee (and shipping) with its amount before the customer places the order, or include it in the advertised price.',
    }))
  }
}
