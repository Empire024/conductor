import { describe, expect, it } from 'vitest'
import { composeLocalPrompt, LOCAL_BACKGROUND_CLOSE, LOCAL_BACKGROUND_OPEN, mentionsConductorControl, splitLocalPrompt } from './briefing'

describe('local prompt briefing', () => {
  it('fences recalled background ahead of the owner\'s words and splits it back out', () => {
    const background = '- [semantic] The checkout tax total is computed from stale cart totals\n- [episodic] Tax rounding lives in cart-totals.ts'
    const prompt = composeLocalPrompt('paste back the prompt you received', background)
    expect(prompt).toBe(`${LOCAL_BACKGROUND_OPEN}\n${background}\n${LOCAL_BACKGROUND_CLOSE}\n\npaste back the prompt you received`)
    // The owner's instruction is the last thing the model reads.
    expect(prompt.endsWith('paste back the prompt you received')).toBe(true)
    expect(splitLocalPrompt(prompt)).toEqual({ instruction: 'paste back the prompt you received', background })
  })

  it('leaves a prompt without background untouched both ways', () => {
    expect(composeLocalPrompt('Output : 1', '')).toBe('Output : 1')
    expect(splitLocalPrompt('Output : 1')).toEqual({ instruction: 'Output : 1', background: '' })
    // An unterminated fence is the owner's text, not background.
    const unterminated = `${LOCAL_BACKGROUND_OPEN}\nno close marker`
    expect(splitLocalPrompt(unterminated)).toEqual({ instruction: unterminated, background: '' })
  })

  it('recognises an owner asking for what the conductor tool does, and nothing else', () => {
    for (const text of ['mark the second task done', 'what do you remember about this project', 'update conductor', 'List my tasks', 'which agents are open?', 'show the usage limits'])
      expect(mentionsConductorControl(text), text).toBe(true)
    for (const text of ['paste back the prompt you received', 'add a footer to index.html', 'Output : 1', 'do not touch files'])
      expect(mentionsConductorControl(text), text).toBe(false)
  })
})
