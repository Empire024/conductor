import { describe, expect, it } from 'vitest'
import { CONTROL_IDS, SOURCE_COVERAGE, SOURCE_ITEM_IDS, type ControlId, type FactKey, type ProfileFacts } from '../../shared/production'
import { defaultProfile, emptyFacts, ownerFact, assumedFact } from './profile'
import { controlDefinition, controlsInvalidatedBy, decideAll, decideApplicability, jurisdictionsFor, provenanceFor, REGISTRY, registryProblems, SOURCES } from './registry'

const AT = '2026-09-28T12:00:00.000Z'
const facts = (values: Partial<Record<FactKey, unknown>>): ProfileFacts => {
  const out = emptyFacts() as unknown as Record<FactKey, unknown>
  for (const [key, value] of Object.entries(values)) out[key as FactKey] = ownerFact(value, AT)
  return out as unknown as ProfileFacts
}
const decide = (id: ControlId, profileFacts: ProfileFacts) => decideApplicability(controlDefinition(id), profileFacts)

describe('control registry', () => {
  it('has no structural problems', () => {
    expect(registryProblems()).toEqual([])
  })

  it('maps all 26 source items to a control whose sources list them', () => {
    expect(SOURCE_ITEM_IDS).toHaveLength(26)
    for (const item of SOURCE_ITEM_IDS) {
      const owner = SOURCE_COVERAGE[item]
      expect(controlDefinition(owner).sources, `${item} → ${owner}`).toContain(item)
    }
    const listed = REGISTRY.controls.flatMap(definition => definition.sources)
    expect([...listed].sort()).toEqual([...SOURCE_ITEM_IDS].sort())
    expect(REGISTRY.controls.map(definition => definition.id)).toEqual([...CONTROL_IDS])
  })

  it('reports a broken coverage map', () => {
    const broken = { ...REGISTRY, controls: REGISTRY.controls.map(definition => definition.id === 'C12' ? { ...definition, sources: definition.sources.filter(item => item !== 'V2-17') } : definition) }
    expect(registryProblems(broken)).toContain('V2-17 maps to C12, but C12.sources does not list it')
  })

  it('makes C01, C02, C13 and C16 applicable on an empty profile and every other control unknown', () => {
    const decisions = new Map(decideAll(emptyFacts()).map(entry => [entry.controlId, entry.decision]))
    for (const id of CONTROL_IDS) {
      const expected = ['C01', 'C02', 'C13', 'C16'].includes(id) ? 'applicable' : 'unknown'
      expect(decisions.get(id)!.status, id).toBe(expected)
    }
    expect(decisions.get('C08')!.rationale).toMatch(/emailMarketing/)
  })

  it('gives every unknown control on an empty profile an owner question that names it', () => {
    const profile = defaultProfile('p1', new Date(AT))
    const unknown = decideAll(profile.facts).filter(entry => entry.decision.status === 'unknown').map(entry => entry.controlId)
    expect(unknown).toHaveLength(12)
    for (const id of unknown) {
      const needed = controlDefinition(id).applicability.requiredFacts
      for (const fact of needed) {
        const question = profile.questions.find(candidate => candidate.factKey === fact)
        expect(question, `${id} needs ${fact}`).toBeDefined()
        expect(question!.blocksControls).toContain(id)
        expect(question!.status).toBe('open')
      }
    }
  })

  it('decides applicability from the rules in order, then otherwise', () => {
    expect(decide('C08', facts({ emailMarketing: false })).status).toBe('not-applicable')
    expect(decide('C08', facts({ emailMarketing: true }))).toMatchObject({ status: 'applicable', ruleIndex: 0 })
    expect(decide('C10', facts({ subscriptions: false })).status).toBe('not-applicable')
    expect(decide('C15', facts({ userUploads: false })).status).toBe('not-applicable')
    expect(decide('C09', facts({ businessModel: 'b2b', products: ['software'] })).status).toBe('not-applicable')
    expect(decide('C09', facts({ businessModel: 'b2c', products: ['flowers'] })).status).toBe('applicable')
    expect(decide('C11', facts({ businessModel: 'both', products: ['flowers'] })).status).toBe('applicable')
    expect(decide('C14', facts({ audience: 'general', ageRestrictedProducts: false }))).toMatchObject({ status: 'not-applicable', ruleIndex: null })
    expect(decide('C14', facts({ audience: 'general', ageRestrictedProducts: true }))).toMatchObject({ status: 'applicable', ruleIndex: 2 })
    expect(decide('C14', facts({ audience: 'child-directed', ageRestrictedProducts: false }))).toMatchObject({ status: 'applicable', ruleIndex: 0 })
    expect(decide('C03', facts({ analytics: false })).rationale).toMatch(/essential-only/)
    expect(decide('C07', facts({ targetCountries: ['sk'], dataCategories: ['contact'] }))).toMatchObject({ status: 'applicable', ruleIndex: 0 })
  })

  it('stays unknown while any required fact is unknown, even if a rule could match', () => {
    expect(decide('C14', facts({ audience: 'child-directed' })).status).toBe('unknown')
    expect(decide('C09', facts({ businessModel: 'b2b' })).status).toBe('unknown')
  })

  it('says when a decision rests on an assumption', () => {
    const profileFacts = { ...emptyFacts(), emailMarketing: assumedFact(true, AT, 'newsletter form seen') }
    const decision = decide('C08', profileFacts)
    expect(decision.status).toBe('applicable')
    expect(decision.rationale).toMatch(/assumed facts: emailMarketing = true/)
    expect(decision.factsUsed).toEqual([{ fact: 'emailMarketing', value: true, status: 'assumed' }])
  })

  it('makes a control the owner disabled not applicable with the owner reason', () => {
    const decision = decideApplicability(controlDefinition('C13'), emptyFacts(), { disabledControls: [{ controlId: 'C13', reason: 'API only, no pages' }] })
    expect(decision).toMatchObject({ status: 'not-applicable', rationale: 'Disabled by the owner for this project: API only, no pages' })
  })
})

