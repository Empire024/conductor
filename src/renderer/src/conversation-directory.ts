import { useEffect, useState } from 'react'
import { conductorUri } from '../../shared/agent-control'
import type { LayoutNode, PaneKind, SessionRecord } from '../../shared/models'

/**
 * Every tab open in this window, across every project and workspace, keyed by the ids agents and
 * Conductor write into conversations: an agentSessionId (`agent_…`), a tab id (`tab_…`/`pane_…`)
 * or a `conductor://<project>/tab/<id>` uri. It is built in the renderer from state Conductor
 * already holds (the live sessions of the project on screen, `sessions.list` for the others), so
 * resolving an id in a rendered message costs no IPC and nothing reaches any model.
 */
export interface DirectoryEntry {
  tabId: string
  kind: PaneKind
  title: string
  agentSessionId?: string
  projectId: string
  projectName: string
  sessionId: string
  workspaceName: string
  uri: string
}
export interface ConversationDirectory {
  entries: DirectoryEntry[]
  byAgent: ReadonlyMap<string, DirectoryEntry>
  byTab: ReadonlyMap<string, DirectoryEntry>
}
export interface DirectoryProject { id: string; name: string }

const tabsOf = (node: LayoutNode, visit: (tab: { id: string; kind: PaneKind; title: string; resourceId?: string }) => void): void => {
  if (node.type === 'split') { tabsOf(node.children[0], visit); tabsOf(node.children[1], visit); return }
  node.tabs.forEach(visit)
}

export function buildConversationDirectory(projects: readonly DirectoryProject[], sessions: readonly SessionRecord[]): ConversationDirectory {
  const names = new Map(projects.map(project => [project.id, project.name]))
  const entries: DirectoryEntry[] = [], byAgent = new Map<string, DirectoryEntry>(), byTab = new Map<string, DirectoryEntry>()
  for (const session of sessions) {
    tabsOf(session.layout.root, tab => {
      if (byTab.has(tab.id)) return
      const agentSessionId = tab.kind === 'agent' && tab.resourceId ? tab.resourceId : undefined
      const entry: DirectoryEntry = {
        tabId: tab.id, kind: tab.kind, title: tab.title || 'Untitled tab', ...(agentSessionId ? { agentSessionId } : {}),
        projectId: session.projectId, projectName: names.get(session.projectId) ?? 'another project',
        sessionId: session.id, workspaceName: session.name, uri: conductorUri(session.projectId, 'tab', tab.id)
      }
      entries.push(entry)
      byTab.set(tab.id, entry)
      if (agentSessionId && !byAgent.has(agentSessionId)) byAgent.set(agentSessionId, entry)
    })
  }
  return { entries, byAgent, byTab }
}

/** Deliberately narrow: Conductor's own `makeId` shape (prefix, base-36 time, random tail), so
 *  prose never looks like an id. Uris stop at whitespace and trailing punctuation. */
const REF = /conductor:\/\/[A-Za-z0-9_.%-]+\/tab\/[A-Za-z0-9_.%-]+|\b(?:agent|tab|pane)_[a-z0-9]{6,11}_[a-z0-9]{3,9}\b/g
export interface ConversationRef { start: number; raw: string; entry: DirectoryEntry }

export function resolveConversationRef(directory: ConversationDirectory, raw: string): DirectoryEntry | null {
  if (raw.startsWith('conductor://')) {
    try {
      const url = new URL(raw)
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] !== 'tab' || parts.length !== 2) return null
      const entry = directory.byTab.get(decodeURIComponent(parts[1]!))
      return entry && entry.projectId === decodeURIComponent(url.hostname) ? entry : null
    } catch { return null }
  }
  return directory.byAgent.get(raw) ?? directory.byTab.get(raw) ?? null
}

