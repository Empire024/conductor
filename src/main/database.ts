import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StructuredAgentStore } from './structured-store'
import type { SessionArchive, SessionArchiveResult } from '../shared/session-archive'
import { parseSessionArchive } from './session-archive'
import type {
  AgentSpec,
  AgentMemory,
  DetachedWindowRecord,
  EditorDraft,
  LayoutTemplateRecord,
  NormalizedAgentEvent,
  MemoryOrigin,
  MemoryPruneCandidate,
  PaneTab,
  ProjectRecord,
  SessionRecord,
  RememberMemoryInput,
  RuntimeProcessSummary,
  TurnMemoryRecall,
  UpdateMemoryInput,
  TerminalSpec,
  WorkspaceDocumentState,
  WorkspaceRecoveryCheckpoint,
  WorkspaceRecoveryState,
  WorkspaceLayout
} from '../shared/models'
import { createDefaultLayout, isMemoryKind, makeId, readActivityPhase } from '../shared/models'
import type { ProjectTaskActivity, ProjectTaskStatus } from '../shared/project-backlog'
import type { AgentActivityRow } from './project-activity'
import {
  clampMemoryWeight,
  memorySourceOf,
  memoryTokens,
  normalizeMemoryCues,
  rankMemoriesForPrune,
  scoreMemory,
  shouldConsolidateMemory,
  shouldForgetMemory
} from './memory'

type DbRow = Record<string, unknown>

const recoveryIdentity = /^[a-zA-Z0-9_-]{1,160}$/
const recoveryDocumentOwner = /^(?:project|detached):[a-zA-Z0-9_-]{1,160}$/
const recoveryDocumentId = /^document:(?:(?:project|detached):)?[a-zA-Z0-9_-]{1,160}:[a-zA-Z0-9_-]{1,160}$/
function normalizeWorkspaceDocuments(value: unknown): WorkspaceDocumentState[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid workspace documents')
  const documentIds = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid workspace document state')
    const state = item as Record<string, unknown>
    if (typeof state.workspaceId !== 'string' || state.workspaceId.length > 340 || !(recoveryIdentity.test(state.workspaceId) || recoveryDocumentOwner.test(state.workspaceId))) throw new Error('Invalid workspace document owner')
    if (!Array.isArray(state.files) || state.files.length > 1000) throw new Error('Invalid workspace document list')
    const files = state.files.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid workspace document')
      const file = item as Record<string, unknown>
      if (typeof file.id !== 'string' || !(recoveryIdentity.test(file.id) || recoveryDocumentId.test(file.id)) || documentIds.has(file.id)) throw new Error('Invalid workspace document identity')
      if (typeof file.machineId !== 'string' || !recoveryIdentity.test(file.machineId) || typeof file.projectId !== 'string' || !recoveryIdentity.test(file.projectId)) throw new Error('Invalid workspace document placement')
      if (typeof file.path !== 'string' || file.path.length > 32000 || file.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file.path) || file.path.replaceAll('\\', '/').split('/').includes('..') || /[\0-\x1f]/.test(file.path)) throw new Error('Invalid workspace document path')
      if (!['editor', 'preview', 'browser'].includes(file.mode as string)) throw new Error('Invalid workspace document mode')
      if (file.line !== undefined && (!Number.isSafeInteger(file.line) || (file.line as number) < 1)) throw new Error('Invalid workspace document line')
      if (file.allowBinary !== undefined && typeof file.allowBinary !== 'boolean') throw new Error('Invalid workspace document setting')
      documentIds.add(file.id)
      return { id: file.id, machineId: file.machineId, projectId: file.projectId, path: file.path.replaceAll('\\', '/'), mode: file.mode as 'editor' | 'preview' | 'browser', ...(file.line !== undefined ? { line: file.line as number } : {}), ...(file.allowBinary !== undefined ? { allowBinary: file.allowBinary } : {}) }
    })
    const activeId = state.activeId === null ? null : state.activeId
    if (activeId !== null && (typeof activeId !== 'string' || !files.some(file => file.id === activeId))) throw new Error('Invalid active workspace document')
    return { workspaceId: state.workspaceId, files, activeId }
  })
}

const mapTaskActivity = (row: DbRow): ProjectTaskActivity => ({
  id: row.id as string,
  status: row.status as ProjectTaskStatus,
  actor: row.actor as 'agent' | 'you' | 'file',
  at: row.created_at as string,
  // NULL is an older row whose agent_id also represented its assignee. New unassigned rows store ''.
  assignedAgentId: ((row.assigned_agent_id == null ? row.agent_id : row.assigned_agent_id) as string | null) || undefined,
  agentId: (row.agent_id as string | null) ?? undefined,
  agentTitle: (row.agent_title as string | null) ?? undefined,
  provider: (row.provider as string | null) ?? undefined,
  sessionId: (row.session_id as string | null) ?? undefined,
  workspace: (row.workspace as string | null) ?? undefined,
  commit: (row.commit_sha as string | null) ?? undefined
})

const now = (): string => new Date().toISOString()

/** Provenance is advisory: a malformed or absent record must read as "unknown", never throw
 *  while listing memories. */
const parseMemoryOrigin = (value: unknown): MemoryOrigin | null => {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.agentSessionId !== 'string' || !record.agentSessionId) return null
    return {
      agentSessionId: record.agentSessionId,
      ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.title === 'string' ? { title: record.title.slice(0, 200) } : {}),
      ...(typeof record.provider === 'string' ? { provider: record.provider as MemoryOrigin['provider'] } : {})
    }
  } catch { return null }
}
const serializeMemoryOrigin = (origin: MemoryOrigin | undefined): string | null =>
  origin && typeof origin.agentSessionId === 'string' && origin.agentSessionId
    ? JSON.stringify({
        agentSessionId: origin.agentSessionId,
        ...(origin.workspaceId ? { workspaceId: origin.workspaceId } : {}),
        ...(origin.title ? { title: origin.title.replace(/\s+/g, ' ').trim().slice(0, 200) } : {}),
        ...(origin.provider ? { provider: origin.provider } : {})
      })
    : null

export class ConductorDatabase {
  private readonly db: DatabaseSync
  readonly structured: StructuredAgentStore

  listDeskProjects(): ProjectRecord[] {
    const projects = this.listProjects()
    const raw = this.getSetting('sessionArchiveProjects')
    if (!raw) return projects
    try {
      const ids = JSON.parse(raw) as unknown
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return projects
      return ids.map(id => projects.find(project => project.id === id)).filter((p): p is ProjectRecord => Boolean(p))
    } catch { return projects }
  }

  includeDeskProject(id: string): void {
    if (this.getSetting('sessionArchiveProjects')) this.setSetting('sessionArchiveProjects', JSON.stringify([...new Set([...this.listDeskProjects().map(p => p.id), id])]))
  }

  listDeskDetachedWindows(): DetachedWindowRecord[] {
    const detached = this.listDetachedWindows()
    const raw = this.getSetting('sessionArchiveDetached')
    if (!raw) return detached
    try {
      const ids = JSON.parse(raw) as unknown
      return Array.isArray(ids) && ids.every(id => typeof id === 'string')
        ? ids.map(id => detached.find(record => record.id === id)).filter((record): record is DetachedWindowRecord => Boolean(record))
        : detached
    } catch { return detached }
  }

  listWorkspaceDocuments(): WorkspaceDocumentState[] {
    try { return this.validateWorkspaceDocuments(normalizeWorkspaceDocuments(JSON.parse(this.getSetting('workspaceDocuments') ?? '[]'))) }
    catch { return [] }
  }

