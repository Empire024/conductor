import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalStopReport } from '../../shared/local-stop.ts'
import type { SessionProjection, TimelineItem } from '../../shared/structured-agent.ts'
import { DurableJobsServiceImpl } from './index.ts'
import { LocalGenerationGate } from './server-lifecycle.ts'
import { DurableJobStore } from './store.ts'
import { FakeRuntime, FakeWorktrees, tick, until } from './test-fakes.ts'
import { handoffPort, supervisionPorts, type DurableJobsWiringOptions } from './wiring.ts'

const services: DurableJobsServiceImpl[] = []
const roots: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** contextRolloverFraction inside a stage, through the real controller, watchdog port and handoff
 *  port: the watch reads the conversation's usage items (the fake token counter here). */
describe('in-stage context rollover through the job controller', () => {
  it('rolls a stage that crosses the fraction mid-stage into a fresh context exactly once and continues', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-rollover-'))
    roots.push(root)
    const store = new DurableJobStore(':memory:')
    /** The fake token counter: the context each conversation's newest request occupied. */
    const tokens = new Map<string, number>()
    const stopReport = (usedTokens: number): LocalStopReport => ({ reason: 'interrupted', detail: 'The turn was stopped.', rounds: 6, hardLimit: 40, context: { usedTokens, capacityTokens: 28_672, reserveTokens: 4_096, windowTokens: 32_768, percent: usedTokens / 286.72, estimated: false }, compactions: 0, recoveredTokens: 0, loopWarnings: 0, filesChanged: ['notes.md'], commandsRun: 2, excludedOutputChars: 0, timeline: [] })
    class CountingRuntime extends FakeRuntime {
      // The real local agent reports the context it had reached when a turn is stopped.
      override async interrupt(id: string): Promise<void> {
        await super.interrupt(id)
        const session = this.sessions.get(id)!
        session.observation = { ...session.observation, report: stopReport(tokens.get(id) ?? 0) }
      }
    }
    const runtime = new CountingRuntime([{ kind: 'hang' }])
    const projection = (id: string): SessionProjection | null => {
      const used = tokens.get(id)
      const items: TimelineItem[] = used === undefined ? [] : [{ id: `${id}:usage`, runtimeId: 'r', sequence: used, timestamp: '', data: { type: 'usage', inputTokens: used - 200, outputTokens: 200, scope: 'message', source: 'provider' } }]
      return { sessionId: id, runtimeId: 'r', phase: 'running', sequence: used ?? 0, items, settings: { permission: 'accept-edits', plan: false }, title: 't', archived: false, truncated: false }
    }
    const wiring: DurableJobsWiringOptions = { store, snapshot: projection, modelConfig: () => ({ id: 'local/qwen', contextTokens: 32_768 }), probeHealth: async () => ({ healthy: true }), serverPorts: async () => { throw new Error('unused') }, endpointOverride: () => 'http://127.0.0.1:1', gate: new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null }), watchdog: { tickMs: 5 } }
    const service = new DurableJobsServiceImpl({ store, runtime, worktrees: new FakeWorktrees(), logRoot: root, projectPath: () => 'C:/p', sleep: tick, pollMs: 0, handoff: handoffPort(wiring), ...supervisionPorts(wiring) })
    services.push(service)
    const created = await service.create({ projectId: 'p', title: 'Long read', objective: 'Summarise every module', model: 'local/qwen', stages: [{ title: 'Summarise', objective: 'Summarise the modules into notes.md', completionCriteria: ['notes.md lists every module'] }] })
    await until(() => runtime.opened.length === 1 && service.get(created.id).stages[0]!.status === 'running')
    // Round by round the stage's context grows; below the fraction nothing happens.
    for (const used of [4_000, 12_000, 20_000, 22_900]) { tokens.set('agent_fake_1', used); await new Promise(resolve => setTimeout(resolve, 20)) }
    expect(runtime.sessions.get('agent_fake_1')!.interrupts).toBe(0)
    tokens.set('agent_fake_2', 3_000)
    tokens.set('agent_fake_1', 24_000)
    await until(() => service.get(created.id).status === 'completed')
    expect(runtime.opened).toEqual(['agent_fake_1', 'agent_fake_2'])
    expect(runtime.sessions.get('agent_fake_1')!.interrupts).toBe(1)
    expect(runtime.sessions.get('agent_fake_2')!.interrupts).toBe(0)
    expect(store.get(created.id).counters.contextRollovers).toBe(1)
    expect(runtime.prompts[1]).toContain('This is a fresh context')
    expect(runtime.prompts[1]).toMatch(/context rollover: the stage context reached 24000 tokens, past 70% of the 32768-token window/)
    expect(store.events(created.id).filter(event => event.data?.contextRollover === true)).toHaveLength(1)
  })
})
