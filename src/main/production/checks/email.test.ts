import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CheckOutcome } from '../../../shared/production'
import { createCapturedMailAdapter, parseRfc822 } from '../adapters/mailpit'
import { resolveEngine } from '../browser'
import { createMailpitFake, type FakeMail, type MailpitFake, type MailpitFakeOptions } from '../fixtures/mailpit-fake'
import { answeringInterpreter, createCommerceContext, type CommerceContextOptions, type JournalEntry } from './commerce-testkit'
import { classifyByRules, createEmailCheck, optOutLink, templateKindByName } from './email'

const engine = await resolveEngine()
const check = createEmailCheck({ suppressionWaitMs: 2_000, pollMs: 100 })
const SUBSCRIBERS = ['anna@sandbox.test', 'ben@sandbox.test']

let scratch: string
let goodTemplates: string
let brokenTemplates: string
const open: MailpitFake[] = []
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-email-'))
  goodTemplates = join(scratch, 'good')
  brokenTemplates = join(scratch, 'broken')
  mkdirSync(join(goodTemplates, 'emails'), { recursive: true })
  mkdirSync(join(brokenTemplates, 'emails'), { recursive: true })
  writeFileSync(join(goodTemplates, 'emails', 'newsletter.html'), '<h1>{{headline}}</h1><p>{{body}}</p><footer>{{company_name}}, {{company_address}} · <a href="{{unsubscribe_url}}">Unsubscribe</a></footer>')
  writeFileSync(join(goodTemplates, 'emails', 'order-receipt.html'), '<p>Your receipt for order {{order_number}}: {{order_total}}.</p>')
  writeFileSync(join(brokenTemplates, 'emails', 'promo-autumn.html'), '<h1>Autumn sale: 20 % off everything</h1><p>Shop now!</p>')
})
afterEach(async () => { await Promise.all(open.splice(0).map(fake => fake.close())) })
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const campaign = (fake: MailpitFake, subject: string) => (to: string): FakeMail => {
  const url = fake.unsubscribeUrl(to, subject)
  return {
    from: 'Example Shop <news@shop.test>', to: [to], subject,
    text: `${subject}\nHand-made vases, 20 % off this week.\n\nExample Shop s.r.o., Hlavná 1, 811 01 Bratislava, Slovakia\nUnsubscribe: ${url}\n`,
    html: `<p>${subject}</p><p>Example Shop s.r.o., Hlavná 1, 811 01 Bratislava</p><p><a href="${url}">Unsubscribe</a></p>`,
    headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  }
}
const RECEIPT: FakeMail = { from: 'Example Shop <orders@shop.test>', to: ['anna@sandbox.test'], subject: 'Your order #5001 has been received', text: 'Thank you for your order #5001.\nTotal: 23.40 EUR\n' }

async function sandbox(options: MailpitFakeOptions = {}, seed: (fake: MailpitFake) => void = fake => { fake.sendCampaign(campaign(fake, 'Autumn collection: 20 % off vases')); fake.deliver(RECEIPT) }): Promise<MailpitFake> {
  const fake = await createMailpitFake({
    subscribers: SUBSCRIBERS,
    secondCampaign: { delayMs: 150, build: (to, self) => campaign(self, 'Winter news: new glazes')(to) },
    ...options,
  })
  open.push(fake)
  seed(fake)
  return fake
}

async function run(fake: MailpitFake, options: Partial<CommerceContextOptions> = {}): Promise<{ result: CheckOutcome; operations: JournalEntry[] }> {
  const harness = createCommerceContext({
    scratch, controlId: 'C08', baseUrl: fake.origin, facts: { emailMarketing: true }, sourceRoot: goodTemplates,
    adapters: { mail: createCapturedMailAdapter({ kind: 'mailpit', location: fake.origin }) },
    ...options,
  })
  try { return { result: await check.run(harness.context), operations: harness.operations } } finally { await harness.close() }
}

