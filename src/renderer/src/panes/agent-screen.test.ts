import { describe, expect, it } from 'vitest'
import { extractAgentScreenSnapshot, joinWrappedTerminalRows } from './agent-screen'

describe('extractAgentScreenSnapshot', () => {
  it('reassembles xterm rows wrapped in the middle of words', () => {
    expect(joinWrappedTerminalRows([
      { text: 'I am using the OpenAI docs skill for t' },
      { text: 'hat check.', wrapped: true },
      { text: '' },
      { text: 'The exact model is not exposed in this ses' },
      { text: 'sion.', wrapped: true }
    ])).toBe('I am using the OpenAI docs skill for that check.\n\nThe exact model is not exposed in this session.')
  })

  it('keeps Codex tool history and status chrome out of the final response', () => {
    const screen = `> What's the model you're running, and effort?

I'll check what this session exposes.

Explored
  Read SKILL.md

Ran Get-ChildItem Env:
  Get-ChildItem: An item with the same key has already been added.

Workingst31 max · ~\\Conductor\\Untitled project 4 · 1 background terminal running · /ps to view · /stop to close

I'm Codex, based on GPT-6. The exact effort setting is not exposed in this session.
gpt-6-astra max · ~\\Conductor\\Untitled project 4`

    expect(extractAgentScreenSnapshot(screen, 'codex', "What's the model you're running, and effort?")).toMatchObject({
      body: "I'm Codex, based on GPT-6. The exact effort setting is not exposed in this session.",
      active: false,
      settled: true
    })
  })

  it('does not leak the Codex directory trust menu into assistant prose', () => {
    const screen = `Do you trust the contents of this directory?\n1. Yes, continue\n2. No, quit\nPress enter to continue`
    expect(extractAgentScreenSnapshot(screen, 'codex')).toEqual({ body: '', active: false, settled: false, interaction: 'directory_trust' })
  })

  it('does not leak the Claude folder safety menu into assistant prose', () => {
    const screen = `Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm`
    expect(extractAgentScreenSnapshot(screen, 'claude')).toEqual({ body: '', active: false, settled: false, interaction: 'directory_trust' })
  })

  it('turns a Claude full-screen limit response into clean prose', () => {
    const screen = `
 ▐▛███▛█   Claude Code v2.1.263
▝▜██████▀  Opus 5 (1M context) with xhigh effort · Claude Max
  C:\\work\\project

❯ [Conductor edit mode: Apply the requested edits.]

  Reply with exactly VISUAL_SMOKE_OK. Do not edit files or run commands.
  ⎿  You've hit your weekly limit · resets 11am (Europe/Budapest)
     /upgrade or /usage-credits to finish what you’re working on.

✻ Baked for 0s · done 10:06 PM
────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent /rc`
    expect(extractAgentScreenSnapshot(
      screen, 'claude', 'Reply with exactly VISUAL_SMOKE_OK. Do not edit files or run commands.'
    )).toEqual({
      body: "You've hit your weekly limit · resets 11am (Europe/Budapest)\n/upgrade or /usage-credits to finish what you’re working on.",
      active: false,
      settled: true
    })
  })

  it('recognizes live work without displaying status chrome', () => {
    const screen = `❯ [Conductor edit mode]\n  Fix checkout\n\n✣ Deciphering…\n· esc to interrupt · ← 1 agent\n❯`
    expect(extractAgentScreenSnapshot(screen, 'claude', 'Fix checkout')).toEqual({ body: '', active: true, settled: false })
  })

  it('preserves response paragraphs and code-like lines', () => {
    const screen = `❯ [Conductor plan mode]\n  Explain the fix\n\nThe guard belongs before submit.\n\n- validate inventory\n- return the error\n\n❯`
    expect(extractAgentScreenSnapshot(screen, 'codex', 'Explain the fix')).toMatchObject({
      body: 'The guard belongs before submit.\n\n- validate inventory\n- return the error', settled: true
    })
  })
})
