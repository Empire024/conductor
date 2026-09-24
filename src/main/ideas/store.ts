import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../../shared/models'
import {
  DEFAULT_INCUBATOR_SETTINGS, IDEA_LINK_KINDS, IDEA_STATUSES, IDEA_STATUS_LABELS, IDEA_TEXT_MAX, ideaPreview, inferIdeaTitle,
  type CaptureIdeaInput, type IdeaActor, type IdeaBrief, type IdeaDetail, type IdeaEvent, type IdeaEventKind, type IdeaExploration,
  type IdeaExplorationStatus, type IdeaIncubatorSettings, type IdeaIntensity, type IdeaLink, type IdeaLinkKind, type IdeaListQuery,
  type IdeaProvenance, type IdeaSection, type IdeaStatus, type IdeaSummary, type IdeasChange, type UpdateIdeaInput
} from '../../shared/ideas'

type Row = Record<string, unknown>

/** Edits this soon after capture still belong to the first sitting and update the original text. */
const FIRST_SITTING_MS = 10 * 60_000
/** Autosaves this close together are one "edited" entry on the timeline. */
const EDIT_COALESCE_MS = 30 * 60_000
/** The incubator leaves a note alone until the owner has stopped typing in it this long. */
const CANDIDATE_QUIET_MS = 10 * 60_000
const CANDIDATE_MIN_CHARS = 8
const EVENTS_SHOWN = 200

export interface LinkInput extends IdeaProvenance { kind: IdeaLinkKind; targetId: string; label: string; projectId?: string }
export interface SectionInput { kind: IdeaSection['kind']; title: string; body: string; brief?: IdeaBrief; createdBy: IdeaSection['createdBy'] }
export interface ExplorationInput { ideaId: string; jobId: string; projectId: string; model: string; intensity: IdeaIntensity; trigger: IdeaExploration['trigger'] }

