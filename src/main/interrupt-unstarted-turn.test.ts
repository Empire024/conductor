import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { ProviderCapabilities } from '../shared/structured-agent'

// Haftheme 2026-10-01: an approval interrupted a successor's first turn 0.3 s after it was sent,
// before the Claude CLI had started it. The CLI never sent a result for a turn it never ran, so
// the tab stayed 'interrupting' through a restart and refused every message.
const capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: false, plans: true, permissions: ['default'], effort: [], models: [], limitations: [] }
const settings = { permission: 'default' as const, plan: false }
const retry = '[Conductor] approved: Bash(bash prod.sh) (once); retry it now.'
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.unstubAllEnvs() })

/** onInterrupt decides what the runtime does with an interrupt: settle the turn as never started,
 *  or (a runtime that lost the turn) nothing at all. */
function harness(onInterrupt: (emit: AdapterOptions['emit']) => void) {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-unstarted-'))
  const database = new ConductorDatabase(join(root, 'state.db'))
  const project = database.upsertProject(root, 'Unstarted')
  const workspace = database.listSessions(project.id)[0]!
  const submitted: string[] = []
  const interrupts = { count: 0 }
  const factory = (_provider: unknown, options: AdapterOptions): ProviderAdapter => ({
    provider: 'claude', capabilities,
    async start() { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-unstarted' } }) },
    async submit(text: string) { submitted.push(text) },
    async respond() {},
    async interrupt() { interrupts.count++; options.emit({ data: { type: 'session', phase: 'interrupting' } }); onInterrupt(options.emit) },
    dispose() {}
  })
  const manager = new StructuredSessions(database, () => 'unused', () => {}, factory)
  const spec = { id: 'agent-unstarted', projectId: project.id, sessionId: workspace.id, provider: 'claude' as const, title: 'Successor', cwd: root }
  manager.ensure(spec)
  cleanups.push(() => {
    manager.dispose(); database.close()
    rmSync(realpathSync(root), { recursive: true, force: true })
  })
  const state = () => database.structured.snapshot(spec.id)!
  return { manager, id: spec.id, submitted, interrupts, state }
}

describe('a turn interrupted before the provider started it', () => {
  it('settles at once, puts its message back ahead of the approved retry, and sends both when the stop was expedited', async () => {
    const h = harness(emit => emit({ data: { type: 'session', phase: 'interrupted', notStarted: true } }))
    await h.manager.submit(h.id, 'Successor brief', settings)
    await h.manager.queue(h.id, retry, settings)
    expect(h.state().queuedPrompts).toHaveLength(1)
    await h.manager.interrupt(h.id, true)
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2))
    // One turn of its own: the brief the provider never ran, then the approved retry.
    expect(h.submitted[1]!.indexOf('Successor brief')).toBeGreaterThanOrEqual(0)
    expect(h.submitted[1]!.indexOf('Successor brief')).toBeLessThan(h.submitted[1]!.indexOf(retry))
    expect(h.state().phase).toBe('running')
    expect(h.state().queuedPrompts ?? []).toEqual([])
    expect(h.state().items.some(item => item.data.type === 'notice' && /had not started this turn/.test(item.data.message))).toBe(true)
  })

  it('holds the unrun message above the composer after a plain Stop, with the rest of the queue', async () => {
    const h = harness(emit => emit({ data: { type: 'session', phase: 'interrupted', notStarted: true } }))
    await h.manager.submit(h.id, 'Successor brief', settings)
    await h.manager.queue(h.id, retry, settings)
    await h.manager.interrupt(h.id, false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.state().phase).toBe('interrupted')
    expect(h.submitted).toEqual(['Successor brief'])
    expect(h.state().queuedPrompts?.map(prompt => prompt.text)).toEqual(['Successor brief', retry])
    // Nothing is sent from the held queue until the owner sends or clears it.
    await expect(h.manager.submit(h.id, 'Owner message', settings)).resolves.toBeUndefined()
  })

  it('ends a turn stuck in interrupting when it is interrupted again and the runtime still does not end it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness(() => undefined)
    await h.manager.submit(h.id, 'Successor brief', settings)
    await h.manager.interrupt(h.id, false)
    expect(h.state().phase).toBe('interrupting')
    // The first stop is not second-guessed: a runtime may take its time to send the result.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.state().phase).toBe('interrupting')
    await expect(h.manager.steerOrStart(h.id, 'Hello', settings)).rejects.toThrow(/still stopping its last turn/)
    // Asked again (agents.interrupt): the runtime gets its chance, then the turn is ended here.
    await h.manager.interrupt(h.id, false)
    expect(h.interrupts.count).toBe(2)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(h.state().phase).toBe('interrupted')
    expect(h.state().items.some(item => item.data.type === 'notice' && /did not end the interrupted turn/.test(item.data.message))).toBe(true)
    vi.useRealTimers()
    await h.manager.steerOrStart(h.id, 'Hello', settings)
    expect(h.submitted.at(-1)).toContain('Hello')
  })
})
