import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TargetFingerprint } from '../../shared/production'
import { createProductionService, type ProductionService } from './index'
import { REGISTRY } from './registry'
import { deferred, fakeBoard, fakeBrowserFactory, fingerprint, outcome, recordingPorts, scriptedCheck, seedProfile, tempStore, type TempStore } from './testkit'

/** Change-triggered runs: which commits start one, and how a newer commit replaces a queued one. */

let temp: TempStore
const services: ProductionService[] = []
beforeEach(() => { temp = tempStore(); seedProfile(temp.store, 'project-a', { designate: true }); seedProfile(temp.store, 'project-b', { designate: true }) })
afterEach(async () => { for (const service of services.splice(0)) await service.stop().catch(() => undefined); temp.close() })

const COMMIT = (n: number): string => `${String(n).padStart(4, '0')}${'a'.repeat(36)}`

function world() {
  const target = { value: fingerprint({ registryVersion: REGISTRY.version, commit: COMMIT(1) }) as TargetFingerprint }
  /** Files changed between two commits, by the commit that introduced them. */
  const commits = new Map<string, string[]>()
  const order: string[] = [COMMIT(1)]
  const diffs: Array<[string, string]> = []
  let hold: { promise: Promise<void> } | null = null
  const check = scriptedCheck('C13', 'accessibility', async context => { if (context.run.projectId === 'project-b' && hold) await hold.promise; return outcome('accessibility', 'PASS') })
  const { factory } = fakeBrowserFactory()
  const service = createProductionService({
    store: temp.store, userData: temp.dir, interpreter: recordingPorts(), board: fakeBoard(), projectRoot: () => null, checks: [check], ownerId: 'owner-A',
    gitHead: async () => target.value.commit,
    browserFactory: policy => factory(policy),
    browserAvailability: async () => ({ available: true, engine: 'playwright-chromium', reason: null }),
    fingerprint: async () => ({ ...target.value }),
    adapters: () => ({ mail: null, commerce: null, storage: null }),
    discovery: false, runCommand: null, readPublic: null, leaseTtlMs: 5_000,
    changedFiles: async (_projectId, from, to) => {
      diffs.push([from, to])
      const start = order.indexOf(from), end = order.indexOf(to)
      if (start < 0 || end < 0) return null
      return order.slice(start + 1, end + 1).flatMap(commit => commits.get(commit) ?? [])
    },
  })
  services.push(service)
  const commit = (files: string[]): string => { const id = COMMIT(order.length + 1); order.push(id); commits.set(id, files); target.value = { ...target.value, commit: id }; return id }
  return { service, target, commit, diffs, check, hold: (gate: { promise: Promise<void> } | null) => { hold = gate } }
}

async function baseline(w: ReturnType<typeof world>, projectId = 'project-a') {
  const started = await w.service.audit(projectId, { controls: ['C13'] })
  await w.service.runner.idle()
  expect(temp.store.run(started.run!.id).status).toBe('completed')
  return started.run!
}

describe('change-triggered production audits', () => {
  it('a commit of docs, scratch files and tests starts no run; a source commit does', async () => {
    const w = world()
    const first = await baseline(w)
    w.commit(['docs/production-agent.md', '.conductor-scratch/notes.json', 'src/cart.test.ts', 'README.md'])
    const docs = await w.service.detectChange('project-a')
    expect(docs.changes).toEqual(['code'])
    expect(docs.outcome).toMatchObject({ outcome: 'dropped', run: null })
    expect(docs.outcome!.outcome === 'dropped' && docs.outcome!.reason).toMatch(/touched only files no audit covers \(4 file/)
    expect(temp.store.runs('project-a')).toHaveLength(1)
    // A second docs commit still compares with the audited commit, and is still nothing.
    w.commit(['docs/other.md'])
    expect((await w.service.detectChange('project-a')).outcome!.outcome).toBe('dropped')
    expect(w.diffs.at(-1)).toEqual([first.fingerprint.commit, w.target.value.commit])
    // A theme file: the range now holds a covered file, so a change run starts.
    w.commit(['wp-content/themes/haf/functions.php'])
    const code = await w.service.detectChange('project-a')
    expect(code.outcome!.outcome).toBe('created')
    await w.service.runner.idle()
    expect(temp.store.runs('project-a')).toHaveLength(2)
  })

  it('an unknown commit range counts as covered (the old behaviour)', async () => {
    const w = world()
    await baseline(w)
    w.target.value = { ...w.target.value, commit: 'feedface00000000000000000000000000000000' }
    expect((await w.service.detectChange('project-a')).outcome!.outcome).toBe('created')
    await w.service.runner.idle()
  })

  it('while a run for an older commit is running, a docs commit adds nothing and a source commit queues one follow-up', async () => {
    const w = world()
    await baseline(w, 'project-b')
    const gate = deferred()
    w.hold(gate)
    w.commit(['src/app.php'])
    const running = await w.service.detectChange('project-b')
    expect(running.outcome!.outcome).toBe('created')
    const runId = running.outcome!.run!.id
    await waitFor(() => temp.store.run(runId).status === 'running')
    w.commit(['docs/a.md'])
    expect((await w.service.detectChange('project-b')).outcome).toMatchObject({ outcome: 'dropped', run: { id: runId } })
    expect(temp.store.run(runId).rerunRequested).toBeNull()
    w.commit(['src/other.php'])
    expect((await w.service.detectChange('project-b')).outcome).toMatchObject({ outcome: 'coalesced', run: { id: runId } })
    expect(temp.store.run(runId).rerunRequested).toMatchObject({ kind: 'change' })
    w.hold(null)
    gate.resolve()
    await w.service.runner.idle()
    await waitFor(() => temp.store.runs('project-b').length === 3)
    await w.service.runner.idle()
  })

  it('a queued change run that has not started is replaced by one for the newer commit', async () => {
    const w = world()
    await baseline(w, 'project-a')
    await baseline(w, 'project-b')
    // Project B's audit holds the runner, so project A's change runs stay queued.
    const gate = deferred()
    w.hold(gate)
    const busy = await w.service.audit('project-b', { controls: ['C13'] })
    await waitFor(() => temp.store.run(busy.run!.id).status === 'running')
    w.commit(['src/a.php'])
    const first = await w.service.detectChange('project-a')
    expect(first.outcome!.outcome).toBe('created')
    expect(temp.store.run(first.outcome!.run!.id).status).toBe('queued')
    w.commit(['package-lock.json'])
    const second = await w.service.detectChange('project-a')
    expect(second.outcome!.outcome).toBe('created')
    expect(second.outcome!.run!.id).not.toBe(first.outcome!.run!.id)
    expect(temp.store.run(first.outcome!.run!.id)).toMatchObject({ status: 'cancelled', rerunRequested: null })
    expect(temp.store.run(first.outcome!.run!.id).statusReason).toMatch(/Superseded by a newer change/)
    expect(temp.store.run(second.outcome!.run!.id)).toMatchObject({ status: 'queued', fingerprint: { commit: w.target.value.commit } })
    w.hold(null)
    gate.resolve()
    await w.service.runner.idle()
    expect(temp.store.run(second.outcome!.run!.id).status).toBe('completed')
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
