import { describe, expect, it } from 'vitest'
import { Bird, Cpu, Orbit, Shell, Sparkles } from 'lucide-react'
import { localModelGlyph } from './ProviderIcon'
import {
  LOCAL_DOLPHIN_X1_8B,
  LOCAL_ORNITH_9B,
  LOCAL_QWEN_35B,
  LOCAL_QWEN_9B
} from '../../../shared/local-models'

describe('localModelGlyph', () => {
  it('gives each shipped local model its own distinct icon', () => {
    expect(localModelGlyph(LOCAL_ORNITH_9B).icon).toBe(Bird)
    expect(localModelGlyph(LOCAL_QWEN_9B).icon).toBe(Orbit)
    expect(localModelGlyph(LOCAL_QWEN_35B).icon).toBe(Sparkles)
    expect(localModelGlyph(LOCAL_DOLPHIN_X1_8B).icon).toBe(Shell)
    const icons = [LOCAL_ORNITH_9B, LOCAL_QWEN_9B, LOCAL_QWEN_35B, LOCAL_DOLPHIN_X1_8B].map(id => localModelGlyph(id).icon)
    expect(new Set(icons).size).toBe(4)
  })

  it('falls back to the generic Cpu glyph for an unrecognized local model', () => {
    expect(localModelGlyph('local/some-future-build').icon).toBe(Cpu)
    expect(localModelGlyph(undefined).icon).toBe(Cpu)
  })
})