describe('provenance', () => {
  it('carries EU, SK, CZ, US federal and US-CA primary sources, none retrieved yet', () => {
    const all = REGISTRY.controls.flatMap(definition => definition.provenance)
    const jurisdictions = new Set(all.filter(entry => entry.kind === 'primary-law').map(entry => entry.jurisdiction))
    for (const jurisdiction of ['EU', 'SK', 'CZ', 'US', 'US-CA']) expect(jurisdictions, jurisdiction).toContain(jurisdiction)
    for (const entry of Object.values(SOURCES)) {
      expect(entry.retrievedAt).toBeNull()
      expect(entry.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      if (entry.effectiveDate) expect(Number.isNaN(Date.parse(entry.effectiveDate))).toBe(false)
    }
    for (const definition of REGISTRY.controls.filter(candidate => candidate.classification === 'legal')) {
      expect(definition.provenance.some(entry => entry.jurisdiction === 'EU'), definition.id).toBe(true)
    }
  })

  it('applies California sources only to projects that target California', () => {
    const skOnly = provenanceFor(controlDefinition('C10'), facts({ targetCountries: ['SK'] }))
    expect(skOnly.map(entry => entry.jurisdiction)).not.toContain('US-CA')
    expect(skOnly.map(entry => entry.jurisdiction)).toEqual(expect.arrayContaining(['EU', 'SK', null]))
    expect(skOnly.map(entry => entry.jurisdiction)).not.toContain('CZ')
    const california = provenanceFor(controlDefinition('C10'), facts({ targetCountries: ['US-CA'] }))
    expect(california.map(entry => entry.jurisdiction)).toEqual(expect.arrayContaining(['US', 'US-CA']))
    expect(california.map(entry => entry.jurisdiction)).not.toContain('EU')
    expect(jurisdictionsFor(emptyFacts().targetCountries)).toBeNull()
    expect([...jurisdictionsFor(ownerFact(['cz', 'US'], AT))!].sort()).toEqual(['CZ', 'EU', 'US'])
  })
})

describe('controlsInvalidatedBy', () => {
  it('invalidates everything on a profile or registry change', () => {
    expect(controlsInvalidatedBy(['profile'])).toEqual([...CONTROL_IDS])
    expect(controlsInvalidatedBy(['registry'])).toEqual([...CONTROL_IDS])
  })

  it('invalidates only the controls a narrow change affects', () => {
    const policy = controlsInvalidatedBy(['policy'])
    expect(policy).toEqual(expect.arrayContaining(['C01', 'C02', 'C11']))
    expect(policy).not.toContain('C13')
    expect(policy).not.toContain('C16')
    expect(controlsInvalidatedBy([])).toEqual([])
    expect(controlsInvalidatedBy(['code'])).toEqual([...CONTROL_IDS])
  })
})
