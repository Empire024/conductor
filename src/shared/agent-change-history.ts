/** Local, pre-git change history for one agent conversation.
 *
 *  Conductor already captures an immutable before/after snapshot around every tool that
 *  writes a file (see `AgentArtifacts`). This module turns that scattered per-tool record
 *  into the two shapes an owner actually reasons about — "what did this turn do?" and
 *  "what happened to this file?" — and works out which of those are safe to undo. It is
 *  deliberately pure: disk state and cross-conversation conflicts are layered on in main.
 */
import type { FileChange, TimelineItem } from './structured-agent'

export interface ChangeHistoryEdit {
  /** Timeline item that carried the `changes` event, plus the index inside it. */
  itemId: string
  index: number
  sequence: number
  timestamp: string
  turnKey: string
  path: string
  oldPath?: string
  kind: FileChange['kind']
  status: FileChange['status']
  artifactId?: string
  additions?: number
  deletions?: number
  limitation?: string
  /** An earlier restore already put this edit back; its snapshot is history, not state. */
  reverted: boolean
}
export interface ChangeHistoryTurn {
  key: string
  /** The prompt that opened the turn, as the owner typed it. */
  label: string
  startedAt: string
  edits: ChangeHistoryEdit[]
  revert: RevertPlan
}
export interface ChangeHistoryFile {
  path: string
  kind: FileChange['kind']
  additions: number
  deletions: number
  lastEditAt: string
  edits: ChangeHistoryEdit[]
  /** How the file on disk compares with the newest snapshot Conductor holds. */
  disk?: 'matches-snapshot' | 'changed-since-snapshot' | 'missing' | 'unreadable'
  revert: RevertPlan
}
/** Everything needed to perform — or explain the refusal of — one restore. */
export interface RevertPlan {
  /** Restore each path to the `before` of its oldest selected edit. `artifactIds` are every
   *  snapshot the restore collapses, so the conversation can record all of them as undone. */
  restore: Array<{ path: string; fromArtifactId: string; expectedArtifactId: string; artifactIds: string[] }>
  blocked: Array<{ path: string; reason: string }>
}
export interface AgentChangeHistory {
  sessionId: string
  cwd: string
  turns: ChangeHistoryTurn[]
  files: ChangeHistoryFile[]
  totals: { files: number; edits: number; additions: number; deletions: number }
  /** Set when the conversation's oldest events were compacted out of the journal. */
  truncated: boolean
  note?: string
}
export type RevertScope =
  | { kind: 'edit'; itemId: string; index: number }
  | { kind: 'turn'; turnKey: string }
  | { kind: 'file'; path: string }
export interface RevertOutcome {
  reverted: Array<{ path: string; artifactIds: string[] }>
  blocked: Array<{ path: string; reason: string }>
  message: string
}

/** Windows and macOS reach the same file through different spellings; group by one key. */
export const pathKey = (path: string): string => path.replace(/\\/g, '/').toLocaleLowerCase()
const firstLine = (text: string): string => {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? ''
  return line.length > 120 ? line.slice(0, 119) + '…' : line
}

/** A turn is what the owner sees as one exchange: their message and everything it caused.
 *  Provider turn ids are used when present, but a conversation resumed across runtimes can
 *  lose them, so the user message itself is always the fallback boundary. */
