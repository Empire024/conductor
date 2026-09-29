import type { AuditPage, CheckContext, CheckOutcome, CommerceSubscription, ControlCheck, TestAccountRef } from '../../../shared/production'
import { decideApplicability } from '../registry'
import {
  accountFor, browserProblem, draft, markTested, mutate, mutationBlocked, newParts, normalise, notRun, outcome, routesTagged,
  throwIfAborted, unobservable, visit, withPage, type OutcomeParts,
} from './commerce-support'

/**
 * C10 Subscriptions and cancellation (docs/production-agent.md, M6). Read-only: the renewal terms
 * (amount with interval, automatic renewal, how to cancel, what a trial converts to) must sit next
 * to the consent action, and the account area must offer an online cancellation control reachable
 * by keyboard. With a sandbox write authorization for `subscription-cancel`, a subscriber test
 * account and a commerce adapter: cancel one subscription through the UI and another through the
 * adapter, and read both back — `nextPaymentAt` must be cleared. Cancellation is its own journey:
 * this check never deletes an account or requests a refund.
 */

const CHECK_ID = 'subscriptions'

export const subscriptionsCheck: ControlCheck = {
  controlId: 'C10',
  checkId: CHECK_ID,
  title: 'Subscriptions: renewal terms at the consent action, online cancellation by UI and adapter, next payment cleared',
  requires: ['browser', 'sandbox-writes', 'commerce-sandbox', 'test-account'],
  run: runSubscriptions,
}

const CONSENT_LABEL = /subscribe|start (?:my |your )?(?:free )?trial|sign ?up|join now|place order|add to (?:cart|basket)|buy now|objedna|predplat|předplat|prihl[aá]si[tť] sa na odber/i
const AMOUNT_INTERVAL = /(?:€|\$|£|kč|eur|usd|czk)\s?\d|\d[\d.,]*\s?(?:€|\$|£|kč|eur|usd|czk)/i
const INTERVAL = /per (?:month|year|week|day)|\/ ?(?:mo|month|yr|year|week)\b|monthly|annually|yearly|weekly|every (?:\d+ )?(?:month|year|week)s?|mesa[čc]ne|ro[čc]ne|m[eě]s[ií][čc]n[eě]|t[ýy]ždenne|t[ýy]dn[eě]/i
const AUTO_RENEW = /renews? automatically|auto-?renew|automatically renew|recurring (?:payment|charge|billing)|until (?:you )?cancel|automaticky (?:sa )?obnov|obnovuje (?:sa )?automaticky|automatick[eéy] obnoven/i
const CANCEL_HOW = /cancel (?:any ?time|online|at any time|in (?:your |my )?account)|how to cancel|you can cancel|zru[šs]i[tť] (?:kedykoľvek|kdykoli|online|v (?:ú|u)[čc]te)|zru[šs]en[ií] (?:je )?mo[žz]n/i
const TRIAL = /free trial|trial period|trial|sk[úu][šs]obn|zku[šs]ebn/i
const AFTER_TRIAL = /after (?:the |your )?(?:free )?trial|then \S*\s?\d|thereafter|converts? to|po (?:skon[čc]en[ií]|uplynut[ií])|pot[oé]m? \d/i
const CANCEL_CONTROL = /cancel(?: (?:my |your )?(?:subscription|membership|plan|renewal))?\b|end (?:my )?subscription|stop (?:my )?subscription|zru[šs]i[tť]|ukon[čc]i[tť] predplatn|zru[šs]it p[řr]edplatn/i
const NOT_SEPARATE = /delete (?:my |your )?account|close (?:my |your )?account|refund|zmaza[tť] [úu][čc]et|smazat [úu][čc]et|vr[aá]ti[tť] peniaze/i

/** The consent actions on the page and the text around each (their form, or the nearest container with some text), bounded. */
const CONSENT_SCRIPT = `(() => {
  const norm = text => (text || '').replace(/\\s+/g, ' ').trim()
  const actions = [...document.querySelectorAll('button, input[type="submit"], a.button, [role="button"]')].slice(0, 200)
  return actions.map(el => {
    const label = norm(el.innerText || el.value || el.getAttribute('aria-label'))
    let container = el.closest('form') || el.parentElement
    for (let i = 0; container && i < 3 && norm(container.innerText).length < 60; i++) container = container.parentElement
    return { label: label.slice(0, 120), context: norm(container ? container.innerText : '').slice(0, 2000) }
  })
})()`

