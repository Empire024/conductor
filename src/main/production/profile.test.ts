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

  it('records a wizard update as source "wizard", never "owner", and lets the owner overwrite it but not the reverse', () => {
    const base = defaultProfile('p1', NOW)
    expect(base.questions.find(question => question.factKey === 'analytics')!.status).toBe('open')
    const wizard = applyProfileUpdate(base, { facts: { analytics: true, userUploads: false } }, { by: 'wizard:agent_w (Haftheme wizard)', source: 'wizard', now: NOW })
    expect(wizard.facts.analytics).toMatchObject({ value: true, status: 'evidenced', source: 'wizard', by: 'wizard:agent_w (Haftheme wizard)' })
    // The wizard closed the owner question; the history says a wizard set it.
    expect(wizard.questions.find(question => question.factKey === 'analytics')).toMatchObject({ status: 'answered', answer: 'yes', answeredBy: 'wizard:agent_w (Haftheme wizard)' })
    // An assumption does not replace a wizard fact; the owner does.
    expect(applyProfileUpdate(wizard, { facts: { analytics: false } }, { by: 'agent_x', source: 'assumption', now: NOW }).facts.analytics).toMatchObject({ value: true, source: 'wizard' })
    const owned = applyProfileUpdate(wizard, { facts: { analytics: false } }, { by: 'owner', source: 'owner', now: NOW })
    expect(owned.facts.analytics).toMatchObject({ value: false, source: 'owner' })
    // A wizard changing the owner's fact is refused visibly; repeating the owner's value is fine.
    expect(() => applyProfileUpdate(owned, { facts: { analytics: true } }, { by: 'wizard:agent_w', source: 'wizard', now: NOW })).toThrow(/The owner set analytics \(owner: no\)/)
    expect(applyProfileUpdate(owned, { facts: { analytics: false, userUploads: true } }, { by: 'wizard:agent_w', source: 'wizard', now: NOW }).facts).toMatchObject({ analytics: { value: false, source: 'wizard' }, userUploads: { value: true, source: 'wizard' } })
    // A wizard answering an owner question records a wizard fact too.
    const answered = answerQuestion(base, questionId('emailMarketing'), 'no', 'wizard:agent_w', NOW, undefined, 'wizard')
    expect(answered.facts.emailMarketing).toMatchObject({ value: false, status: 'evidenced', source: 'wizard', by: 'wizard:agent_w' })
    expect(answered.questions.find(question => question.factKey === 'emailMarketing')).toMatchObject({ status: 'answered', answeredBy: 'wizard:agent_w' })
  })

  it('validates environments and always allows the base URL origin', () => {
    expect(validateEnvironment(environment({ allowedOrigins: ['https://cdn.shop.example/path'] })).allowedOrigins).toEqual(['https://shop.example', 'https://cdn.shop.example'])
    expect(() => validateEnvironment(environment({ baseUrl: 'file:///C:/site' }))).toThrow(/http and https/)
    expect(() => validateEnvironment(environment({ id: '../x' }))).toThrow(/environment id/)
    const account = { id: 'a', label: 'Customer', role: 'customer' as const, usernameRef: { id: 'u', source: 'env' as const, key: 'U', purpose: 'login' }, passwordRef: { id: 'p', source: 'env' as const, key: 'P', purpose: 'login' } }
    expect(() => validateEnvironment(environment({ accounts: [account] }))).toThrow(/production/)
    expect(() => applyProfileUpdate(defaultProfile('p1', NOW), { environments: [environment(), environment()] }, { by: 'owner', source: 'owner', now: NOW })).toThrow(/unique/)
  })

  it('rewrites the source, author and time of a fact re-recorded with the same value by the owner or a wizard, never by an assumption', () => {
    const later = new Date(NOW.getTime() + 60_000)
    const owned = applyProfileUpdate(defaultProfile('p1', NOW), { facts: { legalEntity: 'Hash and Flowers s.r.o.', targetCountries: ['SK'] } }, { by: 'owner', source: 'owner', now: NOW })
    expect(owned.facts.legalEntity).toMatchObject({ source: 'owner', at: AT })
    const restated = applyProfileUpdate(owned, { facts: { legalEntity: ' Hash and Flowers s.r.o. ', targetCountries: ['sk'] } }, { by: 'wizard:agent_w (Haftheme wizard)', source: 'wizard', now: later })
    for (const key of ['legalEntity', 'targetCountries'] as const) {
      expect(restated.facts[key]).toMatchObject({ status: 'evidenced', source: 'wizard', by: 'wizard:agent_w (Haftheme wizard)', at: later.toISOString(), note: 'Set by wizard:agent_w (Haftheme wizard)' })
    }
    expect(restated.facts.legalEntity!.value).toBe('Hash and Flowers s.r.o.')
    // The owner takes it back the same way; an agent restating it demotes nothing.
    expect(applyProfileUpdate(restated, { facts: { legalEntity: 'Hash and Flowers s.r.o.' } }, { by: 'owner', source: 'owner', now: later }).facts.legalEntity).toMatchObject({ source: 'owner' })
    const assumed = applyProfileUpdate(restated, { facts: { legalEntity: 'Hash and Flowers s.r.o.' } }, { by: 'agent_x', source: 'assumption', now: later })
    expect(assumed.facts.legalEntity).toMatchObject({ source: 'wizard', status: 'evidenced' })
    expect(mergeFacts(owned.facts, { legalEntity: discoveredFact('Hash and Flowers s.r.o.', AT, 'footer') }).legalEntity).toMatchObject({ source: 'owner' })
  })

  it('records marketing and transactional senders as validated addresses; older profiles without them stay valid', () => {
    const profile = applyProfileUpdate(defaultProfile('p1', NOW), { facts: { marketingSender: ' News@Shop.Example ', transactionalSender: 'orders@shop.example' } }, { by: 'wizard:agent_w', source: 'wizard', now: NOW })
    expect(profile.facts.marketingSender).toMatchObject({ value: 'news@shop.example', source: 'wizard' })
    expect(profile.facts.transactionalSender).toMatchObject({ value: 'orders@shop.example' })
    expect(() => applyProfileUpdate(profile, { facts: { marketingSender: 'Hash and Flowers' } }, { by: 'owner', source: 'owner', now: NOW })).toThrow(/marketingSender must be one email address/)
    expect(parseFactAnswer('transactionalSender', 'Orders@Shop.example')).toBe('orders@shop.example')
    // No control requires them, so they never become owner questions.
    expect(profile.questions.some(question => question.factKey === 'marketingSender' || question.factKey === 'transactionalSender')).toBe(false)
    const { marketingSender: _m, transactionalSender: _t, ...older } = profile.facts
    expect(profileProblems({ ...profile, facts: older as typeof profile.facts })).toEqual([])
    expect(applyProfileUpdate({ ...profile, facts: older as typeof profile.facts }, { facts: { marketingSender: 'news@shop.example' } }, { by: 'owner', source: 'owner', now: NOW }).facts.marketingSender).toMatchObject({ source: 'owner' })
  })

  it('accepts a gate-only guest account on production and lets only the owner or a wizard set its refresh command', () => {
    const guest = {
      id: 'gate', label: 'Site gate', role: 'guest' as const, usernameRef: null, passwordRef: null,
      storageState: { path: 'C:\\haftheme\\tests-e2e\\.smoke-auth\\state.json', capturedAt: null, capturedBy: 'refresh', refresh: { command: 'npx playwright test --project=gate-setup', cwd: 'C:\\haftheme', maxAgeHours: 24 * 7, maskEnv: ['HAF_SMOKE_SITE_PASSWORD'] } },
    }
    const prod = environment({ accounts: [guest] })
    expect(validateEnvironment(prod).accounts[0]).toMatchObject({ role: 'guest', usernameRef: null, passwordRef: null })
    expect(() => validateEnvironment(environment({ accounts: [{ ...guest, storageState: null }] }))).toThrow(/only a guest account with a storageState/)
    expect(() => validateEnvironment(environment({ accounts: [{ ...guest, storageState: { ...guest.storageState, refresh: { ...guest.storageState.refresh, cwd: 'relative/dir' } } }] }))).toThrow(/refresh.cwd must be an absolute/)
    expect(() => validateEnvironment(environment({ accounts: [{ ...guest, storageState: { ...guest.storageState, refresh: { ...guest.storageState.refresh, maxAgeHours: 0 } } }] }))).toThrow(/maxAgeHours/)

    expect(() => applyProfileUpdate(defaultProfile('p1', NOW), { environments: [prod] }, { by: 'agent_x', source: 'assumption', now: NOW })).toThrow(/only the owner or a wizard tab may set or change it/)
    const set = applyProfileUpdate(defaultProfile('p1', NOW), { environments: [prod] }, { by: 'wizard:agent_w (Haftheme wizard)', source: 'wizard', now: NOW })
    expect(set.environments[0]!.accounts[0]!.storageState!.refresh!.setBy).toEqual({ source: 'wizard', by: 'wizard:agent_w (Haftheme wizard)', at: AT })
    // Resending the same refresh keeps its stamp; a forged stamp is ignored.
    const again = applyProfileUpdate(set, { environments: [environment({ accounts: [{ ...guest, storageState: { ...guest.storageState, refresh: { ...guest.storageState.refresh, setBy: { source: 'owner', by: 'owner', at: AT } } } }] })] }, { by: 'owner', source: 'owner', now: new Date(NOW.getTime() + 1_000) })
    expect(again.environments[0]!.accounts[0]!.storageState!.refresh!.setBy).toEqual({ source: 'wizard', by: 'wizard:agent_w (Haftheme wizard)', at: AT })
  })

  it('validates the environment mutation policy', () => {
    expect(validateEnvironment(environment({ kind: 'staging', mutationPolicy: 'production-intended-or-rollback' })).mutationPolicy).toBe('production-intended-or-rollback')
    expect(validateEnvironment(environment()).mutationPolicy).toBeNull()
    expect(() => validateEnvironment(environment({ mutationPolicy: 'anything' as never }))).toThrow(/mutationPolicy must be one of none, production-intended-or-rollback/)
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
