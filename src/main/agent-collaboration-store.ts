import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId, type LayoutNode, type WorkspaceLayout } from '../shared/models'
import type {
  AgentCollaborationMessage,
  AgentCollaborationMessageQuery,
  AgentCollaborationMessageKind,
  AgentCollaborationSnapshot,
  AgentFilePresence,
  AgentPresenceQuery,
  AnnounceFilePresenceInput,
  FileConflictQuery,
  FilePresenceAnnouncement,
  FilePresenceState,
  FileWorkConflict,
  FileWorkIntent,
  PostAgentCollaborationMessageInput
} from '../shared/agent-collaboration'

type DbRow = Record<string, unknown>

const messageKinds = new Set<AgentCollaborationMessageKind>([
  'activity', 'intent', 'question', 'handoff', 'warning', 'completion'
])
const workIntents = new Set<FileWorkIntent>(['view', 'edit', 'create', 'delete', 'execute'])
const exclusiveIntents = new Set<FileWorkIntent>(['edit', 'create', 'delete'])
const now = (): string => new Date().toISOString()

const compactText = (value: string, label: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

/** Normalize a reported path and reject anything outside the project root. */
export const normalizeCollaborationPath = (projectRoot: string, requestedPath: string): string => {
  let candidate = requestedPath.trim().replace(/^['"`]|['"`]$/g, '')
  candidate = candidate.replace(/^file:\/\//i, '')
  // File mentions commonly include a trailing line and optional column.
  candidate = candidate.replace(/:(\d+)(?::\d+)?$/, '')
  if (!candidate) throw new Error('File path is required')

  const absolute = isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)
    ? resolve(candidate)
    : resolve(projectRoot, candidate)
  const projectRelative = relative(resolve(projectRoot), absolute)
  if (
    projectRelative === '..' ||
    projectRelative.startsWith(`..\\`) ||
    projectRelative.startsWith('../') ||
    isAbsolute(projectRelative)
  ) {
    throw new Error('File path is outside the project')
  }
  const normalized = projectRelative.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.length > 1024) throw new Error('File path is invalid')
  return normalized
}

export const conflictSeverity = (
  requestedIntent: FileWorkIntent,
  existingIntent: FileWorkIntent
): FileWorkConflict['severity'] | null => {
  if (!exclusiveIntents.has(requestedIntent) && !exclusiveIntents.has(existingIntent)) return null
  return exclusiveIntents.has(requestedIntent) && exclusiveIntents.has(existingIntent)
    ? 'blocking'
    : 'advisory'
}

/** Durable live-agent messages and expiring file work leases in conductor.db. */
export class AgentCollaborationStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_collaboration_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        to_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        paths_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS collaboration_messages_project_idx
        ON agent_collaboration_messages(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS collaboration_messages_session_idx
        ON agent_collaboration_messages(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_file_presence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        intent TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        UNIQUE(agent_session_id, path_key)
      );

      CREATE INDEX IF NOT EXISTS file_presence_project_path_idx
        ON agent_file_presence(project_id, path_key, expires_at DESC);
      CREATE INDEX IF NOT EXISTS file_presence_session_idx
        ON agent_file_presence(session_id, heartbeat_at DESC);
    `)
  }

  snapshot(query: AgentCollaborationMessageQuery): AgentCollaborationSnapshot {
    return {
      messages: this.listMessages(query),
      presence: this.listPresence({ projectId: query.projectId, sessionId: query.sessionId })
    }
  }

  postMessage(input: PostAgentCollaborationMessageInput): AgentCollaborationMessage {
    const scope = this.requireAgentScope(input.agentSessionId)
    if (scope.projectId !== input.projectId || scope.sessionId !== input.sessionId) {
      throw new Error('Agent session does not match this project workspace')
    }
    if (!messageKinds.has(input.kind)) throw new Error('Invalid collaboration message kind')
    if (input.toAgentSessionId) {
      const recipient = this.requireAgentScope(input.toAgentSessionId)
      if (recipient.projectId !== input.projectId) {
        throw new Error('Collaboration messages cannot cross projects')
      }
    }
    const projectRoot = this.requireProjectRoot(input.projectId)
    const paths = [...new Set((input.paths ?? []).map((path) =>
      normalizeCollaborationPath(projectRoot, path)
    ))].slice(0, 20)
    const id = makeId('collaboration-message')
    const createdAt = now()
    this.db.prepare(
      `INSERT INTO agent_collaboration_messages
       (id, project_id, session_id, agent_session_id, to_agent_session_id, kind,
        body, paths_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      input.sessionId,
      input.agentSessionId,
      input.toAgentSessionId ?? null,
      input.kind,
      compactText(input.body, 'Message', 4000),
      JSON.stringify(paths),
      input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt
    )
    return this.getMessage(id)!
  }

  listMessages(query: AgentCollaborationMessageQuery): AgentCollaborationMessage[] {
    this.requireProjectRoot(query.projectId)
    const conditions = ['project_id = ?']
    const params: Array<string | number> = [query.projectId]
    if (query.sessionId) {
      conditions.push('session_id = ?')
      params.push(query.sessionId)
    }
    if (query.agentSessionId) {
      const scope = this.requireAgentScope(query.agentSessionId)
      if (scope.projectId !== query.projectId) throw new Error('Agent session does not belong to this project')
      conditions.push('(to_agent_session_id IS NULL OR to_agent_session_id = ? OR agent_session_id = ?)')
      params.push(query.agentSessionId, query.agentSessionId)
    }
    const limit = Math.min(200, Math.max(1, query.limit ?? 60))
    params.push(limit)
    const rows = this.db.prepare(
      `SELECT * FROM agent_collaboration_messages WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT ?`
    ).all(...params) as DbRow[]
    return rows.reverse().map(this.mapMessage)
  }

  announcePresence(input: AnnounceFilePresenceInput): FilePresenceAnnouncement {
    const scope = this.requireAgentScope(input.agentSessionId)
    if (scope.projectId !== input.projectId || scope.sessionId !== input.sessionId) {
      throw new Error('Agent session does not match this project workspace')
    }
    if (!workIntents.has(input.intent)) throw new Error('Invalid file work intent')
    const projectRoot = this.requireProjectRoot(input.projectId)
    const path = normalizeCollaborationPath(projectRoot, input.path)
    const timestamp = now()
    this.expireStale(timestamp)
    const conflicts = this.findConflicts(input.projectId, input.agentSessionId, path, input.intent)
    const granted = !conflicts.some((conflict) => conflict.severity === 'blocking')
    const requestedState = input.state ?? 'active'
    const state: FilePresenceState = requestedState === 'idle'
      ? 'idle'
      : (granted ? 'active' : 'blocked')
    const ttlSeconds = Math.min(900, Math.max(15, Math.round(input.ttlSeconds ?? 90)))
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    const id = makeId('file-presence')

    this.db.prepare(
      `INSERT INTO agent_file_presence
       (id, project_id, session_id, agent_session_id, path, path_key, intent, state,
        detail, acquired_at, heartbeat_at, expires_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(agent_session_id, path_key) DO UPDATE SET
         project_id = excluded.project_id,
         session_id = excluded.session_id,
         path = excluded.path,
         intent = excluded.intent,
         state = excluded.state,
         detail = excluded.detail,
         acquired_at = CASE
           WHEN agent_file_presence.state = 'active' AND excluded.state = 'active'
             THEN agent_file_presence.acquired_at
           ELSE excluded.acquired_at
         END,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at,
         released_at = NULL`
    ).run(
      id,
      input.projectId,
      input.sessionId,
      input.agentSessionId,
      path,
      path.toLowerCase(),
      input.intent,
      state,
      (input.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      timestamp,
      timestamp,
      expiresAt
    )
    return {
      presence: this.getPresence(input.agentSessionId, path)!,
      granted,
      conflicts
    }
  }

  listPresence(query: AgentPresenceQuery): AgentFilePresence[] {
    this.requireProjectRoot(query.projectId)
    this.expireStale(now())
    const conditions = ['project_id = ?', "state NOT IN ('released', 'expired')"]
    const params: string[] = [query.projectId]
    if (query.sessionId) {
      conditions.push('session_id = ?')
      params.push(query.sessionId)
    }
    if (!query.includeIdle) conditions.push("state != 'idle'")
    return (this.db.prepare(
      `SELECT * FROM agent_file_presence WHERE ${conditions.join(' AND ')}
       ORDER BY path_key ASC, heartbeat_at DESC`
    ).all(...params) as DbRow[]).map(this.mapPresence)
  }

  detectConflicts(query: FileConflictQuery): FileWorkConflict[] {
    const scope = this.requireAgentScope(query.agentSessionId)
    if (scope.projectId !== query.projectId) throw new Error('Agent session does not belong to this project')
    if (!workIntents.has(query.intent)) throw new Error('Invalid file work intent')
    const path = normalizeCollaborationPath(this.requireProjectRoot(query.projectId), query.path)
    this.expireStale(now())
    return this.findConflicts(query.projectId, query.agentSessionId, path, query.intent)
  }

  releasePresence(agentSessionId: string, requestedPath?: string): void {
    const scope = this.requireAgentScope(agentSessionId)
    const timestamp = now()
    if (requestedPath) {
      const path = normalizeCollaborationPath(this.requireProjectRoot(scope.projectId), requestedPath)
      this.db.prepare(
        `UPDATE agent_file_presence SET state = 'released', released_at = ?, expires_at = ?, heartbeat_at = ?
         WHERE agent_session_id = ? AND path_key = ?`
      ).run(timestamp, timestamp, timestamp, agentSessionId, path.toLowerCase())
      return
    }
    this.db.prepare(
      `UPDATE agent_file_presence SET state = 'released', released_at = ?, expires_at = ?, heartbeat_at = ?
       WHERE agent_session_id = ? AND state NOT IN ('released', 'expired')`
    ).run(timestamp, timestamp, timestamp, agentSessionId)
  }

  buildBriefing(agentSessionId: string, maxCharacters = 1800): string {
    const scope = this.requireAgentScope(agentSessionId)
    const presence = this.listPresence({ projectId: scope.projectId, includeIdle: false })
      .filter((item) => item.agentSessionId !== agentSessionId && item.state === 'active')
    const messages = this.listMessages({
      projectId: scope.projectId,
      agentSessionId,
      limit: 30
    }).filter((message) => message.agentSessionId !== agentSessionId).slice(-10)
    if (presence.length === 0 && messages.length === 0) return ''

    const agents = this.agentLabels(scope.projectId), tabs = this.agentTabs(scope.projectId)
    const location = (workspaceId: string, id: string): string =>
      `${workspaceId === scope.sessionId ? 'this workspace' : 'another workspace'}=${workspaceId}; agent=${id}; tab=${tabs.get(workspaceId + ':' + id)?.join(',') ?? 'none'}`
    const lines = [
      `[Conductor coworker briefing — project-wide; generated ${now()}; other workspaces are included]`,
      '- Recorded coordination, not live execution evidence. Refresh app.state, agents.list and agents.snapshot for current phase and results; old intents may be stale.',
      '- Coordinate before overlapping edits. Treat active exclusive file work as owned until its lease expires or is released.'
    ]
    for (const item of presence) {
      lines.push(`- Active ${item.intent} lease from ${agents.get(item.agentSessionId) ?? item.agentSessionId}: ${item.path} (${location(item.sessionId, item.agentSessionId)}; heartbeat=${item.heartbeatAt}; expires=${item.expiresAt}).`)
    }
    // Most recent records first, so a bounded briefing does not prefer stale intents.
    for (const message of [...messages].reverse()) {
      const paths = message.paths.length ? ` [${message.paths.join(', ')}]` : ''
      lines.push(`- Recorded ${message.kind} at ${message.createdAt} from ${agents.get(message.agentSessionId) ?? message.agentSessionId} (${location(message.sessionId, message.agentSessionId)}): ${message.body}${paths}`)
    }

    let result = ''
    for (const line of lines) {
      if (result.length + line.length + 1 > Math.max(400, maxCharacters)) break
      result += `${result ? '\n' : ''}${line}`
    }
    return result
  }

  close(): void {
    this.db.close()
  }

  private findConflicts(
    projectId: string,
    agentSessionId: string,
    path: string,
    requestedIntent: FileWorkIntent
  ): FileWorkConflict[] {
    const rows = this.db.prepare(
      `SELECT * FROM agent_file_presence
       WHERE project_id = ? AND path_key = ? AND agent_session_id != ?
         AND state = 'active' AND released_at IS NULL AND expires_at > ?
       ORDER BY heartbeat_at DESC`
    ).all(projectId, path.toLowerCase(), agentSessionId, now()) as DbRow[]
    return rows.flatMap((row) => {
      const presence = this.mapPresence(row)
      const severity = conflictSeverity(requestedIntent, presence.intent)
      if (!severity) return []
      const reason = severity === 'blocking'
        ? `Another agent holds an exclusive ${presence.intent} lease for ${path}`
        : `Another agent is ${presence.intent}ing ${path}`
      return [{ path, severity, reason, presence }]
    })
  }

  private expireStale(timestamp: string): void {
    this.db.prepare(
      `UPDATE agent_file_presence SET state = 'expired', released_at = ?
       WHERE released_at IS NULL AND expires_at <= ? AND state NOT IN ('released', 'expired')`
    ).run(timestamp, timestamp)
  }

  private requireProjectRoot(projectId: string): string {
    const row = this.db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
      | DbRow
      | undefined
    if (!row) throw new Error('Project not found')
    return row.path as string
  }

  private requireAgentScope(agentSessionId: string): { projectId: string; sessionId: string } {
    const row = this.db.prepare(
      'SELECT project_id, session_id FROM agent_sessions WHERE id = ?'
    ).get(agentSessionId) as DbRow | undefined
    if (!row) throw new Error('Agent session not found')
    return { projectId: row.project_id as string, sessionId: row.session_id as string }
  }

  private agentTabs(projectId: string): Map<string, string[]> {
    const result = new Map<string, string[]>()
    const rows = this.db.prepare(`
      SELECT id AS session_id, layout_json FROM sessions WHERE project_id = ? AND closed_at IS NULL
      UNION ALL
      SELECT d.session_id, d.layout_json FROM detached_windows d
      JOIN sessions s ON s.id = d.session_id WHERE d.project_id = ? AND s.closed_at IS NULL
    `).all(projectId, projectId) as DbRow[]
    for (const row of rows) {
      const visit = (node: LayoutNode): void => {
        if (node.type === 'split') { node.children.forEach(visit); return }
        for (const tab of node.tabs) if (tab.kind === 'agent' && tab.resourceId) {
          const key = row.session_id + ':' + tab.resourceId
          result.set(key, [...(result.get(key) ?? []), tab.id])
        }
      }
      visit((JSON.parse(row.layout_json as string) as WorkspaceLayout).root)
    }
    return result
  }

  private agentLabels(projectId: string): Map<string, string> {
    const rows = this.db.prepare(
      'SELECT id, title, provider FROM agent_sessions WHERE project_id = ?'
    ).all(projectId) as DbRow[]
    return new Map(rows.map((row) => [
      row.id as string,
      `${row.title as string} (${row.provider as string})`
    ]))
  }

  private getMessage(id: string): AgentCollaborationMessage | null {
    const row = this.db.prepare('SELECT * FROM agent_collaboration_messages WHERE id = ?').get(id) as
      | DbRow
      | undefined
    return row ? this.mapMessage(row) : null
  }

  private getPresence(agentSessionId: string, path: string): AgentFilePresence | null {
    const row = this.db.prepare(
      'SELECT * FROM agent_file_presence WHERE agent_session_id = ? AND path_key = ?'
    ).get(agentSessionId, path.toLowerCase()) as DbRow | undefined
    return row ? this.mapPresence(row) : null
  }

  private mapMessage = (row: DbRow): AgentCollaborationMessage => ({
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    agentSessionId: row.agent_session_id as string,
    toAgentSessionId: (row.to_agent_session_id as string | null) ?? null,
    kind: row.kind as AgentCollaborationMessageKind,
    body: row.body as string,
    paths: JSON.parse((row.paths_json as string) || '[]') as string[],
    metadata: row.metadata_json
      ? JSON.parse(row.metadata_json as string) as Record<string, unknown>
      : null,
    createdAt: row.created_at as string
  })

  private mapPresence = (row: DbRow): AgentFilePresence => ({
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    agentSessionId: row.agent_session_id as string,
    path: row.path as string,
    intent: row.intent as FileWorkIntent,
    state: row.state as FilePresenceState,
    detail: row.detail as string,
    acquiredAt: row.acquired_at as string,
    heartbeatAt: row.heartbeat_at as string,
    expiresAt: row.expires_at as string,
    releasedAt: (row.released_at as string | null) ?? null
  })
}
