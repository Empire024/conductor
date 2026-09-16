import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import { RemoteProjectError, localProject } from './project-scope'

const withDatabase = (run: (db: ConductorDatabase, root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-remote-projects-'))
  const db = new ConductorDatabase(join(root, 'conductor.db'))
  try { run(db, root) } finally {
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
}

const origin = { machineId: 'main-box', machineName: 'MAIN', remoteProjectId: 'project_9', path: 'C:/Claude/conductor' }

describe('a project that lives on another machine', () => {
  it('is stored with its origin and shows the host\u2019s own path', () => {
    withDatabase(db => {
      const project = db.addRemoteProject({ name: 'Conductor', path: origin.path, remote: origin })
      expect(project.remote).toEqual(origin)
      // The owner is shown MAIN's path, not the key the row is actually filed under.
      expect(project.path).toBe('C:/Claude/conductor')
      expect(db.getProject(project.id)).toEqual(project)
      expect(db.listProjects().find(entry => entry.id === project.id)?.remote).toEqual(origin)
      expect(db.listDeskProjects().find(entry => entry.id === project.id)?.remote).toEqual(origin)
    })
  })

  it('never collides with a local project at the same path, in either direction', () => {
    withDatabase(db => {
      const here = db.upsertProject('C:/Claude/conductor', 'Conductor here')
      const there = db.addRemoteProject({ name: 'Conductor on MAIN', path: 'C:/Claude/conductor', remote: origin })
      expect(there.id).not.toBe(here.id)
      expect(here.remote).toBeUndefined()
      expect(there.remote?.machineId).toBe('main-box')
      // Opening the local folder again finds the local row and can never find the host's.
      expect(db.upsertProject('C:/Claude/conductor', 'Conductor here').id).toBe(here.id)
      // And two hosts sharing a path stay two projects.
      const other = db.addRemoteProject({ name: 'Conductor on Studio', path: 'C:/Claude/conductor', remote: { ...origin, machineId: 'studio', machineName: 'Studio', remoteProjectId: 'p2' } })
      expect(new Set([here.id, there.id, other.id]).size).toBe(3)
    })
  })

  it('opens the same host project twice as one entry, refreshed rather than duplicated', () => {
    withDatabase(db => {
      const first = db.addRemoteProject({ name: 'Conductor', path: 'C:/old/path', remote: { ...origin, path: 'C:/old/path' } })
      const again = db.addRemoteProject({ name: 'Conductor (renamed)', path: 'C:/new/path', remote: { ...origin, machineName: 'MAIN desktop', path: 'C:/new/path' } })
      expect(again.id).toBe(first.id)
      expect(again.name).toBe('Conductor (renamed)')
      expect(again.path).toBe('C:/new/path')
      expect(again.remote?.machineName).toBe('MAIN desktop')
      expect(db.listProjects().filter(entry => entry.remote?.machineId === 'main-box')).toHaveLength(1)
    })
  })

  it('refuses to be created without the machine it lives on', () => {
    withDatabase(db => {
      expect(() => db.addRemoteProject({ name: 'X', path: 'C:/x', remote: { ...origin, machineId: '' } })).toThrow(/needs the machine/)
      expect(() => db.addRemoteProject({ name: 'X', path: 'C:/x', remote: { ...origin, machineId: 'local' } })).toThrow(/needs the machine/)
      expect(() => db.addRemoteProject({ name: 'X', path: 'C:/x', remote: { ...origin, remoteProjectId: '' } })).toThrow(/project id/)
    })
  })

  it('is refused by the local-work guard, naming the host and the feature', () => {
    withDatabase((db, root) => {
      const here = db.upsertProject(join(root, 'here'), 'Here')
      const there = db.addRemoteProject({ name: 'Conductor', path: origin.path, remote: origin })
      expect(localProject(db, here.id, 'Git')).toMatchObject({ id: here.id })
      expect(() => localProject(db, there.id, 'Git')).toThrow(RemoteProjectError)
      expect(() => localProject(db, there.id, 'Git')).toThrow('This project lives on MAIN. Git runs there; it is not available from this computer yet.')
    })
  })

  it('never has its folder moved or renamed from here, because the folder is not here', () => {
    withDatabase(db => {
      const there = db.addRemoteProject({ name: 'Conductor', path: origin.path, remote: origin })
      expect(() => db.updateProjectPath(there.id, 'C:/somewhere/else')).toThrow(/lives on MAIN/)
      expect(() => db.updateProjectLocation(there.id, 'C:/somewhere/else', 'Renamed')).toThrow(/lives on MAIN/)
      expect(db.getProject(there.id)?.path).toBe(origin.path)
    })
  })

  it('is removed exactly as a local project is', () => {
    withDatabase(db => {
      const there = db.addRemoteProject({ name: 'Conductor', path: origin.path, remote: origin })
      db.removeProject(there.id)
      expect(db.getProject(there.id)).toBeNull()
    })
  })

  /**
   * A paired machine's projects are adopted into this list automatically, so "remove" has to mean
   * something that survives the next probe a minute later - otherwise the row the owner just took
   * off their list walks straight back onto it.
   */
  it('stays removed once the owner removes it, per machine and per project', () => {
    withDatabase(db => {
      expect(db.isRemoteProjectDismissed('main-box', 'project_9')).toBe(false)
      db.dismissRemoteProject('main-box', 'project_9')
      expect(db.isRemoteProjectDismissed('main-box', 'project_9')).toBe(true)
      // Another project on the same machine, and the same project id on another machine, are
      // untouched: ids are private to each machine and mean nothing across one.
      expect(db.isRemoteProjectDismissed('main-box', 'project_7')).toBe(false)
      expect(db.isRemoteProjectDismissed('studio', 'project_9')).toBe(false)
      db.dismissRemoteProject('main-box', 'project_9')
      expect(db.listDismissedRemoteProjects()).toEqual([{ machineId: 'main-box', remoteProjectId: 'project_9' }])
      db.restoreRemoteProject('main-box', 'project_9')
      expect(db.listDismissedRemoteProjects()).toEqual([])
    })
  })

  it('forgets what was hidden of a machine the owner unpaired, so re-pairing starts from everything it shares', () => {
    withDatabase(db => {
      db.dismissRemoteProject('main-box', 'project_9')
      db.dismissRemoteProject('studio', 'project_2')
      db.forgetDismissedRemoteProjects('main-box')
      expect(db.listDismissedRemoteProjects()).toEqual([{ machineId: 'studio', remoteProjectId: 'project_2' }])
    })
  })

  it('survives a restart with its origin intact, so it is never mistaken for a local folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-remote-restart-'))
    const path = join(root, 'conductor.db')
    try {
      let db = new ConductorDatabase(path)
      const id = db.addRemoteProject({ name: 'Conductor', path: origin.path, remote: origin }).id
      db.close()
      db = new ConductorDatabase(path)
      try {
        expect(db.getProject(id)?.remote).toEqual(origin)
        expect(() => localProject(db, id, 'Terminals')).toThrow(RemoteProjectError)
      } finally { db.close() }
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) }
  })
})

