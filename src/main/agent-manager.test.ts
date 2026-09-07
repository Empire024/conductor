import { describe, expect, it } from 'vitest'
import { CODEX_EFFORTS, CODEX_MODELS } from './agent-manager'

describe('Codex model catalog', () => {
  it('shows Astra and the current model family instead of retired Codex models', () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual([
      'default',
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])
  })

  it('only exposes reasoning efforts accepted by Codex CLI configuration', () => {
    expect(CODEX_EFFORTS.map((effort) => effort.id)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh'])
    expect(CODEX_EFFORTS.some((effort) => effort.id === 'max')).toBe(false)
  })
})
