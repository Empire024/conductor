import type { AgentControlLink } from './agent-control'
import { awaitingLabel, type AwaitingFact } from './awaiting-results'
import type { AgentActivityPhase, PaneTab } from './models'
import type { SessionProjection } from './structured-agent'

/**
 * Workspace clarity (feature-list `workspace-clarity`). On 2026-09-28 the owner's "local models"
 * workspace held 43 agent tabs, 3 of them live: the strip was a wall of identical "C..." chips,
 * the sidebar a flat list of 40 "completed" rows, and two tabs wore MAIN (a failed old wizard and
 * the live one). These are the rules both surfaces and the main-process sweep share:
 *
 * - one MAIN per workspace: the live wizard (else the controller with the most live coworkers);
 *   a handed-off or failed predecessor is finished work like any other;
 * - live work first: the MAIN with its live coworkers nested, then other live or open tabs;
 *   finished agent tabs fall into one "Done" group, newest first;
 * - a finished tab the owner has not looked at since it finished leaves the tab strip (it stays
 *   open, reachable from the sidebar's Done group and Ctrl+K), and after the owner's sweep age an
 *   unfocused finished tab closes itself with its history kept;
 * - never hidden or closed: a running tab, one waiting on an approval or question, the live
 *   wizard, a pinned tab, the tab on screen in its pane;
 * - a tab whose turn ended waiting for other conversations' results (src/shared/awaiting-results.ts)
 *   is live work labelled with whom it waits for, never Done, hidden or swept.
 */

/** tab.state keys: when the owner last had this tab in front of them, and a pin. */
export const TAB_SEEN_KEY = 'seenAt'
export const TAB_PINNED_KEY = 'pinned'

/** What main knows about one agent conversation that the renderer's phase map does not. */
export interface AgentTabFacts {
  wizard: boolean
  /** It handed itself on (agents.handoff successor:true); read-only from here on. */
  handedOff: boolean
  /** When it last settled after doing work (ISO); absent while it works or if it never ran. */
  settledAt?: string
  /** Main's own reading while it is not settled, for a window without the renderer's phase map. */
  live?: 'running' | 'waiting'
  /** Its turn ended waiting for other conversations' results (src/shared/awaiting-results.ts). */
  awaiting?: AwaitingFact
}

/** 'awaiting': its turn is over but it declared it waits for named conversations, which wake it. */
export type ClarityStatus = 'running' | 'waiting' | 'awaiting' | 'open' | 'done' | 'failed' | 'stopped' | 'handed-off'
export type ClarityRole = 'main' | 'lead' | 'coworker'

const FINISHED: ReadonlySet<ClarityStatus> = new Set(['done', 'failed', 'stopped', 'handed-off'])
export const isFinishedStatus = (status: ClarityStatus): boolean => FINISHED.has(status)

export const tabPinned = (tab: Pick<PaneTab, 'state'>): boolean => tab.state?.[TAB_PINNED_KEY] === true
export const tabSeenAt = (tab: Pick<PaneTab, 'state'>): number | undefined => {
  const value = tab.state?.[TAB_SEEN_KEY]
  const time = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(time) ? time : undefined
}
const time = (iso?: string): number | undefined => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? value : undefined }

/** One agent tab's state in words the owner reads. Non-agent tabs are always 'open'. */
export function clarityStatus(tab: Pick<PaneTab, 'kind'>, phase: AgentActivityPhase | undefined, facts: AgentTabFacts | undefined): ClarityStatus {
  if (tab.kind !== 'agent') return 'open'
  if (phase === undefined && facts?.live) return facts.live
  if (phase === 'working' || phase === 'waiting_background' || phase === 'limited') return 'running'
  if (phase === 'waiting_input') return 'waiting'
  if (facts?.handedOff) return 'handed-off'
  // Ending a provider turn to wait for others' results is not finishing; the owner's stop is.
  if (facts?.awaiting && phase !== 'stopped') return 'awaiting'
  if (phase === 'complete') return 'done'
  if (phase === 'failed' || phase === 'disconnected') return 'failed'
  if (phase === 'stopped') return 'stopped'
  // An idle conversation that has run and settled is done; a fresh one is open.
  return facts?.settledAt ? 'done' : 'open'
}

