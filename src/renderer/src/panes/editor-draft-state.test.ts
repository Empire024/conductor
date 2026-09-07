import { describe, expect, it } from 'vitest'
import type { EditorDraft } from '../../../shared/models'
import { recoverEditorDraft } from './editor-draft-state'
const draft = (content: string, baseContent?: string | null): EditorDraft => ({ tabId: 'tab', projectId: 'project', path: 'file.ts', content, baseContent, viewState: null, updatedAt: '' })
describe('editor draft recovery', () => {
  it('loads newer disk content instead of a clean historical checkpoint', () => {
    expect(recoverEditorDraft('new agent work', draft('old disk', 'old disk'))).toEqual({ content: 'new agent work', savedContent: 'new agent work', baseContent: 'new agent work', recovered: false, conflict: false })
  })
  it('recovers local edits using their original baseline even when disk has changed', () => {
    expect(recoverEditorDraft('new agent work', draft('my edit', 'original'))).toMatchObject({ content: 'my edit', savedContent: 'original', baseContent: 'original', recovered: true, conflict: true })
  })
  it('preserves unknown legacy drafts without granting permission to overwrite disk', () => {
    expect(recoverEditorDraft('new disk', draft('old draft'))).toMatchObject({ content: 'old draft', baseContent: undefined, recovered: true, conflict: true })
  })
  it('recovers unsaved edits after deletion and keeps the deletion conflict', () => {
    expect(recoverEditorDraft(null, draft('my edit', 'original'))).toMatchObject({ content: 'my edit', baseContent: 'original', recovered: true, conflict: true })
  })
  it('recognizes an already saved draft and an unchanged baseline', () => {
    expect(recoverEditorDraft('saved edit', draft('saved edit', 'old disk'))).toMatchObject({ content: 'saved edit', baseContent: 'saved edit', recovered: false, conflict: false })
    expect(recoverEditorDraft('original', draft('my edit', 'original'))).toMatchObject({ content: 'my edit', baseContent: 'original', recovered: true, conflict: false })
  })
})
