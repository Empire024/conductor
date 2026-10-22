import { describe, expect, it } from 'vitest'
import { composerEnterSends } from './composer-enter'

const key = (over: Partial<Parameters<typeof composerEnterSends>[0]> = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over })

describe('composerEnterSends', () => {
  it('sends on Enter when no turn is running', () => {
    expect(composerEnterSends(key(), false)).toBe(true)
    expect(composerEnterSends(key({ ctrlKey: true }), false)).toBe(true)
  })

  it('keeps Enter a newline while a turn runs, so a line break never steers a half-written message', () => {
    // 2026-10-22: "cooking oil for rosin room 165 - 190 max" went into the running turn when the
    // owner ended the line, and the whole message was sent again a minute later.
    expect(composerEnterSends(key(), true)).toBe(false)
  })

  it('sends into a running turn only on Ctrl+Enter or Cmd+Enter', () => {
    expect(composerEnterSends(key({ ctrlKey: true }), true)).toBe(true)
    expect(composerEnterSends(key({ metaKey: true }), true)).toBe(true)
  })

  it('never sends on Shift+Enter, Alt+Enter or another key', () => {
    for (const running of [false, true]) {
      expect(composerEnterSends(key({ shiftKey: true }), running)).toBe(false)
      expect(composerEnterSends(key({ shiftKey: true, ctrlKey: true }), running)).toBe(false)
      expect(composerEnterSends(key({ altKey: true }), running)).toBe(false)
      expect(composerEnterSends(key({ key: 'a', ctrlKey: true }), running)).toBe(false)
    }
  })
})