const parse = <T>(value: unknown, fallback: T): T => { try { return typeof value === 'string' && value ? JSON.parse(value) as T : fallback } catch { return fallback } }
const likeEscape = (value: string): string => value.replace(/[\\%_]/g, match => `\\${match}`)
const cleanTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) throw new Error('tags must be a list of strings')
  return [...new Set(tags.map(tag => String(tag).trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
}

/**
 * The durable side of Ideas (docs/ideas.md). Every write is one transaction and fires a change
 * notification; the owner's text is only ever written by capture/update, never by a section,
 * link or exploration.
 */
export class IdeaStore {
  private readonly db: DatabaseSync
  private readonly listeners = new Set<(change: IdeasChange) => void>()

  constructor(path: string | DatabaseSync, private readonly clock: () => Date = () => new Date()) {
    if (typeof path === 'string') {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
    } else this.db = path
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        original_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'inbox',
        worked_on INTEGER NOT NULL DEFAULT 0,
        captured_from TEXT NOT NULL DEFAULT 'desktop',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_explored_at TEXT
      );
      CREATE INDEX IF NOT EXISTS ideas_updated_idx ON ideas(updated_at);
      CREATE TABLE IF NOT EXISTS idea_links (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        label TEXT NOT NULL,
        project_id TEXT,
        created_from_idea_id TEXT,
        created_by_agent_session_id TEXT,
        created_by_job_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(idea_id, kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idea_links_target_idx ON idea_links(kind, target_id);
      CREATE TABLE IF NOT EXISTS idea_events (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        actor TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idea_events_idea_idx ON idea_events(idea_id, at);
      CREATE TABLE IF NOT EXISTS idea_sections (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        brief TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idea_sections_idea_idx ON idea_sections(idea_id, created_at);
      CREATE TABLE IF NOT EXISTS idea_explorations (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        model TEXT NOT NULL,
        intensity TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        prior_status TEXT NOT NULL,
        note TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idea_explorations_status_idx ON idea_explorations(status, started_at);
      CREATE TABLE IF NOT EXISTS idea_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  close(): void { this.db.close() }

  onChange(listener: (change: IdeasChange) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private changed(ideaId: string | null): void { for (const listener of this.listeners) { try { listener({ ideaId }) } catch (error) { console.warn('Idea listener failed', error) } } }

  private now(): string { return this.clock().toISOString() }

  private transaction<T>(ideaId: string | null, work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    let result: T
    try { result = work(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.changed(ideaId)
    return result
  }

  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(String(id)) as Row | undefined
    if (!row) throw new Error('No idea with that id')
    return row
  }

  exists(id: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM ideas WHERE id = ?').get(String(id))) }

  private insertEvent(ideaId: string, kind: IdeaEventKind, message: string, actor: IdeaActor, data?: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO idea_events (id, idea_id, at, kind, message, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(makeId('ideaevt'), ideaId, this.now(), kind, message.slice(0, 2_000), JSON.stringify(actor), data ? JSON.stringify(data) : null)
  }

  private touch(ideaId: string): void { this.db.prepare('UPDATE ideas SET updated_at = ? WHERE id = ?').run(this.now(), ideaId) }

  capture(input: CaptureIdeaInput, actor: IdeaActor): IdeaDetail {
    const text = String(input.text ?? '')
    if (!text.trim()) throw new Error('An idea cannot be empty')
    if (text.length > IDEA_TEXT_MAX) throw new Error(`An idea is at most ${IDEA_TEXT_MAX} characters`)
    const source = input.source === 'phone' || input.source === 'agent' ? input.source : 'desktop'
    const id = makeId('idea'), now = this.now()
    this.transaction(id, () => {
      this.db.prepare(`INSERT INTO ideas (id, title, text, original_text, status, worked_on, captured_from, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'inbox', 0, ?, '[]', ?, ?)`).run(id, inferIdeaTitle(text), text, text, source, now, now)
      this.insertEvent(id, 'created', `Idea created from ${source === 'agent' ? actor.label ?? 'an agent' : source}`, actor)
    })
    return this.get(id)
  }

  update(id: string, input: UpdateIdeaInput, actor: IdeaActor): IdeaDetail {
    const row = this.row(id)
    if (input.status !== undefined && !IDEA_STATUSES.includes(input.status)) throw new Error('Unknown idea status')
    const tags = input.tags === undefined ? undefined : cleanTags(input.tags)
    this.transaction(id, () => {
      const now = this.now()
      if (input.text !== undefined && input.text !== row.text) {
        const text = String(input.text)
        if (!text.trim()) throw new Error('An idea cannot be empty; archive it instead')
        if (text.length > IDEA_TEXT_MAX) throw new Error(`An idea is at most ${IDEA_TEXT_MAX} characters`)
        const firstSitting = this.clock().getTime() - Date.parse(String(row.created_at)) < FIRST_SITTING_MS
        this.db.prepare(`UPDATE ideas SET text = ?, title = ?, ${firstSitting ? 'original_text = ?,' : ''} updated_at = ? WHERE id = ?`)
          .run(...(firstSitting ? [text, inferIdeaTitle(text), text, now, id] : [text, inferIdeaTitle(text), now, id]))
        const last = this.db.prepare('SELECT id, at, kind, actor FROM idea_events WHERE idea_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(id) as Row | undefined
        const recentEdit = last && last.kind === 'edited' && parse<IdeaActor>(last.actor, { kind: 'owner' }).kind === actor.kind
          && this.clock().getTime() - Date.parse(String(last.at)) < EDIT_COALESCE_MS
        if (recentEdit) this.db.prepare('UPDATE idea_events SET at = ? WHERE id = ?').run(now, String(last.id))
        else this.insertEvent(id, 'edited', 'Note edited', actor)
      }
      if (input.status !== undefined && input.status !== row.status) {
        this.db.prepare('UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?').run(input.status, now, id)
        this.insertEvent(id, 'status', `Marked ${IDEA_STATUS_LABELS[input.status]}`, actor, { from: row.status, to: input.status })
      }
      if (tags) this.db.prepare('UPDATE ideas SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(tags), now, id)
    })
    return this.get(id)
  }

  /** Records related work once per target (a repeat refreshes the label and keeps the first
   *  provenance). `workedOn` marks the idea as worked on and moves a new one to Active. */
  link(ideaId: string, input: LinkInput, actor: IdeaActor, options: { workedOn?: boolean; message?: string } = {}): IdeaLink {
    const row = this.row(ideaId)
    if (!IDEA_LINK_KINDS.includes(input.kind)) throw new Error('Unknown link kind')
    const targetId = String(input.targetId ?? '').trim().slice(0, 1_000)
    if (!targetId) throw new Error('A link needs a target')
    const label = String(input.label ?? '').trim().slice(0, 300) || targetId
    return this.transaction(ideaId, () => {
      const existing = this.db.prepare('SELECT * FROM idea_links WHERE idea_id = ? AND kind = ? AND target_id = ?').get(ideaId, input.kind, targetId) as Row | undefined
      if (existing) this.db.prepare('UPDATE idea_links SET label = ?, project_id = COALESCE(project_id, ?) WHERE id = ?').run(label, input.projectId ?? null, String(existing.id))
      else {
        this.db.prepare(`INSERT INTO idea_links (id, idea_id, kind, target_id, label, project_id, created_from_idea_id, created_by_agent_session_id, created_by_job_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(makeId('idealink'), ideaId, input.kind, targetId, label, input.projectId ?? null,
          input.createdFromIdeaId ?? null, input.createdByAgentSessionId ?? null, input.createdByJobId ?? null, this.now())
        this.insertEvent(ideaId, 'linked', options.message ?? `Linked ${input.kind.replace('-', ' ')}: ${label}`, actor, { kind: input.kind, targetId })
      }
      if (options.workedOn) this.markWorkedOn(ideaId, row, actor, `Worked on: ${label}`)
      this.touch(ideaId)
      return this.linkRow(this.db.prepare('SELECT * FROM idea_links WHERE idea_id = ? AND kind = ? AND target_id = ?').get(ideaId, input.kind, targetId) as Row)
    })
  }

  private markWorkedOn(ideaId: string, row: Row, actor: IdeaActor, message: string): void {
    if (Number(row.worked_on) === 1 && row.status !== 'inbox' && row.status !== 'untouched') return
    this.db.prepare(`UPDATE ideas SET worked_on = 1, status = CASE WHEN status IN ('inbox', 'untouched') THEN 'active' ELSE status END WHERE id = ?`).run(ideaId)
    if (Number(row.worked_on) !== 1) this.insertEvent(ideaId, 'worked-on', message, actor)
  }

  unlink(ideaId: string, linkId: string, actor: IdeaActor): IdeaDetail {
    this.row(ideaId)
    const link = this.db.prepare('SELECT * FROM idea_links WHERE id = ? AND idea_id = ?').get(String(linkId), ideaId) as Row | undefined
    if (!link) throw new Error('No such link on this idea')
    this.transaction(ideaId, () => {
      this.db.prepare('DELETE FROM idea_links WHERE id = ?').run(String(linkId))
      this.insertEvent(ideaId, 'unlinked', `Unlinked ${String(link.kind).replace('-', ' ')}: ${String(link.label)}`, actor)
      this.touch(ideaId)
    })
    return this.get(ideaId)
  }

  links(ideaId: string): IdeaLink[] { return (this.db.prepare('SELECT * FROM idea_links WHERE idea_id = ? ORDER BY created_at, rowid').all(ideaId) as Row[]).map(row => this.linkRow(row)) }

  linkById(linkId: string): IdeaLink | null { const row = this.db.prepare('SELECT * FROM idea_links WHERE id = ?').get(String(linkId)) as Row | undefined; return row ? this.linkRow(row) : null }

  /** Ideas that link to this target (e.g. every idea a conversation was started from). */
  ideasLinkedTo(kind: IdeaLinkKind, targetId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT idea_id FROM idea_links WHERE kind = ? AND target_id = ?').all(kind, targetId) as Row[]).map(row => String(row.idea_id))
  }

  addSection(ideaId: string, input: SectionInput): IdeaSection {
    this.row(ideaId)
    const id = makeId('ideasec')
    this.transaction(ideaId, () => {
      this.db.prepare('INSERT INTO idea_sections (id, idea_id, kind, title, body, brief, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, ideaId, input.kind === 'brief' ? 'brief' : 'note', String(input.title).slice(0, 200), String(input.body).slice(0, 40_000),
          input.brief ? JSON.stringify(input.brief) : null, JSON.stringify(input.createdBy), this.now())
      this.insertEvent(ideaId, 'section', `${input.createdBy.label ?? (input.createdBy.kind === 'job' ? 'A local model' : 'An agent')} added "${String(input.title).slice(0, 120)}"`, input.createdBy, { sectionId: id })
      this.touch(ideaId)
    })
    return this.sections(ideaId).find(section => section.id === id)!
  }

  sections(ideaId: string): IdeaSection[] {
    return (this.db.prepare('SELECT * FROM idea_sections WHERE idea_id = ? ORDER BY created_at DESC, rowid DESC').all(ideaId) as Row[]).map(row => ({
      id: String(row.id), ideaId: String(row.idea_id), kind: row.kind === 'brief' ? 'brief' : 'note', title: String(row.title), body: String(row.body),
      ...(row.brief ? { brief: parse<IdeaBrief>(row.brief, undefined as never) } : {}),
      createdBy: parse<IdeaSection['createdBy']>(row.created_by, { kind: 'agent' }), createdAt: String(row.created_at)
    }))
  }

  event(ideaId: string, kind: IdeaEventKind, message: string, actor: IdeaActor, data?: Record<string, unknown>): void {
    this.row(ideaId)
    this.transaction(ideaId, () => this.insertEvent(ideaId, kind, message, actor, data))
  }

  startExploration(input: ExplorationInput): IdeaExploration {
    const row = this.row(input.ideaId)
    const id = makeId('ideaexp')
    this.transaction(input.ideaId, () => {
      this.db.prepare(`INSERT INTO idea_explorations (id, idea_id, job_id, project_id, model, intensity, trigger, status, prior_status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`).run(id, input.ideaId, input.jobId, input.projectId, input.model, input.intensity, input.trigger,
        row.status === 'exploring' ? 'untouched' : String(row.status), this.now())
      this.db.prepare(`UPDATE ideas SET status = 'exploring', updated_at = updated_at WHERE id = ?`).run(input.ideaId)
      const who = input.trigger === 'incubator' ? 'Idea Incubator' : input.trigger === 'agent' ? 'An agent' : 'You'
      this.insertEvent(input.ideaId, 'exploration-started', `${who} started a ${input.intensity} exploration on ${input.model} (local)`, { kind: 'job', jobId: input.jobId, label: input.model }, { jobId: input.jobId, explorationId: id })
    })
    return this.exploration(id)!
  }

  /** Ends an exploration and restores the status the idea had before it (unless someone changed
   *  it meanwhile). A completed one stamps last_explored_at; it does not count as "worked on". */
  finishExploration(id: string, status: Exclude<IdeaExplorationStatus, 'running'>, note?: string): IdeaExploration {
    const exploration = this.db.prepare('SELECT * FROM idea_explorations WHERE id = ?').get(String(id)) as Row | undefined
    if (!exploration) throw new Error('No such exploration')
    if (exploration.status !== 'running') return this.exploration(String(id))!
    const ideaId = String(exploration.idea_id), now = this.now()
    this.transaction(ideaId, () => {
      this.db.prepare('UPDATE idea_explorations SET status = ?, note = ?, finished_at = ? WHERE id = ?').run(status, note?.slice(0, 2_000) ?? null, now, id)
      const stillRunning = this.db.prepare(`SELECT 1 FROM idea_explorations WHERE idea_id = ? AND status = 'running'`).get(ideaId)
      if (!stillRunning) this.db.prepare(`UPDATE ideas SET status = CASE WHEN status = 'exploring' THEN ? ELSE status END WHERE id = ?`).run(String(exploration.prior_status), ideaId)
      if (status === 'completed') this.db.prepare('UPDATE ideas SET last_explored_at = ? WHERE id = ?').run(now, ideaId)
      const actor: IdeaActor = { kind: 'job', jobId: String(exploration.job_id), label: String(exploration.model) }
      if (status === 'completed') this.insertEvent(ideaId, 'explored', `Explored by ${String(exploration.model)} (local)`, actor, { jobId: exploration.job_id })
      else this.insertEvent(ideaId, 'exploration-stopped', `Exploration stopped${note ? `: ${note}` : ''}`, actor, { jobId: exploration.job_id })
      this.touch(ideaId)
    })
    return this.exploration(String(id))!
  }

  exploration(id: string): IdeaExploration | null {
    const row = this.db.prepare('SELECT * FROM idea_explorations WHERE id = ?').get(String(id)) as Row | undefined
    return row ? this.explorationRow(row) : null
  }

  explorationForJob(jobId: string): IdeaExploration | null {
    const row = this.db.prepare('SELECT * FROM idea_explorations WHERE job_id = ? ORDER BY started_at DESC LIMIT 1').get(String(jobId)) as Row | undefined
    return row ? this.explorationRow(row) : null
  }

  runningExplorations(): IdeaExploration[] { return (this.db.prepare(`SELECT * FROM idea_explorations WHERE status = 'running' ORDER BY started_at`).all() as Row[]).map(row => this.explorationRow(row)) }

  explorationsStartedSince(sinceIso: string, trigger?: IdeaExploration['trigger']): number {
    const row = trigger
      ? this.db.prepare('SELECT COUNT(*) AS n FROM idea_explorations WHERE started_at >= ? AND trigger = ?').get(sinceIso, trigger) as Row
      : this.db.prepare('SELECT COUNT(*) AS n FROM idea_explorations WHERE started_at >= ?').get(sinceIso) as Row
    return Number(row.n)
  }

  /** Oldest untouched ideas first: Inbox or Untouched, never worked on, never explored, nothing
   *  running, the owner not typing in it, and enough text to explore. */
  incubatorCandidates(limit: number): IdeaSummary[] {
    const quietBefore = new Date(this.clock().getTime() - CANDIDATE_QUIET_MS).toISOString()
    const rows = this.db.prepare(`SELECT * FROM ideas WHERE status IN ('inbox', 'untouched') AND worked_on = 0 AND last_explored_at IS NULL AND updated_at <= ?
      AND length(trim(text)) >= ? AND NOT EXISTS (SELECT 1 FROM idea_explorations WHERE idea_id = ideas.id AND status = 'running')
      ORDER BY created_at, rowid LIMIT ?`).all(quietBefore, CANDIDATE_MIN_CHARS, Math.max(0, Math.floor(limit))) as Row[]
    return rows.map(row => this.summary(row))
  }

  list(query: IdeaListQuery = {}): IdeaSummary[] {
    const statuses = (query.statuses?.length ? query.statuses : IDEA_STATUSES.filter(status => status !== 'archived')).filter(status => IDEA_STATUSES.includes(status))
    if (!statuses.length) return []
    const limit = Math.min(Math.max(Math.floor(Number(query.limit ?? 500)) || 500, 1), 2_000)
    const params: Array<string | number> = [...statuses]
    let where = `status IN (${statuses.map(() => '?').join(', ')})`
    const search = String(query.search ?? '').trim().toLowerCase().slice(0, 200)
    if (search) {
      const like = `%${likeEscape(search)}%`
      where += ` AND (lower(text) LIKE ? ESCAPE '\\' OR lower(tags) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM idea_sections s WHERE s.idea_id = ideas.id AND lower(s.body) LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM idea_links l WHERE l.idea_id = ideas.id AND lower(l.label) LIKE ? ESCAPE '\\'))`
      params.push(like, like, like, like)
    }
    const rows = this.db.prepare(`SELECT * FROM ideas WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(...params, limit) as Row[]
    return rows.map(row => this.summary(row))
  }

  get(id: string): IdeaDetail {
    const row = this.row(id)
    const sections = this.sections(id)
    const events = (this.db.prepare('SELECT * FROM idea_events WHERE idea_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(id, EVENTS_SHOWN) as Row[]).map((event): IdeaEvent => ({
      id: String(event.id), ideaId: id, at: String(event.at), kind: event.kind as IdeaEventKind, message: String(event.message),
      actor: parse<IdeaActor>(event.actor, { kind: 'conductor' }), ...(event.data ? { data: parse<Record<string, unknown>>(event.data, {}) } : {})
    }))
    const latestBrief = sections.find(section => section.kind === 'brief')
    return {
      ...this.summary(row), text: String(row.text), originalText: String(row.original_text), links: this.links(id), events, sections,
      explorations: (this.db.prepare('SELECT * FROM idea_explorations WHERE idea_id = ? ORDER BY started_at DESC').all(id) as Row[]).map(item => this.explorationRow(item)),
      ...(latestBrief ? { latestBrief } : {})
    }
  }

  incubatorSettings(): IdeaIncubatorSettings {
    const row = this.db.prepare(`SELECT value FROM idea_settings WHERE key = 'incubator'`).get() as Row | undefined
    return { ...DEFAULT_INCUBATOR_SETTINGS, ...parse<Partial<IdeaIncubatorSettings>>(row?.value, {}) }
  }

  setIncubatorSettings(input: Partial<IdeaIncubatorSettings>): IdeaIncubatorSettings {
    const next = { ...this.incubatorSettings() }
    if (input.enabled !== undefined) next.enabled = input.enabled === true
    if (input.maxPerNight !== undefined) {
      const value = Math.floor(Number(input.maxPerNight))
      if (!Number.isFinite(value)) throw new Error('maxPerNight must be a number')
      next.maxPerNight = Math.min(Math.max(value, 0), 10)
    }
    if (input.intensity !== undefined) {
      if (input.intensity !== 'light' && input.intensity !== 'explore') throw new Error('intensity must be light or explore')
      next.intensity = input.intensity
    }
    this.transaction(null, () => { this.db.prepare(`INSERT INTO idea_settings (key, value) VALUES ('incubator', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next)) })
    return next
  }

  private summary(row: Row): IdeaSummary {
    const counts = this.db.prepare('SELECT kind, COUNT(*) AS n FROM idea_links WHERE idea_id = ? GROUP BY kind').all(String(row.id)) as Row[]
    const exploring = Boolean(this.db.prepare(`SELECT 1 FROM idea_explorations WHERE idea_id = ? AND status = 'running'`).get(String(row.id)))
    return {
      id: String(row.id), title: String(row.title), preview: ideaPreview(String(row.text)), status: row.status as IdeaStatus, workedOn: Number(row.worked_on) === 1,
      capturedFrom: row.captured_from as IdeaSummary['capturedFrom'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(row.last_explored_at ? { lastExploredAt: String(row.last_explored_at) } : {}), exploring,
      linkCounts: Object.fromEntries(counts.map(count => [String(count.kind), Number(count.n)])), tags: parse<string[]>(row.tags, [])
    }
  }

  private linkRow(row: Row): IdeaLink {
    return {
      id: String(row.id), ideaId: String(row.idea_id), kind: row.kind as IdeaLinkKind, targetId: String(row.target_id), label: String(row.label),
      ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      ...(row.created_from_idea_id ? { createdFromIdeaId: String(row.created_from_idea_id) } : {}),
      ...(row.created_by_agent_session_id ? { createdByAgentSessionId: String(row.created_by_agent_session_id) } : {}),
      ...(row.created_by_job_id ? { createdByJobId: String(row.created_by_job_id) } : {}),
      createdAt: String(row.created_at)
    }
  }

  private explorationRow(row: Row): IdeaExploration {
    return {
      id: String(row.id), ideaId: String(row.idea_id), jobId: String(row.job_id), projectId: String(row.project_id), model: String(row.model),
      intensity: row.intensity === 'explore' ? 'explore' : 'light', trigger: row.trigger as IdeaExploration['trigger'], status: row.status as IdeaExplorationStatus,
      ...(row.note ? { note: String(row.note) } : {}), startedAt: String(row.started_at), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {})
    }
  }
}
