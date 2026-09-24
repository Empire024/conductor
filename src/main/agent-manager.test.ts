import { describe, expect, it } from 'vitest'
import { CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODELS } from './agent-manager'

describe('Codex model catalog', () => {
  it('shows Astra and the current model family instead of retired Codex models', () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual([
      'default',
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])
  })

  it('labels the static catalog with the display names the CLI itself reports', () => {
    // model/list on codex-cli 0.153.4 (2026-09-21) says GPT-6-Astra, GPT-5.6-Sol, ...; the composer
    // shows a discovered label verbatim, so the pre-discovery label must read the same.
    expect(CODEX_MODELS.map((model) => model.label)).toEqual(['Default for account', 'GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna'])
  })

  it('offers the full reasoning ladder the installed CLI advertises, including max and ultra', () => {
    expect(CODEX_EFFORTS.map((effort) => effort.id)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(CODEX_EFFORTS.some((effort) => effort.id === 'minimal')).toBe(false)
  })
})

describe('Claude model catalog', () => {
  it('mirrors the ids Claude Code advertises: the 1M Opus entry, Fable, Sonnet and Haiku', () => {
    expect(CLAUDE_MODELS.map((model) => model.id)).toEqual(['default', 'opus[1m]', 'claude-fable-5-1', 'sonnet', 'haiku'])
    expect(CLAUDE_MODELS.some((model) => model.id === 'opus')).toBe(false)
  })
})
