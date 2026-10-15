import { describe, expect, it } from 'vitest'
import { capabilityRank, coordinatorEffort } from './model-routing'

describe('coordinator routing', () => {
  it('ranks frontier capability ahead of cheap and local routes', () => {
    expect(capabilityRank('codex', 'gpt-6-astra')).toBeGreaterThan(capabilityRank('codex', 'gpt-5.6-sol'))
    expect(capabilityRank('codex', 'gpt-5.6-sol')).toBeGreaterThan(capabilityRank('local', 'local/qwen3.5-9b'))
  })
  it('ranks by tier name, not by generation prefix', () => {
    expect(capabilityRank('codex', 'gpt-6-astra')).toBe(3)
    expect(capabilityRank('codex', 'gpt-6-luna')).toBe(1)
    expect(capabilityRank('codex', 'gpt-6-sol')).toBe(1)
    expect(capabilityRank('codex', 'gpt-5.6-terra')).toBe(2)
    expect(capabilityRank('codex', 'gpt-6')).toBe(3)
    expect(capabilityRank('claude', 'opus[1m]')).toBe(3)
  })
  it('ranks the newest Claude tiers, and never Fable above Opus (no Fable spend by default)', () => {
    expect(capabilityRank('claude', 'claude-opus-5-5')).toBe(3)
    expect(capabilityRank('claude', 'claude-sonnet-5-5')).toBe(2)
    expect(capabilityRank('claude', 'claude-haiku-5-5')).toBe(1)
    expect(capabilityRank('claude', 'claude-fable-5-1')).toBe(2)
    expect(capabilityRank('claude', 'fable')).toBeLessThan(capabilityRank('claude', 'opus'))
    expect(capabilityRank('codex', 'gpt-6.1-sol')).toBe(3)
  })
  it('uses high reasoning when the chosen coordinator supports it', () => {
    expect(coordinatorEffort(['low', 'high'], 'low')).toBe('high')
  })
})
