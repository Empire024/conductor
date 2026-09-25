import { describe, expect, it } from 'vitest'
import { ownerIsTyping, TYPING_PAUSE_MS, waitForOwnerPause } from './owner-typing'

describe('owner typing pause', () => {
  it('counts a recent key in Conductor or recent input anywhere as typing', () => {
    expect(ownerIsTyping({ lastKeyAt: () => 10_000, systemIdleSeconds: () => 30 }, 10_000 + TYPING_PAUSE_MS - 1)).toBe(true)
    expect(ownerIsTyping({ lastKeyAt: () => 10_000, systemIdleSeconds: () => 30 }, 10_000 + TYPING_PAUSE_MS)).toBe(false)
    expect(ownerIsTyping({ lastKeyAt: () => 0, systemIdleSeconds: () => 0 }, 50_000)).toBe(true)
    expect(ownerIsTyping({ lastKeyAt: () => 0, systemIdleSeconds: () => undefined }, 50_000)).toBe(false)
  })
  it('waits for the pause, and gives up rather than stealing focus from someone who keeps typing', async () => {
    let clock = 0
    let lastKey = 0
    const sleep = async (ms: number): Promise<void> => { clock += ms }
    // Typing until t=2000, then still.
    const typing = { lastKeyAt: () => { if (clock <= 2000) lastKey = clock; return lastKey }, systemIdleSeconds: () => undefined }
    await expect(waitForOwnerPause(typing, { now: () => clock, sleep })).resolves.toBe(true)
    expect(clock).toBeGreaterThanOrEqual(2000 + TYPING_PAUSE_MS)
    clock = 0
    const endless = { lastKeyAt: () => clock, systemIdleSeconds: () => undefined }
    await expect(waitForOwnerPause(endless, { now: () => clock, sleep, limitMs: 10_000 })).resolves.toBe(false)
  })
})
