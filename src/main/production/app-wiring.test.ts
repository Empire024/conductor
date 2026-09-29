import { describe, expect, it } from 'vitest'
import { evaluationCloudTurn, type EvaluationTurn } from './app-wiring'

describe('the interpreter cloud port', () => {
  it('opens the evaluation turn in the audited project and maps its usage', async () => {
    const calls: Array<Parameters<EvaluationTurn>> = []
    const turn: EvaluationTurn = async (...args) => { calls.push(args); return { answer: '{"rationale":"ok"}', tokens: 1_200, costUsd: 0.01, inputTokens: 1_000 } }
    const signal = new AbortController().signal
    const answer = await evaluationCloudTurn(turn)({ provider: 'claude', model: 'sonnet' }, 'prompt text', signal, 500, { projectId: 'project-audited' })
    expect(calls).toHaveLength(1)
    const [key, prompt, passedSignal, options] = calls[0]!
    expect(key).toEqual({ provider: 'claude', model: 'sonnet' })
    expect(prompt).toEqual({ system: '', user: 'prompt text' })
    expect(passedSignal).toBe(signal)
    // The audited project, never "the first open project": the tab appears beside the audit.
    expect(options).toEqual({ maxTokens: 500, scope: { projectId: 'project-audited' } })
    expect(answer).toEqual({ text: '{"rationale":"ok"}', inputTokens: 1_000, outputTokens: 200, costUsd: 0.01 })
  })

  it('counts a turn that reports no input split as all input, never negative output', async () => {
    const turn: EvaluationTurn = async () => ({ answer: '{}', tokens: null, costUsd: null, inputTokens: null })
    expect(await evaluationCloudTurn(turn)({ provider: 'codex', model: 'm' }, 'p', new AbortController().signal, 100, { projectId: 'p' }))
      .toEqual({ text: '{}', inputTokens: 0, outputTokens: 0, costUsd: null })
  })
})