describe('unsaved edits made against a host, after detaching from it', () => {
  it('are retained and labelled rather than dropped or written anywhere', () => {
    withDatabase((db, root) => {
      const here = db.upsertProject(join(root, 'here'), 'Here')
      const there = db.addRemoteProject({ name: 'Conductor', path: origin.path, remote: origin })
      db.saveEditorDraft('tab-remote', there.id, 'src/app.ts', 'typed on the laptop', null, null, 'main-box')
      db.saveEditorDraft('tab-other-host', there.id, 'src/other.ts', 'typed too', null, null, 'studio')
      db.saveEditorDraft('tab-local', here.id, 'src/local.ts', 'local edit', null, null)

      expect(db.retainRemoteDrafts('main-box', '2026-09-16T10:00:00.000Z')).toBe(1)
      expect(db.getEditorDraft('tab-remote', there.id, 'src/app.ts', 'main-box')).toMatchObject({
        content: 'typed on the laptop', recoveredAt: '2026-09-16T10:00:00.000Z'
      })
      // Another host's drafts and this computer's own drafts are untouched.
      expect(db.getEditorDraft('tab-other-host', there.id, 'src/other.ts', 'studio')?.recoveredAt).toBeNull()
      expect(db.getEditorDraft('tab-local', here.id, 'src/local.ts')?.recoveredAt).toBeNull()

      expect(db.listRecoveredDrafts('main-box').map(draft => draft.tabId)).toEqual(['tab-remote'])
      expect(db.listRecoveredDrafts().map(draft => draft.tabId)).toEqual(['tab-remote'])
    })
  })

  it('keeps the moment they were retained when detaching again, and never retains a local draft', () => {
    withDatabase((db, root) => {
      const here = db.upsertProject(join(root, 'here'), 'Here')
      db.saveEditorDraft('tab', here.id, 'src/app.ts', 'edit', null, null, 'main-box')
      db.retainRemoteDrafts('main-box', '2026-09-16T10:00:00.000Z')
      // A second detach finds nothing new to retain and does not restamp what it already kept.
      expect(db.retainRemoteDrafts('main-box', '2026-09-16T12:00:00.000Z')).toBe(0)
      expect(db.getEditorDraft('tab', here.id, 'src/app.ts', 'main-box')?.recoveredAt).toBe('2026-09-16T10:00:00.000Z')
      expect(db.retainRemoteDrafts('local')).toBe(0)
      expect(db.retainRemoteDrafts('')).toBe(0)
    })
  })

  it('stays retained across a restart and after the owner edits it again', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-remote-drafts-'))
    const path = join(root, 'conductor.db')
    try {
      let db = new ConductorDatabase(path)
      const there = db.addRemoteProject({ name: 'Conductor', path: origin.path, remote: origin })
      db.saveEditorDraft('tab', there.id, 'src/app.ts', 'first', null, null, 'main-box')
      db.retainRemoteDrafts('main-box', '2026-09-16T10:00:00.000Z')
      db.close()
      db = new ConductorDatabase(path)
      try {
        expect(db.listRecoveredDrafts('main-box')).toHaveLength(1)
        db.saveEditorDraft('tab', there.id, 'src/app.ts', 'edited again', null, null, 'main-box')
        const draft = db.getEditorDraft('tab', there.id, 'src/app.ts', 'main-box')
        expect(draft?.content).toBe('edited again')
        expect(draft?.recoveredAt).toBe('2026-09-16T10:00:00.000Z')
      } finally { db.close() }
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) }
  })
})

