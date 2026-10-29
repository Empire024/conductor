import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpec, WorkspaceLayout } from '../shared/models'
import { GENERAL_ANCHOR_SETTING } from '../shared/threads'
import { ConductorDatabase } from './database'
import { GeneralThreads, safeGeneralFolder } from './general-threads'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) })

/** The same wiring main/index.ts uses, on a real database and real folders under a temp "home". */
function setup(root = mkdtempSync(join(tmpdir(), 'conductor-general-threads-'))) {
  if (!roots.includes(root)) roots.push(root)
  const home = join(root, 'home')
  const projectsRoot = join(home, 'Conductor')
  mkdirSync(projectsRoot, { recursive: true })
  const database = new ConductorDatabase(join(root, 'conductor.db'))
  const folderExists = async (path: string): Promise<boolean> => { try { return (await stat(path)).isDirectory() } catch { return false } }
  const created: string[] = [], registered: string[] = []
  const general = new GeneralThreads({
    getSetting: key => database.getSetting(key),
    setSetting: (key, value) => database.setSetting(key, value),
    getProject: id => database.getProject(id),
    listSessions: projectId => database.listSessions(projectId),
    createSession: (projectId, name) => database.createSession(projectId, name),
    projectsRoot: () => projectsRoot,
    folderExists,
    makeFolder: async path => { await mkdir(path, { recursive: true }) },
    createProject: async name => {
      let target = join(projectsRoot, name), suffix = 2
      while (await folderExists(target)) target = join(projectsRoot, `${name} ${suffix++}`)
      await mkdir(target)
      created.push(target)
      return database.upsertProject(target, basename(target))
    },
    registerFolder: async (path, name) => { registered.push(path); return database.upsertProject(path, name) },
    renameRow: (projectId, name) => database.updateProjectLocation(projectId, database.getProject(projectId)!.path, name),
    home: () => home
  })
  return { root, home, projectsRoot, database, general, created, registered }
}

describe('GeneralThreads', () => {
  it('first launch: makes General in the projects folder, marks it, and is the same project after a restart', async () => {
    const first = setup()
    expect(first.general.projectId()).toBeNull()
    const { project, workspace } = await first.general.ensure()
    expect(project).toMatchObject({ name: 'General', path: join(first.projectsRoot, 'General'), general: true })
    expect(existsSync(project.path)).toBe(true)
    expect(workspace.projectId).toBe(project.id)
    expect(first.general.mark(first.database.listDeskProjects())).toEqual([expect.objectContaining({ id: project.id, general: true })])

    // A thread in it: an agent whose working directory is the General folder, in a saved layout.
    const spec: AgentSpec = { id: 'agent_general_1', projectId: project.id, sessionId: workspace.id, provider: 'claude', title: 'Logo ideas', cwd: project.path }
    first.database.upsertAgent(spec, 'idle')
    const layout: WorkspaceLayout = { version: 1, root: { type: 'group', id: 'group_1', tabs: [{ id: 'pane_1', kind: 'agent', title: 'Logo ideas', resourceId: spec.id, state: { provider: 'claude' } }], activeTabId: 'pane_1' } }
    first.database.saveSession(workspace.id, layout, null, [])
    first.database.close()

    const second = setup(first.root)
    expect(second.general.projectId()).toBe(project.id)
    const again = await second.general.ensure()
    expect(again.project.id).toBe(project.id)
    expect(again.workspace.id).toBe(workspace.id)
    expect(JSON.stringify(again.workspace.layout)).toContain(spec.id)
    expect(second.created).toEqual([])
    second.database.close()
  })

  it('makes one General when asked twice at once', async () => {
    const { general, created, database } = setup()
    const [a, b] = await Promise.all([general.ensure(), general.ensure()])
    expect(a.project.id).toBe(b.project.id)
    expect(created).toHaveLength(1)
    expect(database.listProjects()).toHaveLength(1)
    database.close()
  })

  it('makes a deleted General folder again at the same path, so kept threads resume from it', async () => {
    const { general, database } = setup()
    const { project } = await general.ensure()
    rmSync(project.path, { recursive: true })
    const again = await general.ensure()
    expect(again.project.id).toBe(project.id)
    expect(existsSync(project.path)).toBe(true)
    database.close()
  })

  it('brings a removed General back on its old folder instead of making General 2', async () => {
    const { general, database, registered, created } = setup()
    const { project } = await general.ensure()
    database.removeProject(project.id)
    expect(general.projectId()).toBeNull()
    const again = await general.ensure()
    expect(again.project.path).toBe(project.path)
    expect(registered).toEqual([project.path])
    expect(created).toHaveLength(1)
    // Removed and its folder gone too: a fresh one.
    database.removeProject(again.project.id)
    rmSync(project.path, { recursive: true })
    expect((await general.ensure()).project.path).toBe(project.path)
    expect(created).toHaveLength(2)
    database.close()
  })

  it('never anchors threads in the home folder, the projects root or above them', async () => {
    const { general, database, home, projectsRoot, created } = setup()
    const homeProject = database.upsertProject(home, 'Home')
    database.setSetting(GENERAL_ANCHOR_SETTING, JSON.stringify({ projectId: homeProject.id, path: home }))
    const { project } = await general.ensure()
    expect(project.id).not.toBe(homeProject.id)
    expect(project.path).toBe(join(projectsRoot, 'General'))
    expect(created).toHaveLength(1)
    expect(safeGeneralFolder(join(projectsRoot, 'General'), projectsRoot, home)).toBe(true)
    for (const unsafe of [home, projectsRoot, join(home, '..'), '/', '']) expect(safeGeneralFolder(unsafe, projectsRoot, home)).toBe(false)
    database.close()
  })

  it('refuses a General whose folder would be unsafe even when the project maker returns one', async () => {
    const { database, home, projectsRoot } = setup()
    const general = new GeneralThreads({
      getSetting: key => database.getSetting(key), setSetting: (key, value) => database.setSetting(key, value),
      getProject: id => database.getProject(id), listSessions: id => database.listSessions(id), createSession: (id, name) => database.createSession(id, name),
      projectsRoot: () => projectsRoot, folderExists: async () => true, makeFolder: vi.fn(),
      createProject: async () => database.upsertProject(projectsRoot, 'General'),
      registerFolder: vi.fn(), renameRow: vi.fn(), home: () => home
    })
    await expect(general.ensure()).rejects.toThrow(/will not start threads/)
    expect(database.getSetting(GENERAL_ANCHOR_SETTING)).toBeNull()
    database.close()
  })

  it('turns General into a project in place: same folder and threads, a fresh General next time', async () => {
    const { general, database } = setup()
    const { project, workspace } = await general.ensure()
    database.upsertAgent({ id: 'agent_general_2', projectId: project.id, sessionId: workspace.id, provider: 'codex', title: 'Spike', cwd: project.path }, 'idle')
    expect(() => general.promote('  ')).toThrow(/Name the project/)
    expect(() => general.promote('general')).toThrow(/other than General/)
    const promoted = general.promote('Brand spike')
    expect(promoted).toMatchObject({ id: project.id, name: 'Brand spike', path: project.path })
    expect(promoted.general).toBeUndefined()
    expect(database.sessionArchive('check').agents.find(agent => agent.spec.id === 'agent_general_2')?.spec.cwd).toBe(project.path)
    expect(general.projectId()).toBeNull()
    const fresh = await general.ensure()
    expect(fresh.project.id).not.toBe(project.id)
    expect(fresh.project.path).toBe(project.path + ' 2')
    expect(() => setup().general.promote('x')).toThrow(/no General project/)
    database.close()
  })
})
