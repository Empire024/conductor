import {
  CHANGE_CLASSES, CONTROL_IDS, CONTROL_TITLES, SOURCE_COVERAGE, SOURCE_ITEM_IDS,
  type ApplicabilityDecision, type AuditScope, type ChangeClass, type ControlDefinition, type ControlId, type ControlRegistry,
  type FactCondition, type FactKey, type ProfileFact, type ProfileFacts, type Provenance
} from '../../shared/production'

/**
 * The control registry (docs/production-agent.md section 3 and 10): sixteen controls C01-C16 that
 * cover the 26 source items, each with its applicability predicate as data, the provenance that
 * applies (primary law with jurisdiction and dates), evidence requirements, the check ids that
 * implement it and the change classes that invalidate its result.
 *
 * Bump REGISTRY.version on any change to a definition: a registry version change marks every
 * previous result STALE.
 *
 * Provenance is a starting list of primary sources, not legal advice and not a certification.
 * Every entry is `retrievedAt: null` until the legal-sources step has fetched and compared it; the
 * `reviewBy` date asks a human to re-check amendments and effective dates.
 */

const REVIEW_BY = '2027-03-31'

/** EU member states (ISO 3166-1 alpha-2); a target country in this set brings in `EU` sources. */
export const EU_MEMBER_STATES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]
/** EU codes plus `EU` itself, for `includesAny` conditions. */
const EU_TARGETS = ['EU', ...EU_MEMBER_STATES]

const law = (jurisdiction: string, title: string, url: string, effectiveDate: string | null, note?: string): Provenance =>
  ({ kind: 'primary-law', title, jurisdiction, url, effectiveDate, retrievedAt: null, reviewBy: REVIEW_BY, ...(note ? { note } : {}) })
const guidance = (jurisdiction: string | null, title: string, url: string, effectiveDate: string | null, note?: string): Provenance =>
  ({ kind: 'regulator-guidance', title, jurisdiction, url, effectiveDate, retrievedAt: null, reviewBy: REVIEW_BY, ...(note ? { note } : {}) })
const standard = (title: string, url: string, effectiveDate: string | null, note?: string): Provenance =>
  ({ kind: 'standard', title, jurisdiction: null, url, effectiveDate, retrievedAt: null, reviewBy: REVIEW_BY, ...(note ? { note } : {}) })
const internal = (title: string, note: string): Provenance =>
  ({ kind: 'internal-policy', title, jurisdiction: null, url: null, effectiveDate: null, retrievedAt: null, reviewBy: null, note })
const video = (items: string): Provenance =>
  ({ kind: 'video-source', title: `Owner's source videos, items ${items}`, jurisdiction: null, url: null, effectiveDate: null, retrievedAt: null, reviewBy: null, note: 'Names the risk area only; never cited as law and never a source of penalty figures.' })

const eurlex = (eli: string): string => `https://eur-lex.europa.eu/eli/${eli}/oj`
const slovlex = (year: number, number: number): string => `https://www.slov-lex.sk/pravne-predpisy/SK/ZZ/${year}/${number}/`
const esbirka = (year: number, number: number): string => `https://www.e-sbirka.cz/sb/${year}/${number}`
const uscode = (title: number, section: string): string => `https://www.law.cornell.edu/uscode/text/${title}/${section}`
const ecfr = (part: number): string => `https://www.ecfr.gov/current/title-16/part-${part}`
const caCode = (code: string, section: string): string => `https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=${code}&sectionNum=${section}`

