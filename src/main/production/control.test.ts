import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRODUCTION_CONTROL_METHODS, PRODUCTION_LOCAL_METHODS, PRODUCTION_SOVEREIGN_METHODS } from '../../shared/production'
import { CONTROL_METHOD_CLASSES } from '../control-method-classes'
import { LOCAL_CONTROL_METHODS } from '../local-models/tools'
import { PRODUCTION_MUTATION_METHODS, PRODUCTION_READ_METHODS, productionCall, productionSignatures, type ProductionCaller } from './control'
import { createProductionService, type ProductionService } from './index'
import { REGISTRY } from './registry'
import { deferred, fakeBoard, fakeBrowserFactory, finding, fingerprint, outcome, recordingPorts, scriptedCheck, seedProfile, tempStore, type TempStore } from './testkit'

let temp: TempStore
let service: ProductionService
beforeEach(() => {
  temp = tempStore()
  seedProfile(temp.store, 'project-a', { designate: true })
  const { factory } = fakeBrowserFactory()
  const review = scriptedCheck('C01', 'policies', () => outcome('policies', 'PASS', [], { humanReview: [{ id: 'C01:legal-adequacy', controlId: 'C01', question: 'Adequate?', why: 'always reviewed', route: null, evidence: [] }] }))
  const storage = scriptedCheck('C16', 'storage', () => outcome('storage', 'FAIL', [finding('C16', 'storage', 'exposed', { category: 'technical' })]))
  service = createProductionService({
    store: temp.store, userData: temp.dir, interpreter: recordingPorts(), board: fakeBoard(), projectRoot: () => null, checks: [review, storage], ownerId: 'owner-test',
    gitHead: async () => 'c0ffee0000000000000000000000000000000000', browserFactory: policy => factory(policy),
    browserAvailability: async () => ({ available: true, engine: 'playwright-chromium', reason: null }),
    fingerprint: async () => fingerprint({ registryVersion: REGISTRY.version }), adapters: () => ({ mail: null, commerce: null, storage: null }),
    discovery: false, runCommand: null, readPublic: null, leaseTtlMs: 5_000,
  })
})
afterEach(async () => { await service.stop().catch(() => undefined); temp.close() })

const caller = (overrides: Partial<ProductionCaller> = {}): ProductionCaller => ({
  projectId: 'project-a', agentSessionId: 'agent-1', title: 'Coworker', owner: false, wizard: false, sovereign: false, local: false, readOnly: false, ...overrides,
})
const OWNER = caller({ owner: true, sovereign: true, agentSessionId: '', title: 'Owner' })
const WIZARD = caller({ wizard: true, sovereign: true, agentSessionId: 'wizard-1', title: 'Wizard' })

async function audited(by: ProductionCaller = caller()) {
  const started = await productionCall(service, by, 'production.audit', { controls: ['C01', 'C16'] }) as { outcome: string; run: { id: string } }
  expect(started.outcome).toBe('created')
  await service.runner.idle()
  return started.run.id
}

describe('production.* method table', () => {
  it('describes, classifies and exposes every contract method exactly once', () => {
    expect(Object.keys(productionSignatures).sort()).toEqual([...PRODUCTION_CONTROL_METHODS].sort())
    for (const method of PRODUCTION_READ_METHODS) expect(CONTROL_METHOD_CLASSES.has(`read:${method}`), method).toBe(true)
    for (const method of PRODUCTION_MUTATION_METHODS) expect(CONTROL_METHOD_CLASSES.has(`mutation:${method}`), method).toBe(true)
    for (const method of PRODUCTION_LOCAL_METHODS) expect(LOCAL_CONTROL_METHODS as readonly string[], method).toContain(method)
    expect(PRODUCTION_SOVEREIGN_METHODS).toContain('production.review.answer')
  })
})

