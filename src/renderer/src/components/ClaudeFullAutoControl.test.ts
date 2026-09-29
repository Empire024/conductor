import { describe, expect, it } from 'vitest'
import { fullAutoSince } from './ClaudeFullAutoControl'

describe('fullAutoSince', () => {
  const at = '2026-09-29T08:00:00.000Z'
  const now = Date.parse(at)
  it('states when and how long ago the policy changed', () => {
    expect(fullAutoSince(at, now)).toMatch(/\(just now\)$/)
    expect(fullAutoSince(at, now + 25 * 60_000)).toMatch(/\(25 min ago\)$/)
    expect(fullAutoSince(at, now + 3 * 3_600_000)).toMatch(/\(3 h ago\)$/)
    expect(fullAutoSince(at, now + 5 * 86_400_000)).toMatch(/\(5 days ago\)$/)
  })
  it('omits a missing or invalid instant', () => {
    expect(fullAutoSince(undefined)).toBeUndefined()
    expect(fullAutoSince('not a date')).toBeUndefined()
  })
})