export interface ClarityPane { groupId: string; tabs: readonly PaneTab[]; activeTabId: string }
export interface ClarityRow {
  tab: PaneTab
  groupId: string
  status: ClarityStatus
  role?: ClarityRole
  /** 1 for a live coworker listed under its live controller. */
  depth: 0 | 1
  /** Title of the tab that controls this one, when it is not the row it is nested under. */
  controllerTitle?: string
  settledAt?: number
  /** It was a wizard or controlled coworkers: a finished one reads as ended, not as failed. */
  led?: boolean
  /** Whom it waits for, when its status is 'awaiting'. */
  awaiting?: AwaitingFact
}
export interface WorkspaceClarity {
  mainTabId: string | null
  live: ClarityRow[]
  /** Finished agent tabs, newest first. */
  done: ClarityRow[]
  /** Tabs the strip leaves out: finished, unpinned, not on screen, not looked at since they finished. */
  hiddenFromStrip: ReadonlySet<string>
  statusByTab: ReadonlyMap<string, ClarityStatus>
}

export interface ClarityInput {
  panes: readonly ClarityPane[]
  links: readonly AgentControlLink[]
  /** By agentSessionId (tab.resourceId). */
  phases: ReadonlyMap<string, AgentActivityPhase>
  /** By agentSessionId. */
  facts: Readonly<Record<string, AgentTabFacts>>
}

const liveRank = (status: ClarityStatus): number => status === 'waiting' ? 0 : status === 'running' ? 1 : status === 'awaiting' ? 2 : 3

/** The one MAIN: a live (not handed-off) wizard, preferring one at work, then the most recently
 *  settled; with no wizard, the live controller with the most live coworkers. */
function pickMain(rows: ReadonlyMap<string, { tab: PaneTab; status: ClarityStatus; facts?: AgentTabFacts }>, liveCoworkers: ReadonlyMap<string, number>): string | null {
  const score = (id: string): number => {
    const row = rows.get(id)!
    return (row.status === 'running' || row.status === 'waiting' ? 1e15 : 0) + (time(row.facts?.settledAt) ?? 0)
  }
  const wizards = [...rows.entries()].filter(([, row]) => row.facts?.wizard && row.status !== 'handed-off' && row.status !== 'failed' && row.status !== 'stopped').map(([id]) => id)
  if (wizards.length) return wizards.sort((a, b) => score(b) - score(a))[0]!
  const controllers = [...liveCoworkers.entries()].filter(([id, count]) => count > 0 && rows.has(id) && !['failed', 'stopped', 'handed-off'].includes(rows.get(id)!.status))
  if (!controllers.length) return null
  return controllers.sort((a, b) => b[1] - a[1] || score(b[0]) - score(a[0]))[0]![0]
}

