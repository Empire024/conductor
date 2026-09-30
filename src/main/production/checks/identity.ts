import type { CheckContext, CheckOutcome, ControlCheck, FindingDraft, HumanReviewItem, RouteCoverage } from '../../../shared/production'
import { factIsUnknown, jurisdictionsFor, SOURCES } from '../registry'
import {
  browserProblem, companyNames, draft, entityName, entityProblem, footerLinks, LINK_PATTERNS, markTested, matchesLink, MAX_DOCUMENTS,
  namesEntity, normalise, outcome, pathOf, planRoutes, registrationNumbers, review, throwIfAborted, visit, withPage,
} from './document-support'
import { isStateChangingUrl } from '../netpolicy'

/**
 * C02 Business identity (docs/production-agent.md, M5). The identity elements each target
 * jurisdiction requires (IDENTITY_REQUIREMENTS, from the registry's primary sources) must appear
 * on the site: home footer, contact or imprint pages. The same entity and registration number
 * must then appear wherever the site names its operator: policies, checkout and, when captured
 * mail is configured, receipts. A company name or registration number that differs from the
 * profile's legal entity is a finding; whether the disclosures are legally sufficient is always a
 * human's call.
 */

const CHECK_ID = 'identity'

export const IDENTITY_ELEMENTS = ['name', 'address', 'email', 'phone', 'registration', 'register'] as const
export type IdentityElement = (typeof IDENTITY_ELEMENTS)[number]

const ELEMENT_LABELS: Record<IdentityElement, string> = {
  name: 'legal name of the operator',
  address: 'geographic (postal) address',
  email: 'email address',
  phone: 'telephone number',
  registration: 'registration number (IČO / company number)',
  register: 'the register it is entered in (commercial or trade register, file number)',
}

/**
 * What each jurisdiction requires a website operator to disclose, with the primary source. A
 * target without an entry here adds nothing beyond the universal elements; `EU` applies with any
 * member state.
 */
export const IDENTITY_REQUIREMENTS: Readonly<Record<string, { elements: IdentityElement[]; source: string }>> = {
  EU: { elements: ['name', 'address', 'email', 'registration', 'register'], source: `${SOURCES.eCommerce.title}, Art. 5(1)` },
  SK: { elements: ['name', 'address', 'email', 'registration', 'register'], source: SOURCES.skECommerce.title },
  CZ: { elements: ['name', 'address', 'registration', 'register'], source: SOURCES.czCivilCode.title },
  US: { elements: ['name', 'address'], source: SOURCES.canSpam.title },
  'US-CA': { elements: ['name', 'address', 'phone'], source: SOURCES.caCommerceDisclosure.title },
}
/** Asked of every site even when the target countries are unknown. */
const UNIVERSAL: IdentityElement[] = ['name', 'address', 'email']

