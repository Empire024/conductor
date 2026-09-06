import { describe, expect, it } from 'vitest'
import { CODEX_MODELS } from './agent-manager'

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
})
