/**
 * The General project: where a thread the owner starts without choosing a project lives
 * (src/shared/threads.ts). It is an ordinary local project, made on first use in the owner's
 * projects folder, so the agent's working directory is a dedicated folder Conductor created - never
 * the home folder, the projects root itself or a drive root - and every project guard applies.
 *
 * The settings table remembers it as {projectId, path}: the id survives a rename, the path lets a
 * General the owner removed from Conductor come back on the same folder (its files are still there)
 * instead of piling up "General 2", "General 3". A folder deleted behind Conductor's back is made
 * again at the same path, so the conversations kept there still resume from the folder they began in.
 */
import { homedir } from 'node:os'
import { parse, resolve, sep } from 'node:path'
import type { ProjectRecord, SessionRecord } from '../shared/models'
import { GENERAL_ANCHOR_SETTING, GENERAL_PROJECT_NAME, GENERAL_WORKSPACE_NAME, readGeneralAnchor, type GeneralAnchor, type GeneralThreadTarget } from '../shared/threads'

export interface GeneralThreadsDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  getProject(id: string): ProjectRecord | null
  listSessions(projectId: string): SessionRecord[]
  createSession(projectId: string, name: string): SessionRecord
  projectsRoot(): string
  folderExists(path: string): Promise<boolean>
  makeFolder(path: string): Promise<void>
  /** A new project folder under the projects root (the owner's "New project"). */
  createProject(name: string): Promise<ProjectRecord>
  /** An existing folder registered as a project (the owner's "Open existing folder"). */
  registerFolder(path: string, name: string): Promise<ProjectRecord>
  /** Renames the project row only; the folder, and so every working directory, stays put. */
  renameRow(projectId: string, name: string): ProjectRecord
  home?(): string
}

const normalized = (path: string): string => {
  const full = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full
}
const isSelfOrAncestor = (candidate: string, of: string): boolean =>
  of === candidate || of.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep)

/** A folder an agent in Auto may write anywhere inside: never a drive root, and never the home
 *  folder, the projects root or a folder above either (each would hand the agent everything under it). */
export function safeGeneralFolder(path: string, projectsRoot: string, home = homedir()): boolean {
  if (!path) return false
  const target = normalized(path)
  if (target === normalized(parse(resolve(path)).root)) return false
  return ![home, projectsRoot].some(guarded => guarded && isSelfOrAncestor(target, normalized(guarded)))
}

export class GeneralThreads {
  private pending: Promise<GeneralThreadTarget> | null = null

  constructor(private readonly deps: GeneralThreadsDeps) {}

  anchor(): GeneralAnchor | null { return readGeneralAnchor(this.deps.getSetting(GENERAL_ANCHOR_SETTING)) }

  /** The General project's id while it is still in Conductor, else null. */
  projectId(): string | null {
    const anchor = this.anchor()
    const project = anchor ? this.deps.getProject(anchor.projectId) : null
    return project && !project.remote ? project.id : null
  }

  /** Marks the General project in a project list, so the window can call it what it is. */
  mark(projects: ProjectRecord[]): ProjectRecord[] {
    const id = this.projectId()
    return id ? projects.map(project => project.id === id ? { ...project, general: true as const } : project) : projects
  }

  /** The General project and the workspace new threads open in; made on first use. Two clicks at
   *  once share one creation. */
  ensure(): Promise<GeneralThreadTarget> {
    if (!this.pending) this.pending = this.resolve().finally(() => { this.pending = null })
    return this.pending
  }

  /**
   * "Turn into a project" (t3code's adopt-folder): the General project becomes an ordinary project
   * under the owner's name for it. Only the row is renamed - the folder and every conversation's
   * working directory stay exactly where they are, so each thread resumes as before. The next
   * "New thread" starts a fresh General.
   */
  promote(name: string): ProjectRecord {
    const trimmed = String(name ?? '').trim().slice(0, 120)
    if (!trimmed) throw new Error('Name the project')
    const id = this.projectId()
    if (!id) throw new Error('There is no General project to turn into a project')
    if (trimmed.toLowerCase() === GENERAL_PROJECT_NAME.toLowerCase()) throw new Error('Choose a name other than General')
    const renamed = this.deps.renameRow(id, trimmed)
    this.deps.setSetting(GENERAL_ANCHOR_SETTING, '')
    return renamed
  }

  private async resolve(): Promise<GeneralThreadTarget> {
    const root = this.deps.projectsRoot()
    const home = this.deps.home?.() ?? homedir()
    const anchor = this.anchor()
    let project: ProjectRecord | null = anchor ? this.deps.getProject(anchor.projectId) : null
    if (project?.remote) project = null
    if (project && !safeGeneralFolder(project.path, root, home)) project = null
    if (project) {
      // Deleted behind Conductor's back: the same folder again, so kept conversations still resume.
      if (!await this.deps.folderExists(project.path)) await this.deps.makeFolder(project.path)
    } else if (anchor && safeGeneralFolder(anchor.path, root, home) && await this.deps.folderExists(anchor.path)) {
      project = await this.deps.registerFolder(anchor.path, GENERAL_PROJECT_NAME)
    } else {
      project = await this.deps.createProject(GENERAL_PROJECT_NAME)
    }
    if (!safeGeneralFolder(project.path, root, home)) throw new Error(`Conductor will not start threads in ${project.path}`)
    this.deps.setSetting(GENERAL_ANCHOR_SETTING, JSON.stringify({ projectId: project.id, path: project.path } satisfies GeneralAnchor))
    const workspace = this.deps.listSessions(project.id)[0] ?? this.deps.createSession(project.id, GENERAL_WORKSPACE_NAME)
    return { project: { ...project, general: true }, workspace }
  }
}
