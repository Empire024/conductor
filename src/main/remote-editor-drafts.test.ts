import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('remote editor draft identity', () => {
  it('persists the machine and never returns the draft through a local lookup', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-remote-draft-')); roots.push(root)
    const path = join(root, 'state.db')
    let db = new ConductorDatabase(path)
    const project = db.upsertProject(join(root, 'controller-project'), 'Controller project')
    db.saveEditorDraft('remote-tab', project.id, 'same.txt', 'host edit', { line: 2 }, 'host bytes', 'host-a')
    expect(db.getEditorDraft('remote-tab', project.id, 'same.txt')).toBeNull()
    expect(db.getEditorDraft('remote-tab', project.id, 'same.txt', 'host-a')).toMatchObject({ machineId: 'host-a', content: 'host edit', baseContent: 'host bytes' })
    db.close()
    db = new ConductorDatabase(path)
    expect(db.listEditorDrafts()).toEqual([expect.objectContaining({ tabId: 'remote-tab', machineId: 'host-a' })])
    db.close()
  })

  it('does not remap a remote draft when a controller-local path is renamed', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-remote-draft-')); roots.push(root)
    const db = new ConductorDatabase(join(root, 'state.db'))
    const project = db.upsertProject(join(root, 'controller-project'), 'Controller project')
    db.saveEditorDraft('local-tab', project.id, 'same.txt', 'local edit', null, 'local bytes')
    db.saveEditorDraft('remote-tab', project.id, 'same.txt', 'host edit', null, 'host bytes', 'host-a')
    db.remapEditorDrafts(project.id, 'same.txt', 'renamed.txt', false)
    expect(db.getEditorDraft('local-tab', project.id, 'renamed.txt')).not.toBeNull()
    expect(db.getEditorDraft('remote-tab', project.id, 'same.txt', 'host-a')).not.toBeNull()
    db.close()
  })
})
