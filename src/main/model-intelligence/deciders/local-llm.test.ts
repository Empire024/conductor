import { describe, expect, it } from 'vitest'
import type { LocalModelOutcome, LocalModelRequest, LocalModelRunner } from '../../local-assist/contract.ts'
import type { DecisionRequest } from '../../../shared/model-routing'
import { createLocalLlmDecider, localDecisionPrompt, parseLocalVerdict } from './local-llm'

const ids = ['allow', 'deny', 'escalate']
const request: DecisionRequest = { kind: 'approval', question: 'Allow npm test?', options: ids.map(id => ({ id, label: id })), state: { tool: 'Bash', command: 'npm test' }, impact: 'routine', requester: 'approval-gate' }
const runner = (outcome: LocalModelOutcome | Error): LocalModelRunner & { seen: LocalModelRequest[] } => {
  const seen: LocalModelRequest[] = []
  return { seen, ask: async (asked: LocalModelRequest) => { seen.push(asked); if (outcome instanceof Error) throw outcome; return outcome } }
}
const answer = (text: string): LocalModelOutcome => ({ ok: true, answer: { text, model: 'qwen3.5-9b', inputTokens: 300, outputTokens: 40, durationMs: 850 } })

describe('parseLocalVerdict', () => {
  it('reads a clean verdict and fills missing options with 0', () => {
    expect(parseLocalVerdict('{"probabilities":{"allow":0.9,"deny":0.1},"rationale":"Tests are routine."}', ids)).toEqual({ probabilities: { allow: 0.9, deny: 0.1, escalate: 0 }, rationale: 'Tests are routine.' })
  })
  it('strips think blocks, a template-opened think, code fences and prose', () => {
    const json = '{"probabilities":{"allow":1},"rationale":"ok"}'
    for (const text of [`<think>maybe {"not":"this"}</think>\n${json}`, `thinking without an opening tag</think>${json}`, `Here you go:\n\`\`\`json\n${json}\n\`\`\`\nDone.`, `Sure. ${json} Hope that helps.`])
      expect(parseLocalVerdict(text, ids)).toEqual({ probabilities: { allow: 1, deny: 0, escalate: 0 }, rationale: 'ok' })
  })
  it('names what is off', () => {
    expect(parseLocalVerdict('<think>still thinking', ids)).toBe('Reasoning never finished')
    expect(parseLocalVerdict('allow', ids)).toBe('No JSON object in the answer')
    expect(parseLocalVerdict('{"probabilities":{"allow":1,},"rationale":"x"}', ids)).toBe('The answer is not valid JSON')
    expect(parseLocalVerdict('{"rationale":"x"}', ids)).toBe('No probabilities object')
    expect(parseLocalVerdict('{"probabilities":{"allow":1}}', ids)).toBe('No rationale')
    expect(parseLocalVerdict('{"probabilities":{"yes":1},"rationale":"x"}', ids)).toBe('Unknown option id: yes')
    expect(parseLocalVerdict('{"probabilities":{"allow":"high"},"rationale":"x"}', ids)).toMatch(/between 0 and 1/)
    expect(parseLocalVerdict('{"probabilities":{"allow":90,"deny":10},"rationale":"x"}', ids)).toMatch(/between 0 and 1/)
    expect(parseLocalVerdict('{"probabilities":{"allow":0},"rationale":"x"}', ids)).toBe('Probabilities sum to zero')
    expect(parseLocalVerdict('{"probabilities":{"allow":0.5,"deny":0.2},"rationale":"x"}', ids)).toBe('Probabilities sum to 0.70, not 1')
  })
})

describe('local LLM decider', () => {
  it('asks the runner with a strict JSON prompt and returns the verdict', async () => {
    const fake = runner(answer('```json\n{"probabilities":{"allow":0.8,"deny":0.05,"escalate":0.15},"rationale":"Routine test run."}\n```'))
    const decider = createLocalLlmDecider(fake, { waitBudgetMs: 2000 })
    expect(decider.supports('approval') && decider.supports('classify') && !decider.supports('route')).toBe(true)
    const outcome = await decider.decide(request)
    expect(outcome).toEqual({ ok: true, verdict: { decider: 'local-llm:qwen3.5-9b', probabilities: { allow: 0.8, deny: 0.05, escalate: 0.15 }, rationale: 'Routine test run.', tokens: 340, elapsedMs: 850 } })
    expect(fake.seen[0]).toMatchObject({ maxTokens: 1024, waitBudgetMs: 2000, system: expect.stringContaining('{"probabilities"') })
    expect(JSON.parse(fake.seen[0]!.user)).toEqual(JSON.parse(localDecisionPrompt(request).user))
  })
  it('returns ok:false on a runner fallback, a throw, or garbage', async () => {
    expect(await createLocalLlmDecider(runner({ ok: false, reason: 'An interactive local turn holds the GPU' })).decide(request)).toEqual({ ok: false, decider: 'local-llm', reason: 'An interactive local turn holds the GPU' })
    expect(await createLocalLlmDecider(runner(new Error('socket hang up'))).decide(request)).toEqual({ ok: false, decider: 'local-llm', reason: 'socket hang up' })
    expect(await createLocalLlmDecider(runner(answer('I would allow it.'))).decide(request)).toEqual({ ok: false, decider: 'local-llm', reason: 'No JSON object in the answer' })
  })
})
