import { describe, expect, it } from 'vitest'
import { codexDirectivesToMarkdown } from './codex-directives'

describe('codex file citations', () => {
  it('turns a citation with an absolute Windows path into a file link', () => {
    expect(codexDirectivesToMarkdown('Created :codex-file-citation{path="C:/Users/stilj/Conductor/haf-stuff/output/pdf/HAF-font-shortlist-US-Letter.pdf" purpose="output"} — one page.'))
      .toBe('Created [HAF-font-shortlist-US-Letter.pdf](/C:/Users/stilj/Conductor/haf-stuff/output/pdf/HAF-font-shortlist-US-Letter.pdf) — one page.')
  })
  it('keeps the line, encodes spaces and backslashes, and reads unquoted attributes', () => {
    expect(codexDirectivesToMarkdown(':codex-file-citation[codex-file-citation]{line_range_start=12 line_range_end=20 path=src/a.ts}'))
      .toBe('[a.ts:12](src/a.ts#L12)')
    expect(codexDirectivesToMarkdown(':codex-file-citation{path="C:\\My Files\\[draft] notes.md"}'))
      .toBe('[\\[draft\\] notes.md](/C:/My%20Files/%5Bdraft%5D%20notes.md)')
  })
  it('drops a citation without a path and leaves other text alone', () => {
    expect(codexDirectivesToMarkdown('See :codex-file-citation{purpose="output"}.')).toBe('See .')
    expect(codexDirectivesToMarkdown('No directives here: {path="x"}')).toBe('No directives here: {path="x"}')
  })
})
