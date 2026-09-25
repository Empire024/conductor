import { describe, expect, it } from 'vitest'
import { cappedStatus, conductorNoteGuard, STATUS_TEXT_LIMIT, stripConductorNotes } from './visible-text'

describe('visible local model text (VR7 row 19)', () => {
  it('cuts text where an imitated Conductor note starts, even split across deltas', () => {
    const out: string[] = []
    const guard = conductorNoteGuard(delta => out.push(delta))
    for (const delta of ['The answer is 42.', ' [Cond', 'uctor: The assistant has provided', ' a direct answer.]', ' more']) guard.push(delta)
    guard.flush()
    expect(out.join('')).toBe('The answer is 42.')
    expect(guard.cut).toBe(true)
    expect(stripConductorNotes('Done. [Conductor: x] [Conductor: y]')).toBe('Done.')
    expect(stripConductorNotes('No notes [Cond here')).toBe('No notes [Cond here')
  })

  it('releases a held-back tail that turned out not to be a note', () => {
    const out: string[] = []
    const guard = conductorNoteGuard(delta => out.push(delta))
    guard.push('see [Con'); guard.push('text] fine'); guard.flush()
    expect(out.join('')).toBe('see [Context] fine')
  })

  it('caps status text with one ellipsis', () => {
    const out: string[] = []
    const status = cappedStatus(delta => out.push(delta))
    for (let index = 0; index < 100; index++) status('0123456789')
    expect(out.join('').length).toBeLessThanOrEqual(STATUS_TEXT_LIMIT + 2)
    expect(out.join('').endsWith(' …')).toBe(true)
  })
})
