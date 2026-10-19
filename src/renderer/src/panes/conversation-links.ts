import type { SessionPhase, TimelineItem } from '../../../shared/structured-agent'
import { resolveFileLinkTarget, type FileLinkProjectRoot } from '../components/file-link-target'
import { collectFileLinkCandidates, type PlainFileLink } from '../components/plain-file-links'
import { codexDirectivesToMarkdown } from '../../../shared/codex-directives'
import { rendererKind, safeExternalLink, toolPresentation } from './StructuredAgentRenderers'

/**
 * The links and files a conversation produced, for its side rail (feature-list e90b679f): links get
 * lost in a long conversation. Everything is derived from the timeline items already in the
 * renderer, item by item, and cached per item object, so a streamed update re-reads only the item
 * it changed.
 *
 * Sources: URLs and file links in agent messages (and in coordinating agents' messages to this
 * one), files an edit tool or a change set wrote, and files attached to a message. A path that is
 * only mentioned in prose is a candidate until the shared stat cache confirms the file exists, the
 * same rule that makes such a path clickable in the message itself.
 */
export interface ConversationLink {
  /** Identity for deduplication: the URL, or the owning project plus the file path. */
  key: string
  kind: 'url' | 'file'
  label: string
  /** The message (timeline item) it came from, for the jump. */
  itemId: string
  sequence: number
  source: 'message' | 'edit' | 'attachment'
  url?: string
  path?: string
  line?: number
  projectId?: string
  machineId?: string
  /** A prose mention: shown only once the file is known to exist. */
  candidate?: PlainFileLink
  /** The file's full path as the agent wrote it, resolved against its project root, for display. */
  absolutePath?: string
}
export interface LinkContext { cwd: string; projectId?: string; projects: FileLinkProjectRoot[]; machineId?: string }