  private validateWorkspaceDocuments(documents: WorkspaceDocumentState[]): WorkspaceDocumentState[] {
    for (const state of documents) {
      const projectId = state.workspaceId.startsWith('project:')
        ? this.getProject(state.workspaceId.slice('project:'.length))?.id
        : state.workspaceId.startsWith('detached:')
          ? this.getDetachedWindow(state.workspaceId.slice('detached:'.length))?.projectId
          : this.getSession(state.workspaceId)?.projectId
      if (!projectId) throw new Error('Invalid workspace document owner')
      if (state.files.some(file => file.projectId !== projectId)) throw new Error('Invalid workspace document project')
    }
    return documents
  }

  importedSessionMachine(id: string): string | null { return this.getSetting('sessionArchiveImported:' + id) }
  releaseImportedSession(id: string): void { this.removeSetting('sessionArchiveImported:' + id) }
  activateImportedResource(kind: 'agent' | 'terminal', id: string): void {
    const key = kind === 'agent' ? 'sessionArchiveImported:' + id : 'sessionArchiveImportedTerminal:' + id
    const placement = this.getSetting(key)
    if (!placement) return
    if (kind === 'agent' && placement !== 'local') throw new Error(`This saved conversation belongs to remote machine ${placement}. Its private pairing and resume grant were not exported, so it will remain offline and cannot run locally.`)
    this.removeSetting(key)
  }

  sessionArchive(name: string): SessionArchive {
    const projects = this.listDeskProjects()
    const workspaces = projects.flatMap(project => this.listSessions(project.id))
    const workspaceIds = new Set(workspaces.map(s => s.id))
    const detached = this.listDeskDetachedWindows().filter(d => workspaceIds.has(d.sessionId))
    const rows = this.db.prepare('SELECT * FROM agent_sessions').all() as DbRow[]
    const agents = rows.filter(row => workspaceIds.has(row.session_id as string)).map(row => {
      const spec = this.structured.spec<AgentSpec>(row.id as string) ?? {
        id: row.id as string, projectId: row.project_id as string, sessionId: row.session_id as string,
        provider: row.provider as AgentSpec['provider'], title: row.title as string, cwd: row.cwd as string,
        ...(row.model ? { model: row.model as string } : {}), ...(row.effort ? { effort: row.effort as AgentSpec['effort'] } : {})
      }
      return { spec, projection: this.structured.snapshot(spec.id), transcript: row.transcript as string }
    })
    const terminals = (this.db.prepare('SELECT * FROM terminal_sessions').all() as DbRow[])
      .filter(row => workspaceIds.has(row.session_id as string))
      .map(row => ({ spec: { id: row.id as string, projectId: row.project_id as string, sessionId: row.session_id as string, title: row.title as string, cwd: row.cwd as string } satisfies TerminalSpec, transcript: row.transcript as string }))
    const projectIds = new Set(projects.map(project => project.id))
    const detachedProjects = new Map(detached.map(record => [record.id, record.projectId]))
    const documents = this.listWorkspaceDocuments().flatMap(state => {
      const detachedId = state.workspaceId.startsWith('detached:') ? state.workspaceId.slice('detached:'.length) : null
      const included = workspaceIds.has(state.workspaceId) || state.workspaceId.startsWith('project:') && projectIds.has(state.workspaceId.slice('project:'.length)) || detachedId !== null && detachedProjects.has(detachedId)
      if (!included) return []
      return [state]
    })
    return { format: 'conductor-session', version: 1, name, savedAt: now(), projects, workspaces,
      detached, agents, terminals, documents, drafts: this.listEditorDrafts().filter(d => projects.some(project => project.id === d.projectId)), selection: this.getWorkspaceRecoveryState() }
  }

