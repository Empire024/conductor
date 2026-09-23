import { describe, expect, it } from 'vitest'
import type { SessionProjection } from '../../shared/structured-agent'
import { localStopPayload, type LocalStopReport } from '../../shared/local-stop'
import { clampPrompt, localModelId, observeProjection, readLocalExecution } from './structured-runtime'

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

  it('keeps the closing instructions when a prompt is too long and strips the provider prefix', () => {
    const prompt = `${'x'.repeat(100_000)}\nJOB STATUS line`
    const clamped = clampPrompt(prompt)
    expect(clamped.length).toBeLessThanOrEqual(60_000)
    expect(clamped.endsWith('JOB STATUS line')).toBe(true)
    expect(localModelId('local/qwen3.6-35b-a3b')).toBe('qwen3.6-35b-a3b')
    expect(localModelId('qwen')).toBe('qwen')
  })
})