export function buildChangeHistory(sessionId: string, cwd: string, items: TimelineItem[], truncated = false): AgentChangeHistory {
  const reverted = new Set<string>()
  for (const item of items) if (item.data.type === 'review' && item.data.outcome === 'reverted') reverted.add(item.data.artifactId)
  const turns: ChangeHistoryTurn[] = []
  const files = new Map<string, ChangeHistoryFile>()
  let current: ChangeHistoryTurn | undefined
  for (const item of items) {
    if (item.data.type === 'text' && item.data.role === 'user') {
      current = { key: 'item:' + item.id, label: firstLine(item.data.text) || 'Untitled turn', startedAt: item.timestamp, edits: [], revert: { restore: [], blocked: [] } }
      turns.push(current)
      continue
    }
    if (item.data.type !== 'changes') continue
    if (!current) {
      current = { key: 'turn:' + (item.turnId ?? item.id), label: 'Before the first recorded message', startedAt: item.timestamp, edits: [], revert: { restore: [], blocked: [] } }
      turns.push(current)
    }
    const turn = current
    item.data.changes.forEach((change, index) => {
      const edit: ChangeHistoryEdit = {
        itemId: item.id, index, sequence: item.sequence, timestamp: item.timestamp, turnKey: turn.key,
        path: change.path, oldPath: change.oldPath, kind: change.kind, status: change.status, artifactId: change.artifactId,
        additions: change.additions, deletions: change.deletions, limitation: change.limitation,
        reverted: Boolean(change.artifactId && reverted.has(change.artifactId))
      }
      turn.edits.push(edit)
      const key = pathKey(change.path)
      const file = files.get(key) ?? { path: change.path, kind: change.kind, additions: 0, deletions: 0, lastEditAt: item.timestamp, edits: [], revert: { restore: [], blocked: [] } }
      file.edits.push(edit)
      file.additions += change.additions ?? 0
      file.deletions += change.deletions ?? 0
      file.lastEditAt = item.timestamp
      // The net effect the owner sees: born in this conversation, removed by it, or edited.
      file.kind = change.kind === 'rename' ? 'rename' : change.kind === 'delete' ? 'delete' : file.edits[0]!.kind === 'add' ? 'add' : 'update'
      files.set(key, file)
    })
  }
  const ordered = [...files.values()].sort((left, right) => right.lastEditAt.localeCompare(left.lastEditAt) || left.path.localeCompare(right.path))
  const history: AgentChangeHistory = {
    sessionId, cwd, truncated,
    turns: turns.filter(turn => turn.edits.length),
    files: ordered,
    totals: {
      files: ordered.length,
      edits: ordered.reduce((sum, file) => sum + file.edits.length, 0),
      additions: ordered.reduce((sum, file) => sum + file.additions, 0),
      deletions: ordered.reduce((sum, file) => sum + file.deletions, 0)
    }
  }
  for (const turn of history.turns) turn.revert = planRevert(history, turn.edits)
  for (const file of history.files) file.revert = planRevert(history, file.edits)
  return history
}

/** Selecting edits is not enough to make a restore exact: the snapshot chain for a path has
 *  to reach all the way to its current recorded state, or writing the old bytes back would
 *  silently drop whatever this conversation did afterwards. */
export function planRevert(history: AgentChangeHistory, selection: ChangeHistoryEdit[]): RevertPlan {
  const plan: RevertPlan = { restore: [], blocked: [] }
  const restorable = (edit: ChangeHistoryEdit): boolean => Boolean(edit.artifactId) && edit.status === 'applied' && !edit.reverted && !edit.oldPath
  const byPath = new Map<string, ChangeHistoryEdit[]>()
  for (const edit of selection) byPath.set(pathKey(edit.path), [...(byPath.get(pathKey(edit.path)) ?? []), edit])
  for (const [key, edits] of byPath) {
    const file = history.files.find(candidate => pathKey(candidate.path) === key)
    const path = edits[0]!.path
    const usable = edits.filter(restorable).sort((left, right) => left.sequence - right.sequence || left.index - right.index)
    if (!usable.length) {
      const only = edits.at(-1)!
      plan.blocked.push({ path, reason: only.reverted ? 'Already restored from this snapshot.' : only.status !== 'applied' ? `This change was ${only.status}; nothing was written to disk.` : only.oldPath ? 'Renames are recorded but not restorable; move the file back by hand.' : only.limitation ?? 'No complete before/after snapshot was captured for this change.' })
      continue
    }
    const newest = (file?.edits ?? edits).filter(restorable).at(-1)!
    const latestSelected = usable.at(-1)!
    if (newest.itemId !== latestSelected.itemId || newest.index !== latestSelected.index) {
      plan.blocked.push({ path, reason: 'A later edit in this conversation changed this file. Undo that edit first, or revert the whole file.' })
      continue
    }
    plan.restore.push({ path, fromArtifactId: usable[0]!.artifactId!, expectedArtifactId: newest.artifactId!, artifactIds: usable.map(edit => edit.artifactId!) })
  }
  plan.restore.sort((left, right) => left.path.localeCompare(right.path))
  plan.blocked.sort((left, right) => left.path.localeCompare(right.path))
  return plan
}

/** Resolve a UI request into the edits it covers. */
export function selectEdits(history: AgentChangeHistory, scope: RevertScope): ChangeHistoryEdit[] {
  if (scope.kind === 'turn') return history.turns.find(turn => turn.key === scope.turnKey)?.edits ?? []
  if (scope.kind === 'file') return history.files.find(file => pathKey(file.path) === pathKey(scope.path))?.edits ?? []
  return history.turns.flatMap(turn => turn.edits).filter(edit => edit.itemId === scope.itemId && edit.index === scope.index)
}