/** Shared source library; each control lists the entries that bear on it. */
export const SOURCES = {
  gdpr: law('EU', 'Regulation (EU) 2016/679 (GDPR)', eurlex('reg/2016/679'), '2018-05-25'),
  ePrivacy: law('EU', 'Directive 2002/58/EC (ePrivacy), Art. 5(3) and 13 as amended by Directive 2009/136/EC', eurlex('dir/2002/58'), '2011-05-25', 'The amended Art. 5(3) applies from the 2009/136/EC transposition deadline.'),
  eCommerce: law('EU', 'Directive 2000/31/EC (e-Commerce), Art. 5 and 6', eurlex('dir/2000/31'), '2002-01-17'),
  consumerRights: law('EU', 'Directive 2011/83/EU (Consumer Rights), Art. 6, 8 and 9-16', eurlex('dir/2011/83'), '2014-06-13'),
  withdrawalFunction: law('EU', 'Directive (EU) 2023/2673, new Art. 11a of Directive 2011/83/EU (withdrawal function)', eurlex('dir/2023/2673'), '2026-06-19'),
  omnibus: law('EU', 'Directive (EU) 2019/2161 (Omnibus: price reductions, reviews, personalised pricing)', eurlex('dir/2019/2161'), '2022-05-28'),
  priceIndication: law('EU', 'Directive 98/6/EC (Price Indication), Art. 6a as inserted by Directive (EU) 2019/2161', eurlex('dir/1998/6'), '2022-05-28'),
  ucpd: law('EU', 'Directive 2005/29/EC (Unfair Commercial Practices), Annex I', eurlex('dir/2005/29'), '2007-12-12'),
  misleadingAdvertising: law('EU', 'Directive 2006/114/EC (Misleading and Comparative Advertising, B2B)', eurlex('dir/2006/114'), '2007-12-12'),
  dsa: law('EU', 'Regulation (EU) 2022/2065 (Digital Services Act), Art. 16, 25 and 28', eurlex('reg/2022/2065'), '2024-02-17'),
  eaa: law('EU', 'Directive (EU) 2019/882 (European Accessibility Act)', eurlex('dir/2019/882'), '2025-06-28', 'Applies to e-commerce services offered to consumers; microenterprises providing services are exempt.'),
  aiAct: law('EU', 'Regulation (EU) 2024/1689 (AI Act), Art. 50 transparency obligations', eurlex('reg/2024/1689'), '2026-08-02'),
  copyrightDsm: law('EU', 'Directive (EU) 2019/790 (Copyright in the Digital Single Market), Art. 17', eurlex('dir/2019/790'), '2021-06-07'),
  edpbConsent: guidance('EU', 'EDPB Guidelines 05/2020 on consent under Regulation 2016/679', 'https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en', '2020-05-04'),
  edpbDeceptive: guidance('EU', 'EDPB Guidelines 03/2022 on deceptive design patterns in social media platform interfaces', 'https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-032022-deceptive-design-patterns-social-media_en', '2023-02-14'),

  skDataProtection: law('SK', 'Zákon č. 18/2018 Z. z. o ochrane osobných údajov', slovlex(2018, 18), '2018-05-25'),
  skElectronicCommunications: law('SK', 'Zákon č. 452/2021 Z. z. o elektronických komunikáciách, § 109 (cookies) and § 116 (unsolicited communications)', slovlex(2021, 452), '2022-02-01'),
  skECommerce: law('SK', 'Zákon č. 22/2004 Z. z. o elektronickom obchode, § 4 (information about the provider)', slovlex(2004, 22), '2004-02-01'),
  skConsumerProtection: law('SK', 'Zákon č. 108/2024 Z. z. o ochrane spotrebiteľa (distance contracts, withdrawal, price information)', slovlex(2024, 108), '2024-07-01'),
  skAccessibility: law('SK', 'Zákon č. 351/2022 Z. z. o požiadavkách na prístupnosť výrobkov a služieb (EAA transposition)', slovlex(2022, 351), '2025-06-28', 'Number and effective date to be confirmed on first retrieval.'),

  czDataProtection: law('CZ', 'Zákon č. 110/2019 Sb. o zpracování osobních údajů', esbirka(2019, 110), '2019-04-24'),
  czElectronicCommunications: law('CZ', 'Zákon č. 127/2005 Sb. o elektronických komunikacích, § 89(3) (cookies, opt-in since 2022)', esbirka(2005, 127), '2022-01-01'),
  czInformationSociety: law('CZ', 'Zákon č. 480/2004 Sb. o některých službách informační společnosti, § 7 (commercial communications)', esbirka(2004, 480), '2004-09-07'),
  czCivilCode: law('CZ', 'Zákon č. 89/2012 Sb. občanský zákoník, § 435 (entrepreneur identification), § 1811-1830 (distance contracts, withdrawal)', esbirka(2012, 89), '2014-01-01'),
  czConsumerProtection: law('CZ', 'Zákon č. 634/1992 Sb. o ochraně spotřebitele (unfair practices, price information, reviews)', esbirka(1992, 634), '1992-12-31'),
  czAccessibility: law('CZ', 'Zákon č. 424/2023 Sb. o požadavcích na přístupnost některých výrobků a služeb (EAA transposition)', esbirka(2023, 424), '2025-06-28', 'Number and effective date to be confirmed on first retrieval.'),

  ftcAct: law('US', 'FTC Act § 5, 15 U.S.C. § 45 (unfair or deceptive acts or practices)', uscode(15, '45'), null),
  canSpam: law('US', 'CAN-SPAM Act, 15 U.S.C. § 7701 et seq., and 16 CFR Part 316', ecfr(316), '2004-01-01'),
  coppa: law('US', "Children's Online Privacy Protection Act, 15 U.S.C. § 6501-6506, and COPPA Rule 16 CFR Part 312 (2025 amendments)", ecfr(312), '2025-06-23', 'Amended rule effective 2025-06-23 with a compliance date of 2026-04-22.'),
  rosca: law('US', 'Restore Online Shoppers\' Confidence Act, 15 U.S.C. § 8401-8405 (negative option)', uscode(15, '8403'), '2010-12-29', 'The FTC negative option ("click-to-cancel") rule was vacated in 2025; ROSCA and state law apply.'),
  ftcFees: law('US', 'FTC Rule on Unfair or Deceptive Fees, 16 CFR Part 464', ecfr(464), '2025-05-12', 'Covers live-event tickets and short-term lodging only; elsewhere FTC Act § 5 and state law apply.'),
  ftcReviews: law('US', 'FTC Rule on the Use of Consumer Reviews and Testimonials, 16 CFR Part 465', ecfr(465), '2024-10-21'),
  ftcEndorsements: guidance('US', 'FTC Guides Concerning the Use of Endorsements and Testimonials in Advertising, 16 CFR Part 255', ecfr(255), '2023-06-29'),
  dmca: law('US', 'DMCA safe harbor, 17 U.S.C. § 512 (designated agent, notice and takedown, repeat infringers)', uscode(17, '512'), '1998-10-28'),
  dmcaDirectory: guidance('US', 'U.S. Copyright Office DMCA Designated Agent Directory (registration renews every three years)', 'https://www.copyright.gov/dmca-directory/', '2016-12-01'),
  adaGuidance: guidance('US', 'DOJ Guidance on Web Accessibility and the ADA (Title III, 42 U.S.C. § 12181 et seq.)', 'https://www.ada.gov/resources/web-guidance/', '2022-03-18'),

  ccpa: law('US-CA', 'California Consumer Privacy Act as amended by CPRA, Cal. Civ. Code § 1798.100 et seq., and 11 CCR § 7000 et seq.', caCode('CIV', '1798.100'), '2023-01-01'),
  calOppa: law('US-CA', 'California Online Privacy Protection Act, Cal. Bus. & Prof. Code § 22575-22579', caCode('BPC', '22575'), '2004-07-01'),
  caCommerceDisclosure: law('US-CA', 'Cal. Civ. Code § 1789.3 (electronic commerce: provider name, address and charges)', caCode('CIV', '1789.3'), null),
  caAutoRenewal: law('US-CA', 'California Automatic Renewal Law, Cal. Bus. & Prof. Code § 17600-17606 (as amended by AB 2863)', caCode('BPC', '17602'), '2025-07-01'),
  caHonestPricing: law('US-CA', 'Cal. Civ. Code § 1770(a)(29) (SB 478, drip pricing)', caCode('CIV', '1770'), '2024-07-01'),
  caRefundPolicy: law('US-CA', 'Cal. Civ. Code § 1723 (conspicuous refund policy when no full refund within seven days)', caCode('CIV', '1723'), null),
  caEmailAdvertising: law('US-CA', 'Cal. Bus. & Prof. Code § 17529.5 (misleading commercial email)', caCode('BPC', '17529.5'), null),
  caInvasionOfPrivacy: law('US-CA', 'California Invasion of Privacy Act, Cal. Penal Code § 631 (session replay and chat interception claims)', caCode('PEN', '631'), null),
  caUnruh: law('US-CA', 'Unruh Civil Rights Act, Cal. Civ. Code § 51 (website accessibility claims)', caCode('CIV', '51'), null),
  caMinors: law('US-CA', 'Cal. Bus. & Prof. Code § 22580-22582 (privacy rights for California minors) and Cal. Civ. Code § 1798.120(c)', caCode('BPC', '22580'), '2015-01-01'),

  wcag22: standard('W3C Web Content Accessibility Guidelines (WCAG) 2.2, level AA', 'https://www.w3.org/TR/WCAG22/', '2023-10-05', 'Internal engineering target.'),
  en301549: standard('EN 301 549 V3.2.1 Accessibility requirements for ICT products and services', 'https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf', '2021-03-01'),
} as const satisfies Record<string, Provenance>

