import { describe, expect, it } from 'vitest'
import {
  AGENT_RESIZE_ACTIVITY_SUPPRESSION_MS,
  extendResizeActivitySuppression,
  normalizeAgentOutputSignal,
  shouldSignalAgentActivity,
  shouldSignalAgentOutput
} from './agent-activity'

describe('agent PTY activity gating', () => {
  it('suppresses terminal redraw output immediately after a resize', () => {
    const now = 10_000
    const suppressUntil = extendResizeActivitySuppression(0, now)

    expect(suppressUntil).toBe(now + AGENT_RESIZE_ACTIVITY_SUPPRESSION_MS)
    expect(shouldSignalAgentActivity(suppressUntil, now + 100)).toBe(false)
    expect(shouldSignalAgentActivity(suppressUntil, suppressUntil)).toBe(true)
  })

  it('extends an active window across repeated resize events', () => {
    const first = extendResizeActivitySuppression(0, 10_000)
    const second = extendResizeActivitySuppression(first, 10_500)

    expect(second).toBe(10_500 + AGENT_RESIZE_ACTIVITY_SUPPRESSION_MS)
    expect(shouldSignalAgentActivity(second, first + 1)).toBe(false)
  })

  it('never turns idle PTY repaint bytes into agent work', () => {
    expect(shouldSignalAgentOutput(false, 0, 10_000)).toBe(false)
    expect(shouldSignalAgentOutput(true, 0, 10_000)).toBe(true)
    expect(shouldSignalAgentOutput(true, 11_000, 10_000)).toBe(false)
  })

  it('gives repeated terminal paint a stable semantic fingerprint', () => {
    expect(normalizeAgentOutputSignal('\u001b[2K⠋ Thinking… 00:01')).toBe(
      normalizeAgentOutputSignal('\u001b[2K⠙ Thinking… 00:02')
    )
    expect(normalizeAgentOutputSignal('\u001b[2K⠋')).toBe('')
    expect(normalizeAgentOutputSignal('I found the failing checkout test.')).not.toBe('')
  })
})
