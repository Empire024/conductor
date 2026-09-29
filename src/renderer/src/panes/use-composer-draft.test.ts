import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_PROMPT_CHARS, type ContextAttachment } from '../../../shared/structured-agent'
import { composerCommandQuery } from './composer-commands'
import { composerDraftView } from './use-composer-draft'

// Typing re-rendered the whole conversation pane on every key (header, timeline wrapper, composer
// controls, usage summary) because the pane held the draft's text: about 8 ms per key at 4x
// throttle, half the frame budget (scripts/perf-input.mjs, docs/verification/2026-09-29-typing.md).
// The pane now renders from a view of the draft that ordinary typing does not change, and the
// textarea is uncontrolled: a controlled one re-rendered per key and React rewrote its defaultValue
// (its child text node) each time.
describe('composer draft view', () => {
  const attachments: ContextAttachment[] = []
  it('stays the same while ordinary text is typed', () => {
    const views = ['h', 'he', 'hello', 'hello world', 'hello world, how are you'].map(message => composerDraftView({ message, attachments }))
    for (const view of views) expect(view).toEqual(views[0])
    expect(views[0]).toEqual({ attachments, commandQuery: '', sendBlock: undefined, nearLimitChars: 0 })
  })

  it('changes when what the pane shows changes', () => {
    expect(composerDraftView({ message: '', attachments }).sendBlock).toBe('empty')
    expect(composerDraftView({ message: '   ', attachments }).sendBlock).toBe('empty')
    expect(composerDraftView({ message: '/mo', attachments }).commandQuery).toBe('/mo')
    expect(composerDraftView({ message: '@bro', attachments }).commandQuery).toBe('@bro')
    const near = 'x'.repeat(Math.ceil(MAX_PROMPT_CHARS * 0.9) + 1)
    expect(composerDraftView({ message: near, attachments }).nearLimitChars).toBe(near.length)
    expect(composerDraftView({ message: 'x'.repeat(MAX_PROMPT_CHARS + 1), attachments }).sendBlock).toBe('oversized')
  })

  it('keeps the command query exactly what the command list matched on', () => {
    for (const text of ['/MO', '/', '@', '@bro', '/model argument', 'Use /model please', '/file.ts', '@file.ts', 'ordinary text', ''])
      expect(composerCommandQuery(text)).toBe(/^[/@][a-zA-Z0-9:_-]*$/.test(text) ? text : '')
  })

  it('leaves the draft text to an uncontrolled textarea, never to the pane', () => {
    const pane = readFileSync(new URL('./StructuredAgentPane.tsx', import.meta.url), 'utf8')
    expect(pane).toContain('useComposerTextSync(projectId, sessionId, textareaRef)')
    expect(pane).toMatch(/<ComposerTextarea [^>]*textareaRef=\{composer\}/)
    expect(pane).not.toMatch(/const \{[^}]*\bdraft\b[^}]*\} = useComposerDraft/)
    expect(pane).not.toMatch(/<textarea [^>]*\bvalue=/)
    // A present placeholder costs a style recalc per key; it is there only while the draft is empty.
    expect(pane).toContain("placeholder={sendBlocked !== 'empty' ? undefined :")
  })
})
