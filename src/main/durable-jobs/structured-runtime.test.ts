import { describe, expect, it } from 'vitest'
import type { DurableJob, DurableJobStage } from '../../shared/durable-jobs'
import type { ProjectRecord, SessionRecord } from '../../shared/models'
import type { SessionProjection, SessionSettings } from '../../shared/structured-agent'
import { localStopPayload, type LocalStopReport } from '../../shared/local-stop'
import { clampPrompt, localModelId, observeProjection, readLocalExecution, structuredStageRuntime } from './structured-runtime'

const report = (reason: LocalStopReport['reason'], filesChanged: string[] = []): LocalStopReport => ({ reason, detail: `${reason} detail`, rounds: 3, hardLimit: 16, context: { usedTokens: 1, capacityTokens: 2, reserveTokens: 0, windowTokens: 2, percent: 50, estimated: false }, compactions: 0, recoveredTokens: 0, loopWarnings: 0, filesChanged, commandsRun: 0, excludedOutputChars: 0, timeline: [] })

const projection = (phase: SessionProjection['phase'], items: SessionProjection['items']): SessionProjection => ({ sessionId: 's', runtimeId: 'r', phase, sequence: 9, items, settings: { permission: 'accept-edits' } as SessionProjection['settings'], title: 't', archived: false, truncated: false })
const item = (sequence: number, data: SessionProjection['items'][number]['data']) => ({ id: `i${sequence}`, runtimeId: 'r', sequence, timestamp: '', data }) as SessionProjection['items'][number]

describe('structured stage runtime helpers', () => {
  it('reads the stop report, last answer and changed files from the durable projection', () => {
    const observation = observeProjection(projection('completed', [
      item(1, { type: 'text', role: 'assistant', text: 'old', mode: 'snapshot' }),
      item(2, { type: 'changes', changes: [{ path: 'src/a.ts' } as never] }),
      item(3, { type: 'text', role: 'assistant', text: 'final answer', mode: 'snapshot' }),
      item(4, { type: 'notice', message: 'stop', payload: localStopPayload(report('completed', ['src/b.ts'])) })
    ]), undefined)
    expect(observation).toMatchObject({ phase: 'completed', stopSequence: 4, stop: { reason: 'completed' }, lastAnswer: 'final answer' })
    expect(observation.filesChanged.sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(observeProjection(null, undefined).phase).toBe('missing')
  })

  it('reads the pending tool call from the local session checkpoint and never reads a corrupt one as clean', () => {
    const key = `local-session-checkpoint:${JSON.stringify(['p', 'agent_1'])}`
    const settings = new Map([[key, JSON.stringify({ version: 1, state: { execution: { lifecycle: 'running', nextAction: 'go', pending: { id: 'c1', name: 'run_command', arguments: '{}' } } } })]])
    expect(readLocalExecution(k => settings.get(k) ?? null, 'p', 'agent_1')).toEqual({ lifecycle: 'running', nextAction: 'go', pending: { id: 'c1', name: 'run_command', arguments: '{}' } })
    settings.set(key, '{broken')
    expect(readLocalExecution(k => settings.get(k) ?? null, 'p', 'agent_1')?.lifecycle).toBe('failed')
    expect(readLocalExecution(() => null, 'p', 'agent_1')).toBeUndefined()
  })

  it('keeps the closing instructions when a prompt is too long and keeps the full local model id', () => {
    const prompt = `${'x'.repeat(100_000)}\nJOB STATUS line`
    const clamped = clampPrompt(prompt)
    expect(clamped.length).toBeLessThanOrEqual(60_000)
    expect(clamped.endsWith('JOB STATUS line')).toBe(true)
    expect(localModelId('local/qwen3.6-35b-a3b')).toBe('local/qwen3.6-35b-a3b')
    expect(localModelId('qwen')).toBe('local/qwen')
  })

  it('opens a research stage with the research grant and every other kind without it', async () => {
    const saved: SessionSettings[] = []
    const runtime = structuredStageRuntime({
      sessions: { ensure: () => ({ available: true }), submit: async () => undefined, interrupt: async () => undefined },
      database: {
        structured: { snapshot: () => projection('idle', []), spec: () => null, update: (_id, values) => { if (values.settings) saved.push(values.settings) } },
        getSetting: () => null, getProject: () => ({ id: 'p', path: 'C:/work', name: 'Work' }) as ProjectRecord, upsertProject: () => ({ id: 'p', path: 'C:/work', name: 'Work' }) as ProjectRecord,
        listSessions: () => [{ id: 'w' } as SessionRecord], createSession: () => { throw new Error('unused') }
      }
    })
    const job = { id: 'job_1', projectId: 'p', cwd: 'C:/work', title: 'Job', model: { model: 'local/qwen' } } as DurableJob
    const stage = (kind: DurableJobStage['kind']) => ({ id: 's', title: 'Stage', objective: 'x', kind }) as DurableJobStage
    for (const kind of ['research', 'implement', 'investigate'] as const) await runtime.open({ job, stage: stage(kind), title: kind })
    expect(saved.map(settings => [settings.localResearch, settings.permission, settings.localGit])).toEqual([[true, 'read-only', false], [false, 'accept-edits', false], [false, 'read-only', false]])
  })
})
