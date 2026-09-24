import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpec } from '../shared/models'
import { ConductorDatabase } from './database'
import { MEMORY_PROTOCOL } from './memory'
import type { CoworkerBriefingOptions } from './agent-collaboration-store'
import { CONTEXT_RESET, MEMORY_HEADING, LOCAL_ASSIST_HINT, TurnBriefings, handoffNudge } from './turn-briefing'

const roots: string[] = [], databases: ConductorDatabase[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function fixture(provider: AgentSpec['provider'] = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'conductor-turn-briefing-')); roots.push(root)
  const database = new ConductorDatabase(join(root, 'conductor.db')); databases.push(database)
  const project = database.upsertProject(join(root, 'project'), 'Project')
  const session = database.listSessions(project.id)[0]!
  const spec: AgentSpec = { id: 'agent-one', projectId: project.id, sessionId: session.id, provider, title: 'Builder', cwd: join(root, 'project') }
  database.upsertAgent(spec, 'running')
  const remember = (gist: string, cues: string[]) => database.remember({ projectId: project.id, kind: 'semantic', gist, cues, source: 'human' })
  const coworkers = vi.fn((_id: string, options: CoworkerBriefingOptions) => options.guidance ? 'COWORKERS with guidance' : 'COWORKERS delta')
  const control = vi.fn((target: AgentSpec) => `CONTROL for ${target.id}`)
  const machine = vi.fn(() => 'MACHINE limits: one local model server at a time')
  let tick = 0
  const briefings = new TurnBriefings({ database, coworkers, control, machine, now: () => new Date(Date.UTC(2026, 8, 21, 12, 0, tick++)).toISOString() })
  const starting = (runtimeId: string) => briefings.observe(spec, { runtimeId, data: { type: 'session', phase: 'starting' } })
  return { database, project, spec, remember, coworkers, control, briefings, starting }
}

const STATIC = [MEMORY_PROTOCOL, 'Conductor project tasks: feature-list.md', 'MACHINE limits: one local model server at a time', 'CONTROL for agent-one']