/** Marks the first cancellation control and returns its label and whether it submits a form, or null. */
const MARK_CANCEL_SCRIPT = `(() => {
  const norm = text => (text || '').replace(/\\s+/g, ' ').trim()
  const pattern = ${CANCEL_CONTROL.toString()}
  const control = [...document.querySelectorAll('button, input[type="submit"], a[href], [role="button"]')].find(el => pattern.test(norm(el.innerText || el.value || el.getAttribute('aria-label'))))
  if (!control) return null
  control.setAttribute('data-conductor-target', 'cancel')
  const form = control.closest('form')
  if (form) form.setAttribute('data-conductor-target', 'cancel-form')
  return { label: norm(control.innerText || control.value || control.getAttribute('aria-label')).slice(0, 120), form: !!form, hasPassword: !!document.querySelector('input[type="password"]') }
})()`

const reachedCancel = (selectors: string[]): string => `(() => {
  const target = document.querySelector('[data-conductor-target="cancel"]')
  return ${JSON.stringify(selectors)}.findIndex(sel => { try { const el = document.querySelector(sel); return !!el && !!target && (el === target || target.contains(el)) } catch { return false } })
})()`

async function runSubscriptions(context: CheckContext): Promise<CheckOutcome> {
  const decision = decideApplicability(context.control, context.profile.facts, context.profile.scope)
  if (decision.status === 'not-applicable') return notRun(CHECK_ID, 'NOT_APPLICABLE', decision.rationale)
  if (decision.status === 'unknown') return notRun(CHECK_ID, 'UNVERIFIED', decision.rationale)

  const parts = newParts()
  parts.observations.push(decision.rationale)
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { ...parts, unconcluded: [noBrowser] })

  await renewalTerms(context, parts)
  const account = accountFor(context, ['subscriber', 'customer'])
  const accountRoute = routesTagged(context, ['subscriptions'], parts.coverage, 1)[0] ?? routesTagged(context, ['account'], parts.coverage, 1)[0] ?? null
  if (!accountRoute) {
    parts.unconcluded.push('no account route in scope (tag `subscriptions` or `account`): online cancellation not checked')
    return outcome(CHECK_ID, parts)
  }
  const control = await cancellationControl(context, parts, accountRoute.path, account)
  if (!control) return outcome(CHECK_ID, parts)

  const blocked = mutationBlocked(context, 'subscription-cancel', 'the cancellation journey (UI and adapter)')
  const adapter = context.adapters.commerce
  const missing = blocked ?? (!adapter ? 'no commerce sandbox adapter: nextPaymentAt cannot be read back, so the cancellation journey was not started'
    : !account ? 'no subscriber test account in the environment: the cancellation journey was not started' : null)
  if (missing) {
    parts.unconcluded.push(missing)
    unobservable(parts.coverage, 'cancellation through the UI and the adapter was not performed; nextPaymentAt not verified')
    return outcome(CHECK_ID, parts)
  }
  await cancellationJourney(context, parts, accountRoute.path, account!)
  return outcome(CHECK_ID, parts)
}

async function renewalTerms(context: CheckContext, parts: OutcomeParts): Promise<void> {
  const tagged = routesTagged(context, ['subscription'], parts.coverage, 4)
  const routes = tagged.length ? tagged : routesTagged(context, ['product'], parts.coverage, 4)
  let offers = 0
  for (const route of routes) {
    throwIfAborted(context)
    await withPage(context, async page => {
      const loaded = await visit(page, context.url(route.path))
      if (!loaded.ok) { parts.unconcluded.push(`route ${route.path} could not be read (${loaded.problem})`); return }
      markTested(parts.coverage, route.path, 'desktop')
      const actions = (await page.evaluate<Array<{ label: string; context: string }>>(CONSENT_SCRIPT)).filter(action => CONSENT_LABEL.test(action.label))
      // On an untagged product route only a page that talks about a subscription is an offer.
      const pageText = normalise((await page.snapshot()).text)
      if (!actions.length || (!tagged.length && !AUTO_RENEW.test(pageText) && !INTERVAL.test(pageText) && !/subscri|predplat|předplat/i.test(pageText))) return
      offers++
      const action = actions.find(item => /subscribe|trial|predplat|předplat/i.test(item.label)) ?? actions[0]!
      const near = action.context
      const missing: string[] = []
      if (!(AMOUNT_INTERVAL.test(near) && INTERVAL.test(near))) missing.push('the amount with its billing interval')
      if (!AUTO_RENEW.test(near)) missing.push('that it renews automatically')
      if (!CANCEL_HOW.test(near)) missing.push('how to cancel')
      if (TRIAL.test(near) && !AFTER_TRIAL.test(near)) missing.push('what the trial converts to and when')
      const shot = await page.screenshot(`consent action "${action.label}" on ${route.path}`)
      parts.evidence.push(shot.id)
      if (!missing.length) { parts.observations.push(`Renewal terms next to "${action.label}" on ${route.path}: ${near.slice(0, 240)}`); return }
      const elsewhere = AUTO_RENEW.test(pageText) ? ' The page mentions renewal elsewhere, away from the consent action.' : ''
      parts.findings.push(draft(context, CHECK_ID, {
        key: 'renewal-terms-not-at-consent', route: route.path, component: action.label,
        title: 'Renewal terms are not shown next to the subscribe action',
        expected: 'Next to the consent action: the amount and interval, that it renews automatically, how to cancel, and what any trial converts to',
        observed: `Next to "${action.label}" the page says: "${near.slice(0, 300)}" — missing ${missing.join(', ')}.${elsewhere}`,
        severity: 'high', confidence: 'confirmed', evidence: [shot.id],
        reproduction: [`Open ${route.path}`, `Read the text around "${action.label}"`],
        proposedFix: 'Put the renewal terms (price per interval, automatic renewal, cancellation route, trial conversion) directly above or beside the subscribe button.',
      }))
    })
  }
  if (!offers) parts.unconcluded.push(`no subscription offer with a consent action found on ${routes.map(route => route.path).join(', ') || 'any route (tag `subscription` or `product`)'}`)
}

