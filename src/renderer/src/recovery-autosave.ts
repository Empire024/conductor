import type { WorkspaceDocumentState, WorkspaceRecoveryCheckpoint } from '../../shared/models'

/** Autosave waits for a quiet second after the last layout change, then for idle time (at most
 *  this much longer), so a burst of edits is one write and never lands in the middle of typing.
 *  pagehide, beforeunload, restart-to-update, project switches and manual saves still flush at
 *  once, which is what keeps a crash or reload from losing the layout. */
export const RECOVERY_CHECKPOINT_DELAY_MS = 1_000
export const RECOVERY_IDLE_TIMEOUT_MS = 1_000

const DOCUMENTS_PREFIX = 'conductor.workspaceFiles.'
type KeyedStorage = Pick<Storage, 'length' | 'key' | 'getItem'>

/** Reads the workspace documents for a checkpoint, parsing only records whose stored text changed
 *  since the last read. An unchanged record comes back as the same object, which is what lets
 *  `checkpointChanged` skip a checkpoint that would write exactly what main already holds. */
export function workspaceDocumentsReader(storage: () => KeyedStorage, load: (workspaceId: string) => WorkspaceDocumentState): () => WorkspaceDocumentState[] {
  let cache = new Map<string, { raw: string | null; document: WorkspaceDocumentState }>()
  return () => {
    const store = storage()
    const next = new Map<string, { raw: string | null; document: WorkspaceDocumentState }>()
    const documents: WorkspaceDocumentState[] = []
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index)
      if (!key?.startsWith(DOCUMENTS_PREFIX)) continue
      const raw = store.getItem(key)
      const cached = cache.get(key)
      const document = cached && cached.raw === raw ? cached.document : load(key.slice(DOCUMENTS_PREFIX.length))
      next.set(key, { raw, document })
      documents.push(document)
    }
    cache = next
    return documents
  }
}

const sameRecord = (left: Record<string, string>, right: Record<string, string>): boolean => {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key])
}
const sameItems = <T>(left: readonly T[] | undefined, right: readonly T[] | undefined, same: (a: T, b: T) => boolean): boolean =>
  left === right || (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((item, index) => same(item, right![index]!))

/** Whether `next` differs from the last checkpoint main accepted. Layouts, tabs and documents are
 *  compared by identity: React state and the documents reader only replace what changed. */
export function checkpointChanged(previous: WorkspaceRecoveryCheckpoint | null, next: WorkspaceRecoveryCheckpoint): boolean {
  if (!previous) return true
  return previous.activeProjectId !== next.activeProjectId || previous.activeSessionId !== next.activeSessionId ||
    !sameRecord(previous.focusedGroupIds, next.focusedGroupIds) || !sameRecord(previous.sessionIdsByProject, next.sessionIdsByProject) ||
    !sameItems(previous.documents, next.documents, (a, b) => a === b) ||
    !sameItems(previous.sessions, next.sessions, (a, b) => a.id === b.id && a.layout === b.layout && a.maximizedGroupId === b.maximizedGroupId && a.closedTabs === b.closedTabs)
}

type IdleWindow = Pick<Window, 'setTimeout' | 'clearTimeout'> & Partial<Pick<Window, 'requestIdleCallback' | 'cancelIdleCallback'>>

/** Runs `run` once the page has been quiet for `delayMs` and then idle (or `idleTimeoutMs` more
 *  has passed). Returns a cancel function. */
export function afterQuietIdle(run: () => void, delayMs = RECOVERY_CHECKPOINT_DELAY_MS, idleTimeoutMs = RECOVERY_IDLE_TIMEOUT_MS, host: IdleWindow = window): () => void {
  let idle: number | null = null
  const timer = host.setTimeout(() => {
    if (host.requestIdleCallback) idle = host.requestIdleCallback(() => { idle = null; run() }, { timeout: idleTimeoutMs })
    else run()
  }, delayMs)
  return () => {
    host.clearTimeout(timer)
    if (idle !== null) host.cancelIdleCallback?.(idle)
  }
}