describe('caller rules', () => {
  it('refuses a sovereign method to a coworker with the route, and serves it to the owner and a wizard', async () => {
    await expect(productionCall(service, caller(), 'production.designate', { productionReady: false, note: 'x' })).rejects.toThrow(/owner's decision.*agents\.report/)
    await expect(productionCall(service, caller(), 'production.waive', { findingId: 'f', reason: 'r', scope: 's', owner: 'o', expiresAt: '2030-01-01' })).rejects.toThrow(/only the owner's control credential or a wizard tab/)
    await expect(productionCall(service, caller(), 'production.drift', { enabled: true })).rejects.toThrow(/owner's decision/)
    const drift = await productionCall(service, WIZARD, 'production.drift', { enabled: true, onChange: 'audit' }) as { drift: { enabled: boolean; onChange: string } }
    expect(drift.drift).toMatchObject({ enabled: true, onChange: 'audit' })
    expect(await productionCall(service, OWNER, 'production.designate', { productionReady: true, environmentId: 'env-a', note: 'launch' })).toMatchObject({ designation: { productionReady: true, environmentId: 'env-a' } })
  })

  it('lets a local model read only status, findings and the registry, and a read-only conversation no mutation or artifact', async () => {
    const local = caller({ local: true })
    expect(await productionCall(service, local, 'production.status', {})).toMatchObject({ projectId: 'project-a', gate: { state: expect.any(String) } })
    expect(await productionCall(service, local, 'production.registry', { controlId: 'C03' })).toMatchObject({ id: 'C03' })
    await expect(productionCall(service, local, 'production.audit', {})).rejects.toThrow(/not for a local model/)
    await expect(productionCall(service, local, 'production.runs', {})).rejects.toThrow(/not for a local model/)
    const readOnly = caller({ readOnly: true })
    await expect(productionCall(service, readOnly, 'production.audit', {})).rejects.toThrow(/read-only or planning conversation/)
    await expect(productionCall(service, readOnly, 'production.report', {})).rejects.toThrow(/returns audit artifacts/)
    expect(await productionCall(service, readOnly, 'production.runs', {})).toEqual([])
  })

  it('refuses unknown arguments, another project, and names what the method takes', async () => {
    await expect(productionCall(service, caller(), 'production.audit', { everything: true })).rejects.toThrow(/does not accept everything; it takes environmentId, controls, full/)
    await expect(productionCall(service, caller(), 'production.audit', { projectId: 'project-b' })).rejects.toThrow(/does not accept projectId/)
    await expect(productionCall(service, caller(), 'production.audit', { controls: ['C99'] })).rejects.toThrow(/Unknown control ids: C99/)
  })

  it('keeps profile changes that widen or narrow the audit for the owner; a coworker records facts as assumptions', async () => {
    await expect(productionCall(service, caller(), 'production.profile.update', { scope: { disabledControls: [{ controlId: 'C03', reason: 'no' }] } })).rejects.toThrow(/only the owner or a wizard tab may/)
    const profile = await productionCall(service, caller(), 'production.profile.update', { facts: { analytics: true } }) as { facts: { analytics: { status: string; source: string } } }
    expect(profile.facts.analytics).toMatchObject({ status: 'assumed', source: 'assumption' })
  })
})

describe('audit, review answers, fix tasks, waivers (fake checks)', () => {
  it('runs an audit from a coworker, blocks on the FAIL, answers the review item, files a medium task on request, waives as the owner', async () => {
    const runId = await audited()
    const status = await productionCall(service, caller(), 'production.status', {}) as { gate: { state: string; reasons: string[] }; results: Array<{ controlId: string; status: string; humanReview: Array<{ id: string }> }>; openFindings: Array<{ id: string; taskId: string | null }> }
    expect(status.gate.state).toBe('BLOCKED')
    expect(status.results.find(result => result.controlId === 'C01')).toMatchObject({ status: 'NEEDS_HUMAN_REVIEW', humanReview: [{ id: 'C01:legal-adequacy' }] })
    // The high finding was filed by the audit itself.
    expect(status.openFindings[0]!.taskId).toBe('task-1')

    await expect(productionCall(service, caller(), 'production.review.answer', { itemId: 'C01:legal-adequacy', answer: 'confirmed' })).rejects.toThrow(/owner's decision/)
    await expect(productionCall(service, OWNER, 'production.review.answer', { itemId: 'C01:nope', answer: 'confirmed' })).rejects.toThrow(/No human-review item C01:nope/)
    await expect(productionCall(service, OWNER, 'production.review.answer', { itemId: 'C01:legal-adequacy', answer: 'maybe' })).rejects.toThrow(/confirmed or rejected/)
    const answer = await productionCall(service, OWNER, 'production.review.answer', { projectId: 'project-a', itemId: 'C01:legal-adequacy', answer: 'confirmed', note: 'read by counsel' })
    expect(answer).toMatchObject({ itemId: 'C01:legal-adequacy', answer: 'confirmed', answeredBy: 'owner', runId })
    const after = await productionCall(service, caller(), 'production.status', {}) as typeof status
    expect(after.results.find(result => result.controlId === 'C01')).toMatchObject({ status: 'PASS', humanReview: [{ answer: 'confirmed', note: 'read by counsel' }] })

    // A wizard is the owner: it waives even a failure its own run found, and the waiver records who and why.
    const findingId = after.openFindings[0]!.id
    const mine = await audited(WIZARD)
    expect(mine).toBeTruthy()
    await expect(productionCall(service, caller(), 'production.waive', { findingId, reason: 'accepted', scope: 'site', owner: 'ops', expiresAt: '2099-01-01T00:00:00Z' })).rejects.toThrow(/owner's decision/)
    const waiver = await productionCall(service, WIZARD, 'production.waive', { findingId, reason: 'accepted risk', scope: 'site', owner: 'ops', expiresAt: '2099-01-01T00:00:00Z' })
    expect(waiver).toMatchObject({ findingId, reason: 'accepted risk', grantedBy: { kind: 'wizard', agentSessionId: 'wizard-1', title: 'Wizard' } })
    // The waived FAIL no longer blocks; the open owner questions of the seeded profile still need review.
    const gate = service.gate('project-a')
    expect(gate).toMatchObject({ state: 'NEEDS_REVIEW', activeWaivers: 1, openCriticalOrHigh: 0, humanReviewPending: 0 })
    expect(gate.reasons.every(reason => reason.startsWith('Owner question open'))).toBe(true)
  })

  it('reads the report and evidence bounded and masked for a writable caller', async () => {
    const runId = await audited()
    const report = await productionCall(service, caller(), 'production.report', {}) as { runId: string; text: string; truncated: boolean }
    expect(report).toMatchObject({ runId, truncated: false })
    expect(report.text).toMatch(/C16/)
    const json = await productionCall(service, caller(), 'production.report', { runId, format: 'json' }) as { text: string }
    expect(JSON.parse(json.text)).toMatchObject({ run: { id: runId } })
    await expect(productionCall(service, caller(), 'production.evidence', { runId, evidenceId: 'nope' })).rejects.toThrow(/No evidence nope/)
    const run = await productionCall(service, caller(), 'production.run', { runId }) as { status: string; events: unknown[]; steps: unknown[] }
    expect(run.status).toBe('completed')
    expect(run.events.length).toBeGreaterThan(0)
  })

  it('refuses a verification while a run is active instead of folding it into a plain audit', async () => {
    await audited()
    const [found] = service.findings('project-a', {})
    const hang = deferred()
    await service.stop()
    const { factory } = fakeBrowserFactory()
    const slow = scriptedCheck('C16', 'storage', async () => { await hang.promise; return outcome('storage', 'PASS') })
    service = createProductionService({
      store: temp.store, userData: temp.dir, interpreter: recordingPorts(), board: fakeBoard(), projectRoot: () => null, checks: [slow], ownerId: 'owner-test-3',
      gitHead: async () => 'c0ffee0000000000000000000000000000000000', browserFactory: policy => factory(policy),
      browserAvailability: async () => ({ available: true, engine: 'playwright-chromium', reason: null }),
      fingerprint: async () => fingerprint({ registryVersion: REGISTRY.version }), adapters: () => ({ mail: null, commerce: null, storage: null }),
      discovery: false, runCommand: null, readPublic: null, leaseTtlMs: 5_000,
    })
    await productionCall(service, caller(), 'production.audit', { controls: ['C16'] })
    await expect(productionCall(service, caller(), 'production.verify', { findingIds: [found!.id] })).rejects.toThrow(/Verification needs its own run.*ask again when it has finished/)
    await expect(productionCall(service, caller(), 'production.retest', { findingIds: [found!.id] })).rejects.toThrow(/A re-test needs its own run/)
    hang.resolve()
    await service.runner.idle()
  })

  it('files a medium finding only on request and never changes its status', async () => {
    const medium = scriptedCheck('C16', 'storage', () => outcome('storage', 'WARN', [finding('C16', 'storage', 'listing', { severity: 'medium' })]))
    await service.stop()
    const { factory } = fakeBrowserFactory()
    service = createProductionService({
      store: temp.store, userData: temp.dir, interpreter: recordingPorts(), board: fakeBoard(), projectRoot: () => null, checks: [medium], ownerId: 'owner-test-2',
      gitHead: async () => 'c0ffee0000000000000000000000000000000000', browserFactory: policy => factory(policy),
      browserAvailability: async () => ({ available: true, engine: 'playwright-chromium', reason: null }),
      fingerprint: async () => fingerprint({ registryVersion: REGISTRY.version }), adapters: () => ({ mail: null, commerce: null, storage: null }),
      discovery: false, runCommand: null, readPublic: null, leaseTtlMs: 5_000,
    })
    const started = await productionCall(service, caller(), 'production.audit', { controls: ['C16'] }) as { run: { id: string } }
    await service.runner.idle()
    const [listed] = service.findings('project-a', {})
    expect(listed).toMatchObject({ severity: 'medium', taskId: null })
    expect(started.run.id).toBeTruthy()
    const filed = await productionCall(service, caller(), 'production.tasks.create', { findingIds: [listed!.id] })
    expect(filed).toEqual([{ findingId: listed!.id, taskId: 'task-1', created: true, reopened: false }])
    expect(service.findings('project-a', {})[0]).toMatchObject({ status: 'open', taskId: 'task-1' })
  })
})