const S = SOURCES
const ALWAYS: ChangeClass[] = ['profile', 'registry']
const invalidated = (...classes: ChangeClass[]): ChangeClass[] => CHANGE_CLASSES.filter(change => classes.includes(change) || ALWAYS.includes(change))

const control = (definition: Omit<ControlDefinition, 'title'>): ControlDefinition => ({ ...definition, title: CONTROL_TITLES[definition.id] })

export const REGISTRY: ControlRegistry = {
  version: 1,
  controls: [
    control({
      id: 'C01', sources: ['V2-04', 'V2-16'], classification: 'legal', owner: 'legal',
      applicability: { requiredFacts: [], rules: [], otherwise: 'applicable' },
      provenance: [S.gdpr, S.consumerRights, S.skDataProtection, S.czDataProtection, S.ftcAct, S.calOppa, S.ccpa, video('V2-04, V2-16')],
      evidenceRequirements: [
        'privacy and terms pages reached from every tested route (footer link, final URL, HTTP status)',
        'mobile rendering of each policy page (font size, viewport overflow)',
        'version or last-updated date found in each document',
        'entity name in each document compared with the profile legal entity',
        'placeholder scan result and policy-versus-observed-data-flow comparison'
      ],
      checks: ['policies'], humanReviewAlways: true,
      invalidatedBy: invalidated('code', 'content', 'policy', 'deployment')
    }),
    control({
      id: 'C02', sources: ['V2-09'], classification: 'legal', owner: 'legal',
      applicability: { requiredFacts: [], rules: [], otherwise: 'applicable' },
      provenance: [S.eCommerce, S.consumerRights, S.skECommerce, S.czCivilCode, S.canSpam, S.caCommerceDisclosure, video('V2-09')],
      evidenceRequirements: [
        'identity elements found on the site (entity, address, registration, contact) with their route',
        'the same elements on checkout, receipts (captured mail) and policies, compared',
        'the profile legal entity each is compared with'
      ],
      checks: ['identity'], humanReviewAlways: true,
      invalidatedBy: invalidated('code', 'content', 'policy', 'deployment')
    }),
    control({
      id: 'C03', sources: ['V2-01'], classification: 'legal', owner: 'engineering',
      applicability: {
        requiredFacts: ['analytics'],
        rules: [
          { when: [{ fact: 'analytics', is: 'true' }], then: 'applicable', rationale: 'Analytics or tracking is intended: storage and requests that need prior consent must not start before a choice or after rejection and withdrawal.' },
          { when: [{ fact: 'analytics', is: 'false' }], then: 'applicable', rationale: 'No analytics is declared: the control verifies the site is essential-only (no consent-requiring storage or requests in any consent state); a banner is not required for that.' }
        ],
        otherwise: 'unknown'
      },
      provenance: [S.ePrivacy, S.gdpr, S.edpbConsent, S.skElectronicCommunications, S.czElectronicCommunications, S.ccpa, S.ftcAct, video('V2-01')],
      evidenceRequirements: [
        'request, cookie and storage inventory per consent state (clean, no-interaction, rejected, selected, accepted, withdrawn) and device',
        'the same inventories after navigation, reload and delayed script load',
        'keyboard trace reaching every consent choice'
      ],
      checks: ['consent'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'content', 'dependency', 'deployment', 'configuration')
    }),
    control({
      id: 'C04', sources: ['V2-12', 'V2-19'], classification: 'legal', owner: 'engineering',
      applicability: {
        requiredFacts: ['dataCategories'],
        rules: [],
        otherwise: 'applicable'
      },
      provenance: [S.gdpr, S.edpbConsent, S.skDataProtection, S.czDataProtection, S.ftcAct, S.ccpa, video('V2-12, V2-19')],
      evidenceRequirements: [
        'form inventory (fields, purpose, required flags, default-checked boxes) per tested route',
        'synthetic-marker leak search over URLs, third-party requests and storage',
        'submission evidence only from an authorized sandbox operation'
      ],
      checks: ['forms'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'content', 'dependency', 'deployment', 'configuration')
    }),
    control({
      id: 'C05', sources: ['V2-06', 'V2-10', 'V1-02'], classification: 'legal', owner: 'engineering',
      applicability: {
        requiredFacts: ['processors', 'aiRuntime'],
        rules: [
          { when: [{ fact: 'aiRuntime', is: 'true' }], then: 'applicable', rationale: 'Runtime AI features are offered: vendor inventory plus AI interaction and content disclosures.' }
        ],
        otherwise: 'applicable'
      },
      provenance: [S.gdpr, S.aiAct, S.skDataProtection, S.czDataProtection, S.ftcAct, S.ccpa,
        internal('Self-hosted web fonts', 'Internal privacy and performance preference; a remote font is an internal-quality WARN, never a legal finding by itself.'),
        video('V2-06, V2-10, V1-02')],
      evidenceRequirements: [
        'third-party request inventory by origin and resource type',
        'reconciliation of each origin with the profile processors and the notices text',
        'remote font origins',
        'AI disclosure text near each AI feature when runtime AI is offered'
      ],
      checks: ['vendors'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'content', 'dependency', 'policy', 'deployment', 'configuration')
    }),
    control({
      id: 'C06', sources: ['V1-03'], classification: 'legal', owner: 'engineering',
      applicability: {
        requiredFacts: ['sessionReplay'],
        rules: [
          { when: [{ fact: 'sessionReplay', is: 'true' }], then: 'applicable', rationale: 'Session replay is declared: masking and consent handling are tested with synthetic markers.' },
          { when: [{ fact: 'sessionReplay', is: 'false' }], then: 'applicable', rationale: 'No session replay is declared: the control verifies that no replay or input-capture SDK is present.' }
        ],
        otherwise: 'unknown'
      },
      provenance: [S.gdpr, S.ePrivacy, S.skElectronicCommunications, S.czElectronicCommunications, S.caInvasionOfPrivacy, S.ftcAct, video('V1-03')],
      evidenceRequirements: [
        'replay SDK detection (scripts, globals, input listeners)',
        'outbound request excerpts searched for synthetic markers typed into password, email, card-like and message fields'
      ],
      checks: ['replay'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'dependency', 'deployment', 'configuration')
    }),
    control({
      id: 'C07', sources: ['V2-13'], classification: 'legal', owner: 'operations',
      applicability: {
        requiredFacts: ['targetCountries', 'dataCategories'],
        rules: [
          { when: [{ fact: 'targetCountries', includesAny: EU_TARGETS }], then: 'applicable', rationale: 'EU targets: GDPR Art. 15-22 data subject rights apply.' },
          { when: [{ fact: 'targetCountries', includesAny: ['US-CA'] }], then: 'applicable', rationale: 'California targets: CCPA consumer rights apply where the business meets the CCPA thresholds (owner confirms).' }
        ],
        otherwise: 'applicable'
      },
      provenance: [S.gdpr, S.skDataProtection, S.czDataProtection, S.ccpa, video('V2-13')],
      evidenceRequirements: [
        'request route reachable from the privacy notice',
        'identity verification step recorded',
        'synthetic deletion request traced through the adapter to the remaining-records output',
        'documented exceptions (retention, backups) compared with the implementation'
      ],
      checks: ['data-rights'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'dependency', 'policy', 'deployment', 'configuration')
    }),
    control({
      id: 'C08', sources: ['V1-04'], classification: 'legal', owner: 'operations',
      applicability: {
        requiredFacts: ['emailMarketing'],
        rules: [
          { when: [{ fact: 'emailMarketing', is: 'true' }], then: 'applicable', rationale: 'Marketing email is sent: sender identity, truthful subject, postal address, opt-out and suppression apply.' },
          { when: [{ fact: 'emailMarketing', is: 'false' }], then: 'not-applicable', rationale: 'No marketing email is sent; transactional mail is outside this control.' }
        ],
        otherwise: 'unknown'
      },
      provenance: [S.ePrivacy, S.gdpr, S.skElectronicCommunications, S.czInformationSociety, S.canSpam, S.caEmailAdvertising, video('V1-04')],
      evidenceRequirements: [
        'templates from the source tree and captured deliveries, each classified marketing or transactional',
        'sender, subject, postal address and opt-out link per marketing message',
        'captured second campaign after opt-out showing suppression'
      ],
      checks: ['email'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'dependency', 'deployment', 'configuration')
    }),
    control({
      id: 'C09', sources: ['V2-07'], classification: 'legal', owner: 'operations',
      applicability: {
        requiredFacts: ['businessModel', 'products'],
        rules: [
          { when: [{ fact: 'businessModel', equals: 'b2b' }], then: 'not-applicable', rationale: 'B2B-only sales: consumer price-indication and hidden-fee rules do not apply (misleading advertising is covered by C12).' }
        ],
        otherwise: 'applicable'
      },
      provenance: [S.priceIndication, S.consumerRights, S.ucpd, S.skConsumerProtection, S.czConsumerProtection, S.ftcAct, S.ftcFees, S.caHonestPricing, video('V2-07')],
      evidenceRequirements: [
        'advertised, cart, checkout, order and receipt totals for the same sandbox order',
        'fee, tax and shipping disclosure before the commitment step'
      ],
      checks: ['pricing'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'content', 'dependency', 'deployment', 'configuration')
    }),
    control({
      id: 'C10', sources: ['V2-14', 'V1-05'], classification: 'legal', owner: 'operations',
      applicability: {
        requiredFacts: ['subscriptions'],
        rules: [
          { when: [{ fact: 'subscriptions', is: 'true' }], then: 'applicable', rationale: 'Subscriptions are sold: renewal terms, consent, reminders and cancellation apply.' },
          { when: [{ fact: 'subscriptions', is: 'false' }], then: 'not-applicable', rationale: 'No subscriptions or automatic renewals are offered.' }
        ],
        otherwise: 'unknown'
      },
      provenance: [S.consumerRights, S.withdrawalFunction, S.ucpd, S.skConsumerProtection, S.czCivilCode, S.rosca, S.caAutoRenewal, video('V2-14, V1-05')],
      evidenceRequirements: [
        'renewal terms near the consent action (amount, interval, trial conversion, cancellation)',
        'cancellation through the UI and the adapter with nextPaymentAt cleared',
        'keyboard trace through the cancellation flow'
      ],
      checks: ['subscriptions'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'content', 'dependency', 'policy', 'deployment', 'configuration')
    }),
    control({
      id: 'C11', sources: ['V2-08'], classification: 'legal', owner: 'legal',
      applicability: {
        requiredFacts: ['businessModel', 'products'],
        rules: [
          { when: [{ fact: 'businessModel', equals: 'b2b' }], then: 'not-applicable', rationale: 'B2B-only sales: the consumer right of withdrawal does not apply; contractual refund terms are outside this control.' }
        ],
        otherwise: 'applicable'
      },
      provenance: [S.consumerRights, S.withdrawalFunction, S.skConsumerProtection, S.czCivilCode, S.ftcAct, S.caRefundPolicy, video('V2-08')],
      evidenceRequirements: [
        'refund and withdrawal policy reachable before purchase',
        'consistency between policy, checkout and support pages',
        'sandbox refund request outcome (only with a write authorization)'
      ],
      checks: ['refunds'], humanReviewAlways: true,
      invalidatedBy: invalidated('code', 'content', 'dependency', 'policy', 'deployment')
    }),
    control({
      id: 'C12', sources: ['V2-03', 'V2-05', 'V2-17'], classification: 'legal', owner: 'content',
      applicability: {
        requiredFacts: ['businessModel'],
        rules: [
          { when: [{ fact: 'businessModel', equals: 'b2b' }], then: 'applicable', rationale: 'B2B-only: misleading advertising rules (Directive 2006/114/EC, FTC Act § 5) apply; consumer review rules do not.' }
        ],
        otherwise: 'applicable'
      },
      provenance: [S.ucpd, S.omnibus, S.misleadingAdvertising, S.dsa, S.edpbDeceptive, S.skConsumerProtection, S.czConsumerProtection, S.ftcAct, S.ftcReviews, S.ftcEndorsements, video('V2-03, V2-05, V2-17')],
      evidenceRequirements: [
        'claim, badge, testimonial, scarcity and countdown inventory per route',
        'countdown value across reloads',
        'preselected extras and confirm-shaming copy in the purchase flow'
      ],
      checks: ['claims'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'content', 'deployment')
    }),
    control({
      id: 'C13', sources: ['V2-02', 'V2-11', 'V2-15'], classification: 'engineering', owner: 'engineering',
      applicability: { requiredFacts: [], rules: [], otherwise: 'applicable' },
      provenance: [S.wcag22, S.en301549, S.eaa, S.skAccessibility, S.czAccessibility, S.adaGuidance, S.caUnruh, video('V2-02, V2-11, V2-15')],
      evidenceRequirements: [
        'axe results per tested route and state',
        'keyboard traversal traces (focus visible, order, dialog trap, cookie choices)',
        'screenshots at 200 % zoom and on the mobile viewport',
        'human-review list for the checks automation cannot conclude'
      ],
      checks: ['accessibility'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'content', 'dependency', 'deployment')
    }),
    control({
      id: 'C14', sources: ['V2-18', 'V1-01'], classification: 'legal', owner: 'legal',
      applicability: {
        requiredFacts: ['audience', 'ageRestrictedProducts'],
        rules: [
          { when: [{ fact: 'audience', equals: 'child-directed' }], then: 'applicable', rationale: 'The service is directed at children: child-data rules and parental notices apply.' },
          { when: [{ fact: 'audience', equals: 'mixed' }], then: 'applicable', rationale: 'Mixed audience: actual-knowledge handling and age screening for the child-directed parts apply.' },
          { when: [{ fact: 'ageRestrictedProducts', is: 'true' }], then: 'applicable', rationale: 'Age-restricted products are sold: a jurisdiction-specific eligibility review applies.' },
          { when: [{ fact: 'audience', equals: 'adult-only' }], then: 'applicable', rationale: 'The service is adult-only: how access by minors is prevented must be evidenced.' }
        ],
        otherwise: 'not-applicable'
      },
      provenance: [S.gdpr, S.dsa, S.skDataProtection, S.czDataProtection, S.coppa, S.caMinors, video('V2-18, V1-01')],
      evidenceRequirements: [
        'age gate, parental notice and consent flow where applicable',
        'data flows on child-directed routes',
        'owner-provided eligibility evidence for age-restricted products'
      ],
      checks: ['children'], humanReviewAlways: true,
      invalidatedBy: invalidated('code', 'content', 'policy', 'deployment')
    }),
    control({
      id: 'C15', sources: ['V1-06'], classification: 'legal', owner: 'legal',
      applicability: {
        requiredFacts: ['userUploads'],
        rules: [
          { when: [{ fact: 'userUploads', is: 'true' }, { fact: 'userUploadsVisibility', equals: 'private-only' }], then: 'not-applicable', rationale: 'Uploads are private documents only (kept in non-public storage, seen only by the shop): no content is hosted for the public, so notice-and-action and takedown duties do not apply.' },
          { when: [{ fact: 'userUploads', is: 'true' }], then: 'applicable', rationale: 'Users upload or publish content: rights notices, reporting routes and takedown handling apply.' },
          { when: [{ fact: 'userUploads', is: 'false' }], then: 'not-applicable', rationale: 'No user-generated content is hosted.' }
        ],
        otherwise: 'unknown'
      },
      provenance: [S.dsa, S.copyrightDsm, S.eCommerce, S.dmca, S.dmcaDirectory, video('V1-06')],
      evidenceRequirements: [
        'rights notice, reporting route, counter-notice and repeat-infringer policy on the site',
        'owner-provided DMCA designated agent listing and renewal date when relying on the safe harbor'
      ],
      checks: ['uploads'], humanReviewAlways: true,
      invalidatedBy: invalidated('code', 'content', 'policy', 'deployment', 'configuration')
    }),
    control({
      id: 'C16', sources: ['V2-20'], classification: 'engineering', owner: 'engineering',
      applicability: { requiredFacts: [], rules: [], otherwise: 'applicable' },
      provenance: [S.gdpr, S.skDataProtection, S.czDataProtection, S.ftcAct, S.ccpa, video('V2-20')],
      evidenceRequirements: [
        'storage inventory with public and private prefixes',
        'anonymous probe status (never content) for private keys and listings',
        'signed-link expiry behaviour'
      ],
      checks: ['storage'], humanReviewAlways: false,
      invalidatedBy: invalidated('code', 'dependency', 'deployment', 'configuration')
    }),
  ]
}

