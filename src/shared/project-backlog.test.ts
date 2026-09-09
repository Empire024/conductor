import { describe, expect, it } from 'vitest'
import { heaviestProjectTaskWeight, projectTaskWeightDefaults, projectTaskWeights } from './project-backlog'
import type { ProjectTaskWeight } from './project-backlog'

describe('heaviestProjectTaskWeight', () => {
  it('defaults to medium for an empty selection', () => {
    expect(heaviestProjectTaskWeight([])).toBe('medium')
  })
  it('picks the single weight given for one task', () => {
    for (const weight of projectTaskWeights) expect(heaviestProjectTaskWeight([weight])).toBe(weight)
  })
  it('lets the heaviest task in a mixed batch win, regardless of order', () => {
    expect(heaviestProjectTaskWeight(['light', 'heavy', 'medium'])).toBe('heavy')
    expect(heaviestProjectTaskWeight(['heavy', 'light'])).toBe('heavy')
    expect(heaviestProjectTaskWeight(['medium', 'light'])).toBe('medium')
    expect(heaviestProjectTaskWeight(['light', 'light'])).toBe('light')
  })
})

describe('projectTaskWeightDefaults', () => {
  it('offers a real model and effort for every weight on every dispatchable provider', () => {
    for (const provider of ['codex', 'claude'] as const) {
      for (const weight of projectTaskWeights) {
        const suggestion = projectTaskWeightDefaults[provider][weight]
        expect(suggestion.model).toBeTruthy()
        expect(suggestion.effort).toBeTruthy()
      }
    }
  })
  it('suggests a strictly higher effort for a heavy task than a light one, per provider', () => {
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3 }
    for (const provider of ['codex', 'claude'] as const) {
      const heavy = projectTaskWeightDefaults[provider].heavy, light = projectTaskWeightDefaults[provider].light
      expect(rank[heavy.effort]).toBeGreaterThan(rank[light.effort]!)
      expect(heavy.model).not.toBe(light.model)
    }
  })
  it('never suggests the same model for heavy and light work', () => {
    const weights: ProjectTaskWeight[] = ['heavy', 'medium', 'light']
    for (const provider of ['codex', 'claude'] as const) {
      const models = weights.map(weight => projectTaskWeightDefaults[provider][weight].model)
      expect(new Set(models).size).toBe(models.length)
    }
  })
})