/** Every id in `text` that names an open tab; unknown ids are left out, so they stay plain text. */
export function findConversationRefs(text: string, directory: ConversationDirectory): ConversationRef[] {
  if (!directory.entries.length || !/conductor:\/\/|agent_|tab_|pane_/.test(text)) return []
  const refs: ConversationRef[] = []
  for (const match of text.matchAll(REF)) {
    const raw = match[0].replace(/[.,;:!?)\]}]+$/, '')
    const entry = resolveConversationRef(directory, raw)
    if (entry) refs.push({ start: match.index!, raw, entry })
    if (refs.length === 64) break
  }
  return refs
}

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[]; data?: Record<string, unknown> }
const refLink = (ref: ConversationRef, currentProjectId: string | undefined, children: MarkdownNode[]): MarkdownNode =>
  ({ type: 'link', url: ref.entry.uri, data: { hProperties: { className: ['sa-conversation-ref'], title: 'Show ' + conversationLabel(ref.entry, currentProjectId), 'data-agent-session': ref.entry.agentSessionId ?? '' } }, children })

/** Runs after Markdown parsing, like the plain file links: explicit links and fenced code keep
 *  their own nodes; an inline-code span that is exactly one id becomes a link around that code. */
export function conversationRefRemarkPlugin(directory: ConversationDirectory, currentProjectId: string | undefined): () => (tree: MarkdownNode) => void {
  return () => (tree) => {
    const visit = (node: MarkdownNode): void => {
      if (!node.children || node.type === 'link' || node.type === 'code') return
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type === 'text' && child.value) {
          const refs = findConversationRefs(child.value, directory)
          if (!refs.length) return [child]
          const parts: MarkdownNode[] = []
          let cursor = 0
          for (const ref of refs) {
            if (ref.start < cursor) continue
            if (ref.start > cursor) parts.push({ type: 'text', value: child.value.slice(cursor, ref.start) })
            parts.push(refLink(ref, currentProjectId, [{ type: 'text', value: ref.raw }]))
            cursor = ref.start + ref.raw.length
          }
          if (cursor < child.value.length) parts.push({ type: 'text', value: child.value.slice(cursor) })
          return parts
        }
        if (child.type === 'inlineCode' && child.value) {
          const value = child.value.trim(), entry = resolveConversationRef(directory, value)
          return entry ? [refLink({ start: 0, raw: value, entry }, currentProjectId, [child])] : [child]
        }
        visit(child)
        return [child]
      })
    }
    visit(tree)
  }
}

/** Whether `text` carries something shaped like an id at all; a miss may be a tab opened since
 *  the directory was last read, which is worth one bounded refresh. */
export const mentionsConversationId = (text: string): boolean => { REF.lastIndex = 0; const found = REF.test(text); REF.lastIndex = 0; return found }

/** Hover text of a link to `entry`, naming its project when that is not the one on screen. */
export function conversationLabel(entry: DirectoryEntry, currentProjectId?: string): string {
  return entry.projectId !== currentProjectId ? `${entry.title} (${entry.projectName})` : entry.title
}

/**
 * The Ctrl+K matches for a query: an id (agentSessionId or tab id, whole or any fragment of at
 * least four characters, such as the "muldox0q" time part) first, then titles. Case-insensitive.
 */
export function matchConversationTabs(directory: ConversationDirectory, query: string, limit = 20): DirectoryEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const byId: DirectoryEntry[] = [], byTitle: DirectoryEntry[] = []
  for (const entry of directory.entries) {
    const idHit = q.length >= 4 && (entry.agentSessionId?.toLowerCase().includes(q) || entry.tabId.toLowerCase().includes(q) || entry.uri.toLowerCase() === q)
    if (idHit) byId.push(entry)
    else if (q.length >= 2 && `${entry.title} ${entry.projectName} ${entry.workspaceName}`.toLowerCase().includes(q)) byTitle.push(entry)
  }
  return [...byId, ...byTitle].slice(0, limit)
}

/** Brings the tab into view, switching project and workspace as needed. An agent tab goes by its
 *  durable session id (which also restores a just-closed tab); any other tab by its uri. */
