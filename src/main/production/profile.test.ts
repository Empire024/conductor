import { describe, expect, it } from 'vitest'
import { CONSENT_STATES, DEFAULT_AUDIT_BUDGET, type ProductionEnvironment } from '../../shared/production'
import {
  answerQuestion, applyProfileUpdate, assumedFact, authorizeWrites, defaultProfile, designate, discoveredFact, dismissQuestion, FACT_KEYS,
  liveWriteAuthorization, mergeFacts, emptyFacts, ownerFact, parseFactAnswer, profileProblems, questionId, questionsFor, revokeWrites, validateEnvironment
} from './profile'

const NOW = new Date('2026-09-28T12:00:00.000Z')
const AT = NOW.toISOString()
const environment = (patch: Partial<ProductionEnvironment> = {}): ProductionEnvironment => ({
  id: 'prod', kind: 'production', label: 'Production', baseUrl: 'https://shop.example/', allowedOrigins: [], accounts: [],
  capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null, ...patch
})

describe('defaultProfile', () => {
  it('starts with every fact unknown, not designated, drift off and the default budget', () => {
    const profile = defaultProfile('p1', NOW)
    expect(profile).toMatchObject({ projectId: 'p1', version: 1, updatedAt: AT, environments: [], writeAuthorizations: [], stack: null })
    for (const key of FACT_KEYS) expect(profile.facts[key]).toEqual({ value: null, status: 'unknown', source: null, at: null })
    expect(profile.designation.productionReady).toBe(false)
    expect(profile.drift.enabled).toBe(false)
    expect(profile.budget).toEqual(DEFAULT_AUDIT_BUDGET)
    expect(profile.scope.consentStates).toEqual([...CONSENT_STATES])
  })

  it('asks one question per unknown fact some control requires, and none for the others', () => {
    const profile = defaultProfile('p1', NOW)
    const asked = profile.questions.map(question => question.factKey)
    expect(new Set(asked).size).toBe(asked.length)
    expect(asked).toEqual(expect.arrayContaining(['analytics', 'dataCategories', 'processors', 'aiRuntime', 'sessionReplay', 'targetCountries', 'emailMarketing', 'businessModel', 'products', 'subscriptions', 'audience', 'ageRestrictedProducts', 'userUploads']))
    // Read by checks, but no applicability predicate needs them.
    for (const fact of ['legalEntity', 'accountFeatures', 'paymentProviders', 'safeHarborReliance'] as const) expect(asked).not.toContain(fact)
    const businessModel = profile.questions.find(question => question.factKey === 'businessModel')!
    expect(businessModel).toMatchObject({ id: 'pq_businessModel', status: 'open', blocksControls: ['C09', 'C11', 'C12'] })
  })
})

describe('mergeFacts', () => {
  it('lets the owner beat discovery and discovery beat an assumption', () => {
    let facts = mergeFacts(emptyFacts(), { analytics: assumedFact(false, AT, 'no script seen') })
    expect(facts.analytics).toMatchObject({ value: false, status: 'assumed', source: 'assumption' })
    facts = mergeFacts(facts, { analytics: discoveredFact(true, AT, 'gtag.js in header.php') })
    expect(facts.analytics).toMatchObject({ value: true, status: 'evidenced', source: 'discovery' })
    facts = mergeFacts(facts, { analytics: assumedFact(false, AT, 'guess') })
    expect(facts.analytics.source).toBe('discovery')
    facts = mergeFacts(facts, { analytics: ownerFact(false, AT) })
    expect(facts.analytics).toMatchObject({ value: false, status: 'evidenced', source: 'owner' })
    facts = mergeFacts(facts, { analytics: discoveredFact(true, AT, 'gtag again') })
    expect(facts.analytics).toMatchObject({ value: false, source: 'owner' })
  })

  it('marks an owner answer evidenced whatever status it came with, and ignores unknown input', () => {
    const facts = mergeFacts(emptyFacts(), { subscriptions: { value: true, status: 'assumed', source: 'owner', at: AT }, audience: { value: null, status: 'unknown', source: 'owner', at: AT } })
    expect(facts.subscriptions.status).toBe('evidenced')
    expect(facts.audience.status).toBe('unknown')
  })

  it('validates values for the fact type', () => {
    expect(() => mergeFacts(emptyFacts(), { businessModel: ownerFact('wholesale', AT) })).toThrow(/b2b, b2c, both/)
    expect(() => mergeFacts(emptyFacts(), { analytics: ownerFact('yes', AT) })).toThrow(/true or false/)
    expect(mergeFacts(emptyFacts(), { targetCountries: ownerFact(['sk', 'SK', ' cz '], AT) }).targetCountries.value).toEqual(['SK', 'CZ'])
  })
})