describe('C08 rules and adapters', () => {
  it('classifies by headers and footers before words, and leaves the rest unknown', () => {
    expect(classifyByRules('Hello', 'plain', { 'list-unsubscribe': '<https://x.test/u>' })).toEqual({ kind: 'marketing', rule: 'List-Unsubscribe header' })
    expect(classifyByRules('Hello', 'plain', { precedence: 'bulk' }).kind).toBe('marketing')
    expect(classifyByRules('Your order #12 has shipped', 'Tracking number 1Z', {}).kind).toBe('transactional')
    expect(classifyByRules('Autumn sale', '20 % off', {}).kind).toBe('marketing')
    expect(classifyByRules('A note from us', 'We wanted to share some thoughts.', {})).toEqual({ kind: 'unknown', rule: 'no rule matched' })
  })

  it('treats order, pickup, shipping, receipt, password and account templates as transactional', () => {
    expect(classifyByRules('customer-ready-pickup.php', 'Hi %s, Great news! Your order #%s is ready for pickup. Pickup Location', {})).toEqual({ kind: 'transactional', rule: 'transaction wording' })
    for (const path of ['woocommerce/emails/customer-ready-pickup.php', 'woocommerce/emails/plain/customer-ready-pickup.php', 'woocommerce/emails/customer-processing-order.php', 'woocommerce/emails/customer-completed-order.php',
      'woocommerce/emails/customer-reset-password.php', 'woocommerce/emails/customer-new-account.php', 'woocommerce/emails/customer-invoice.php', 'emails/order-receipt.html', 'emails/shipping-confirmation.mjml']) {
      expect(templateKindByName(path), path).toEqual({ kind: 'transactional', rule: 'transactional template name' })
    }
    expect(templateKindByName('emails/newsletter-order-now.html')).toEqual({ kind: 'marketing', rule: 'template name' })
    expect(templateKindByName('emails/spring-sale.html')).toBeNull()
    expect(templateKindByName('woocommerce/emails/email-header.php')).toBeNull()
  })

  it('finds the opt-out link in List-Unsubscribe, the HTML or the text', () => {
    expect(optOutLink({ headers: { 'List-Unsubscribe': '<mailto:u@x.test>, <https://x.test/u?id=1>' }, html: null, text: '' })).toBe('https://x.test/u?id=1')
    expect(optOutLink({ headers: {}, html: '<a href="https://x.test/prefs?a=1&amp;b=2">Unsubscribe</a>', text: '' })).toBe('https://x.test/prefs?a=1&b=2')
    expect(optOutLink({ headers: {}, html: null, text: 'To stop these emails:\nhttps://x.test/stop' })).toBeNull()
    expect(optOutLink({ headers: {}, html: null, text: 'Unsubscribe here:\nhttps://x.test/stop' })).toBe('https://x.test/stop')
  })

  it('reads captured mail from Mailpit oldest first and parses a raw maildir message', async () => {
    const fake = await sandbox()
    const messages = await createCapturedMailAdapter({ kind: 'mailpit', location: fake.origin }).list(null)
    expect(messages.map(message => `${message.to[0]}:${message.subject}`)).toEqual([
      'anna@sandbox.test:Autumn collection: 20 % off vases',
      'ben@sandbox.test:Autumn collection: 20 % off vases',
      'anna@sandbox.test:Your order #5001 has been received',
    ])
    expect(messages[0]!.headers['list-unsubscribe']).toMatch(/^<http:\/\/127\.0\.0\.1:\d+\/esp\/unsubscribe/)
    const raw = 'From: Shop <news@shop.test>\r\nTo: a@x.test\r\nSubject: =?UTF-8?B?WsS+YXZh?=\r\nList-Unsubscribe: <https://x.test/u>\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nZ=C4=BEava 20 % =\r\noff\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>Hi</p>\r\n--b1--\r\n'
    const parsed = parseRfc822(raw)
    expect(parsed).toMatchObject({ subject: 'Zľava', from: 'Shop <news@shop.test>', to: ['a@x.test'], html: '<p>Hi</p>\n' })
    expect(parsed.text.trim()).toBe('Zľava 20 % off')
    expect(parsed.headers['list-unsubscribe']).toBe('<https://x.test/u>')
  })
})

describe('C08 applicability', () => {
  it('is NOT_APPLICABLE when no marketing email is sent (negative control), reading nothing', async () => {
    const fake = await sandbox()
    const { result } = await run(fake, { facts: { emailMarketing: false } })
    expect(result).toMatchObject({ status: 'NOT_APPLICABLE', findings: [] })
    expect(fake.optOutRequests()).toEqual([])
  })

  it('flags a message of each kind sent from another address than the recorded sender fact', async () => {
    const fake = await sandbox()
    const { result } = await run(fake, { facts: { emailMarketing: true, marketingSender: 'news@shop.test', transactionalSender: 'shop@shop.test' } })
    const wrong = result.findings.filter(finding => finding.key.startsWith('wrong-sender:'))
    expect(wrong.map(finding => finding.key)).toEqual(['wrong-sender:transactional:orders@shop.test'])
    expect(wrong[0]).toMatchObject({ severity: 'medium', confidence: 'confirmed', expected: expect.stringMatching(/sent from shop@shop\.test \(profile fact transactionalSender\)/) })
    expect(result.observations).toEqual(expect.arrayContaining(['Marketing sender (profile): news@shop.test', 'Transactional sender (profile): shop@shop.test']))
    const { result: unset } = await run(await sandbox(), { facts: { emailMarketing: true } })
    expect(unset.findings.some(finding => finding.key.startsWith('wrong-sender:'))).toBe(false)
  })

  it('is UNVERIFIED while marketing email use is unknown', async () => {
    const fake = await sandbox()
    const { result } = await run(fake, { facts: {} })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/until the owner answers: emailMarketing/)
  })
})