const BY_ID = new Map(REGISTRY.controls.map(definition => [definition.id, definition]))

export function controlDefinition(id: ControlId, registry: ControlRegistry = REGISTRY): ControlDefinition {
  const found = registry === REGISTRY ? BY_ID.get(id) : registry.controls.find(definition => definition.id === id)
  if (!found) throw new Error(`Control ${id} is not in registry version ${registry.version}`)
  return found
}

/** A fact counts as unknown when its status says so or it has no value; `assumed` facts are known. */
export const factIsUnknown = (fact: ProfileFact<unknown> | undefined): boolean => !fact || fact.status === 'unknown' || fact.value === null || fact.value === undefined

const upper = (value: unknown): string => String(value).trim().toUpperCase()

function conditionHolds(condition: FactCondition, facts: ProfileFacts): boolean {
  const fact = facts[condition.fact] as ProfileFact<unknown> | undefined
  const unknown = factIsUnknown(fact)
  if (condition.is === 'unknown') { if (!unknown) return false }
  else if (unknown) return false
  const value = fact?.value
  if (condition.is === 'true' && value !== true) return false
  if (condition.is === 'false' && value !== false) return false
  if (condition.is === 'empty' && !(Array.isArray(value) && value.length === 0)) return false
  if (condition.is === 'nonEmpty' && !(Array.isArray(value) && value.length > 0)) return false
  if (condition.equals !== undefined && (Array.isArray(value) || String(value) !== condition.equals)) return false
  if (condition.includesAny !== undefined) {
    if (!Array.isArray(value)) return false
    const wanted = new Set(condition.includesAny.map(upper))
    if (!value.some(item => wanted.has(upper(item)))) return false
  }
  return true
}