describe('a saved desk that contains a project from another machine', () => {
  it('comes back as that machine\u2019s project, not as a local folder at the same path', () => {
    withDatabase((db, root) => {
      const here = db.upsertProject(join(root, 'here'), 'Here')
      const there = db.addRemoteProject({ name: 'Conductor on MAIN', path: 'C:/Claude/conductor', remote: origin })
      const archive = db.sessionArchive('Desk')
      expect(archive.projects.find(entry => entry.id === there.id)?.remote).toEqual(origin)
      expect(archive.projects.find(entry => entry.id === here.id)?.remote).toBeUndefined()

      // Imported into a different computer, which happens to have its own C:/Claude/conductor.
      withDatabase(other => {
        const collides = other.upsertProject('C:/Claude/conductor', 'My own copy')
        other.importSessionArchive(archive)
        const imported = other.listProjects().filter(entry => entry.remote?.machineId === 'main-box')
        expect(imported).toHaveLength(1)
        // The origin travelled, so every local-work guard still refuses it.
        expect(imported[0]!.remote).toEqual(origin)
        expect(() => localProject(other, imported[0]!.id, 'Git')).toThrow(RemoteProjectError)
        // And it did not absorb, or get absorbed by, the local folder of the same path.
        expect(imported[0]!.id).not.toBe(collides.id)
        expect(other.getProject(collides.id)?.remote).toBeUndefined()
      })
    })
  })

  it('is matched to the host project already open here rather than being added twice', () => {
    withDatabase((db, root) => {
      db.upsertProject(join(root, 'here'), 'Here')
      db.addRemoteProject({ name: 'Conductor on MAIN', path: 'C:/Claude/conductor', remote: origin })
      const archive = db.sessionArchive('Desk')
      withDatabase(other => {
        // Same host project, but the folder moved there since the archive was written.
        other.addRemoteProject({ name: 'Conductor', path: 'D:/moved', remote: { ...origin, path: 'D:/moved' } })
        other.importSessionArchive(archive)
        expect(other.listProjects().filter(entry => entry.remote?.machineId === 'main-box')).toHaveLength(1)
      })
    })
  })
})
