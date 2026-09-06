import { describe, expect, it } from 'vitest'
import { getAgentSoundPlan } from './agent-sounds'

describe('agent notification sounds', () => {
  it('stays silent when sounds are disabled', () => {
    expect(getAgentSoundPlan('off', 'complete')).toEqual([])
  })

  it('gives soft completion a warm rising cadence', () => {
    const tones = getAgentSoundPlan('soft', 'complete')
    expect(tones).toHaveLength(3)
    expect(tones.map((tone) => tone.frequency)).toEqual([...tones.map((tone) => tone.frequency)].sort((a, b) => a - b))
    expect(Math.max(...tones.map((tone) => tone.gain))).toBeLessThanOrEqual(0.02)
  })

  it('keeps the minimal profile to one quiet tone per cue', () => {
    expect(getAgentSoundPlan('minimal', 'complete')).toHaveLength(1)
    expect(getAgentSoundPlan('minimal', 'question')).toHaveLength(1)
    expect(getAgentSoundPlan('minimal', 'input')).toHaveLength(1)
  })
})
