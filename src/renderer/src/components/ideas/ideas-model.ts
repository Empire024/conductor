/**
 * Pure view logic for the Ideas view (docs/ideas.md): list filters, relative ages, the "worked on"
 * and "explored" lines, link grouping and provenance, the brief's render data, and the autosave
 * controller that turns keystrokes into one `capture` and then `update` calls without ever letting
 * a stale response move the owner's cursor.
 */
import type {
  IdeaActor, IdeaDetail, IdeaEvent, IdeaLink, IdeaLinkKind, IdeaListQuery, IdeaSection, IdeaStatus, IdeaSummary
} from '../../../../shared/ideas'
import { IDEA_STATUS_LABELS, IDEA_STATUSES } from '../../../../shared/ideas'

// ---------------------------------------------------------------------------------------------
// List filter

/** `active` is the default list: every status except archived. */
export type IdeaFilter = 'active' | IdeaStatus

export const IDEA_FILTERS: ReadonlyArray<{ id: IdeaFilter; label: string }> = [
  { id: 'active', label: 'All active' },
  ...IDEA_STATUSES.map(status => ({ id: status as IdeaFilter, label: IDEA_STATUS_LABELS[status] }))
]

export const IDEA_LIST_LIMIT = 500

export function ideaListQuery(filter: IdeaFilter, search: string): IdeaListQuery {
  const query: IdeaListQuery = { limit: IDEA_LIST_LIMIT }
  const term = search.trim()
  if (term) query.search = term
  if (filter !== 'active') query.statuses = [filter]
  return query
}

// ---------------------------------------------------------------------------------------------
// Time labels

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A compact age for a list row: "just now", "5 min", "3 h", "yesterday", "4 d", "3 wk", a date. */
export function relativeAge(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h`
  if (diff < 2 * DAY) return 'yesterday'
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d`
  if (diff < 5 * 7 * DAY) return `${Math.floor(diff / (7 * DAY))} wk`
  return formatDate(iso, now)
}