describe.skipIf(!engine.available)('C08 marketing email check', { timeout: 60_000 }, () => {
  it('passes compliant campaigns, a working opt-out and a suppressed second campaign; receipts are not flagged (known-good)', async () => {
    const fake = await sandbox()
    const asked: string[] = []
    const { result, operations } = await run(fake, { authorize: ['email-optout'], interpreter: answeringInterpreter(() => ({ kind: 'marketing' }), asked) })
    expect(result.reason).toBeNull()
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(operations.map(entry => `${entry.mutation}:${entry.status}`)).toEqual(['email-optout:done'])
    expect(fake.optOuts()).toEqual(['ben@sandbox.test'])
    const observed = result.observations.join('\n')
    expect(observed).toMatch(/Templates: emails\/newsletter\.html: marketing \(template name\); emails\/order-receipt\.html: transactional \(transactional template name\)/)
    expect(observed).toMatch(/Captured deliveries: 3 \(2 marketing, 1 transactional, 0 unclassified\)/)
    expect(observed).toMatch(/Opt-out of ben@sandbox\.test confirmed/)
    expect(observed).toMatch(/Suppression shown: "Winter news: new glazes" went to 1 recipient\(s\) after the opt-out, not to ben@sandbox\.test/)
    // Deterministic rules placed every message: no model call.
    expect(asked).toEqual([])
  })

  it('finds a campaign with no opt-out, no address, a reply-framed subject and an unnamed sender, and a template without an opt-out (broken)', async () => {
    const fake = await sandbox({}, self => {
      self.deliver({ from: 'deals@bulk-mailer.test', to: ['anna@sandbox.test'], subject: 'Re: your order', text: 'Autumn sale: 20% off everything this week. Shop now at http://shop.test/sale\n' })
    })
    const { result, operations } = await run(fake, { authorize: ['email-optout'], sourceRoot: brokenTemplates })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual([
      'deceptive-subject:re-your-order', 'no-opt-out:re-your-order', 'no-postal-address:re-your-order', 'sender-unidentified:re-your-order',
      'template-no-opt-out:emails/promo-autumn.html', 'template-no-postal-address:emails/promo-autumn.html',
    ])
    expect(result.findings.find(finding => finding.key === 'no-opt-out:re-your-order')).toMatchObject({ severity: 'high', confidence: 'confirmed', scope: 'email', category: 'legal' })
    expect(result.reason).toMatch(/no captured marketing message with an opt-out link/)
    expect(operations).toEqual([])
  })

  it('finds a campaign that still reaches a recipient after they opted out (broken suppression)', async () => {
    const fake = await sandbox({ suppress: false })
    const { result } = await run(fake, { authorize: ['email-optout'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key)).toEqual(['opt-out-not-honoured'])
    expect(result.findings[0]).toMatchObject({ severity: 'critical', component: 'Winter news: new glazes' })
    expect(result.findings[0]!.observed).toMatch(/reached ben@sandbox\.test at .*after the opt-out/)
  })

  it('is UNVERIFIED, not PASS, when no campaign follows the opt-out within the wait', async () => {
    const fake = await sandbox({ secondCampaign: null })
    const { result } = await run(fake, { authorize: ['email-optout'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/no campaign was sent within 2 s after the opt-out: suppression not shown/)
  })

  it('stops before the opt-out without a write authorization: UNVERIFIED with the reason, the link never followed', async () => {
    const fake = await sandbox()
    const { result, operations } = await run(fake)
    expect(result.status).toBe('UNVERIFIED')
    expect(result.findings).toEqual([])
    expect(result.reason).toMatch(/sandbox write authorization required for email-optout/)
    expect(operations).toEqual([])
    expect(fake.optOutRequests()).toEqual([])
  })

  it('never follows an opt-out on production, even with a stray authorization', async () => {
    const fake = await sandbox()
    const { result, operations } = await run(fake, { environmentKind: 'production', authorize: ['email-optout'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/sandbox write authorization required for email-optout: .*production/)
    expect(operations).toEqual([])
    expect(fake.optOutRequests()).toEqual([])
  })

  it('does not follow an opt-out link off the allowlist', async () => {
    const fake = await sandbox()
    const { result, operations } = await run(fake, { baseUrl: 'http://127.0.0.1:9', authorize: ['email-optout'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/is not an allowed origin of this environment/)
    expect(operations).toEqual([])
    expect(fake.optOutRequests()).toEqual([])
  })

  it('asks the classify role only for mail the rules cannot place, and sends a refusal to human review', async () => {
    const fake = await sandbox({}, self => {
      self.sendCampaign(campaign(self, 'Autumn collection: 20 % off vases'))
      self.deliver({ from: 'Example Shop <hello@shop.test>', to: ['anna@sandbox.test'], subject: 'A note from Example Shop', text: 'We wanted to share what our workshop has been up to.' })
    })
    const asked: string[] = []
    const answered = await run(fake, { interpreter: answeringInterpreter(() => ({ kind: 'transactional' }), asked) })
    expect(asked).toEqual(['classify:email-kind'])
    expect(answered.result.observations.join('\n')).toMatch(/2 marketing, 1 transactional, 0 unclassified/)
    const refused = await run(fake)
    expect(refused.result.humanReview.map(item => item.id)).toEqual(['C08:classify:a-note-from-example-shop'])
    expect(refused.result.humanReview[0]!.why).toMatch(/local model unavailable/)
  })
})
