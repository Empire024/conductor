import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveEngine } from './browser'
import { createConsentCheck } from './checks/consent'
import { createFixtureServer, type FixtureServer } from './fixtures/server'
import { createProductionService, type ProductionService } from './index'
import { REGISTRY } from './registry'
import { environment, fakeBoard, fingerprint, recordingPorts, seedProfile, tempStore, type TempStore } from './testkit'
import { recheckSpec, verdict } from './verifier'

const engine = await resolveEngine()

describe('verdicts', () => {
  const base = fingerprint()
  const spec = { id: 'pf_1', controlId: 'C03' as const, checkId: 'consent', key: 'tracker-before-consent:host-x', route: '/', expected: 'nothing before consent', claimed: 'claimed-fixed' as const }
  const produced = { checkId: 'consent', status: 'FAIL' as const, reason: null, findings: [], evidence: [], humanReview: [], coverage: { tested: [], sampled: [], excluded: [], unobservable: [] }, observations: [] }
  it('refuses a fix claim on an unchanged artifact before looking at any outcome', () => {
    expect(verdict({ spec, projectId: 'p', environmentId: 'env-a', verifierRunId: 'v', fingerprint: base, lastSeenFingerprint: base, outcomes: [produced], reason: null, evidence: [], at: '' }))
      .toMatchObject({ status: 'could-not-verify', disagreement: expect.stringMatching(/^could-not-verify: artifact unchanged/) })
  })
  it('never reads prior evidence: a recheck spec holds only the finding\'s identity, expectation and claim', () => {
    expect(Object.keys(recheckSpec({ id: 'pf_1', controlId: 'C03', checkId: 'consent', key: 'k', route: '/', expected: 'e', observed: 'secret observation', evidence: ['ev'], status: 'open' } as never, true)).sort())
      .toEqual(['checkId', 'claimed', 'controlId', 'expected', 'id', 'key', 'route'])
  })
  it('a check that did not conclude is could-not-verify with its reason, never fixed', () => {
    expect(verdict({ spec, projectId: 'p', environmentId: 'env-a', verifierRunId: 'v', fingerprint: { ...base, commit: 'moved' }, lastSeenFingerprint: base, outcomes: [{ ...produced, status: 'UNVERIFIED', reason: 'budget exhausted' }], reason: null, evidence: [], at: '' }))
      .toMatchObject({ status: 'could-not-verify', disagreement: 'budget exhausted' })
  })
})

describe.skipIf(!engine.available)('Production Verifier on fixture sites (real audit browser)', { timeout: 90_000 }, () => {
  let server: FixtureServer
  let temp: TempStore
  let service: ProductionService
  beforeAll(async () => { server = await createFixtureServer({ sites: ['consent-tracker-before', 'verify-superficial-fix'] }) })
  afterAll(async () => { await server?.close() })
  beforeEach(() => { temp = tempStore() })
  afterEach(async () => { await service?.stop(); temp.close() })

  it('rejects the superficial fix: the banner text is gone but the tracker still fires before consent → verified-open with the disagreement', async () => {
    const broken = server.site('consent-tracker-before')
    const superficial = server.site('verify-superficial-fix')
    seedProfile(temp.store, 'project-a', { environment: { baseUrl: `${broken.origin}/`, allowedOrigins: [broken.origin] }, facts: { analytics: true }, designate: true })
    temp.store.mutateProfile('project-a', 'owner', profile => ({ ...profile, budget: { ...profile.budget, requestsPerSecondPerOrigin: 0 }, scope: { ...profile.scope, devices: ['desktop'], consentStates: ['clean'] } }))
    const board = fakeBoard()
    const target = { value: fingerprint({ registryVersion: REGISTRY.version }) }
    service = createProductionService({
      store: temp.store, userData: temp.dir, interpreter: recordingPorts({ cloudText: prompt => /fix was claimed/.test(prompt) ? '{"note":"The tracker script still loads on page load."}' : '{"rationale":"ok"}' }),
      board, projectRoot: () => null, checks: [createConsentCheck({ maxRoutes: 1, settleMs: 700, maxTabs: 10 })], ownerId: 'verifier-test',
      fingerprint: async () => ({ ...target.value }), adapters: () => ({ mail: null, commerce: null, storage: null }), discovery: false, runCommand: null, readPublic: null,
    })

    const audit = await service.audit('project-a', { controls: ['C03'] })
    await service.runner.idle()
    expect(temp.store.run(audit.run!.id).status).toBe('completed')
    const tracker = temp.store.findings('project-a').find(item => item.key === 'tracker-before-consent:host-localhost')!
    expect(tracker).toMatchObject({ controlId: 'C03', status: 'open', severity: 'high', confidence: 'confirmed' })

    // The builder "fixes" it: deploys the superficial fix and closes the task.
    service.updateProfile('project-a', { environments: [environment({ baseUrl: `${superficial.origin}/`, allowedOrigins: [superficial.origin] })] })
    target.value = { ...target.value, commit: 'superficial00000000000000000000000000000' }
    board.updateTask(tracker.taskId!, { status: 'done' })

    const verify = await service.verify('project-a', [tracker.id])
    await service.runner.idle()
    const run = temp.store.run(verify.run!.id)
    expect(run.status).toBe('completed')
    const after = temp.store.finding(tracker.id)!
    expect(after.status).toBe('open')
    expect(after.verification).toMatchObject({ status: 'verified-open', verifierRunId: run.id })
    expect(after.verification!.disagreement).toMatch(/builder claimed this fixed, but a fresh session on the current target still reproduces it/)
    expect(after.verification!.disagreement).toMatch(/Reviewer note: The tracker script still loads on page load\./)
    // It really ran on the superficial site, in a fresh session.
    expect(server.requests('verify-superficial-fix').some(request => request.path === '/')).toBe(true)
    expect(run.coverage.tested.map(item => item.path)).toContain('/')
    // Nothing was mutated on either site.
    expect(server.mutations()).toEqual([])
    expect(board.tasks.get(tracker.taskId!)!.status).toBe('done')
    expect(service.gate('project-a').state).toBe('NEEDS_REVIEW')
  })
})