/** Enough for any conversation an owner scrolls back through; the oldest fall off past it. */
export const CONVERSATION_LINK_LIMIT = 300
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`\]\[)(]+(?:\([^\s<>"'`)(]*\)[^\s<>"'`\]\[)(]*)*/gi
// A destination in angle brackets may hold spaces (`[x](<C:/My files/x.pdf>)`).
const MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\(\s*(?:<([^>\n]+)>|([^)\s>]+))(?:\s+"[^"]*")?\s*\)/g

const trimUrl = (value: string): string => value.replace(/[.,;:!?'"*_~]+$/, '')
const shortUrl = (url: string): string => {
  try { const parsed = new URL(url); const path = parsed.pathname === '/' ? '' : parsed.pathname; return (parsed.host + path).slice(0, 80) } catch { return url.slice(0, 80) }
}
const fileKey = (projectId: string | undefined, machineId: string | undefined, path: string): string => 'file\u0000' + (machineId ?? '') + '\u0000' + (projectId ?? '') + '\u0000' + path.toLowerCase()
const baseName = (path: string): string => path.split('/').pop() || path

const absolutePath = (target: { path: string; projectId?: string }, context: LinkContext): string => {
  const root = (target.projectId ? context.projects.find(project => project.id === target.projectId)?.path : context.cwd) ?? context.cwd
  return root ? root.replaceAll('\\', '/').replace(/\/+$/, '') + '/' + target.path : target.path
}

function fileLink(item: TimelineItem, raw: string, context: LinkContext, source: ConversationLink['source']): ConversationLink | null {
  const target = resolveFileLinkTarget(raw, context.cwd, context.projects, context.machineId)
  if (!target) return null
  const projectId = target.projectId ?? context.projectId
  return { key: fileKey(projectId, target.machineId, target.path), kind: 'file', label: baseName(target.path), itemId: item.id, sequence: item.sequence, source, path: target.path, absolutePath: absolutePath(target, context), ...(target.line ? { line: target.line } : {}), ...(projectId ? { projectId } : {}), ...(target.machineId ? { machineId: target.machineId } : {}) }
}

/** What one message says: explicit Markdown links (Codex file citations read as such), bare URLs,
 *  then path-shaped mentions. */
export function messageLinks(item: TimelineItem, written: string, context: LinkContext): ConversationLink[] {
  const text = codexDirectivesToMarkdown(written)
  const links: ConversationLink[] = []
  const seen = new Set<string>()
  const add = (link: ConversationLink | null): void => { if (link && !seen.has(link.key)) { seen.add(link.key); links.push(link) } }
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const label = match[1]!.replace(/[`*_]/g, '').trim(), href = (match[2] ?? match[3]!).trim()
    if (safeExternalLink(href)) add({ key: 'url\u0000' + href, kind: 'url', label: label || shortUrl(href), itemId: item.id, sequence: item.sequence, source: 'message', url: href })
    else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(href)) add(fileLink(item, href, context, 'message'))
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0])
    if (safeExternalLink(url)) add({ key: 'url\u0000' + url, kind: 'url', label: shortUrl(url), itemId: item.id, sequence: item.sequence, source: 'message', url })
  }
  // URLs and link destinations already read are not prose: drop them before looking for path-shaped words.
  const prose = text.replace(MARKDOWN_LINK, ' ').replace(URL_PATTERN, ' ')
  for (const candidate of collectFileLinkCandidates(prose, context.cwd, context.projectId, context.projects, context.machineId)) {
    const projectId = candidate.projectId ?? context.projectId
    const key = fileKey(projectId, candidate.machineId, candidate.path)
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ key, kind: 'file', label: baseName(candidate.path), itemId: item.id, sequence: item.sequence, source: 'message', path: candidate.path, absolutePath: absolutePath(candidate, context), ...(candidate.line ? { line: candidate.line } : {}), ...(projectId ? { projectId } : {}), ...(candidate.machineId ? { machineId: candidate.machineId } : {}), candidate })
  }
  return links
}

/** The links one timeline item contributes, in the order they appear in it. */
export function itemLinks(item: TimelineItem, context: LinkContext): ConversationLink[] {
  const data = item.data
  if (data.type === 'text') {
    const links: ConversationLink[] = []
    const agentWrote = data.role === 'assistant' || (data.role === 'user' && Boolean(data.origin))
    if (agentWrote) links.push(...messageLinks(item, data.text, context))
    for (const attachment of data.attachments ?? []) {
      const link = attachment.path ? fileLink(item, attachment.path, context, 'attachment') : null
      if (link) links.push({ ...link, label: attachment.name || link.label, ...(attachment.startLine ? { line: attachment.startLine } : {}) })
    }
    return links
  }
  if (data.type === 'changes') return data.changes.filter(change => change.status !== 'rejected' && change.kind !== 'delete').flatMap(change => fileLink(item, change.path, context, 'edit') ?? [])
  if (data.type === 'tool' && rendererKind(data.name) === 'edit' && data.status !== 'failed') {
    const path = toolPresentation(data).path
    const link = path ? fileLink(item, path, context, 'edit') : null
    return link ? [link] : []
  }
  return []
}

const cache = new WeakMap<TimelineItem, { context: string; links: ConversationLink[] }>()
const contextKey = (context: LinkContext): string => JSON.stringify([context.cwd, context.projectId ?? '', context.machineId ?? '', context.projects.map(project => project.id + '=' + project.path)])

/** Every link of the conversation, deduplicated, newest first. An item object is read once per
 *  context: timeline items are immutable, so a changed item is a new object and the rest are
 *  served from the cache. */
function cachedItemLinks(item: TimelineItem, context: LinkContext, signature: string): ConversationLink[] {
  let entry = cache.get(item)
  if (!entry || entry.context !== signature) { entry = { context: signature, links: itemLinks(item, context) }; cache.set(item, entry) }
  return entry.links
}

export function conversationLinks(items: readonly TimelineItem[], context: LinkContext, limit = CONVERSATION_LINK_LIMIT): ConversationLink[] {
  const signature = contextKey(context)
  const result: ConversationLink[] = []
  const seen = new Set<string>()
  for (let index = items.length - 1; index >= 0 && result.length < limit; index--) {
    for (const link of cachedItemLinks(items[index]!, context, signature)) {
      if (seen.has(link.key)) continue
      seen.add(link.key)
      result.push(link)
      if (result.length >= limit) break
    }
  }
  return result
}

/** How far back the Delivered group looks for a turn that posted files. */
const DELIVERED_TURNS = 8
const DELIVERED_ITEMS = 600
/**
 * The files the agent handed over (feature-list delivered-outputs-highlight): every file link it
 * posted in the latest turn that posted any, in the order it posted them. A turn is the agent's
 * replies after the latest message to it (the owner's or a coordinating agent's); a nested agent's
 * text and the files an edit tool merely wrote do not count. Prose mentions stay candidates, so
 * the caller passes `shown` (its stat results); `candidates` are the prose mentions it should check.
 */
export function deliveredLinks(items: readonly TimelineItem[], context: LinkContext, shown: (link: ConversationLink) => boolean = () => true): { links: ConversationLink[]; candidates: PlainFileLink[] } {
  const signature = contextKey(context)
  const candidates: PlainFileLink[] = []
  let turn: TimelineItem[] = [], turns = 0
  const settle = (): ConversationLink[] => {
    const links: ConversationLink[] = []
    const seen = new Set<string>()
    for (const item of turn.reverse()) for (const link of cachedItemLinks(item, context, signature)) {
      if (link.kind !== 'file' || link.source !== 'message' || seen.has(link.key)) continue
      seen.add(link.key)
      if (link.candidate) candidates.push(link.candidate)
      if (shown(link)) links.push(link)
    }
    return links
  }
  for (let index = items.length - 1; index >= 0 && index >= items.length - DELIVERED_ITEMS; index--) {
    const item = items[index]!
    if (item.parentId || item.data.type !== 'text') continue
    if (item.data.role === 'assistant') { turn.push(item); continue }
    if (item.data.role !== 'user') continue
    const links = settle()
    if (links.length || ++turns >= DELIVERED_TURNS) return { links, candidates }
    turn = []
  }
  return { links: settle(), candidates }
}
/** Identity of what the Delivered group shows, for "seen": its newest message and its files. */
export const deliveredSignature = (links: readonly ConversationLink[]): string => links.length ? links.at(-1)!.itemId + '\u0000' + links.map(link => link.key).join('\u0000') : ''

const ACTIVE = new Set<SessionPhase>(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
/** The final paragraph of a message, without Markdown emphasis or trailing quotes, for the check. */
export function lastParagraph(text: string): string {
  const paragraphs = text.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)
  return (paragraphs.at(-1) ?? '').replace(/[*_`~"')\]]+$/, '').trim()
}
/**
 * A plain-text question the agent ended its turn with ("Should I also update the docs?"), which no
 * question card represents and so is easy to forget. Heuristic, on purpose: the latest reply of
 * the conversation itself (not a nested agent's), the turn is over, its last paragraph ends with a
 * question mark, and nothing has been said to the agent since.
 */
export function unansweredQuestion(items: readonly TimelineItem[], phase: SessionPhase): { itemId: string; text: string } | null {
  if (ACTIVE.has(phase)) return null
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.parentId || item.data.type !== 'text') continue
    if (item.data.role === 'user') return null
    if (item.data.role !== 'assistant') continue
    const paragraph = lastParagraph(item.data.text)
    return paragraph.endsWith('?') ? { itemId: item.id, text: paragraph.length > 280 ? '…' + paragraph.slice(-279) : paragraph } : null
  }
  return null
}