describe('owner questions', () => {
  it('answers a question as an evidenced owner fact and drops it from the open list', () => {
    const profile = answerQuestion(defaultProfile('p1', NOW), questionId('emailMarketing'), 'no', 'owner', NOW)
    expect(profile.facts.emailMarketing).toMatchObject({ value: false, status: 'evidenced', source: 'owner' })
    const question = profile.questions.find(candidate => candidate.factKey === 'emailMarketing')!
    expect(question).toMatchObject({ status: 'answered', answer: 'no', answeredBy: 'owner', answeredAt: AT })
    expect(profile.questions.filter(candidate => candidate.status === 'open').map(candidate => candidate.factKey)).not.toContain('emailMarketing')
  })

  it('parses list, enum and boolean answers and refuses nonsense with the expected shape', () => {
    expect(parseFactAnswer('targetCountries', 'sk, cz; EU')).toEqual(['SK', 'CZ', 'EU'])
    expect(parseFactAnswer('dataCategories', 'none')).toEqual([])
    expect(parseFactAnswer('businessModel', 'B2C')).toBe('b2c')
    expect(parseFactAnswer('userUploads', 'áno')).toBe(true)
    expect(() => parseFactAnswer('userUploads', 'sometimes')).toThrow(/yes or no/)
    expect(() => answerQuestion(defaultProfile('p1', NOW), 'pq_nope', 'x', 'owner', NOW)).toThrow(/No owner question/)
  })

  it('keeps a dismissed question dismissed and its fact unknown on recomputation', () => {
    const dismissed = dismissQuestion(defaultProfile('p1', NOW), questionId('audience'), 'decide later', 'owner', NOW)
    const again = questionsFor(dismissed, undefined, NOW)
    expect(again.find(question => question.factKey === 'audience')).toMatchObject({ status: 'dismissed', answer: 'Dismissed: decide later' })
    expect(dismissed.facts.audience.status).toBe('unknown')
    expect(() => dismissQuestion(dismissed, questionId('audience'), ' ', 'owner', NOW)).toThrow(/reason/)
  })

  it('drops an open question whose fact discovery established, and leaves disabled controls out of blocksControls', () => {
    const base = defaultProfile('p1', NOW)
    const discovered = { ...base, facts: mergeFacts(base.facts, { userUploads: discoveredFact(false, AT, 'no upload fields') }) }
    expect(questionsFor(discovered, undefined, NOW).map(question => question.factKey)).not.toContain('userUploads')
    const disabled = { ...base, scope: { ...base.scope, disabledControls: [{ controlId: 'C12' as const, reason: 'no marketing copy' }] } }
    expect(questionsFor(disabled, undefined, NOW).find(question => question.factKey === 'businessModel')!.blocksControls).toEqual(['C09', 'C11'])
  })
})