const describe = (value: unknown): string => Array.isArray(value) ? (value.length ? value.join(', ') : 'none') : String(value)

/**
 * Applicability of one control for the profile facts. A required fact that is unknown makes the
 * decision `unknown` (UNVERIFIED plus an owner question), never PASS or NOT_APPLICABLE; rules are
 * tried in order and the first whose conditions all hold decides; `otherwise` applies when none
 * does. A control the owner disabled in the scope is NOT_APPLICABLE with the owner's reason.
 * Assumed facts decide like evidenced ones, and the rationale says the decision rests on them.
 */
export function decideApplicability(definition: ControlDefinition, facts: ProfileFacts, scope?: Pick<AuditScope, 'disabledControls'> | null): ApplicabilityDecision {
  const predicate = definition.applicability
  const referenced = [...new Set<FactKey>([...predicate.requiredFacts, ...predicate.rules.flatMap(rule => rule.when.map(condition => condition.fact))])]
  const factsUsed = referenced.map(fact => ({ fact, value: facts[fact]?.value ?? null, status: facts[fact]?.status ?? 'unknown' as const }))
  const disabled = scope?.disabledControls.find(entry => entry.controlId === definition.id)
  if (disabled) return { status: 'not-applicable', rationale: `Disabled by the owner for this project: ${disabled.reason}`, factsUsed, ruleIndex: null }
  const missing = predicate.requiredFacts.filter(fact => factIsUnknown(facts[fact]))
  if (missing.length) {
    return { status: 'unknown', rationale: `Applicability cannot be decided until the owner answers: ${missing.join(', ')}.`, factsUsed, ruleIndex: null }
  }
  const assumed = factsUsed.filter(entry => entry.status === 'assumed')
  const basis = assumed.length ? ` Rests on assumed facts: ${assumed.map(entry => `${entry.fact} = ${describe(entry.value)}`).join('; ')}.` : ''
  const ruleIndex = predicate.rules.findIndex(rule => rule.when.every(condition => conditionHolds(condition, facts)))
  const rule = ruleIndex >= 0 ? predicate.rules[ruleIndex] : undefined
  if (rule) return { status: rule.then, rationale: rule.rationale + basis, factsUsed, ruleIndex }
  const rationale = predicate.otherwise === 'unknown'
    ? 'No applicability rule matched the recorded facts; the owner must decide.'
    : predicate.requiredFacts.length || predicate.rules.length
      ? `${predicate.otherwise === 'applicable' ? 'Applicable' : 'Not applicable'} for the recorded facts (${factsUsed.map(entry => `${entry.fact} = ${describe(entry.value)}`).join('; ')}).${basis}`
      : `Applies to every audited site (${definition.classification === 'engineering' ? 'engineering control' : 'no fact narrows it'}).`
  return { status: predicate.otherwise, rationale, factsUsed, ruleIndex: null }
}

