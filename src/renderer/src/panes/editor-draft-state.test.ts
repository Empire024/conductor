import { describe, expect, it } from 'vitest'
import type { EditorDraft } from '../../../shared/models'
import { isRecoveryDraft, recoverEditorDraft, recoveryDraftLabel, recoveryDraftNotice } from './editor-draft-state'
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

describe('an unsaved edit kept from a machine this computer detached from', () => {
  const draft = (patch: Partial<EditorDraft> = {}): EditorDraft => ({
    tabId: 'tab', machineId: 'main-box', projectId: 'p', path: 'src/app.ts',
    content: 'typed on the laptop', baseContent: 'on disk', viewState: null,
    updatedAt: '2026-09-16T09:00:00.000Z', recoveredAt: '2026-09-16T10:00:00.000Z', ...patch
  })

  it('is labelled with the machine it was typed against and the file it belongs to', () => {
    expect(recoveryDraftLabel(draft(), 'MAIN')).toBe('Unsaved edit from MAIN › src/app.ts (recovered)')
    // With no name to hand it still names the machine rather than going vague.
    expect(recoveryDraftLabel(draft())).toBe('Unsaved edit from main-box › src/app.ts (recovered)')
  })

  it('is not claimed for an ordinary draft, which is still live and still saveable', () => {
    expect(recoveryDraftLabel(draft({ recoveredAt: null }), 'MAIN')).toBe('')
    expect(recoveryDraftLabel(null, 'MAIN')).toBe('')
    expect(isRecoveryDraft(draft())).toBe(true)
    expect(isRecoveryDraft(draft({ recoveredAt: null }))).toBe(false)
    expect(isRecoveryDraft(null)).toBe(false)
  })

  it('says plainly that it is never written to a local file of the same name', () => {
    const notice = recoveryDraftNotice('MAIN')
    expect(notice).toMatch(/nothing you wrote is lost/)
    expect(notice).toMatch(/never written to a file of the same name on this computer/)
    expect(notice).toMatch(/save a copy/i)
  })

  it('still recovers the edited text itself, because keeping it is the whole point', () => {
    const state = recoverEditorDraft('on disk', draft())
    expect(state.content).toBe('typed on the laptop')
    expect(state.recovered).toBe(true)
  })
})
