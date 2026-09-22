import { describe, expect, it } from 'vitest'
import { autoModeDenialMessage, autoModeDenialOf, autoModeDenialPayload, autoModeDenialSummary, parseAutoModeDenialReason } from './auto-mode-denial'

// The exact wording claude 2.1.280 puts in the tool_result of a tool its auto-mode classifier refused.
const denied = (reason: string): string => `Permission for this action was denied by the Claude Code auto mode classifier. Reason: [${reason}]. If you have other tasks that don't depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat.`

describe('claude auto-mode classifier denial text', () => {
  it('captures each bracketed reason the CLI is known to give', () => {
    for (const reason of ['Security Weaken', 'Create Unsafe Agents', 'Self-Modification', 'Permission Grant']) expect(parseAutoModeDenialReason(denied(reason))).toBe(reason)
  })

  it('accepts the CLI wording without brackets or a trailing sentence, and ignores anything else', () => {
    expect(parseAutoModeDenialReason('Permission for this action was denied by the Claude Code auto mode classifier. Reason: Security Weaken. Continue.')).toBe('Security Weaken')
    expect(parseAutoModeDenialReason('denied by the Claude Code auto mode classifier. Reason: Self-Modification')).toBe('Self-Modification')
    // The owner's own denial, a hook denial, and an ordinary failure are not classifier denials.
    expect(parseAutoModeDenialReason('Permission for this action has been denied. Reason: the user rejected it')).toBeUndefined()
    expect(parseAutoModeDenialReason('Error: ENOENT: no such file or directory')).toBeUndefined()
    expect(parseAutoModeDenialReason('')).toBeUndefined()
  })

  it('round-trips the notice payload and words the message so the owner blames the right decider', () => {
    const denial = { tool: 'Bash', reason: 'Security Weaken', toolUseId: 'toolu_1' }
    expect(autoModeDenialOf({ type: 'notice', message: autoModeDenialMessage(denial), payload: autoModeDenialPayload(denial) })).toEqual(denial)
    expect(autoModeDenialOf({ type: 'notice', message: autoModeDenialMessage(denial), payload: autoModeDenialPayload(denial, true) })).toEqual(denial)
    expect(autoModeDenialOf({ type: 'notice', message: 'Claude process diagnostic', payload: { stderr: 'x' } })).toBeUndefined()
    expect(autoModeDenialOf({ type: 'notice', message: 'no payload' })).toBeUndefined()
    expect(autoModeDenialOf({ type: 'text', role: 'assistant', text: 'x', mode: 'snapshot' })).toBeUndefined()
    expect(autoModeDenialMessage(denial)).toBe("Auto mode refused Bash (Security Weaken). The claude CLI's own classifier decided this, so Conductor could not show you a card. Switch this conversation to Edit to get an Allow card for such actions, or add a permission rule.")
    expect(autoModeDenialSummary(denial)).toBe('Auto mode refused Bash: Security Weaken')
  })
})