async function cancellationControl(context: CheckContext, parts: OutcomeParts, path: string, account: TestAccountRef | null): Promise<{ label: string; form: boolean } | null> {
  try {
    return await withPage(context, async page => {
      const loaded = await visit(page, context.url(path))
      if (!loaded.ok) { parts.unconcluded.push(`account route ${path} could not be read (${loaded.problem})`); return null }
      markTested(parts.coverage, path, 'desktop', account ? 'authenticated' : 'guest')
      const control = await page.evaluate<{ label: string; form: boolean; hasPassword: boolean } | null>(MARK_CANCEL_SCRIPT)
      if (!control) {
        if ((await page.evaluate<boolean>(`!!document.querySelector('input[type="password"]')`))) {
          parts.unconcluded.push(`${path} shows a login form: the account area needs a recorded login state for a subscriber test account`)
          return null
        }
        parts.findings.push(draft(context, CHECK_ID, {
          key: 'no-online-cancellation', route: path, title: 'No way to cancel the subscription online',
          expected: 'A cancellation control in the account area, as easy to use as signing up', observed: `${path} offers no cancel control`,
          severity: 'high', confidence: 'likely', reproduction: [`Open ${path}${account ? ` as ${account.label}` : ''}`],
          proposedFix: 'Offer a "Cancel subscription" button in the account area that ends the renewal without contacting support.',
        }))
        return null
      }
      if (NOT_SEPARATE.test(control.label)) {
        parts.findings.push(draft(context, CHECK_ID, {
          key: 'cancellation-not-separate', route: path, component: control.label, title: 'Cancelling is tied to deleting the account or a refund',
          expected: 'Cancellation, account deletion and refund are separate choices', observed: `The only cancellation control is "${control.label}"`,
          severity: 'medium', confidence: 'likely', reproduction: [`Open ${path}`],
          proposedFix: 'Offer cancellation on its own; deletion and refunds are separate requests.',
        }))
      }
      // Keyboard: the cancel control must be reachable with Tab alone.
      const trace = await page.keyboard(Array.from({ length: 30 }, () => 'Tab'))
      const index = await page.evaluate<number>(reachedCancel(trace.map(step => step.focusedSelector ?? '')))
      parts.evidence.push((await context.evidence.writeJson('log', `keyboard trace to the cancellation control on ${path}`, { control: control.label, trace, reachedAt: index })).id)
      if (index < 0) {
        parts.findings.push(draft(context, CHECK_ID, {
          key: 'cancel-not-keyboard-reachable', route: path, component: control.label, title: 'The cancellation control cannot be reached by keyboard',
          expected: `"${control.label}" receives focus within 30 Tab presses`, observed: 'Focus never reached it', severity: 'medium', confidence: 'confirmed',
          reproduction: [`Open ${path}`, 'Press Tab repeatedly'], proposedFix: 'Make the cancel control a real button or link in the tab order.',
        }))
      } else {
        parts.observations.push(`"${control.label}" on ${path} is reached by keyboard after ${index + 1} Tab presses`)
      }
      return control
    }, { account })
  } catch (error) {
    parts.unconcluded.push(`account route ${path} could not be opened${account ? ` as ${account.label}` : ''}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

const isActive = (subscription: CommerceSubscription): boolean => /^(active|on-hold|trial|trialing)$/i.test(subscription.status)
const isCancelled = (subscription: CommerceSubscription): boolean => /cancel/i.test(subscription.status) || !!subscription.cancelledAt

async function cancellationJourney(context: CheckContext, parts: OutcomeParts, path: string, account: TestAccountRef): Promise<void> {
  const adapter = context.adapters.commerce!
  const read = async (): Promise<CommerceSubscription[] | null> => {
    try { return await adapter.subscriptions(account) } catch (error) {
      parts.unconcluded.push(`commerce adapter could not list subscriptions of ${account.label}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  const before = await read()
  if (!before) return
  const active = before.filter(isActive)
  if (!active.length) { parts.unconcluded.push(`${account.label} has no active sandbox subscription to cancel`); return }

  // Through the UI.
  const viaUi = await withPage(context, async page => {
    const loaded = await visit(page, context.url(path))
    if (!loaded.ok) { parts.unconcluded.push(`account route ${path} could not be read (${loaded.problem})`); return false }
    const control = await page.evaluate<{ form: boolean } | null>(MARK_CANCEL_SCRIPT)
    if (!control) { parts.unconcluded.push(`the cancellation control on ${path} disappeared`); return false }
    const done = await mutate(context, 'subscription-cancel', `cancel through the UI on ${path}`, () => submitCancel(page, control.form))
    if (!done.ok) { parts.unconcluded.push(done.reason); return false }
    parts.observations.push(`UI cancellation on ${path} ended on "${normalise((await page.snapshot()).title)}"`)
    return true
  }, { account })
  if (!viaUi) return
  const afterUi = await read()
  if (!afterUi) return
  const cancelledByUi = afterUi.filter(item => isCancelled(item) && active.some(prior => prior.id === item.id))
  if (!cancelledByUi.length) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'ui-cancel-no-effect', route: path, title: 'Cancelling in the account area did not cancel the subscription',
      expected: 'The sandbox subscription is cancelled after the UI cancellation', observed: `Subscriptions after: ${afterUi.map(item => `${item.id} ${item.status}`).join(', ')}`,
      severity: 'high', confidence: 'confirmed', reproduction: [`Open ${path}`, 'Cancel the subscription', 'Read the subscription from the shop backend'],
      proposedFix: 'Make the cancel control end the subscription in the billing system.',
    }))
  }
  for (const item of cancelledByUi) billingContinues(context, parts, item, 'ui', path)

  // Through the adapter, on another active subscription when there is one.
  const second = afterUi.find(item => isActive(item) && !cancelledByUi.some(done => done.id === item.id))
  if (!second) {
    unobservable(parts.coverage, 'adapter cancellation not exercised: the test account has no second active subscription')
  } else {
    const done = await mutate(context, 'subscription-cancel', `cancel ${second.id} through the adapter`, () => adapter.cancelSubscription(second.id))
    if (!done.ok) parts.unconcluded.push(done.reason)
    else {
      const reread = (await read())?.find(item => item.id === second.id) ?? done.value
      billingContinues(context, parts, reread, 'adapter', path)
    }
  }
  parts.evidence.push((await context.evidence.writeJson('log', `subscriptions of ${account.label} before and after cancellation`, { before, after: await read() })).id)
}