/** Every control's decision, in registry order. */
export function decideAll(facts: ProfileFacts, scope?: Pick<AuditScope, 'disabledControls'> | null, registry: ControlRegistry = REGISTRY): Array<{ controlId: ControlId; decision: ApplicabilityDecision }> {
  return registry.controls.map(definition => ({ controlId: definition.id, decision: decideApplicability(definition, facts, scope) }))
}

/**
 * Jurisdictions whose sources bear on a project: its target countries, `EU` when any is an EU
 * member, and `US` (federal) for any US target. California rules come in only when `US-CA` is a
 * target, never because another project operates there. Unknown targets give null: the caller
 * treats the legal controls as undecided rather than applying every source.
 */
export function jurisdictionsFor(targetCountries: ProfileFact<string[]>): Set<string> | null {
  if (factIsUnknown(targetCountries)) return null
  const set = new Set<string>()
  for (const raw of targetCountries.value ?? []) {
    const code = upper(raw)
    set.add(code)
    if (code === 'EU' || EU_MEMBER_STATES.includes(code)) set.add('EU')
    if (code === 'US' || code.startsWith('US-')) set.add('US')
  }
  return set
}

/** The provenance entries that apply to the project: jurisdiction-free ones (standards, internal
 *  policy, the source videos) always, legal ones only for the project's jurisdictions. */
