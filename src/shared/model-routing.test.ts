import { describe, expect, it } from 'vitest'
import { capabilityRank, coordinatorEffort } from './model-routing'

describe('coordinator routing', () => {
  it('ranks frontier capability ahead of cheap and local routes', () => {
    expect(capabilityRank('codex', 'gpt-6-astra')).toBeGreaterThan(capabilityRank('codex', 'gpt-5.6-sol'))
    expect(capabilityRank('codex', 'gpt-5.6-sol')).toBeGreaterThan(capabilityRank('local', 'local/qwen3.5-9b'))
  })
  it('uses high reasoning when the chosen coordinator supports it', () => {
    expect(coordinatorEffort(['low', 'high'], 'low')).toBe('high')
  })
})