export function buildWorkspaceClarity(input: ClarityInput): WorkspaceClarity {
  const byTab = new Map<string, { tab: PaneTab; groupId: string; status: ClarityStatus; facts?: AgentTabFacts; active: boolean; position: number }>()
  let position = 0
  for (const pane of input.panes) for (const tab of pane.tabs) {
    const facts = tab.resourceId ? input.facts[tab.resourceId] : undefined
    const phase = tab.resourceId ? input.phases.get(tab.resourceId) : undefined
    byTab.set(tab.id, { tab, groupId: pane.groupId, status: clarityStatus(tab, phase, facts), facts, active: pane.activeTabId === tab.id, position: position++ })
  }
  // Live control links between tabs of this workspace: coworker tab -> controller tab.
  const controllerOf = new Map<string, string>()
  for (const link of input.links) if (byTab.has(link.controlledTabId) && byTab.has(link.controllerTabId) && link.controlledTabId !== link.controllerTabId) controllerOf.set(link.controlledTabId, link.controllerTabId)
  const ended = (id: string): boolean => { const row = byTab.get(id)!; return isFinishedStatus(row.status) && !tabPinned(row.tab) }
  const liveCoworkers = new Map<string, number>()
  for (const [coworker, controller] of controllerOf) if (!ended(coworker)) liveCoworkers.set(controller, (liveCoworkers.get(controller) ?? 0) + 1)
  const mainTabId = pickMain(byTab, liveCoworkers)
  const leaders = new Set(controllerOf.values())
  // A controller whose own turn is over but whose coworkers still work is live work, and so is
  // the MAIN between turns.
  const finished = (id: string): boolean => ended(id) && id !== mainTabId && !liveCoworkers.get(id)
  const roleOf = (id: string): ClarityRole | undefined => id === mainTabId ? 'main' : liveCoworkers.get(id) ? 'lead' : controllerOf.has(id) ? 'coworker' : undefined

  const row = (id: string, depth: 0 | 1, nestedUnder?: string): ClarityRow => {
    const entry = byTab.get(id)!, controller = controllerOf.get(id)
    return {
      tab: entry.tab, groupId: entry.groupId, status: entry.status, depth,
      ...(roleOf(id) ? { role: roleOf(id) } : {}),
      ...(controller && controller !== nestedUnder ? { controllerTitle: byTab.get(controller)!.tab.title } : {}),
      ...(time(entry.facts?.settledAt) !== undefined ? { settledAt: time(entry.facts?.settledAt) } : {}),
      ...(entry.facts?.wizard || leaders.has(id) ? { led: true } : {}),
      ...(entry.status === 'awaiting' && entry.facts?.awaiting ? { awaiting: entry.facts.awaiting } : {})
    }
  }
  const byPosition = (a: string, b: string): number => byTab.get(a)!.position - byTab.get(b)!.position
  const byLiveness = (a: string, b: string): number => liveRank(byTab.get(a)!.status) - liveRank(byTab.get(b)!.status) || byPosition(a, b)
  const liveIds = [...byTab.keys()].filter(id => !finished(id))
  // A live coworker nests under its controller when that controller is listed live too.
  const nestedParent = (id: string): string | undefined => { const controller = controllerOf.get(id); return controller && !finished(controller) && controller !== id ? controller : undefined }
  const childrenOf = (id: string): string[] => liveIds.filter(child => nestedParent(child) === id).sort(byLiveness)
  const tops = liveIds.filter(id => !nestedParent(id) || nestedParent(nestedParent(id)!) === id)
  const agentFirst = (a: string, b: string): number => {
    const rank = (id: string): number => id === mainTabId ? -1 : byTab.get(id)!.tab.kind !== 'agent' ? 4 : liveRank(byTab.get(id)!.status)
    return rank(a) - rank(b) || byPosition(a, b)
  }
  const live: ClarityRow[] = []
  const listed = new Set<string>()
  // Depth is shown one level deep; a coworker's own coworkers follow it at the same indent.
  const emit = (id: string, depth: 0 | 1, parent?: string): void => {
    if (listed.has(id)) return
    listed.add(id); live.push(row(id, depth, parent))
    for (const child of childrenOf(id)) emit(child, 1, id)
  }
  for (const id of tops.sort(agentFirst)) emit(id, 0)
  // Anything a cycle kept out of the loop above still shows, flat.
  for (const id of liveIds) if (!listed.has(id)) { listed.add(id); live.push(row(id, 0)) }

  const done = [...byTab.keys()].filter(finished).map(id => row(id, 0))
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0) || byTab.get(b.tab.id)!.position - byTab.get(a.tab.id)!.position)

  const hiddenFromStrip = new Set<string>()
  for (const [id, entry] of byTab) {
    if (!finished(id) || entry.active) continue
    const settled = time(entry.facts?.settledAt)
    // Until main has said when it settled, a tab that just finished stays where it is.
    if (settled === undefined && entry.status !== 'handed-off') continue
    const seen = tabSeenAt(entry.tab)
    if (seen !== undefined && settled !== undefined && seen >= settled) continue
    hiddenFromStrip.add(id)
  }
  return { mainTabId, live, done, hiddenFromStrip, statusByTab: new Map([...byTab].map(([id, entry]) => [id, entry.status])) }
}

/** The tab strip's order of rank: the MAIN first, then live coworkers (waiting, then running),
 *  then everything else where it already stood. Returns tab ids. */
export function stripRank(tabIds: readonly string[], clarity: Pick<WorkspaceClarity, 'mainTabId' | 'live'>): string[] {
  const coworkers = new Set(clarity.live.filter(row => row.depth === 1 || row.role === 'coworker').map(row => row.tab.id))
  const rank = (id: string): number => id === clarity.mainTabId ? 0 : coworkers.has(id) ? 1 : 2
  return tabIds.map((id, index) => ({ id, index })).sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index).map(entry => entry.id)
}

export const statusLabel = (row: Pick<ClarityRow, 'status' | 'led' | 'awaiting'>): string => {
  if (row.status === 'awaiting') return row.awaiting ? awaitingLabel(row.awaiting) : 'waiting for results'
  if (row.status === 'handed-off') return 'handed off'
  if ((row.status === 'failed' || row.status === 'stopped') && row.led) return 'ended'
  // Done is what the group already says; only a different ending is worth a label.
  return row.status === 'done' || row.status === 'open' ? '' : row.status
}