/** "12 Mar" in the current year, "12 Mar 2025" otherwise. */
export function formatDate(iso: string, now: number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "12 Mar, 14:05" for timeline entries and authorship lines. */
export function formatDateTime(iso: string, now: number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${formatDate(iso, now)}, ${time}`
}

// ---------------------------------------------------------------------------------------------
// Worked on / explored

export type IdeaProgressTone = 'worked' | 'explored' | 'untouched'

/** The small indicator on a list row: worked on beats explored beats never touched. */
export function ideaProgress(idea: Pick<IdeaSummary, 'workedOn' | 'lastExploredAt'>): { label: string; tone: IdeaProgressTone } {
  if (idea.workedOn) return { label: 'Worked on', tone: 'worked' }
  if (idea.lastExploredAt) return { label: 'Explored', tone: 'explored' }
  return { label: 'Never touched', tone: 'untouched' }
}

export function workedOnLine(idea: Pick<IdeaSummary, 'workedOn'>): string {
  return idea.workedOn ? 'Yes' : 'No'
}

export function exploredLine(idea: Pick<IdeaSummary, 'lastExploredAt' | 'exploring'>, now: number): string {
  if (idea.exploring) return idea.lastExploredAt ? `exploring now (last ${formatDate(idea.lastExploredAt, now)})` : 'exploring now'
  return idea.lastExploredAt ? formatDate(idea.lastExploredAt, now) : 'never'
}

export function isExploring(idea: Pick<IdeaSummary, 'exploring' | 'status'>): boolean {
  return idea.exploring || idea.status === 'exploring'
}

/** The original note is worth showing only when the current text has moved away from it. */
export function showOriginalText(idea: Pick<IdeaDetail, 'text' | 'originalText'>): boolean {
  return Boolean(idea.originalText.trim()) && idea.originalText.trim() !== idea.text.trim()
}

/** The project the idea is already tied to, used as the default for Work on / Create task. */
export function defaultProjectId(idea: Pick<IdeaDetail, 'links'> | null, projectIds: string[]): string {
  const linked = idea?.links.find(link => link.kind === 'project' && projectIds.includes(link.targetId))?.targetId
    ?? idea?.links.find(link => link.projectId && projectIds.includes(link.projectId))?.projectId
  return linked ?? projectIds[0] ?? ''
}

// ---------------------------------------------------------------------------------------------
// Links

export const IDEA_LINK_GROUP_LABELS: Readonly<Record<IdeaLinkKind, string>> = {
  'agent-session': 'Conversations', task: 'Tasks', memory: 'Memories', artifact: 'Artifacts', job: 'Jobs', project: 'Projects'
}
const LINK_GROUP_ORDER: IdeaLinkKind[] = ['agent-session', 'task', 'memory', 'artifact', 'job', 'project']

export interface IdeaLinkGroup { kind: IdeaLinkKind; label: string; links: IdeaLink[] }

/** Links grouped by kind in a fixed order, newest first inside each group; empty groups dropped. */
export function groupIdeaLinks(links: IdeaLink[]): IdeaLinkGroup[] {
  return LINK_GROUP_ORDER.map(kind => ({
    kind,
    label: IDEA_LINK_GROUP_LABELS[kind],
    links: links.filter(link => link.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })).filter(group => group.links.length > 0)
}

/** Where a link came from, in words: "Created from this idea · by a conversation · by job 1a2b3c4d". */
export function linkProvenance(link: IdeaLink): string {
  const parts: string[] = []
  if (link.createdFromIdeaId) parts.push(link.createdFromIdeaId === link.ideaId ? 'created from this idea' : 'created from another idea')
  if (link.createdByJobId) parts.push(`by job ${shortId(link.createdByJobId)}`)
  else if (link.createdByAgentSessionId) parts.push(`by conversation ${shortId(link.createdByAgentSessionId)}`)
  if (!parts.length) parts.push('linked by the owner')
  const text = parts.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** Link counts summarized for a list row: "2 conversations · 1 task". */
export function linkCountsLine(counts: Partial<Record<IdeaLinkKind, number>>): string {
  const nouns: Record<IdeaLinkKind, [string, string]> = {
    'agent-session': ['conversation', 'conversations'], task: ['task', 'tasks'], memory: ['memory', 'memories'],
    artifact: ['artifact', 'artifacts'], job: ['job', 'jobs'], project: ['project', 'projects']
  }
  return LINK_GROUP_ORDER.filter(kind => (counts[kind] ?? 0) > 0)
    .map(kind => { const count = counts[kind] ?? 0; return `${count} ${nouns[kind][count === 1 ? 0 : 1]}` })
    .join(' · ')
}

// ---------------------------------------------------------------------------------------------
// Actors, timeline and briefs

export function actorLabel(actor: IdeaActor): string {
  if (actor.label?.trim()) return actor.label.trim()
  switch (actor.kind) {
    case 'owner': return 'You'
    case 'agent': return actor.agentSessionId ? `Agent ${shortId(actor.agentSessionId)}` : 'An agent'
    case 'job': return actor.jobId ? `Job ${shortId(actor.jobId)}` : 'A job'
    default: return 'Conductor'
  }
}

/** Newest first, whatever order the events arrived in. */
export function timelineEvents(events: IdeaEvent[]): IdeaEvent[] {
  return [...events].sort((a, b) => b.at.localeCompare(a.at))
}

export type IdeaBriefView =
  | { kind: 'structured'; concept: string; openQuestions: string[]; nextStep: string; observations: string[]; relatedMemoryIds: string[] }
  | { kind: 'body'; body: string }

export function briefView(section: IdeaSection): IdeaBriefView {
  const brief = section.brief
  if (brief && (brief.concept.trim() || brief.nextStep.trim() || brief.openQuestions.length || brief.observations.length)) {
    return {
      kind: 'structured',
      concept: brief.concept.trim(),
      openQuestions: brief.openQuestions.map(item => item.trim()).filter(Boolean),
      nextStep: brief.nextStep.trim(),
      observations: brief.observations.map(item => item.trim()).filter(Boolean),
      relatedMemoryIds: brief.relatedMemoryIds
    }
  }
  return { kind: 'body', body: section.body }
}

/** "Written by Qwen on MAIN · qwen3-14b · 12 Mar, 03:10" */
export function sectionAuthorLine(section: IdeaSection, now: number): string {
  const parts = [actorLabel(section.createdBy)]
  if (section.createdBy.model && !parts[0]!.includes(section.createdBy.model)) parts.push(section.createdBy.model)
  if (section.createdBy.machine && !parts.some(part => part.includes(section.createdBy.machine!))) parts.push(`on ${section.createdBy.machine}`)
  parts.push(formatDateTime(section.createdAt, now))
  return `Written by ${parts.filter(Boolean).join(' · ')}`
}

/** An IPC failure without Electron's "Error invoking remote method 'ideas:x': Error:" wrapper. */
export function ideaErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(\w*Error):\s*/, '').trim() || 'Something went wrong.'
}

// ---------------------------------------------------------------------------------------------
// Incubator settings

export function clampMaxPerNight(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(10, Math.max(1, Math.round(value)))
}

// ---------------------------------------------------------------------------------------------
// Autosave

export const IDEA_AUTOSAVE_DELAY_MS = 600

export type IdeaSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface IdeaAutosaveBackend {
  capture(text: string): Promise<IdeaDetail>
  update(ideaId: string, text: string): Promise<IdeaDetail>
}

export interface IdeaAutosaveOptions {
  delayMs?: number
  /** A save landed. `created` is true for the capture that gave a new note its id. */
  onSaved?(detail: IdeaDetail, info: { created: boolean; text: string }): void
  onState?(state: IdeaSaveState): void
  onError?(error: unknown): void
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

/**
 * One note's autosave. A new note (`ideaId` null) is created by `capture` on its first
 * non-whitespace text; later text goes through `update`. Requests are serialized: while one is in
 * flight, newer keystrokes wait and are sent next, so the server always ends on the latest text
 * and no response ever writes text back into the editor. An empty note is never created and a
 * note is never saved empty. One instance per note: switching notes flushes the old instance and
 * makes a new one, so a late response can only touch the note it belongs to.
 */
export class IdeaAutosave {
  private currentText: string
  private savedText: string
  private timer: unknown = null
  private running: Promise<void> | null = null
  private failed = false
  private revisionCount = 0
  private readonly delayMs: number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly backend: IdeaAutosaveBackend, private id: string | null, initialText: string, private readonly options: IdeaAutosaveOptions = {}) {
    this.currentText = initialText
    this.savedText = initialText
    this.delayMs = options.delayMs ?? IDEA_AUTOSAVE_DELAY_MS
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get ideaId(): string | null { return this.id }
  /** Bumps on every keystroke and every landed save; a server read taken at an older revision is stale. */
  get revision(): number { return this.revisionCount }
  get text(): string { return this.currentText }
  /** Local text the server has not acknowledged yet (typed, waiting, or in flight). */
  get dirty(): boolean { return this.currentText !== this.savedText || this.running !== null }

  edit(text: string): void {
    this.currentText = text
    this.failed = false
    this.revisionCount++
    this.cancelTimer()
    if (!this.hasSomethingToSave()) { this.options.onState?.(this.running ? 'saving' : 'idle'); return }
    this.options.onState?.('pending')
    this.timer = this.setTimer(() => { this.timer = null; void this.save() }, this.delayMs)
  }

  /** Saves now (blur, close, switching notes) and resolves once the latest text has landed. */
  async flush(): Promise<void> {
    this.cancelTimer()
    await this.save()
  }

  /**
   * A server copy of the note (a phone edit, a refresh). It replaces the local text only when
   * nothing local is waiting and, when `sinceRevision` is given, nothing was typed or saved since
   * the read started; returns whether the editor should show it.
   */
  acceptServerText(text: string, sinceRevision?: number): boolean {
    if (this.dirty || this.timer !== null || this.failed) return false
    if (sinceRevision !== undefined && sinceRevision !== this.revisionCount) return false
    this.currentText = text
    this.savedText = text
    return true
  }

  private hasSomethingToSave(): boolean {
    return this.currentText !== this.savedText && Boolean(this.currentText.trim())
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private save(): Promise<void> {
    if (this.running) return this.running.then(() => (this.hasSomethingToSave() && !this.failed ? this.save() : undefined))
    if (!this.hasSomethingToSave()) return Promise.resolve()
    this.running = this.loop().finally(() => { this.running = null })
    return this.running
  }

  private async loop(): Promise<void> {
    this.options.onState?.('saving')
    while (this.hasSomethingToSave()) {
      const sending = this.currentText
      const created = this.id === null
      let detail: IdeaDetail
      try {
        detail = created ? await this.backend.capture(sending) : await this.backend.update(this.id!, sending)
      } catch (error) {
        this.failed = true
        this.options.onState?.('error')
        this.options.onError?.(error)
        return
      }
      if (created) this.id = detail.id
      this.savedText = sending
      this.revisionCount++
      this.options.onSaved?.(detail, { created, text: sending })
    }
    this.options.onState?.(this.timer !== null ? 'pending' : 'saved')
  }
}