export function provenanceFor(definition: ControlDefinition, facts: ProfileFacts): Provenance[] {
  const jurisdictions = jurisdictionsFor(facts.targetCountries)
  return definition.provenance.filter(entry => entry.jurisdiction === null || jurisdictions === null || jurisdictions.has(entry.jurisdiction))
}

/**
 * Controls whose last result a set of changes invalidates. A profile or registry change
 * invalidates everything, whatever the definitions say.
 */
export function controlsInvalidatedBy(changes: readonly ChangeClass[], registry: ControlRegistry = REGISTRY): ControlId[] {
  if (changes.includes('profile') || changes.includes('registry')) return registry.controls.map(definition => definition.id)
  return registry.controls.filter(definition => definition.invalidatedBy.some(change => changes.includes(change))).map(definition => definition.id)
}

/** The controls whose legal adequacy a human must always confirm. */
export const HUMAN_REVIEW_ALWAYS: readonly ControlId[] = ['C01', 'C02', 'C11', 'C14', 'C15']

/**
 * Structural assertions over a registry; returns every problem (empty when sound). The test suite
 * runs it over REGISTRY, and the service can refuse to start an audit with a broken registry.
 */
export function registryProblems(registry: ControlRegistry = REGISTRY): string[] {
  const problems: string[] = []
  const ids = registry.controls.map(definition => definition.id)
  for (const id of CONTROL_IDS) if (!ids.includes(id)) problems.push(`${id} has no definition`)
  if (new Set(ids).size !== ids.length) problems.push('A control id is defined twice')
  const factKeys = new Set<string>(['legalEntity', 'targetCountries', 'businessModel', 'products', 'accountFeatures', 'subscriptions', 'userUploads', 'userUploadsVisibility', 'aiRuntime', 'analytics', 'sessionReplay', 'emailMarketing', 'dataCategories', 'audience', 'ageRestrictedProducts', 'paymentProviders', 'processors', 'safeHarborReliance'] satisfies FactKey[])
  const checkIds = new Map<string, ControlId>()
  for (const item of SOURCE_ITEM_IDS) {
    const owner = SOURCE_COVERAGE[item]
    const definition = registry.controls.find(candidate => candidate.id === owner)
    if (!definition) problems.push(`${item} maps to ${owner}, which has no definition`)
    else if (!definition.sources.includes(item)) problems.push(`${item} maps to ${owner}, but ${owner}.sources does not list it`)
  }
  for (const definition of registry.controls) {
    for (const item of definition.sources) if (SOURCE_COVERAGE[item] !== definition.id) problems.push(`${definition.id} lists ${item}, which SOURCE_COVERAGE maps to ${SOURCE_COVERAGE[item]}`)
    if (!definition.sources.length) problems.push(`${definition.id} covers no source item`)
    if (definition.title !== CONTROL_TITLES[definition.id]) problems.push(`${definition.id} title differs from CONTROL_TITLES`)
    if (!definition.checks.length && !definition.humanReviewAlways) problems.push(`${definition.id} has no check and is not human-review-only`)
    for (const check of definition.checks) {
      const other = checkIds.get(check)
      if (other && other !== definition.id) problems.push(`Check id ${check} is used by ${other} and ${definition.id}`)
      checkIds.set(check, definition.id)
    }
    if (!definition.evidenceRequirements.length) problems.push(`${definition.id} names no evidence requirement`)
    if (definition.humanReviewAlways !== HUMAN_REVIEW_ALWAYS.includes(definition.id)) problems.push(`${definition.id} humanReviewAlways disagrees with the design`)
    if (!definition.invalidatedBy.includes('profile') || !definition.invalidatedBy.includes('registry')) problems.push(`${definition.id} must be invalidated by profile and registry changes`)
    const predicate = definition.applicability
    for (const fact of predicate.requiredFacts) if (!factKeys.has(fact)) problems.push(`${definition.id} requires unknown fact ${fact}`)
    predicate.rules.forEach((rule, index) => {
      if (!rule.when.length) problems.push(`${definition.id} rule ${index} has no condition`)
      if (!rule.rationale.trim()) problems.push(`${definition.id} rule ${index} has no rationale`)
      for (const condition of rule.when) {
        if (!factKeys.has(condition.fact)) problems.push(`${definition.id} rule ${index} reads unknown fact ${condition.fact}`)
        if (condition.is === undefined && condition.equals === undefined && condition.includesAny === undefined) problems.push(`${definition.id} rule ${index} has an empty condition on ${condition.fact}`)
      }
    })
    if (definition.classification === 'legal') {
      const legal = definition.provenance.filter(entry => entry.kind === 'primary-law')
      if (!legal.length) problems.push(`${definition.id} is legal but cites no primary law`)
    }
    for (const entry of definition.provenance) {
      if (entry.kind === 'primary-law' || entry.kind === 'regulator-guidance') {
        if (!entry.jurisdiction) problems.push(`${definition.id} cites "${entry.title}" without a jurisdiction`)
        if (!entry.url) problems.push(`${definition.id} cites "${entry.title}" without a URL`)
        if (!entry.reviewBy) problems.push(`${definition.id} cites "${entry.title}" without a review date`)
      }
      if (entry.retrievedAt !== null && Number.isNaN(Date.parse(entry.retrievedAt))) problems.push(`${definition.id} "${entry.title}" has an invalid retrievedAt`)
    }
  }
  return problems
}
