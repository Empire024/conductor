import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpec } from '../shared/models'
import { ConductorDatabase } from './database'
import { MEMORY_PROTOCOL } from './memory'
import type { CoworkerBriefingOptions } from './agent-collaboration-store'
import { COWORKER_OPENED_PREFIX } from './coworker-autoclose'
import { CONTEXT_RESET, OUTAGE_NUDGES, FINISH_HINT, MEMORY_HEADING, LOCAL_ASSIST_HINT, SHELL_HYGIENE_HINT, TurnBriefings, handoffNudge, SUCCESSION_HINT, SUCCESSION_PERCENT, SUCCESSION_TURNS, successionNudge, coworkerHint } from './turn-briefing'

const roots: string[] = [], databases: ConductorDatabase[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

function fixture(provider: AgentSpec['provider'] = 'claude', native?: { id?: string }) {
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
  // `native` stands in for the structured state's nativeSessionId; a second instance on the same
  // database is the next app launch.
  const launch = () => new TurnBriefings({ database, coworkers, control, machine, ...(native ? { nativeSession: () => native.id } : {}), now: () => new Date(Date.UTC(2026, 8, 21, 12, 0, tick++)).toISOString() })
  const briefings = launch()
  const starting = (runtimeId: string) => briefings.observe(spec, { runtimeId, data: { type: 'session', phase: 'starting' } })
  return { database, project, spec, remember, coworkers, control, briefings, starting, launch }
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
    expect(f.coworkers.mock.calls[0]![1]).toEqual({ since: undefined, workOnly: true, guidance: true, leases: expect.any(Map) })
    // The prompt above was composed before its process existed; this is that process.
    f.starting('runtime-1')

    const second = f.briefings.compose(f.spec, 'Fix the checkout tax total now', 'item-2', 'runtime-1')
    expect(second).toBe('COWORKERS delta')
    expect(second).not.toContain('CONTROL for agent-one')
    expect(f.coworkers.mock.calls[1]![1]).toEqual({ since: '2026-09-21T12:00:00.000Z', workOnly: true, guidance: false, leases: expect.any(Map) })

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
    // The adapter announces its own start a second time; the same process is not a new one.
    f.starting('runtime-2')
    expect(f.briefings.compose(f.spec, 'Still on the checkout tax', 'item-4', 'runtime-2')).toBe('COWORKERS delta')

    // Compaction keeps a summary, not the text.
    f.briefings.observe(f.spec, { runtimeId: 'runtime-2', data: { type: 'notice', message: 'compacted', payload: { [CONTEXT_RESET]: true } } })
    const compacted = f.briefings.compose(f.spec, 'And the checkout tax after compaction', 'item-5', 'runtime-2')
    for (const block of STATIC) expect(compacted).toContain(block)
    expect(compacted).toContain('stale cart totals')
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

  it('tells Claude once per runtime to write scripts with Write and not to sleep-poll', () => {
    const f = fixture('claude')
    expect(f.briefings.compose(f.spec, 'Run the tests', 'item-1', '')).toContain(SHELL_HYGIENE_HINT)
    expect(SHELL_HYGIENE_HINT).toContain('Write tool')
    expect(SHELL_HYGIENE_HINT).toContain('git.ship.status({waitSeconds})')
    f.starting('runtime-1')
    expect(f.briefings.compose(f.spec, 'Again', 'item-2', 'runtime-1')).not.toContain(SHELL_HYGIENE_HINT)
    const codex = fixture('codex')
    expect(codex.briefings.compose(codex.spec, 'Run the tests', 'item-1', '')).not.toContain(SHELL_HYGIENE_HINT)
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

  it('tells a coworker a controller opened, once per runtime, to finish itself when done', () => {
    const owner = fixture()
    expect(owner.briefings.compose(owner.spec, 'Build it', 'item-1', '')).not.toContain(FINISH_HINT)
    const f = fixture()
    f.database.setSetting(COWORKER_OPENED_PREFIX + f.spec.id, 'controller')
    expect(f.briefings.compose(f.spec, 'Build it', 'item-1', '')).toContain(FINISH_HINT)
    expect(FINISH_HINT).toBe('When your work is delivered and reported, end with agents.finish({}) so your tab and CLI are released.')
    f.starting('runtime-1')
    expect(f.briefings.compose(f.spec, 'Again', 'item-2', 'runtime-1')).not.toContain(FINISH_HINT)
  })

  it('names the controller a coworker reports to, and how, once per runtime', () => {
    const f = fixture()
    const controller = vi.fn((id: string) => ({ id, title: 'Swarm lead' }))
    const briefings = new TurnBriefings({ database: f.database, controller })
    f.database.setSetting(COWORKER_OPENED_PREFIX + f.spec.id, 'agent-lead')
    const first = briefings.compose(f.spec, 'Build it', 'item-1', '')
    expect(first).toContain(coworkerHint({ id: 'agent-lead', title: 'Swarm lead' }))
    expect(first).toContain('You are a coworker of "Swarm lead" (agent-lead). Report results with report (agents.report({text})')
    expect(first).toContain('send_message to agent-lead')
    expect(first).toContain(FINISH_HINT)
    expect(controller).toHaveBeenCalledWith('agent-lead')
    expect(briefings.compose(f.spec, 'Again', 'item-2', '')).not.toContain('coworker of')
    // Without a title it still names the controller by id.
    expect(coworkerHint({ id: 'agent-lead' })).toMatch(/^You are a coworker of agent-lead\. /)
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

// conductor-task:gap-H12
describe('a resumed provider session keeps what it was told', () => {
  const session = (f: ReturnType<typeof fixture>, runtimeId: string, nativeSessionId?: string, phase: 'starting' | 'idle' = 'starting') =>
    f.briefings.observe(f.spec, { runtimeId, nativeSessionId, data: { type: 'session', phase, ...(phase === 'idle' && nativeSessionId ? { nativeSessionId } : {}) } })

  it('does not resend the static block or a memory to a new process on the same provider session', () => {
    const native: { id?: string } = {}
    const f = fixture('claude', native)
    f.remember('The checkout tax total is computed from stale cart totals', ['checkout', 'tax'])
    const first = f.briefings.compose(f.spec, 'Investigate the checkout tax bug', 'item-1', '')
    for (const block of STATIC) expect(first).toContain(block)
    session(f, 'runtime-1')
    // The runtime names its provider session once it has one.
    native.id = 'thread-1'
    session(f, 'runtime-1', 'thread-1', 'idle')

    // A resume, a reconnect: a new process on thread-1.
    session(f, 'runtime-2', 'thread-1')
    expect(f.briefings.compose(f.spec, 'Continue with the checkout tax', 'item-2', 'runtime-2')).toBe('COWORKERS delta')
    // A caller that already knows the new runtime, without a lifecycle event.
    expect(f.briefings.compose(f.spec, 'Still the checkout tax', 'item-3', 'runtime-3')).toBe('COWORKERS delta')

    // Compaction still forgets.
    f.briefings.observe(f.spec, { runtimeId: 'runtime-3', data: { type: 'notice', message: 'compacted', payload: { [CONTEXT_RESET]: true } } })
    const compacted = f.briefings.compose(f.spec, 'The checkout tax after compaction', 'item-4', 'runtime-3')
    for (const block of STATIC) expect(compacted).toContain(block)
    expect(compacted).toContain('stale cart totals')
  })

  it('briefs afresh when the runtime turns out to hold another provider session', () => {
    const native: { id?: string } = { id: 'thread-1' }
    const f = fixture('codex', native)
    f.briefings.compose(f.spec, 'Start the work', 'item-1', '')
    session(f, 'runtime-1', 'thread-1', 'idle')
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-2', 'runtime-1')).toBe('COWORKERS delta')
    // Codex had no saved rollout and started a new thread in its place.
    native.id = 'thread-2'
    session(f, 'runtime-2', 'thread-1')
    session(f, 'runtime-2', 'thread-2', 'idle')
    const fresh = f.briefings.compose(f.spec, 'Keep going', 'item-3', 'runtime-2')
    for (const block of STATIC) expect(fresh).toContain(block)
    // A new process whose conversation is not known yet is a new conversation.
    native.id = undefined
    const unknown = f.briefings.compose(f.spec, 'Keep going', 'item-4', 'runtime-3')
    for (const block of STATIC) expect(unknown).toContain(block)
  })

  it('keeps the ledger across an app restart for Claude and Codex, not for a provider whose resume is not relied on', () => {
    const native: { id?: string } = { id: 'thread-1' }
    const f = fixture('claude', native)
    f.remember('The checkout tax total is computed from stale cart totals', ['checkout', 'tax'])
    f.briefings.compose(f.spec, 'Investigate the checkout tax bug', 'item-1', '')
    session(f, 'runtime-1', 'thread-1', 'idle')
    f.briefings.compose(f.spec, 'Keep going', 'item-2', 'runtime-1')

    // The next launch resumes thread-1.
    expect(f.launch().compose(f.spec, 'Continue with the checkout tax', 'item-3', '')).toBe('COWORKERS delta')
    // A launch whose conversation resumes another provider session starts over.
    native.id = 'thread-9'
    const other = f.launch().compose(f.spec, 'Continue with the checkout tax', 'item-4', '')
    for (const block of STATIC) expect(other).toContain(block)

    const grok = fixture('grok', { id: 'grok-1' })
    grok.briefings.compose(grok.spec, 'Start', 'item-1', '')
    session(grok, 'runtime-1', 'grok-1')
    session(grok, 'runtime-1', 'grok-1', 'idle')
    session(grok, 'runtime-2', 'grok-1')
    expect(grok.briefings.compose(grok.spec, 'Resumed', 'item-2', 'runtime-2')).toContain(MEMORY_PROTOCOL)
    expect(grok.launch().compose(grok.spec, 'After a restart', 'item-3', '')).toContain(MEMORY_PROTOCOL)
  })

  it('restates the static block when the control credential it carried changed', () => {
    const f = fixture('claude', { id: 'thread-1' })
    f.briefings.compose(f.spec, 'Start the work', 'item-1', 'runtime-1')
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-2', 'runtime-1')).toBe('COWORKERS delta')
    f.control.mockImplementation((target: AgentSpec) => `CONTROL for ${target.id} on a new endpoint`)
    const rotated = f.briefings.compose(f.spec, 'Keep going', 'item-3', 'runtime-1')
    expect(rotated).toContain('CONTROL for agent-one on a new endpoint')
    expect(rotated).toContain(MEMORY_PROTOCOL)
    expect(f.briefings.compose(f.spec, 'Keep going', 'item-4', 'runtime-1')).toBe('COWORKERS delta')
  })

  it('hands the coworker log the leases this provider session was told about, and forgets them with it', () => {
    const f = fixture('claude', { id: 'thread-1' })
    const known: string[][] = []
    f.coworkers.mockImplementation((_id: string, options: CoworkerBriefingOptions) => {
      known.push([...options.leases!.keys()])
      options.leases!.set('agent-two|src/a.ts|edit', { path: 'src/a.ts', agent: 'Two', intent: 'edit' })
      return 'COWORKERS delta' as const
    })
    f.briefings.compose(f.spec, 'Start', 'item-1', 'runtime-1')
    f.briefings.compose(f.spec, 'Again', 'item-2', 'runtime-1')
    const [first, second] = f.coworkers.mock.calls.map(call => call[1].leases)
    expect(second).toBe(first)
    // Kept for the next launch too.
    f.launch().compose(f.spec, 'After a restart', 'item-3', '')
    expect(known).toEqual([[], ['agent-two|src/a.ts|edit'], ['agent-two|src/a.ts|edit']])
    f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: { type: 'notice', message: 'compacted', payload: { [CONTEXT_RESET]: true } } })
    expect(first!.size).toBe(0)
  })
})

// conductor-task:main-brain-succession
describe('telling a main brain when to pass itself on', () => {
  it('gives a main brain the succession line once per runtime, from the message it became one', () => {
    const f = fixture()
    // A conversation that is not (yet) a main brain is not told.
    expect(f.briefings.compose(f.spec, 'Plan the batch', 'item-1', '', { turns: 1 })).not.toContain(SUCCESSION_HINT)
    f.starting('runtime-1')
    // It opened coworkers: from its next message on it is a controller.
    expect(f.briefings.compose(f.spec, 'Dispatch the workers', 'item-2', 'runtime-1', { mainBrain: true, turns: 2 })).toContain(SUCCESSION_HINT)
    expect(f.briefings.compose(f.spec, 'Next report', 'item-3', 'runtime-1', { mainBrain: true, turns: 3 })).not.toContain(SUCCESSION_HINT)
    // A new process has forgotten it.
    f.starting('runtime-2')
    expect(f.briefings.compose(f.spec, 'Resumed', 'item-4', 'runtime-2', { mainBrain: true, turns: 4 })).toContain(SUCCESSION_HINT)
    expect(SUCCESSION_HINT).toContain('agents.handoff({handoff, successor:true})')
  })

  it('nudges a main brain once, as a notice in its tab, when it passes the turn or context threshold', () => {
    const f = fixture()
    const notice = vi.fn()
    const send = (turns: number, percent?: number, nudged = false) => f.briefings.compose(f.spec, 'Report from W3', 'item-' + turns, 'runtime-1', { mainBrain: true, turns, ...(percent === undefined ? {} : { percent }), nudged, notice })
    f.starting('runtime-1')
    expect(send(SUCCESSION_TURNS - 1, SUCCESSION_PERCENT - 1)).not.toContain('Conductor: this main conversation')
    expect(notice).not.toHaveBeenCalled()
    const crossed = send(SUCCESSION_TURNS)
    expect(crossed).toContain(successionNudge(SUCCESSION_TURNS))
    expect(notice).toHaveBeenCalledExactlyOnceWith(successionNudge(SUCCESSION_TURNS))
    // Never again for this conversation: not later, not in a new runtime, not after a compaction.
    expect(send(SUCCESSION_TURNS + 5, 70)).not.toContain('Conductor: this main conversation')
    f.starting('runtime-2')
    expect(f.briefings.compose(f.spec, 'Later', 'item-x', 'runtime-2', { mainBrain: true, turns: 40, notice })).not.toContain('Conductor: this main conversation')
    expect(notice).toHaveBeenCalledOnce()
  })

  it('crosses on context as well as turns, and trusts the notice already in the timeline after a restart', () => {
    const early = fixture(), notice = vi.fn()
    expect(early.briefings.compose(early.spec, 'Report', 'item-1', '', { mainBrain: true, turns: 3, percent: SUCCESSION_PERCENT, notice })).toContain(successionNudge(3, SUCCESSION_PERCENT))
    expect(notice).toHaveBeenCalledOnce()
    // A fresh process (an app restart) has no memory of it, but the timeline has the notice.
    const restarted = fixture(), again = vi.fn()
    expect(restarted.briefings.compose(restarted.spec, 'Report', 'item-1', '', { mainBrain: true, turns: 30, percent: 50, nudged: true, notice: again })).not.toContain('Conductor: this main conversation')
    expect(again).not.toHaveBeenCalled()
    // A worker at the same figures gets only the ordinary context bands, never the succession nudge.
    const worker = fixture(), quiet = vi.fn()
    expect(worker.briefings.compose(worker.spec, 'Work', 'item-1', '', { turns: 30, percent: 50, notice: quiet })).not.toContain('Conductor: this main conversation')
    expect(quiet).not.toHaveBeenCalled()
  })

  it('points a main brain at the successor form of the ordinary context-band nudge', () => {
    expect(handoffNudge(60, true)).toContain('agents.handoff({handoff, successor:true})')
    expect(handoffNudge(60)).not.toContain('successor')
  })
})

describe('outage nudges (harness gap H16)', () => {
  const outage = (kind: 'classifierUnavailable' | 'hookUnreachable') => ({ type: 'notice' as const, message: 'outage', payload: { [kind]: { tool: 'Bash', count: 1 } } })

  it('tells the next message once per runtime what to do about a classifier outage or an unreachable hook', () => {
    const f = fixture()
    f.briefings.compose(f.spec, 'Start the work', 'item-1', '')
    f.starting('runtime-1')
    // Nothing happened: no nudge.
    expect(f.briefings.compose(f.spec, 'Continue', 'item-2', 'runtime-1')).not.toContain('Retry')
    // An outage notice is updated in place many times; the next message carries its rule once.
    for (let i = 0; i < 3; i++) f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: outage('classifierUnavailable') })
    const told = f.briefings.compose(f.spec, 'Continue', 'item-3', 'runtime-1')
    expect(told.split(OUTAGE_NUDGES.classifierUnavailable)).toHaveLength(2)
    expect(told).toContain('Retry the same call in 60 s; if it is still refused after 3 tries, request_permission for it.')
    // A second outage in the same runtime is not news; a different kind is.
    f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: outage('classifierUnavailable') })
    f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: outage('hookUnreachable') })
    const next = f.briefings.compose(f.spec, 'Continue', 'item-4', 'runtime-1')
    expect(next).not.toContain(OUTAGE_NUDGES.classifierUnavailable)
    expect(next).toContain(OUTAGE_NUDGES.hookUnreachable)
    // A compaction forgets it, so the rule is sent again with the next outage.
    f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: { type: 'notice', message: 'compacted', payload: { [CONTEXT_RESET]: true } } })
    f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: outage('classifierUnavailable') })
    expect(f.briefings.compose(f.spec, 'Continue', 'item-5', 'runtime-1')).toContain(OUTAGE_NUDGES.classifierUnavailable)
  })

  it('remembers across an app restart that a resumed session was already told', () => {
    const native = { id: 'native-1' }
    const f = fixture('claude', native)
    f.briefings.compose(f.spec, 'Start the work', 'item-1', 'runtime-1')
    f.briefings.observe(f.spec, { runtimeId: 'runtime-1', data: outage('hookUnreachable') })
    expect(f.briefings.compose(f.spec, 'Continue', 'item-2', 'runtime-1')).toContain(OUTAGE_NUDGES.hookUnreachable)
    const next = f.launch()
    // The outage is seen before the new launch has sent this conversation anything.
    next.observe(f.spec, { runtimeId: 'runtime-2', data: outage('hookUnreachable') })
    expect(next.compose(f.spec, 'Continue', 'item-3', 'runtime-2')).not.toContain(OUTAGE_NUDGES.hookUnreachable)
  })
})