describe('what a native runtime is told, and how often', () => {
  it('sends the static briefing once per runtime, then only what is new', () => {
    const f = fixture()
    f.remember('The checkout tax total is computed from stale cart totals', ['checkout', 'tax'])
    const first = f.briefings.compose(f.spec, 'Investigate the checkout tax bug', 'item-1', '')
    expect(first).toContain(`${MEMORY_HEADING}\n- [semantic] The checkout tax total`)
    for (const block of STATIC) expect(first).toContain(block)
    expect(first).toContain('COWORKERS with guidance')
    expect(f.coworkers.mock.calls[0]![1]).toEqual({ since: undefined, workOnly: true, guidance: true })
    // The prompt above was composed before its process existed; this is that process.
    f.starting('runtime-1')

    const second = f.briefings.compose(f.spec, 'Fix the checkout tax total now', 'item-2', 'runtime-1')
    expect(second).toBe('COWORKERS delta')
    expect(f.control).toHaveBeenCalledTimes(1)
    expect(f.coworkers.mock.calls[1]![1]).toEqual({ since: '2026-09-21T12:00:00.000Z', workOnly: true, guidance: false })

    // A memory learned since is new to this runtime; the one it already holds is not repeated.
    f.remember('Tax rounding happens in cart-totals.ts', ['tax', 'rounding'])
    const third = f.briefings.compose(f.spec, 'Where is tax rounding done?', 'item-3', 'runtime-1')
    expect(third).toContain('cart-totals.ts')
    expect(third).not.toContain('stale cart totals')
    for (const block of STATIC) expect(third).not.toContain(block)

    // The turn ledger records exactly what each message carried.
    expect(f.database.listMemoryRecalls(f.spec.id).map(recall => [recall.itemId, recall.memories.map(memory => memory.gist)])).toEqual([
      ['item-1', ['The checkout tax total is computed from stale cart totals']],
      ['item-3', ['Tax rounding happens in cart-totals.ts']]
    ])
  })

  it('does not recall anything for a prompt that names nothing', () => {
    const f = fixture()
    f.remember('The checkout tax total is computed from stale cart totals', ['checkout', 'tax'])
    const recall = vi.spyOn(f.database, 'recall')
    f.briefings.compose(f.spec, 'Investigate the checkout tax bug', 'item-1', 'runtime-1')
    expect(f.briefings.compose(f.spec, 'y', 'item-2', 'runtime-1')).toBe('COWORKERS delta')
    expect(recall).toHaveBeenCalledTimes(1)
  })

  it('restates everything for a new process and again after a compaction', () => {
    const f = fixture()
    f.remember('The checkout tax total is computed from stale cart totals', ['checkout', 'tax'])
    f.briefings.compose(f.spec, 'Investigate the checkout tax bug', 'item-1', '')
    f.starting('runtime-1')
    expect(f.briefings.compose(f.spec, 'Look at the checkout tax again', 'item-2', 'runtime-1')).not.toContain(MEMORY_PROTOCOL)

    // A resume or reconnect is a new process: it knows nothing.
    f.starting('runtime-2')
    const resumed = f.briefings.compose(f.spec, 'Continue with the checkout tax', 'item-3', 'runtime-2')
    for (const block of STATIC) expect(resumed).toContain(block)
    expect(resumed).toContain('stale cart totals')
    expect(resumed).toContain('COWORKERS with guidance')
    expect(f.control).toHaveBeenCalledTimes(2)
    // The adapter announces its own start a second time; the same process is not a new one.
    f.starting('runtime-2')
    expect(f.briefings.compose(f.spec, 'Still on the checkout tax', 'item-4', 'runtime-2')).toBe('COWORKERS delta')

    // Compaction keeps a summary, not the text.
    f.briefings.observe(f.spec, { runtimeId: 'runtime-2', data: { type: 'notice', message: 'compacted', payload: { [CONTEXT_RESET]: true } } })
    const compacted = f.briefings.compose(f.spec, 'And the checkout tax after compaction', 'item-5', 'runtime-2')
    for (const block of STATIC) expect(compacted).toContain(block)
    expect(compacted).toContain('stale cart totals')
    expect(f.control).toHaveBeenCalledTimes(3)
    // An ordinary notice is not a reset.
    f.briefings.observe(f.spec, { runtimeId: 'runtime-2', data: { type: 'notice', message: 'diagnostic', payload: { stderr: 'x' } } })
    expect(f.briefings.compose(f.spec, 'One more checkout tax question', 'item-6', 'runtime-2')).toBe('COWORKERS delta')
  })

  it('treats a runtime id the caller already knows as the runtime to brief', () => {
    const f = fixture()
    // The adapter was connected before any prompt (a tab opened, a session resumed).
    f.starting('runtime-1')
    const first = f.briefings.compose(f.spec, 'Start the work', 'item-1', 'runtime-1')
    for (const block of STATIC) expect(first).toContain(block)
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-2', 'runtime-1')).toBe('COWORKERS delta')
    // The caller names a different runtime without a lifecycle event in between.
    const rebriefed = f.briefings.compose(f.spec, 'Keep going', 'item-3', 'runtime-9')
    for (const block of STATIC) expect(rebriefed).toContain(block)
  })

  it('nudges a conversation to hand off once per context band per runtime', () => {
    const f = fixture()
    f.briefings.compose(f.spec, 'Start the work', 'item-1', 'runtime-1', { percent: 12 })
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-2', 'runtime-1', { percent: 31 })).toBe('COWORKERS delta')
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-3', 'runtime-1', { percent: 62.4 })).toBe(`COWORKERS delta\n\n${handoffNudge(62)}`)
    expect(handoffNudge(62)).toContain('agents.handoff')
    // The same band is not repeated; the next band is said once too.
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-4', 'runtime-1', { percent: 71 })).toBe('COWORKERS delta')
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-5', 'runtime-1', { percent: 88 })).toBe(`COWORKERS delta\n\n${handoffNudge(88)}`)
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-6', 'runtime-1', { percent: 93 })).toBe('COWORKERS delta')
    // Compaction or a new process empties the context the bands measure.
    f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: { type: 'notice', message: 'compacted', payload: { [CONTEXT_RESET]: true } } })
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-7', 'runtime-1', { percent: 61 })).toContain(handoffNudge(61))
    // No usage report, no nudge; a local model has no handoff to call.
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-8', 'runtime-1')).toBe('COWORKERS delta')
    const local = fixture('local')
    local.briefings.compose(local.spec, 'Start', 'item-1', 'runtime-1', { percent: 90 })
    expect(local.briefings.compose(local.spec, 'Keep going', 'item-2', 'runtime-1', { percent: 95 })).toBe('')
  })

  it('tells Claude and Codex once per runtime to hand long output to the local model', () => {
    const f = fixture('codex')
    const first = f.briefings.compose(f.spec, 'Run the tests', 'item-1', '')
    expect(first).toContain(`MACHINE limits: one local model server at a time ${LOCAL_ASSIST_HINT}`)
    expect(LOCAL_ASSIST_HINT).toContain('run_and_summarize')
    expect(LOCAL_ASSIST_HINT.length).toBeLessThan(200)
    f.starting('runtime-1')
    expect(f.briefings.compose(f.spec, 'Again', 'item-2', 'runtime-1')).not.toContain(LOCAL_ASSIST_HINT)
    const grok = fixture('grok')
    expect(grok.briefings.compose(grok.spec, 'Run the tests', 'item-1', '')).not.toContain(LOCAL_ASSIST_HINT)
  })

  it('gives a local model only its memory lines: no heading, no nudge, never a control credential', () => {
    const f = fixture('local')
    // Nothing recalled on a fresh runtime means nothing at all, not a standing instruction.
    expect(f.briefings.compose(f.spec, 'paste back the prompt you received', 'item-0', '')).toBe('')
    f.remember('The checkout tax total is computed from stale cart totals', ['checkout', 'tax'])
    const first = f.briefings.compose(f.spec, 'Investigate the checkout tax bug', 'item-1', '')
    expect(first).toBe('- [semantic] The checkout tax total is computed from stale cart totals')
    expect(first).not.toContain(MEMORY_HEADING)
    f.starting('runtime-1')
    expect(f.briefings.compose(f.spec, 'Fix the checkout tax total', 'item-2', 'runtime-1')).toBe('')
    expect(f.database.listMemoryRecalls(f.spec.id).map(recall => recall.itemId)).toEqual(['item-1'])
    expect(f.control).not.toHaveBeenCalled()
    expect(f.coworkers).not.toHaveBeenCalled()
  })

  it('never lets coordination or the ledger stop a message', () => {
    const f = fixture()
    f.remember('The checkout tax total is computed from stale cart totals', ['checkout', 'tax'])
    f.coworkers.mockImplementation(() => { throw new Error('collaboration store is closed') })
    vi.spyOn(f.database, 'recordMemoryRecall').mockImplementation(() => { throw new Error('ledger unavailable') })
    const first = f.briefings.compose(f.spec, 'Investigate the checkout tax bug', 'item-1', '')
    expect(first).toContain('stale cart totals')
    for (const block of STATIC) expect(first).toContain(block)
    expect(first).not.toContain('COWORKERS')
  })
})