  /** Fresh workspace/conversation identities; existing project folders and history are never overwritten. */
  importSessionArchive(input: SessionArchive): SessionArchiveResult {
    const archive = parseSessionArchive(JSON.stringify(input))
    const remapping = new Map<string, string>()
    const mapped = (id: string): string => { let value = remapping.get(id); if (!value) { value = makeId('import'); remapping.set(id, value) }; return value }
    const existingProjects = this.listProjects()
    for (const p of archive.projects) {
      const existing = existingProjects.find(other => other.path.replaceAll('\\', '/').toLowerCase() === p.path.replaceAll('\\', '/').toLowerCase())
      remapping.set(p.id, existing?.id ?? makeId('project'))
    }
    const mapTab = (tab: PaneTab): PaneTab => ({ ...tab, id: mapped(tab.id), ...(tab.tabGroupId ? { tabGroupId: mapped(tab.tabGroupId) } : {}), ...(['agent', 'terminal'].includes(tab.kind) && tab.resourceId ? { resourceId: mapped(tab.resourceId) } : {}) })
    const mapLayout = (layout: WorkspaceLayout): WorkspaceLayout => {
      const visit = (node: import('../shared/models').LayoutNode): import('../shared/models').LayoutNode => node.type === 'split'
        ? { ...node, id: mapped(node.id), children: [visit(node.children[0]), visit(node.children[1])] }
        : { ...node, id: mapped(node.id), tabs: node.tabs.map(mapTab), activeTabId: node.activeTabId ? mapped(node.activeTabId) : '', tabGroups: node.tabGroups?.map(g => ({ ...g, id: mapped(g.id) })) }
      return { version: 1, root: visit(layout.root) }
    }
    const selection = {
      activeProjectId: archive.selection.activeProjectId ? mapped(archive.selection.activeProjectId) : null,
      activeSessionId: archive.selection.activeSessionId ? mapped(archive.selection.activeSessionId) : null,
      focusedGroupIds: Object.fromEntries(Object.entries(archive.selection.focusedGroupIds).map(([s, g]) => [mapped(s), mapped(g)])),
      sessionIdsByProject: Object.fromEntries(Object.entries(archive.selection.sessionIdsByProject).map(([p, s]) => [mapped(p), mapped(s)]))
    }
    const documents = (archive.documents ?? []).map(state => {
      const workspaceId = state.workspaceId.startsWith('project:')
        ? 'project:' + mapped(state.workspaceId.slice('project:'.length))
        : state.workspaceId.startsWith('detached:')
          ? 'detached:' + mapped(state.workspaceId.slice('detached:'.length))
          : mapped(state.workspaceId)
      const files = state.files.map(file => {
        const id = `document:${workspaceId}:${makeId('file')}`
        remapping.set(file.id, id)
        return { ...file, id, projectId: mapped(file.projectId) }
      })
      return { workspaceId, files, activeId: state.activeId ? remapping.get(state.activeId)! : null }
    })
    const importedIds: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // A recoverable previous desk remains in the same database, with its exact old IDs/drafts.
      this.setSetting('sessionArchivePreviousDesk', JSON.stringify({ name: this.getSetting('sessionArchiveName') ?? '', projects: this.listDeskProjects().map(p => p.id), selection: this.getWorkspaceRecoveryState(), workspaces: this.listDeskProjects().flatMap(p => this.listSessions(p.id)).map(s => s.id), detached: this.listDeskDetachedWindows().map(d => d.id) }))
      for (const p of this.listDeskProjects()) for (const s of this.listSessions(p.id)) this.closeSession(s.id)
      for (const p of archive.projects) if (!existingProjects.some(existing => existing.id === mapped(p.id))) this.db.prepare('INSERT INTO projects(id,name,path,created_at,updated_at) VALUES(?,?,?,?,?)').run(mapped(p.id), p.name, p.path, p.createdAt, p.updatedAt)
      for (const s of archive.workspaces) this.db.prepare('INSERT INTO sessions(id,project_id,name,layout_json,maximized_group_id,closed_tabs_json,continue_on_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)').run(mapped(s.id), mapped(s.projectId), s.name, JSON.stringify(mapLayout(s.layout)), s.maximizedGroupId ? mapped(s.maximizedGroupId) : null, JSON.stringify(s.closedTabs.map(mapTab)), s.createdAt, s.updatedAt)
      for (const d of archive.detached) this.db.prepare('INSERT INTO detached_windows(id,project_id,session_id,layout_json,maximized_group_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(mapped(d.id), mapped(d.projectId), mapped(d.sessionId), JSON.stringify(mapLayout(d.layout)), d.maximizedGroupId ? mapped(d.maximizedGroupId) : null, d.createdAt, d.updatedAt)
      for (const a of archive.agents) {
        const spec = { ...a.spec, id: mapped(a.spec.id), projectId: mapped(a.spec.projectId), sessionId: mapped(a.spec.sessionId) }
        this.upsertAgent(spec, 'exited', 'disconnected')
        this.db.prepare('UPDATE agent_sessions SET transcript=? WHERE id=?').run(a.transcript, spec.id)
        // Imported resources cannot execute on first mount, including legacy and remote tabs.
        this.setSetting('sessionArchiveImported:' + spec.id, spec.machineId && spec.machineId !== 'local' ? spec.machineId : 'local')
        if (a.projection) {
          const projection = { ...a.projection, sessionId: spec.id, runtimeId: '', items: a.projection.items.map(item => ({ ...item, data: item.data.type === 'text' && item.data.origin ? { ...item.data, origin: { ...item.data.origin, agentSessionId: mapped(item.data.origin.agentSessionId) } } : item.data })) }
          this.db.prepare('INSERT INTO structured_sessions(id,project_id,provider,spec_json,projection_json,title,archived) VALUES(?,?,?,?,?,?,?)').run(spec.id, spec.projectId, spec.provider, JSON.stringify(spec), JSON.stringify(projection), projection.title, projection.archived ? 1 : 0)
          importedIds.push(spec.id)
        }
      }
      for (const terminal of archive.terminals) {
        const spec = { ...terminal.spec, id: mapped(terminal.spec.id), projectId: mapped(terminal.spec.projectId), sessionId: mapped(terminal.spec.sessionId), shell: undefined, startupCommand: undefined }
        this.upsertTerminal(spec, 'exited')
        this.db.prepare('UPDATE terminal_sessions SET transcript=? WHERE id=?').run(terminal.transcript, spec.id)
        this.setSetting('sessionArchiveImportedTerminal:' + spec.id, 'dormant')
      }
      for (const d of archive.drafts) this.saveEditorDraft(mapped(d.tabId), mapped(d.projectId), d.path, d.content, d.viewState, d.baseContent, d.machineId ?? 'local')
      this.setSetting('workspaceDocuments', JSON.stringify(documents))
      this.setSetting('sessionArchiveName', archive.name)
      this.setSetting('sessionArchiveProjects', JSON.stringify(archive.projects.map(p => mapped(p.id))))
      this.setSetting('sessionArchiveDetached', JSON.stringify(archive.detached.map(d => mapped(d.id))))
      this.setSetting('activeProjectId', selection.activeProjectId ?? '')
      this.setSetting('activeSessionId', selection.activeSessionId ?? '')
      this.setSetting('focusedGroupIds', JSON.stringify(selection.focusedGroupIds))
      this.setSetting('sessionIdsByProject', JSON.stringify(selection.sessionIdsByProject))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.structured.loadImported(importedIds)
    return { name: archive.name, selection: { ...selection, documents } }
  }

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
    this.structured = new StructuredAgentStore(this.db, dirname(path))
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        layout_json TEXT NOT NULL,
        maximized_group_id TEXT,
        closed_tabs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        shell TEXT,
        cwd TEXT NOT NULL,
        startup_command TEXT,
        transcript TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        resume INTEGER NOT NULL DEFAULT 0,
        transcript TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_id TEXT,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS layout_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        layout_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS detached_windows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        layout_json TEXT NOT NULL,
        maximized_group_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS detached_windows_session_idx
        ON detached_windows(session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_continuations (
        agent_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        resume_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_key TEXT,
        kind TEXT NOT NULL,
        gist TEXT NOT NULL,
        cues_json TEXT NOT NULL DEFAULT '[]',
        salience REAL NOT NULL DEFAULT 0.5,
        strength REAL NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 0.75,
        occurred_at TEXT NOT NULL,
        last_recalled_at TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_recalls (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        memory_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_recalls_session_idx
        ON memory_recalls(agent_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS editor_drafts (
        tab_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL DEFAULT 'local',
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        view_state_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS editor_drafts_project_idx ON editor_drafts(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS project_task_activity (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        agent_id TEXT,
        agent_title TEXT,
        provider TEXT,
        session_id TEXT,
        workspace TEXT,
        commit_sha TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS project_task_activity_idx
        ON project_task_activity(project_id, task_id, created_at DESC);
    `)
    this.ensureColumn('project_task_activity', 'assigned_agent_id', 'TEXT')
    this.ensureColumn('editor_drafts', 'base_content_json', 'TEXT')
    this.ensureColumn('editor_drafts', 'machine_id', "TEXT NOT NULL DEFAULT 'local'")
    this.ensureColumn('sessions', 'continue_on_limit', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('sessions', 'closed_at', 'INTEGER')
    this.ensureColumn('agent_sessions', 'model', 'TEXT')
    this.ensureColumn('agent_sessions', 'effort', 'TEXT')
    this.ensureColumn('agent_sessions', 'continue_on_limit', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('agent_sessions', 'activity_phase', "TEXT NOT NULL DEFAULT 'idle'")
    // Agents could not write memory before this column existed, so every
    // pre-existing row came from a person and must never be auto-forgotten.
    this.ensureColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'human'")
    // Memories written before provenance was recorded cannot be attributed to a conversation;
    // a null origin reads as "unknown" in the pane rather than pretending to a source.
    this.ensureColumn('memories', 'origin_json', 'TEXT')
    this.ensureColumn('memories', 'corrected_at', 'TEXT')
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[]
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private applyOrder<T extends { id: string }>(key: string, records: T[]): T[] {
    let order: string[] = []
    try { const saved: unknown = JSON.parse(this.getSetting(key) ?? '[]'); if (Array.isArray(saved)) order = saved.filter((id): id is string => typeof id === 'string') } catch { /* stale UI order */ }
    const rank = new Map(order.map((id, index) => [id, index]))
    return records.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }

  reorderProjects(ids: string[]): ProjectRecord[] {
    this.saveOrder('projectOrder', ids, this.listProjects())
    return this.listProjects()
  }

  reorderSessions(projectId: string, ids: string[]): SessionRecord[] {
    this.saveOrder('sessionOrder:' + projectId, ids, this.listSessions(projectId))
    return this.listSessions(projectId)
  }

  private saveOrder(key: string, ids: string[], records: Array<{ id: string }>): void {
    if (!Array.isArray(ids) || ids.length !== records.length || new Set(ids).size !== ids.length || ids.some((id) => !records.some((record) => record.id === id))) throw new Error('The list changed. Refresh and try reordering again.')
    this.setSetting(key, JSON.stringify(ids))
  }

  listProjects(): ProjectRecord[] {
    return this.applyOrder('projectOrder', (this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as DbRow[]).map(this.mapProject))
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as DbRow | undefined
    return row ? this.mapProject(row) : null
  }

  upsertProject(path: string, name: string): ProjectRecord {
    const existing = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as DbRow | undefined
    if (existing) {
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), existing.id as string)
      return this.getProject(existing.id as string)!
    }

    const id = makeId('project')
    const timestamp = now()
    this.db
      .prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, path, timestamp, timestamp)
    this.createSession(id, 'Workspace')
    return this.getProject(id)!
  }

  updateProjectPath(projectId: string, path: string): ProjectRecord {
    const project = this.getProject(projectId)
    if (!project) throw new Error('Project not found')
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('UPDATE projects SET path = ?, updated_at = ? WHERE id = ?')
        .run(path, timestamp, projectId)
      this.db
        .prepare('UPDATE terminal_sessions SET cwd = ?, updated_at = ? WHERE project_id = ?')
        .run(path, timestamp, projectId)
      this.db
        .prepare('UPDATE agent_sessions SET cwd = ?, updated_at = ? WHERE project_id = ?')
        .run(path, timestamp, projectId)
      this.structured.rebindProject(projectId, path)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getProject(projectId)!
  }

  removeProject(projectId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Events deliberately do not use a foreign key so older databases can be
      // migrated safely. Remove their project-scoped history explicitly.
      this.db.prepare('DELETE FROM events WHERE project_id = ?').run(projectId)
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateProjectLocation(projectId: string, path: string, name: string): ProjectRecord {
    const project = this.getProject(projectId)
    if (!project) throw new Error('Project not found')
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('UPDATE projects SET path = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(path, name, timestamp, projectId)
      this.db
        .prepare('UPDATE terminal_sessions SET cwd = ?, updated_at = ? WHERE project_id = ?')
        .run(path, timestamp, projectId)
      this.db
        .prepare('UPDATE agent_sessions SET cwd = ?, updated_at = ? WHERE project_id = ?')
        .run(path, timestamp, projectId)
      this.structured.rebindProject(projectId, path)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getProject(projectId)!
  }

  removeSetting(key: string): void { this.db.prepare('DELETE FROM settings WHERE key = ?').run(key) }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as DbRow | undefined
    return (row?.value as string | undefined) ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now())
  }

  /** Task provenance: which agent, in which workspace, against which commit. */
  recordProjectTaskActivity(entry: {
    projectId: string
    taskId: string
    status: ProjectTaskStatus
    actor: 'agent' | 'you' | 'file'
    assignedAgentId?: string
    agentId?: string
    agentTitle?: string
    provider?: string
    sessionId?: string
    workspace?: string
    commit?: string
  }): ProjectTaskActivity {
    const id = makeId('task-activity')
    const at = now()
    this.db
      .prepare(
        `INSERT INTO project_task_activity
           (id, project_id, task_id, status, actor, agent_id, agent_title, provider, session_id, workspace, commit_sha, created_at, assigned_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, entry.projectId, entry.taskId, entry.status, entry.actor, entry.agentId ?? null, entry.agentTitle ?? null, entry.provider ?? null, entry.sessionId ?? null, entry.workspace ?? null, entry.commit ?? null, at, entry.assignedAgentId ?? '')
    return { id, at, status: entry.status, actor: entry.actor, assignedAgentId: entry.assignedAgentId, agentId: entry.agentId, agentTitle: entry.agentTitle, provider: entry.provider, sessionId: entry.sessionId, workspace: entry.workspace, commit: entry.commit }
  }

  /** Newest first, so a task can show who last moved it without another query. */
  listProjectTaskActivity(projectId: string, perTask = 12): Map<string, ProjectTaskActivity[]> {
    const rows = this.db
      .prepare('SELECT * FROM project_task_activity WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 2000')
      .all(projectId) as DbRow[]
    const activity = new Map<string, ProjectTaskActivity[]>()
    for (const row of rows) {
      const taskId = row.task_id as string
      const list = activity.get(taskId) ?? []
      if (list.length < perTask) list.push(mapTaskActivity(row))
      activity.set(taskId, list)
    }
    return activity
  }

  /** The commits a task was opened against and last moved against, in that order. */
  projectTaskCommitRange(projectId: string, taskId: string): { base?: string; head?: string } {
    const rows = this.db
      .prepare('SELECT commit_sha FROM project_task_activity WHERE project_id = ? AND task_id = ? AND commit_sha IS NOT NULL ORDER BY created_at ASC, rowid ASC')
      .all(projectId, taskId) as DbRow[]
    const commits = rows.map((row) => row.commit_sha as string)
    return { base: commits[0], head: commits.at(-1) }
  }

  listSessions(projectId: string): SessionRecord[] {
    return this.applyOrder('sessionOrder:' + projectId, (this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND closed_at IS NULL ORDER BY created_at ASC').all(projectId) as DbRow[]).map(this.mapSession))
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbRow | undefined
    return row ? this.mapSession(row) : null
  }

  createSession(projectId: string, name = 'New session'): SessionRecord {
    const id = makeId('session')
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO sessions
          (id, project_id, name, layout_json, maximized_group_id, closed_tabs_json, continue_on_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, '[]', 0, ?, ?)`
      )
      .run(id, projectId, name, JSON.stringify(createDefaultLayout()), timestamp, timestamp)
    return this.listSessions(projectId).find((session) => session.id === id)!
  }

  /** Closing is reversible; keep pane IDs, conversation history and drafts in place. */
  closeSession(sessionId: string): void {
    const latest = this.db.prepare('SELECT MAX(closed_at) AS latest FROM sessions').get() as DbRow
    const closedAt = Math.max(Date.now(), Number(latest.latest ?? 0) + 1)
    this.db.prepare('UPDATE sessions SET closed_at = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL').run(closedAt, now(), sessionId)
    if (this.getSetting('activeSessionId') === sessionId) this.setSetting('activeSessionId', '')
  }

  listClosedSessions(): SessionRecord[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC').all() as DbRow[]).map(this.mapSession)
  }

  restoreSession(sessionId?: string): SessionRecord | null {
    const row = (sessionId
      ? this.db.prepare('SELECT * FROM sessions WHERE id = ? AND closed_at IS NOT NULL').get(sessionId)
      : this.db.prepare('SELECT * FROM sessions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1').get()) as DbRow | undefined
    if (!row) return null
    this.db.prepare('UPDATE sessions SET closed_at = NULL, updated_at = ? WHERE id = ?').run(now(), row.id as string)
    return this.getSession(row.id as string)
  }
  deleteSession(sessionId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  renameSession(sessionId: string, name: string): void {
    this.db
      .prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?')
      .run(name.trim() || 'Untitled', now(), sessionId)
  }

  setSessionContinuation(sessionId: string, enabled: boolean): void {
    this.db.prepare('UPDATE sessions SET continue_on_limit = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now(), sessionId)
  }

  saveSession(
    sessionId: string,
    layout: WorkspaceLayout,
    maximizedGroupId: string | null,
    closedTabs: PaneTab[]
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET layout_json = ?, maximized_group_id = ?, closed_tabs_json = ?, updated_at = ?
         WHERE id = ? AND closed_at IS NULL`
      )
      .run(JSON.stringify(layout), maximizedGroupId, JSON.stringify(closedTabs.slice(-20)), now(), sessionId)
  }

  getWorkspaceRecoveryState(): WorkspaceRecoveryState {
    const activeProjectId = this.getSetting('activeProjectId') || null
    const activeSessionId = this.getSetting('activeSessionId') || null
    const project = activeProjectId ? this.getProject(activeProjectId) : null
    const session = activeSessionId && activeProjectId ? this.listSessions(activeProjectId).find(item => item.id === activeSessionId) : null
    return {
      activeProjectId: project?.id ?? null,
      activeSessionId: project && session?.projectId === project.id ? session.id : null,
      focusedGroupIds: this.readStringMapSetting('focusedGroupIds'),
      sessionIdsByProject: this.readStringMapSetting('sessionIdsByProject'),
      documents: this.listWorkspaceDocuments()
    }
  }

  private readStringMapSetting(key: string): Record<string, string> {
    try {
      const parsed = JSON.parse(this.getSetting(key) || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    } catch {
      return {}
    }
  }

  saveRecoveryCheckpoint(checkpoint: WorkspaceRecoveryCheckpoint): void {
    const timestamp = now()
    const documents = checkpoint.documents === undefined
      ? undefined
      : this.validateWorkspaceDocuments(normalizeWorkspaceDocuments(checkpoint.documents))
    const saveSession = this.db.prepare(
      `UPDATE sessions
       SET layout_json = ?, maximized_group_id = ?, closed_tabs_json = ?, updated_at = ?
       WHERE id = ? AND closed_at IS NULL`
    )
    const saveSetting = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const session of checkpoint.sessions) {
        saveSession.run(
          JSON.stringify(session.layout),
          session.maximizedGroupId,
          JSON.stringify(session.closedTabs.slice(-20)),
          timestamp,
          session.id
        )
      }
      saveSetting.run('activeProjectId', checkpoint.activeProjectId ?? '', timestamp)
      saveSetting.run('activeSessionId', checkpoint.activeSessionId && this.db.prepare('SELECT id FROM sessions WHERE id = ? AND closed_at IS NULL').get(checkpoint.activeSessionId) ? checkpoint.activeSessionId : '', timestamp)
      saveSetting.run('focusedGroupIds', JSON.stringify(checkpoint.focusedGroupIds), timestamp)
      saveSetting.run('sessionIdsByProject', JSON.stringify(checkpoint.sessionIdsByProject), timestamp)
      if (documents !== undefined) saveSetting.run('workspaceDocuments', JSON.stringify(documents), timestamp)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  remapEditorDrafts(projectId: string, previousPath: string, nextPath: string, directory: boolean): void {
    const drafts = this.listEditorDrafts().filter((draft) => (draft.machineId ?? 'local') === 'local' && draft.projectId === projectId && (draft.path === previousPath || directory && draft.path.startsWith(previousPath + '/')))
    this.db.exec('BEGIN IMMEDIATE')
    try { for (const draft of drafts) this.db.prepare('UPDATE editor_drafts SET path = ?, updated_at = ? WHERE tab_id = ?').run(nextPath + draft.path.slice(previousPath.length), now(), draft.tabId); this.db.exec('COMMIT') } catch (reason) { this.db.exec('ROLLBACK'); throw reason }
  }

  listEditorDrafts(): EditorDraft[] {
    const rows = this.db.prepare('SELECT tab_id, machine_id, project_id, path FROM editor_drafts ORDER BY updated_at ASC').all() as DbRow[]
    return rows.map((row) => this.getEditorDraft(row.tab_id as string, row.project_id as string, row.path as string, row.machine_id as string)!).filter(Boolean)
  }

  getEditorDraft(tabId: string, projectId: string, path: string, machineId = 'local'): EditorDraft | null {
    const row = this.db
      .prepare('SELECT * FROM editor_drafts WHERE tab_id = ? AND machine_id = ? AND project_id = ? AND path = ?')
      .get(tabId, machineId, projectId, path) as DbRow | undefined
    if (!row) return null
    let viewState: unknown | null = null
    try {
      viewState = row.view_state_json ? JSON.parse(row.view_state_json as string) : null
    } catch {
      viewState = null
    }
    return {
      tabId: row.tab_id as string,
      machineId: row.machine_id as string,
      projectId: row.project_id as string,
      path: row.path as string,
      content: row.content as string,
      baseContent: row.base_content_json == null ? undefined : JSON.parse(row.base_content_json as string) as string | null,
      viewState,
      updatedAt: row.updated_at as string
    }
  }

  saveEditorDraft(tabId: string, projectId: string, path: string, content: string, viewState: unknown, baseContent?: string | null, machineId = 'local'): void {
    // Clean buffers can be older than disk without containing any user edits.
    if (content === baseContent || baseContent === null && content === '') { this.removeEditorDraft(tabId); return }
    this.db.prepare(
      `INSERT INTO editor_drafts (tab_id, machine_id, project_id, path, content, view_state_json, updated_at, base_content_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tab_id) DO UPDATE SET
         machine_id = excluded.machine_id, project_id = excluded.project_id, path = excluded.path, content = excluded.content,
         view_state_json = excluded.view_state_json, updated_at = excluded.updated_at,
         base_content_json = excluded.base_content_json`
    ).run(tabId, machineId, projectId, path, content, viewState ? JSON.stringify(viewState) : null, now(), baseContent === undefined ? null : JSON.stringify(baseContent))
  }

  removeEditorDraft(tabId: string): void {
    this.db.prepare('DELETE FROM editor_drafts WHERE tab_id = ?').run(tabId)
  }

  reconcileInterruptedRuntimes(): void {
    const timestamp = now()
    this.db.prepare(
      "UPDATE terminal_sessions SET status = 'exited', updated_at = ? WHERE status IN ('starting', 'running', 'waiting_input')"
    ).run(timestamp)
    this.db.prepare(
      "UPDATE agent_sessions SET status = 'exited', activity_phase = 'idle', updated_at = ? WHERE status IN ('starting', 'running', 'waiting_input')"
    ).run(timestamp)
  }

  listLayoutTemplates(projectId: string): LayoutTemplateRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM layout_templates WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at DESC')
        .all(projectId) as DbRow[]
    ).map((row) => ({
      id: row.id as string,
      projectId: (row.project_id as string | null) ?? null,
      name: row.name as string,
      layout: JSON.parse(row.layout_json as string) as WorkspaceLayout,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    }))
  }

  saveLayoutTemplate(projectId: string, name: string, layout: WorkspaceLayout): LayoutTemplateRecord {
    const id = makeId('layout')
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO layout_templates (id, project_id, name, layout_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, projectId, name.trim() || 'Untitled layout', JSON.stringify(layout), timestamp, timestamp)
    return this.listLayoutTemplates(projectId).find((template) => template.id === id)!
  }

  createDetachedWindow(
    projectId: string,
    sessionId: string,
    tab: PaneTab,
    sourceLayoutOverride?: WorkspaceLayout
  ): DetachedWindowRecord {
    const session = this.db
      .prepare('SELECT project_id, layout_json FROM sessions WHERE id = ?')
      .get(sessionId) as DbRow | undefined
    if (!session || session.project_id !== projectId) {
      throw new Error('Source session not found for this project')
    }

    const id = makeId('detached')
    const timestamp = now()
    const layout: WorkspaceLayout = {
      version: 1,
      root: {
        type: 'group',
        id: makeId('group'),
        tabs: [tab],
        activeTabId: tab.id
      }
    }
    const sourceLayout = sourceLayoutOverride ?? JSON.parse(session.layout_json as string) as WorkspaceLayout
    const nextSourceLayout = sourceLayoutOverride ?? this.removeLayoutTab(sourceLayout, tab.id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO detached_windows
            (id, project_id, session_id, layout_json, maximized_group_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(id, projectId, sessionId, JSON.stringify(layout), timestamp, timestamp)
      this.db
        .prepare('UPDATE sessions SET layout_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nextSourceLayout), timestamp, sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getDetachedWindow(id)!
  }

  getDetachedWindow(id: string): DetachedWindowRecord | null {
    const row = this.db.prepare('SELECT * FROM detached_windows WHERE id = ?').get(id) as
      | DbRow
      | undefined
    return row ? this.mapDetachedWindow(row) : null
  }

  listDetachedWindows(): DetachedWindowRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM detached_windows WHERE session_id IN (SELECT id FROM sessions WHERE closed_at IS NULL) ORDER BY created_at ASC')
        .all() as DbRow[]
    ).map(this.mapDetachedWindow)
  }

  saveDetachedWindow(
    id: string,
    layout: WorkspaceLayout,
    maximizedGroupId: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE detached_windows
         SET layout_json = ?, maximized_group_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(layout), maximizedGroupId, now(), id)
  }

  closeDetachedWindow(id: string, restoreToWorkspace = false): { sessionId: string; tabs: PaneTab[] } | null {
    const record = this.getDetachedWindow(id)
    if (!record) return null

    const tabs = this.collectLayoutTabs(record.layout)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const source = this.db
        .prepare('SELECT layout_json, closed_tabs_json FROM sessions WHERE id = ?')
        .get(record.sessionId) as DbRow | undefined
      if (source) {
        const closedTabs = JSON.parse((source.closed_tabs_json as string) || '[]') as PaneTab[]
        const returnedIds = new Set(tabs.map((tab) => tab.id))
        const retainedClosedTabs = closedTabs.filter((tab) => !returnedIds.has(tab.id))
        if (restoreToWorkspace && tabs.length) {
          const layout = JSON.parse(source.layout_json as string) as WorkspaceLayout
          let group = layout.root
          while (group.type === 'split') group = group.children[0]
          const existing = new Set(this.collectLayoutTabs(layout).map(tab => tab.id))
          const returning = tabs.filter(tab => !existing.has(tab.id))
          group.tabs.push(...returning)
          if (returning.length) group.activeTabId = returning.at(-1)!.id
          this.db.prepare('UPDATE sessions SET layout_json = ?, maximized_group_id = NULL, closed_tabs_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(layout), JSON.stringify(retainedClosedTabs), now(), record.sessionId)
        } else {
          const nextClosedTabs = [...retainedClosedTabs, ...tabs].slice(-20)
          this.db.prepare('UPDATE sessions SET closed_tabs_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(nextClosedTabs), now(), record.sessionId)
        }
      }
      this.db.prepare('DELETE FROM detached_windows WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { sessionId: record.sessionId, tabs }
  }

  upsertTerminal(spec: TerminalSpec, status: string): string {
    this.db
      .prepare(
        `INSERT INTO terminal_sessions
          (id, project_id, session_id, title, shell, cwd, startup_command, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id, session_id = excluded.session_id,
          title = excluded.title, shell = excluded.shell, cwd = excluded.cwd,
          startup_command = excluded.startup_command, status = excluded.status, updated_at = excluded.updated_at`
      )
      .run(
        spec.id,
        spec.projectId,
        spec.sessionId,
        spec.title,
        spec.shell ?? null,
        spec.cwd,
        spec.startupCommand ?? null,
        status,
        now()
      )
    return this.getTerminalTranscript(spec.id)
  }

  setTerminalStatus(id: string, status: string): void {
    this.db.prepare('UPDATE terminal_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
  }

  getTerminalTranscript(id: string): string {
    const row = this.db.prepare('SELECT transcript FROM terminal_sessions WHERE id = ?').get(id) as
      | DbRow
      | undefined
    return (row?.transcript as string | undefined) ?? ''
  }

  appendTerminalTranscript(id: string, data: string): void {
    this.db
      .prepare(
        `UPDATE terminal_sessions
         SET transcript = substr(transcript || ?, -500000), updated_at = ? WHERE id = ?`
      )
      .run(data, now(), id)
  }

  upsertAgent(spec: AgentSpec, status: string, activityPhase = status === 'starting' ? 'starting' : 'idle'): string {
    this.db
      .prepare(
        `INSERT INTO agent_sessions
          (id, project_id, session_id, provider, title, cwd, resume, model, effort, continue_on_limit, status, activity_phase, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id, session_id = excluded.session_id,
          provider = excluded.provider, title = excluded.title, cwd = excluded.cwd,
          resume = excluded.resume, model = excluded.model, effort = excluded.effort,
          continue_on_limit = excluded.continue_on_limit,
          status = excluded.status, activity_phase = excluded.activity_phase, updated_at = excluded.updated_at`
      )
      .run(
        spec.id,
        spec.projectId,
        spec.sessionId,
        spec.provider,
        spec.title,
        spec.cwd,
        spec.resume ? 1 : 0,
        spec.model ?? null,
        spec.effort ?? 'auto',
        spec.continueOnLimit ? 1 : 0,
        status,
        activityPhase,
        now()
      )
    return this.getAgentTranscript(spec.id)
  }

  setAgentStatus(id: string, status: string, activityPhase?: string): void {
    if (activityPhase) {
      this.db.prepare('UPDATE agent_sessions SET status = ?, activity_phase = ?, updated_at = ? WHERE id = ?')
        .run(status, activityPhase, now(), id)
      return
    }
    this.db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
  }

  getAgentTranscript(id: string): string {
    const row = this.db.prepare('SELECT transcript FROM agent_sessions WHERE id = ?').get(id) as
      | DbRow
      | undefined
    return (row?.transcript as string | undefined) ?? ''
  }

  appendAgentTranscript(id: string, data: string): void {
    this.db
      .prepare(
        `UPDATE agent_sessions
         SET transcript = substr(transcript || ?, -750000), updated_at = ? WHERE id = ?`
      )
      .run(data, now(), id)
  }

  appendEvent(
    projectId: string,
    sessionId: string,
    event: NormalizedAgentEvent
  ): void {
    this.db
      .prepare(
        `INSERT INTO events
          (id, project_id, session_id, source_id, type, message, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        projectId,
        sessionId,
        event.agentSessionId,
        event.type,
        event.message,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.createdAt
      )
  }

  listAgentEvents(agentSessionId: string): NormalizedAgentEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_id, type, message, metadata_json, created_at
         FROM events WHERE source_id = ? ORDER BY created_at DESC LIMIT 80`
      )
      .all(agentSessionId) as DbRow[]
    return rows.reverse().map((row) => ({
      id: row.id as string,
      agentSessionId: row.source_id as string,
      type: row.type as NormalizedAgentEvent['type'],
      message: row.message as string,
      metadata: row.metadata_json
        ? (JSON.parse(row.metadata_json as string) as Record<string, unknown>)
        : undefined,
      createdAt: row.created_at as string
    }))
  }

  saveContinuation(agentId: string, projectId: string, sessionId: string, resumeAt: string): void {
    this.db.prepare(
      `INSERT INTO agent_continuations (agent_id, project_id, session_id, resume_at, status, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(agent_id) DO UPDATE SET project_id = excluded.project_id,
       session_id = excluded.session_id, resume_at = excluded.resume_at,
       status = 'pending', updated_at = excluded.updated_at`
    ).run(agentId, projectId, sessionId, resumeAt, now())
  }

  getContinuation(agentId: string): { resumeAt: string; status: string } | null {
    const row = this.db.prepare('SELECT resume_at, status FROM agent_continuations WHERE agent_id = ?')
      .get(agentId) as DbRow | undefined
    return row ? { resumeAt: row.resume_at as string, status: row.status as string } : null
  }

  completeContinuation(agentId: string): void {
    this.db.prepare("UPDATE agent_continuations SET status = 'resumed', updated_at = ? WHERE agent_id = ?")
      .run(now(), agentId)
  }

  clearContinuation(agentId: string): void {
    this.db.prepare('DELETE FROM agent_continuations WHERE agent_id = ?').run(agentId)
  }

  clearPendingContinuations(): void {
    this.db.prepare("DELETE FROM agent_continuations WHERE status = 'pending'").run()
  }

  /** Every agent's last recorded phase, for every project. The renderer only holds the active
   *  project's workspaces, so cross-project activity has to be answered from here. */
  listAgentActivity(): AgentActivityRow[] {
    return (this.db.prepare(
      'SELECT id, project_id, session_id, activity_phase FROM agent_sessions'
    ).all() as DbRow[]).map((row) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      sessionId: row.session_id as string,
      activityPhase: row.activity_phase ? readActivityPhase(row.activity_phase as string) : 'idle'
    }))
  }

  listProcesses(projectId?: string): RuntimeProcessSummary[] {
    const filter = projectId ? ' WHERE project_id = ?' : ''
    const params = projectId ? [projectId] : []
    const terminals = this.db.prepare(
      `SELECT id, project_id, session_id, title, status, updated_at FROM terminal_sessions${filter}`
    ).all(...params) as DbRow[]
    const agents = this.db.prepare(
      `SELECT a.id, a.project_id, a.session_id, a.title, a.provider, a.model, a.status, a.activity_phase,
              a.updated_at, c.resume_at
       FROM agent_sessions a LEFT JOIN agent_continuations c
         ON c.agent_id = a.id AND c.status = 'pending'
       ${projectId ? 'WHERE a.project_id = ?' : ''}`
    ).all(...params) as DbRow[]
    return [
      ...terminals.map((row) => ({
        id: row.id as string,
        projectId: row.project_id as string,
        sessionId: row.session_id as string,
        kind: 'terminal' as const,
        title: row.title as string,
        status: row.status as RuntimeProcessSummary['status'],
        activityPhase: row.activity_phase ? readActivityPhase(row.activity_phase as string) : 'idle',
        needsInput: false,
        progress: null,
        updatedAt: row.updated_at as string
      })),
      ...agents.map((row) => ({
        id: row.id as string,
        projectId: row.project_id as string,
        sessionId: row.session_id as string,
        kind: 'agent' as const,
        title: row.title as string,
        provider: row.provider as RuntimeProcessSummary['provider'],
        model: (row.model as string | null) ?? undefined,
        status: row.status as RuntimeProcessSummary['status'],
        activityPhase: row.activity_phase ? readActivityPhase(row.activity_phase as string) : 'idle',
        needsInput: row.status === 'waiting_input',
        progress: null,
        resumeAt: (row.resume_at as string | null) ?? undefined,
        updatedAt: row.updated_at as string
      }))
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  remember(input: RememberMemoryInput): AgentMemory {
    const gist = input.gist.replace(/\s+/g, ' ').trim().slice(0, 4000)
    if (!gist) throw new Error('Memory needs a concise gist')
    const cues = normalizeMemoryCues(input.cues?.length ? input.cues : memoryTokens(gist).slice(0, 10))
    const memoryScope = input.agentKey ?? null
    const source = memorySourceOf(input.source)
    const existing = this.listMemories(input.projectId).find((memory) =>
      memory.agentKey === memoryScope && memory.source === source &&
      shouldConsolidateMemory(memory.kind, memory.cues, input.kind, cues)
    )
    const timestamp = now()
    const origin = serializeMemoryOrigin(input.origin)
    if (existing) {
      this.db.prepare(
        `UPDATE memories SET gist = ?, cues_json = ?, salience = ?, strength = ?, confidence = ?,
         occurred_at = ?, updated_at = ?, origin_json = COALESCE(?, origin_json) WHERE id = ?`
      ).run(
        gist.length <= existing.gist.length * 1.4 ? gist : existing.gist,
        JSON.stringify([...new Set([...existing.cues, ...cues])].slice(0, 20)),
        clampMemoryWeight(Math.max(existing.salience, input.salience ?? 0.5)),
        existing.strength + 1,
        clampMemoryWeight(Math.max(existing.confidence, input.confidence ?? 0.75)),
        timestamp,
        timestamp,
        // Consolidation re-attributes the memory to the conversation that last reinforced it,
        // which is the one worth opening when the claim turns out to be wrong.
        origin,
        existing.id
      )
      return this.getMemory(existing.id)!
    }
    const id = makeId('memory')
    this.db.prepare(
      `INSERT INTO memories
       (id, project_id, agent_key, kind, gist, cues_json, salience, strength, confidence,
        occurred_at, last_recalled_at, recall_count, created_at, updated_at, source, origin_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 0, ?, ?, ?, ?)`
    ).run(
      id, input.projectId, input.agentKey ?? null, input.kind, gist, JSON.stringify(cues),
      clampMemoryWeight(input.salience ?? 0.5),
      clampMemoryWeight(input.confidence ?? 0.75),
      timestamp, timestamp, timestamp, source, origin
    )
    return this.getMemory(id)!
  }

  /**
   * A hand correction. Editing an agent-written memory does not rewrite its provenance —
   * who first claimed it stays visible — but it does mark the memory as vouched for, which
   * takes it out of reach of the automatic forgetting pass.
   */
  updateMemory(input: UpdateMemoryInput): AgentMemory {
    const existing = this.getMemory(input.id)
    if (!existing) throw new Error('That memory no longer exists')
    if (input.kind !== undefined && !isMemoryKind(input.kind)) throw new Error('Unknown memory kind')
    const gist = input.gist === undefined ? existing.gist : input.gist.replace(/\s+/g, ' ').trim().slice(0, 4000)
    if (!gist) throw new Error('Memory needs a concise gist')
    const cues = input.cues === undefined
      ? existing.cues
      : normalizeMemoryCues(input.cues.length ? input.cues : memoryTokens(gist).slice(0, 10))
    const timestamp = now()
    this.db.prepare(
      `UPDATE memories SET kind = ?, gist = ?, cues_json = ?, salience = ?, confidence = ?,
       strength = ?, corrected_at = ?, updated_at = ? WHERE id = ?`
    ).run(
      input.kind ?? existing.kind,
      gist,
      JSON.stringify(cues),
      clampMemoryWeight(input.salience ?? existing.salience),
      clampMemoryWeight(input.confidence ?? existing.confidence),
      // Re-weighting rehearsal is how a person says "this matters more than its history
      // suggests"; it is bounded so one slider cannot make a memory permanent.
      Math.min(50, Math.max(0, input.strength ?? existing.strength)),
      timestamp,
      timestamp,
      existing.id
    )
    return this.getMemory(existing.id)!
  }

  /** The visible prune: everything ranked weakest-first, with the reason it is fading.
   *  Nothing is deleted here — the owner decides, which is the point of it being visible. */
  memoryPruneCandidates(projectId: string, limit = 25, currentTime = Date.now()): MemoryPruneCandidate[] {
    return rankMemoriesForPrune(this.listMemories(projectId), currentTime)
      .slice(0, Math.min(200, Math.max(1, limit)))
      .map(({ memory, standing, retrievability, reason }) => ({ memory, standing, retrievability, reason }))
  }

  /** Records what recall actually handed to a turn, keyed by the user message it rode along
   *  with, so the conversation can say which memories steered it. */
  recordMemoryRecall(entry: {
    projectId: string
    agentSessionId: string
    itemId: string
    prompt: string
    memoryIds: string[]
  }): void {
    if (!entry.itemId || !entry.memoryIds.length) return
    this.db.prepare(
      `INSERT INTO memory_recalls (id, project_id, agent_session_id, item_id, prompt, memory_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      makeId('recall'), entry.projectId, entry.agentSessionId, entry.itemId,
      entry.prompt.replace(/\s+/g, ' ').trim().slice(0, 500),
      JSON.stringify(entry.memoryIds.slice(0, 50)), now()
    )
  }

  /** Resolves a conversation's recall ledger against memory as it stands now, so a memory
   *  that was since corrected shows its corrected text and a deleted one is counted, not faked. */
  listMemoryRecalls(agentSessionId: string): TurnMemoryRecall[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_recalls WHERE agent_session_id = ? ORDER BY created_at ASC LIMIT 500'
    ).all(agentSessionId) as DbRow[]
    if (!rows.length) return []
    const byId = new Map(this.listMemories(rows[0]!.project_id as string).map((memory) => [memory.id, memory]))
    return rows.map((row) => {
      let ids: string[] = []
      try { const parsed: unknown = JSON.parse((row.memory_ids_json as string) || '[]'); if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string') } catch { /* a corrupt ledger row still lists nothing rather than failing the pane */ }
      const memories = ids.map((id) => byId.get(id)).filter((memory): memory is AgentMemory => Boolean(memory))
      return {
        itemId: row.item_id as string,
        agentSessionId: row.agent_session_id as string,
        prompt: row.prompt as string,
        createdAt: row.created_at as string,
        memories,
        forgotten: ids.length - memories.length
      }
    })
  }

  listMemories(projectId: string, agentKey?: string): AgentMemory[] {
    const rows = agentKey
      ? this.db.prepare('SELECT * FROM memories WHERE project_id = ? AND (agent_key = ? OR agent_key IS NULL) ORDER BY updated_at DESC').all(projectId, agentKey)
      : this.db.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
    return (rows as DbRow[]).map(this.mapMemory)
  }

  recall(projectId: string, query: string, agentKey?: string, limit = 12): AgentMemory[] {
    const tokens = new Set(memoryTokens(query))
    const currentTime = Date.now()
    const ranked = this.listMemories(projectId, agentKey).map((memory) => {
      const { overlap, score } = scoreMemory(memory, tokens, currentTime)
      return { memory, overlap, score }
    }).filter((item) => tokens.size === 0 || item.overlap > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(50, Math.max(1, limit)))
    const recalledAt = now()
    const statement = this.db.prepare(
      'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ?, updated_at = ? WHERE id = ?'
    )
    for (const { memory } of ranked) statement.run(recalledAt, recalledAt, memory.id)
    return ranked.map(({ memory }) => ({ ...memory, recallCount: memory.recallCount + 1, lastRecalledAt: recalledAt }))
  }

  /** Only unrehearsed, low-stakes episodes decay out; knowledge, policy and anything a human
   *  wrote are what the project is expected to retain. Returns how many were dropped. */
  forgetStaleMemories(projectId: string, currentTime = Date.now()): number {
    const stale = this.listMemories(projectId).filter((memory) => shouldForgetMemory(memory, currentTime))
    for (const memory of stale) this.removeMemory(memory.id)
    return stale.length
  }

  removeMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  private getMemory(id: string): AgentMemory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as DbRow | undefined
    return row ? this.mapMemory(row) : null
  }

  close(): void {
    this.structured.flush()
    this.db.close()
  }

  private mapProject = (row: DbRow): ProjectRecord => ({
    id: row.id as string,
    name: row.name as string,
    path: row.path as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })

  private mapSession = (row: DbRow): SessionRecord => ({
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    layout: JSON.parse(row.layout_json as string) as WorkspaceLayout,
    maximizedGroupId: (row.maximized_group_id as string | null) ?? null,
    closedTabs: JSON.parse((row.closed_tabs_json as string) || '[]') as PaneTab[],
    continueOnLimit: Boolean(row.continue_on_limit),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })

  private mapDetachedWindow = (row: DbRow): DetachedWindowRecord => ({
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    layout: JSON.parse(row.layout_json as string) as WorkspaceLayout,
    maximizedGroupId: (row.maximized_group_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })

  private collectLayoutTabs(layout: WorkspaceLayout): PaneTab[] {
    const collect = (node: WorkspaceLayout['root']): PaneTab[] =>
      node.type === 'group'
        ? node.tabs
        : [...collect(node.children[0]), ...collect(node.children[1])]
    return collect(layout.root)
  }

  private removeLayoutTab(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
    const remove = (
      node: WorkspaceLayout['root']
    ): { node: WorkspaceLayout['root'] | null; removed: boolean } => {
      if (node.type === 'group') {
        const index = node.tabs.findIndex((tab) => tab.id === tabId)
        if (index < 0) return { node, removed: false }
        const tabs = node.tabs.filter((tab) => tab.id !== tabId)
        if (tabs.length === 0) return { node: null, removed: true }
        const activeTabId = node.activeTabId === tabId
          ? tabs[Math.max(0, index - 1)]!.id
          : node.activeTabId
        return { node: { ...node, tabs, activeTabId }, removed: true }
      }

      const first = remove(node.children[0])
      if (first.removed) {
        return {
          node: first.node ? { ...node, children: [first.node, node.children[1]] } : node.children[1],
          removed: true
        }
      }
      const second = remove(node.children[1])
      if (second.removed) {
        return {
          node: second.node ? { ...node, children: [node.children[0], second.node] } : node.children[0],
          removed: true
        }
      }
      return { node, removed: false }
    }

    const result = remove(layout.root)
    return {
      ...layout,
      root: result.node ?? {
        type: 'group',
        id: layout.root.type === 'group' ? layout.root.id : makeId('group'),
        tabs: [],
        activeTabId: ''
      }
    }
  }

  private mapMemory = (row: DbRow): AgentMemory => ({
    id: row.id as string,
    projectId: row.project_id as string,
    agentKey: (row.agent_key as string | null) ?? null,
    kind: row.kind as AgentMemory['kind'],
    source: memorySourceOf(row.source),
    origin: parseMemoryOrigin(row.origin_json),
    gist: row.gist as string,
    cues: JSON.parse((row.cues_json as string) || '[]') as string[],
    salience: Number(row.salience),
    strength: Number(row.strength),
    confidence: Number(row.confidence),
    occurredAt: row.occurred_at as string,
    lastRecalledAt: (row.last_recalled_at as string | null) ?? null,
    recallCount: Number(row.recall_count),
    correctedAt: (row.corrected_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })
}