const ELEMENT_PATTERNS: Record<Exclude<IdentityElement, 'name'>, RegExp[]> = {
  address: [
    /[\p{L}.'\- ]{2,40}\s\d{1,4}[a-z]?(?:\/\d{1,4}[a-z]?)?,?\s+\d{3}\s?\d{2}\s+\p{L}{2,}/iu,
    /\b\d{1,6}\s+[\p{L} .'-]{2,40}\s(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|way|square)\b/iu,
    /\b[A-Z][\p{L} .-]+,\s?[A-Z]{2}\s\d{5}(?:-\d{4})?\b/u,
  ],
  email: [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  phone: [/(?:\+|00)\d{1,3}[\s\d()-]{7,16}\d|\b(?:tel|phone|telefón|telefon)\.?\s*:?\s*[\d+(][\d\s()-]{6,}\d/i],
  // `\b` does not see the boundary after a non-ASCII letter (IČ), so the label ends at the colon or digits instead.
  registration: [/(?:^|[^\p{L}])(?:I[ČC]O|I[ČC]|Company (?:No|number)|Reg(?:istration)?\.? ?(?:No|number)|CRN|EIN)\.?\s*:?\s*\d/iu],
  register: [/obchodn(?:om|ém|ého) regist|obchodn[ií]m? rejst[řr][ií]k|business register|commercial register|companies house|handelsregister|[žz]ivnostensk|zap[ií]san[aá] v|zapsan[aá] v|spisov[aá] zna[čc]ka|vlo[žz]ka|oddiel/i],
}

interface IdentitySource {
  kind: 'site' | 'identity-page' | 'policy' | 'checkout' | 'receipt'
  where: string
  text: string
  evidence: string | null
}

export const identityCheck: ControlCheck = {
  controlId: 'C02',
  checkId: CHECK_ID,
  title: 'Business identity: required elements per jurisdiction, consistent across site, policies, checkout and receipts',
  requires: ['browser'],
  run: runIdentity,
}

export function elementsIn(text: string, entity: string | null): Set<IdentityElement> {
  const found = new Set<IdentityElement>()
  if (entity ? namesEntity(text, entity) : companyNames(text).length > 0) found.add('name')
  for (const [element, patterns] of Object.entries(ELEMENT_PATTERNS) as Array<[Exclude<IdentityElement, 'name'>, RegExp[]]>) {
    if (patterns.some(pattern => pattern.test(text))) found.add(element)
  }
  return found
}

/** The elements required for the target countries, with the sources that require each. */
export function requiredElements(targets: Set<string> | null): Map<IdentityElement, string[]> {
  const required = new Map<IdentityElement, string[]>()
  for (const element of UNIVERSAL) required.set(element, ['every site'])
  for (const target of targets ?? []) {
    const rule = IDENTITY_REQUIREMENTS[target]
    if (!rule) continue
    for (const element of rule.elements) required.set(element, [...(required.get(element) ?? []).filter(source => source !== 'every site'), rule.source])
  }
  return required
}

async function runIdentity(context: CheckContext): Promise<CheckOutcome> {
  const findings: FindingDraft[] = []
  const unconcluded: string[] = []
  const evidence: string[] = []
  const humanReview: HumanReviewItem[] = []
  const observations: string[] = []
  const coverage: RouteCoverage = { tested: [], sampled: [], excluded: [], unobservable: [] }
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { findings, unconcluded: [noBrowser], evidence, humanReview, coverage, observations })

  const facts = context.profile.facts
  const entityFact = factIsUnknown(facts.legalEntity) ? null : String(facts.legalEntity.value)
  const entity = entityFact ? entityName(entityFact) : null
  const entityNumbers = entityFact ? [...new Set([...registrationNumbers(entityFact), ...(entityFact.match(/\b\d{8}\b/g) ?? [])])] : []
  if (!entity) unconcluded.push(entityProblem(context)!)
  const targets = jurisdictionsFor(facts.targetCountries)
  if (!targets) unconcluded.push('target countries unknown: only the elements every site needs were required (owner question targetCountries)')

  const sources: IdentitySource[] = []
  const followed = new Set<string>()
  const read = async (url: string, kind: IdentitySource['kind']): Promise<void> => {
    const key = url.split('#')[0]!
    if (followed.has(key) || followed.size >= MAX_DOCUMENTS + 2) return
    followed.add(key)
    throwIfAborted(context)
    await withPage(context, 'desktop', async page => {
      const loaded = await visit(page, key)
      if (!loaded.ok) { unconcluded.push(`${kind} ${pathOf(key)} could not be read (${loaded.problem})`); return }
      markTested(coverage, pathOf(key), 'desktop')
      const text = (await page.snapshot()).text
      const ref = await context.evidence.writeText('dom', `Identity source (${kind}) ${pathOf(key)}`, text)
      evidence.push(ref.id)
      sources.push({ kind, where: pathOf(key), text, evidence: ref.id })
    })
  }

  // The home page: its footer text and the links to identity pages, policies and checkout.
  const home = context.url('/')
  let homeLinks: Array<{ text: string; href: string }> = []
  await withPage(context, 'desktop', async page => {
    const loaded = await visit(page, home)
    if (!loaded.ok) { unconcluded.push(`home page could not be read (${loaded.problem})`); return }
    markTested(coverage, '/', 'desktop')
    followed.add(home)
    const footer = await footerLinks(page)
    const snapshot = await page.snapshot()
    homeLinks = [...footer.links, ...snapshot.links]
    const footerText = await page.evaluate<string>(`(() => [...document.querySelectorAll('footer, [role="contentinfo"]')].map(node => node.innerText).join('\\n'))()`)
    const ref = await context.evidence.writeText('dom', 'Home page footer text', footerText || snapshot.text)
    evidence.push(ref.id)
    sources.push({ kind: 'site', where: '/', text: footerText || snapshot.text, evidence: ref.id })
  })
  // An "Add to cart" link (`?add-to-cart=800`) matches the checkout pattern but is a mutation the policy refuses; never follow one.
  const allowed = (href: string): boolean => { try { return context.policy.allowedOrigins.includes(new URL(href).origin) && !isStateChangingUrl(href) } catch { return false } }
  const linksTo = (pattern: RegExp): string[] => [...new Set(homeLinks.filter(link => allowed(link.href) && matchesLink(link, pattern)).map(link => link.href.split('#')[0]!))]
  for (const url of linksTo(LINK_PATTERNS.identity).slice(0, 3)) await read(url, 'identity-page')
  for (const url of [...linksTo(LINK_PATTERNS.privacy).slice(0, 1), ...linksTo(LINK_PATTERNS.terms).slice(0, 1)]) await read(url, 'policy')
  const checkoutRoutes = planRoutes(context, { tags: ['checkout'] }, 2).routes.map(route => context.url(route.path))
  for (const url of checkoutRoutes.length ? checkoutRoutes : linksTo(/checkout|pokladn|objedn[aá]vk|ko[šs][ií]k|\bcart\b|basket/i).slice(0, 1)) await read(url, 'checkout')
  if (!sources.some(source => source.kind === 'checkout')) coverage.unobservable.push('checkout: no checkout route in the scope and no checkout link on the home page')

  // Receipts from captured mail, when configured.
  if (context.adapters.mail) {
    try {
      const messages = (await context.adapters.mail.list(null)).slice(0, 20)
      for (const message of messages) {
        const text = `${message.from}\n${message.subject}\n${message.text}`
        const ref = await context.evidence.writeText('email', `Captured message "${message.subject}"`, text)
        evidence.push(ref.id)
        sources.push({ kind: 'receipt', where: `email "${normalise(message.subject).slice(0, 80)}"`, text, evidence: ref.id })
      }
      if (!messages.length) coverage.unobservable.push('receipts: the captured mailbox holds no messages yet')
    } catch (error) {
      unconcluded.push(`captured mail could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else coverage.unobservable.push('receipts: no captured mail is configured for this environment')

  // Required elements on the site (home footer and identity pages).
  const onSite = sources.filter(source => source.kind === 'site' || source.kind === 'identity-page')
  const present = new Map<IdentityElement, string[]>()
  for (const source of onSite) for (const element of elementsIn(source.text, entity)) present.set(element, [...(present.get(element) ?? []), source.where])
  const table = [...requiredElements(targets)].map(([element, requiredBy]) => ({ element, requiredBy, foundOn: present.get(element) ?? [] }))
  evidence.push((await context.evidence.writeJson('note', 'Identity elements required per jurisdiction and where each was found', table)).id)
  for (const row of table) {
    if (row.foundOn.length) continue
    if (row.element === 'name' && !entity) continue
    findings.push(draft(context, CHECK_ID, {
      key: `missing:${row.element}`, severity: ['name', 'address', 'registration', 'register'].includes(row.element) ? 'high' : 'medium', confidence: 'likely',
      evidence: onSite.map(source => source.evidence!).filter(Boolean),
      title: `The site does not show the ${ELEMENT_LABELS[row.element]}`,
      expected: `The ${ELEMENT_LABELS[row.element]} is shown on the site (footer, contact or imprint page), as required by ${row.requiredBy.join('; ')}`,
      observed: `Not found on ${onSite.map(source => source.where).join(', ') || 'any readable identity page'}`,
      reproduction: ['Open the home page and read the footer', ...onSite.filter(source => source.kind === 'identity-page').map(source => `Open ${source.where}`)],
      proposedFix: `Add the ${ELEMENT_LABELS[row.element]} to the footer or the contact/imprint page.`,
    }))
  }

  // The same operator everywhere it is named.
  if (entity) for (const source of sources) {
    const names = companyNames(source.text).filter(name => !namesEntity(name, entity) && !namesEntity(entity, name))
    const namesProfile = namesEntity(source.text, entity)
    if (names.length && !namesProfile) findings.push(draft(context, CHECK_ID, {
      key: `entity-mismatch:${source.kind}`, route: source.kind === 'receipt' ? null : source.where, scope: source.kind === 'receipt' ? 'email' : 'page',
      severity: 'high', confidence: 'confirmed', evidence: source.evidence ? [source.evidence] : [],
      title: `The ${source.kind === 'receipt' ? 'receipt' : source.kind.replace('-', ' ')} names a different operator`,
      expected: `The operator named is ${entity}, as in the profile and on the rest of the site`,
      observed: `${source.where} names ${names.join(', ')}`,
      reproduction: source.kind === 'receipt' ? [`Read the captured message ${source.where}`] : [`Open ${source.where}`, `Search for "${names[0]}"`],
      proposedFix: `Use ${entity} consistently, or correct the legal entity in the profile if the operator changed.`,
    }))
    const numbers = registrationNumbers(source.text).filter(number => entityNumbers.length && !entityNumbers.includes(number))
    if (numbers.length) findings.push(draft(context, CHECK_ID, {
      key: `registration-mismatch:${source.kind}`, route: source.kind === 'receipt' ? null : source.where, scope: source.kind === 'receipt' ? 'email' : 'page',
      severity: 'high', confidence: 'confirmed', evidence: source.evidence ? [source.evidence] : [],
      title: `The ${source.kind === 'receipt' ? 'receipt' : source.kind.replace('-', ' ')} shows a different registration number`,
      expected: `Registration number ${entityNumbers.join(' / ')} from the profile`,
      observed: `${source.where} shows ${numbers.join(', ')}`,
      reproduction: source.kind === 'receipt' ? [`Read the captured message ${source.where}`] : [`Open ${source.where}`, `Search for "${numbers[0]}"`],
      proposedFix: 'Show the same registration number everywhere the operator is identified.',
    }))
  }
  for (const source of sources) if (source.kind === 'checkout' && entity && !namesEntity(source.text, entity)) {
    observations.push(`checkout ${source.where} does not name ${entity}; the seller is identified only elsewhere on the site`)
  }

  humanReview.push(review(context, 'legal-adequacy',
    `Do the identity disclosures satisfy ${targets ? [...targets].sort().join(', ') : 'the target countries (not yet answered)'}, including VAT and licensing details where they apply?`,
    'Conductor checks that the required elements appear and agree with the profile; whether they are complete for the business is a human decision.',
    null, sources.map(source => source.evidence!).filter(Boolean)))
  return outcome(CHECK_ID, { findings, unconcluded, evidence, humanReview, coverage, observations })
}