function billingContinues(context: CheckContext, parts: OutcomeParts, subscription: CommerceSubscription, via: 'ui' | 'adapter', path: string): void {
  if (!subscription.nextPaymentAt) {
    parts.observations.push(`Subscription ${subscription.id} cancelled through the ${via}: status ${subscription.status}, next payment cleared`)
    return
  }
  parts.findings.push(draft(context, CHECK_ID, {
    key: `billing-continues-after-cancel:${via}`, route: via === 'ui' ? path : null, scope: via === 'ui' ? 'journey' : 'config',
    title: `Billing continues after cancellation through the ${via === 'ui' ? 'account area' : 'shop backend'}`,
    expected: 'After cancellation the subscription has no next payment scheduled',
    observed: `Subscription ${subscription.id} is ${subscription.status} but its next payment is still scheduled for ${subscription.nextPaymentAt}`,
    severity: 'critical', confidence: 'confirmed',
    reproduction: via === 'ui' ? [`Open ${path}`, 'Cancel the subscription', `Read subscription ${subscription.id} from the shop backend`] : [`Cancel subscription ${subscription.id} in the shop backend`, 'Read it back'],
    proposedFix: 'Clear the next payment date (and any scheduled renewal order) when a subscription is cancelled.',
  }))
}

async function submitCancel(page: AuditPage, form: boolean): Promise<void> {
  if (form) { await page.submit('form[data-conductor-target="cancel-form"]', 'subscription-cancel'); return }
  await page.click('[data-conductor-target="cancel"]', { mutation: 'subscription-cancel' })
}