describe('profile updates', () => {
  it('records an agent update as an assumption that never overwrites the owner', () => {
    const owned = applyProfileUpdate(defaultProfile('p1', NOW), { facts: { analytics: true } }, { by: 'owner', source: 'owner', now: NOW })
    const agent = applyProfileUpdate(owned, { facts: { analytics: false, subscriptions: false } }, { by: 'agent_x', source: 'assumption', now: NOW })
    expect(agent.facts.analytics).toMatchObject({ value: true, source: 'owner' })
    expect(agent.facts.subscriptions).toMatchObject({ value: false, status: 'assumed', source: 'assumption' })
  })

  it('validates environments and always allows the base URL origin', () => {
    expect(validateEnvironment(environment({ allowedOrigins: ['https://cdn.shop.example/path'] })).allowedOrigins).toEqual(['https://shop.example', 'https://cdn.shop.example'])
    expect(() => validateEnvironment(environment({ baseUrl: 'file:///C:/site' }))).toThrow(/http and https/)
    expect(() => validateEnvironment(environment({ id: '../x' }))).toThrow(/environment id/)
    const account = { id: 'a', label: 'Customer', role: 'customer' as const, usernameRef: { id: 'u', source: 'env' as const, key: 'U', purpose: 'login' }, passwordRef: { id: 'p', source: 'env' as const, key: 'P', purpose: 'login' } }
    expect(() => validateEnvironment(environment({ accounts: [account] }))).toThrow(/production/)
    expect(() => applyProfileUpdate(defaultProfile('p1', NOW), { environments: [environment(), environment()] }, { by: 'owner', source: 'owner', now: NOW })).toThrow(/unique/)
  })

  it('validates scope, budget and drift', () => {
    const profile = defaultProfile('p1', NOW)
    expect(() => applyProfileUpdate(profile, { scope: { disabledControls: [{ controlId: 'C03', reason: '' }] } }, { by: 'owner', source: 'owner', now: NOW })).toThrow(/reason/)
    expect(() => applyProfileUpdate(profile, { budget: { maxTokens: -1 } }, { by: 'owner', source: 'owner', now: NOW })).toThrow(/budget.maxTokens/)
    expect(() => applyProfileUpdate(profile, { drift: { everyMinutes: 5 } }, { by: 'owner', source: 'owner', now: NOW })).toThrow(/drift/)
    expect(applyProfileUpdate(profile, { drift: { enabled: true } }, { by: 'owner', source: 'owner', now: NOW }).drift).toMatchObject({ enabled: true, onChange: 'mark-stale' })
  })

  it('designates only a known environment', () => {
    const profile = applyProfileUpdate(defaultProfile('p1', NOW), { environments: [environment()] }, { by: 'owner', source: 'owner', now: NOW })
    expect(() => designate(profile, { productionReady: true, environmentId: 'staging', note: '' }, 'owner', NOW)).toThrow(/No environment staging/)
    expect(() => designate(profile, { productionReady: true, environmentId: null, note: '' }, 'owner', NOW)).toThrow(/names the environment/)
    expect(designate(profile, { productionReady: true, environmentId: 'prod', note: 'launch' }, 'owner', NOW).designation).toEqual({ productionReady: true, environmentId: 'prod', note: 'launch', by: 'owner', at: AT })
  })
})

describe('write authorizations', () => {
  const profile = applyProfileUpdate(defaultProfile('p1', NOW), { environments: [environment(), environment({ id: 'staging', kind: 'staging', baseUrl: 'https://staging.shop.example/' })] }, { by: 'owner', source: 'owner', now: NOW })
  const later = new Date(NOW.getTime() + 3_600_000).toISOString()

  it('refuses a production environment whatever the grantor', () => {
    for (const kind of ['owner', 'wizard'] as const) expect(() => authorizeWrites(profile, { environmentId: 'prod', mutations: ['form-submit'], expiresAt: later, note: '' }, { kind, agentSessionId: null }, NOW)).toThrow(/production/)
    const forged = { ...profile, writeAuthorizations: [{ id: 'x', environmentId: 'prod', mutations: ['checkout' as const], grantedBy: { kind: 'owner' as const, agentSessionId: null }, grantedAt: AT, expiresAt: later, note: '' }] }
    expect(profileProblems(forged).join(' ')).toMatch(/production environment/)
    expect(liveWriteAuthorization(forged, 'prod', 'checkout', NOW)).toBeNull()
  })

  it('grants named mutations on staging until expiry, and revokes', () => {
    expect(() => authorizeWrites(profile, { environmentId: 'staging', mutations: [], expiresAt: later, note: '' }, { kind: 'owner', agentSessionId: null }, NOW)).toThrow(/mutation kind/)
    expect(() => authorizeWrites(profile, { environmentId: 'staging', mutations: ['checkout'], expiresAt: AT, note: '' }, { kind: 'owner', agentSessionId: null }, NOW)).toThrow(/future/)
    const { profile: granted, authorization } = authorizeWrites(profile, { environmentId: 'staging', mutations: ['checkout', 'checkout'], expiresAt: later, note: 'test mode' }, { kind: 'wizard', agentSessionId: 'agent_w' }, NOW)
    expect(authorization.mutations).toEqual(['checkout'])
    expect(liveWriteAuthorization(granted, 'staging', 'checkout', NOW)?.id).toBe(authorization.id)
    expect(liveWriteAuthorization(granted, 'staging', 'form-submit', NOW)).toBeNull()
    expect(liveWriteAuthorization(granted, 'staging', 'checkout', new Date(NOW.getTime() + 7_200_000))).toBeNull()
    expect(revokeWrites(granted, authorization.id).writeAuthorizations).toEqual([])
  })
})
