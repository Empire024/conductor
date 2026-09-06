import { describe, expect, it } from 'vitest'
import { classifyPerformance, classifyTabUiWeight, formatMemoryMb } from './performance-metrics'

describe('performance meter labels', () => {
  it('uses CPU, frame rate, and blocking work to classify the suite', () => {
    expect(classifyPerformance({ cpuPercent: 8, fps: 60, longTaskMs: 0 })).toBe('smooth')
    expect(classifyPerformance({ cpuPercent: 42, fps: 60, longTaskMs: 0 })).toBe('busy')
    expect(classifyPerformance({ cpuPercent: 4, fps: 30, longTaskMs: 0 })).toBe('strained')
  })

  it('classifies tab UI footprint without inventing per-tab memory figures', () => {
    expect(classifyTabUiWeight(100)).toBe('light')
    expect(classifyTabUiWeight(600)).toBe('medium')
    expect(classifyTabUiWeight(1800)).toBe('heavy')
  })

  it('formats suite memory compactly', () => {
    expect(formatMemoryMb(512.4)).toBe('512 MB')
    expect(formatMemoryMb(1536)).toBe('1.5 GB')
  })
})
