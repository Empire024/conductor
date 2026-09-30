import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveEngine } from './browser'
import { computeFingerprint, sameTarget } from './fingerprint'
import { createFixtureServer, type FixtureServer } from './fixtures/server'
import { createProductionService, type ProductionService } from './index'
import { REGISTRY } from './registry'
import { applyInterpretation } from './runner'
import { ENV_ID, recordingPorts, seedProfile, tempStore, type TempStore } from './testkit'

const engine = await resolveEngine()

describe('applyInterpretation', () => {
  const result = {
    runId: 'r', controlId: 'C03' as const, status: 'FAIL' as const, applicability: { status: 'applicable' as const, rationale: '', factsUsed: [], ruleIndex: null },
    rationale: 'consent: FAIL', evidence: [], findingIds: ['pf_a'], humanReview: [], checks: [], coverage: { tested: [], sampled: [], excluded: [], unobservable: [] }, provenance: [],
  }
  it('adds "not interpreted" on a refusal and changes nothing else', () => {
    const next = applyInterpretation(result, [], null, null, 'local model unavailable')
    expect(next.result).toEqual({ ...result, rationale: 'consent: FAIL\nNot interpreted: local model unavailable' })
    expect(next.findings).toEqual([])
  })
})

describe.skipIf(!engine.available)('default wiring on a fixture site (real audit browser)', { timeout: 90_000 }, () => {
  let server: FixtureServer
  let temp: TempStore
  let service: ProductionService
  beforeAll(async () => { server = await createFixtureServer({ sites: ['baseline'] }) })
  afterAll(async () => { await server?.close() })
  beforeEach(() => { temp = tempStore() })
  afterEach(async () => { await service?.stop(); temp.close() })

  it('discovers the stack and routes into the profile once, reads policy pages for the fingerprint, and a second audit of the unchanged site reuses that crawl and is not STALE; a new commit crawls again', async () => {
    const site = server.site('baseline')
    let head = 'abc1230000000000000000000000000000000000'
    seedProfile(temp.store, 'project-a', { environment: { baseUrl: `${site.origin}/`, allowedOrigins: [site.origin] }, routes: [], designate: true })
    temp.store.mutateProfile('project-a', 'owner', profile => ({ ...profile, budget: { ...profile.budget, requestsPerSecondPerOrigin: 0 } }))
    service = createProductionService({ store: temp.store, userData: temp.dir, interpreter: recordingPorts(), board: null, projectRoot: () => null, gitHead: async () => head, ownerId: 'wiring-test' })

    const first = await service.audit('project-a', { controls: ['C16'] })
    await service.runner.idle()
    const run = temp.store.run(first.run!.id)
    expect(run.status).toBe('completed')
    const profile = temp.store.profile('project-a')!
    expect(profile.stack?.platform).toBe('woocommerce')
    expect(profile.scope.routes.length).toBeGreaterThan(3)
    expect(profile.scope.routes.some(route => route.tags.includes('policy'))).toBe(true)
    const empty = computeFingerprint({ environmentId: ENV_ID, commit: null, build: null, configFiles: [], policyPages: [], dependencyFiles: [], routes: [], profileVersion: 1, registryVersion: REGISTRY.version })
    expect(run.fingerprint).toMatchObject({ commit: 'abc1230000000000000000000000000000000000', registryVersion: REGISTRY.version })
    expect(run.fingerprint.policyHash).not.toBe(empty.policyHash)
    expect(run.fingerprint.routesHash).not.toBe(empty.routesHash)
    // Storage has no configuration here: UNVERIFIED with the reason, never PASS.
    expect(temp.store.results(run.id)[0]).toMatchObject({ controlId: 'C16', status: 'UNVERIFIED' })
    expect(run.reportPaths).not.toBeNull()
    expect(server.mutations('baseline')).toEqual([])

    const second = await service.audit('project-a', { controls: ['C16'] })
    await service.runner.idle()
    const again = temp.store.run(second.run!.id)
    expect(temp.store.profile('project-a')!.version).toBe(profile.version)
    expect(sameTarget(run.fingerprint, again.fingerprint)).toBe(true)
    expect(service.gate('project-a').state).not.toBe('STALE')
    const reused = (id: string) => temp.store.events(id).some(event => event.message.startsWith(`Discovery reused from run ${run.id}`))
    expect(reused(run.id)).toBe(false)
    expect(reused(again.id)).toBe(true)

    // Another commit is another target: the crawl runs again.
    head = 'def4560000000000000000000000000000000000'
    const third = await service.audit('project-a', { controls: ['C16'] })
    await service.runner.idle()
    expect(temp.store.run(third.run!.id).status).toBe('completed')
    expect(temp.store.events(third.run!.id).some(event => event.message.startsWith('Discovery reused'))).toBe(false)
  })
})
