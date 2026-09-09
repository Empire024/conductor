import { describe, expect, it } from 'vitest'
import { stripMemoryDirectives } from './memory-directive'

describe('hiding the memory-write directive from the conversation', () => {
  it('removes a standalone directive line in the middle of a reply', () => {
    const text = [
      'Here is what I found.',
      'CONDUCTOR_MEMORY[semantic]: The checkout tax bug was a stale total | cues: checkout, tax',
      'That should do it.'
    ].join('\n')
    expect(stripMemoryDirectives(text)).toBe('Here is what I found.\nThat should do it.')
  })

  it('removes a directive that is the last line, with or without a trailing newline', () => {
    expect(stripMemoryDirectives('All done.\nCONDUCTOR_MEMORY: Vitest runs in a node environment'))
      .toBe('All done.\n')
    expect(stripMemoryDirectives('All done.\nCONDUCTOR_MEMORY: Vitest runs in a node environment\n'))
      .toBe('All done.\n')
  })

  it('removes a directive with no cues field at all', () => {
    expect(stripMemoryDirectives('CONDUCTOR_MEMORY[procedural]: Run npm.cmd on Windows\nNext step.'))
      .toBe('Next step.')
  })

  it('tolerates blank lines around the directive without leaving it visible', () => {
    const text = 'Intro.\n\nCONDUCTOR_MEMORY[episodic]: Retried the flaky test and it passed | cues: flaky\n\nOutro.'
    const result = stripMemoryDirectives(text)
    expect(result).not.toContain('CONDUCTOR_MEMORY')
    expect(result).toContain('Intro.')
    expect(result).toContain('Outro.')
  })

  it('holds back a directive that is still streaming in rather than flashing it half-typed', () => {
    expect(stripMemoryDirectives('Wrapping up.\nCONDUCTOR_MEM')).toBe('Wrapping up.\n')
    expect(stripMemoryDirectives('Wrapping up.\nCONDUCTOR_MEMORY[sem')).toBe('Wrapping up.\n')
    expect(stripMemoryDirectives('Wrapping up.\nCONDUCTOR_MEMORY[semantic]: still typing the gist'))
      .toBe('Wrapping up.\n')
  })

  it('leaves an ordinary line that merely starts with the same letters alone once it diverges', () => {
    expect(stripMemoryDirectives('Considering the options here.')).toBe('Considering the options here.')
    expect(stripMemoryDirectives('Configuration looks correct.')).toBe('Configuration looks correct.')
  })

  it('does not touch a mention fenced in backticks, since it is not a standalone directive line', () => {
    const text = 'Use a line like `CONDUCTOR_MEMORY[semantic]: <fact> | cues: <cues>` to save one.'
    expect(stripMemoryDirectives(text)).toBe(text)
  })

  it('is a no-op on text with no directive in it', () => {
    const text = 'Just a normal reply with nothing to strip.'
    expect(stripMemoryDirectives(text)).toBe(text)
  })
})