/**
 * Chips that still tell tabs apart when space is short: titles sharing a leading run of words
 * ("Conductor continuation (continued)", "Conductor continuation - fix") drop that run and show
 * what differs, word by word within each group that starts alike ("Conductor coworker: llama slots"
 * reads "…llama slots"). A title the prefix would empty, or one with no such sibling, keeps its text.
 */
export function distinctTabLabels(titles: readonly string[]): string[] {
  const words = titles.map(title => title.split(/\s+/).filter(Boolean))
  const offsets = titles.map(() => 0)
  // Titles that share their next word drop it, as long as every one of them keeps a word after it;
  // then the survivors of each group are compared again from there.
  const strip = (members: number[], offset: number): void => {
    const groups = new Map<string, number[]>()
    for (const index of members) { const word = words[index]![offset]; if (word !== undefined) groups.set(word, [...groups.get(word) ?? [], index]) }
    for (const group of groups.values()) {
      if (group.length < 2 || !group.every(index => words[index]!.length > offset + 1)) continue
      for (const index of group) offsets[index] = offset + 1
      strip(group, offset + 1)
    }
  }
  strip(titles.map((_, index) => index), 0)
  return titles.map((title, index) => offsets[index] ? '…' + words[index]!.slice(offsets[index]).join(' ') : title)
}

/** A handed-off conversation's timeline ends with a Conductor notice naming its successor. */
export function handedOffIn(items: SessionProjection['items']): boolean {
  for (let index = items.length - 1; index >= 0; index--) {
    const data = items[index]!.data
    if (data.type !== 'notice' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) continue
    const succession = (data.payload as Record<string, unknown>).succession
    if (succession && typeof succession === 'object') return true
  }
  return false
}

/** Hours; '0' is Off. How long a finished, unfocused tab stays open before it closes itself. */
export const FINISHED_TAB_SWEEP_SETTING = 'finishedTabSweepHours'
export const DEFAULT_FINISHED_TAB_SWEEP_HOURS = 24
export const FINISHED_TAB_SWEEP_CHOICES = [0, 4, 12, 24, 72, 168] as const

export function finishedTabSweepHours(getSetting: (key: string) => string | null): number {
  const raw = getSetting(FINISHED_TAB_SWEEP_SETTING), stored = Number(raw)
  return raw !== null && (FINISHED_TAB_SWEEP_CHOICES as readonly number[]).includes(stored) ? stored : DEFAULT_FINISHED_TAB_SWEEP_HOURS
}
export function normalizeFinishedTabSweepHours(value: unknown): number {
  if (typeof value !== 'number' || !(FINISHED_TAB_SWEEP_CHOICES as readonly number[]).includes(value)) throw new Error(`Choose one of ${FINISHED_TAB_SWEEP_CHOICES.join(', ')} hours (0 is Off)`)
  return value
}

/** Why the sweep or "Close finished tabs" keeps a tab open; null when it may close. `aged` is the
 *  sweep's extra rule (settled and unseen for its age, not on screen); the owner's button skips it. */
export function finishedCloseRefusal(tab: {
  finished: boolean; pinned: boolean; wizard: boolean; controlsLiveCoworkers: boolean; remote: boolean; busy: string | null
  /** It waits for other conversations' results (awaitingSentence), so its work is not over. */
  awaiting?: string | null
}, aged?: { active: boolean; settledAt?: number; seenAt?: number; now: number; ageMs: number }): string | null {
  if (tab.busy) return tab.busy
  if (!tab.finished) return 'it is not finished'
  if (tab.pinned) return 'it is pinned'
  if (tab.wizard) return 'it is the live wizard'
  if (tab.controlsLiveCoworkers) return 'it still controls open coworkers'
  if (tab.awaiting) return tab.awaiting
  if (tab.remote) return 'it runs on another machine'
  if (!aged) return null
  if (aged.active) return 'it is the tab on screen in its pane'
  if (aged.settledAt === undefined || aged.now - aged.settledAt < aged.ageMs) return 'it finished too recently'
  if (aged.seenAt !== undefined && aged.now - aged.seenAt < aged.ageMs) return 'you looked at it recently'
  return null
}