export function focusDirectoryEntry(entry: Pick<DirectoryEntry, 'agentSessionId' | 'uri'>): Promise<void> {
  const control = window.conductor.agentControl
  return entry.agentSessionId ? control.focusOrigin(entry.agentSessionId) : control.openUri(entry.uri)
}

// ---- The one shared directory every message, card and the palette read ----

const REFRESH_TTL_MS = 4000
let projects: DirectoryProject[] = []
let live: { projectId: string | null; sessions: readonly SessionRecord[] } = { projectId: null, sessions: [] }
let stored = new Map<string, readonly SessionRecord[]>()
let current: ConversationDirectory = buildConversationDirectory([], [])
let signature = ''
let fetchedAt = 0
let inFlight: Promise<void> | null = null
let watching = false
const subscribers = new Set<(directory: ConversationDirectory) => void>()

function rebuild(): void {
  const sessions = [...(live.projectId ? live.sessions : []), ...[...stored].filter(([projectId]) => projectId !== live.projectId).flatMap(([, list]) => list)]
  const next = buildConversationDirectory(projects, sessions)
  // Layout sizes, focus and tab state change constantly; only identities and titles matter here,
  // and every mounted message would re-parse its Markdown on a new directory object.
  const nextSignature = next.entries.map(entry => `${entry.tabId}\u0001${entry.agentSessionId ?? ''}\u0001${entry.title}\u0001${entry.sessionId}\u0001${entry.workspaceName}\u0001${entry.projectName}`).join('\u0002')
  if (nextSignature === signature) return
  signature = nextSignature
  current = next
  for (const notify of subscribers) notify(current)
}

/** The project on screen is read from the window's own state, which is newer than what is saved. */
export function setLiveWorkspaces(projectId: string | null, sessions: readonly SessionRecord[], knownProjects?: readonly DirectoryProject[]): void {
  live = { projectId, sessions }
  if (knownProjects) projects = knownProjects.map(project => ({ id: project.id, name: project.name }))
  rebuild()
}

/** Reads every other open project's workspaces once; calls within REFRESH_TTL_MS share one read. */
export function refreshConversationDirectory(force = false): Promise<void> {
  const api = typeof window === 'undefined' ? undefined : window.conductor
  if (!api?.projects?.list || !api.sessions?.list) return Promise.resolve()
  if (inFlight) return inFlight
  if (!force && Date.now() - fetchedAt < REFRESH_TTL_MS) return Promise.resolve()
  inFlight = (async () => {
    try {
      const listed = await api.projects.list()
      projects = listed.map(project => ({ id: project.id, name: project.name }))
      const next = new Map<string, readonly SessionRecord[]>()
      await Promise.all(listed.filter(project => project.id !== live.projectId).map(async project => {
        try { next.set(project.id, await api.sessions.list(project.id)) } catch { /* A project that cannot be read has nothing to link to. */ }
      }))
      stored = next
      fetchedAt = Date.now()
      rebuild()
    } catch { /* Links fall back to plain text; the next refresh tries again. */ } finally { inFlight = null }
  })()
  return inFlight
}

function watch(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('focus', () => void refreshConversationDirectory())
  // A coworker opened or released in any project changes which tabs exist.
  window.conductor?.agentControl?.onLinksChanged?.(() => void refreshConversationDirectory(true))
}

export function currentConversationDirectory(): ConversationDirectory { return current }

export function useConversationDirectory(): ConversationDirectory {
  const [directory, setDirectory] = useState(current)
  useEffect(() => {
    subscribers.add(setDirectory)
    setDirectory(current)
    watch()
    void refreshConversationDirectory()
    return () => { subscribers.delete(setDirectory) }
  }, [])
  return directory
}

export const conversationDirectoryForTest = {
  reset(): void { projects = []; live = { projectId: null, sessions: [] }; stored = new Map(); current = buildConversationDirectory([], []); signature = ''; fetchedAt = 0; inFlight = null; subscribers.clear() }
}
