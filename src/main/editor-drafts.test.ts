import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'

function fixture(run: (db: ConductorDatabase, projectId: string, path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'conductor-editor-draft-'))
  const path = join(root, 'db.sqlite')
  const db = new ConductorDatabase(path)
  try { run(db, db.upsertProject(join(root, 'project'), 'Project').id, path) }
  finally { db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) }
}
describe('editor recovery baselines', () => {
  it('does not persist a clean editor on flush and removes old edits after undo', () => fixture((db, projectId) => {
    db.saveEditorDraft('tab', projectId, 'file.ts', 'read-only text', null, 'read-only text')
    expect(db.listEditorDrafts()).toEqual([])
    db.saveEditorDraft('tab', projectId, 'file.ts', 'local edit', null, 'read-only text')
    expect(db.listEditorDrafts()).toHaveLength(1)
    db.saveEditorDraft('tab', projectId, 'file.ts', 'read-only text', null, 'read-only text')
    expect(db.listEditorDrafts()).toEqual([])
  }))
  it('preserves the original baseline through checkpoints, restart, and file moves', () => fixture((db, projectId, path) => {
    db.saveEditorDraft('tab', projectId, 'file.ts', 'edit one', null, 'original disk')
    db.saveEditorDraft('tab', projectId, 'file.ts', 'edit two', null, 'original disk')
    db.remapEditorDrafts(projectId, 'file.ts', 'renamed.ts', false)
    const reopened = new ConductorDatabase(path)
    try { expect(reopened.getEditorDraft('tab', projectId, 'renamed.ts')).toMatchObject({ content: 'edit two', baseContent: 'original disk' }) }
    finally { reopened.close() }
  }))
  it('distinguishes unknown old baselines from an intentionally missing file or empty file', () => fixture((db, projectId) => {
    db.saveEditorDraft('legacy', projectId, 'legacy.ts', 'old draft', null)
    db.saveEditorDraft('new', projectId, 'new.ts', 'new draft', null, null)
    db.saveEditorDraft('empty', projectId, 'empty.ts', 'edit', null, '')
    expect(db.getEditorDraft('legacy', projectId, 'legacy.ts')?.baseContent).toBeUndefined()
    expect(db.getEditorDraft('new', projectId, 'new.ts')?.baseContent).toBeNull()
    expect(db.getEditorDraft('empty', projectId, 'empty.ts')?.baseContent).toBe('')
  }))
})
