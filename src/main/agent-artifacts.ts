import { realpath, lstat, open, unlink } from 'node:fs/promises'
import { realpathSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch, parsePatch, applyPatch, reversePatch } from 'diff'
import type { DiffArtifact, FileChange } from '../shared/structured-agent'
import type { AgentChangeHistory, RevertOutcome, RevertPlan, RevertScope } from '../shared/agent-change-history'
import { buildChangeHistory, pathKey, planRevert, selectEdits } from '../shared/agent-change-history'
import type { StructuredAgentStore } from './structured-store'

export function patchCounts(patch: string): { additions: number; deletions: number } {
  const patches = parsePatch(patch)
  let additions = 0, deletions = 0
  for (const file of patches) for (const hunk of file.hunks) for (const line of hunk.lines) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** A containment refusal from `workspacePath`: the requested path is not addressable inside
 *  this workspace. Every refusal message and every rejection is exactly what it always was —
 *  the subclass only lets a caller ask "is this path simply not mine to touch?" without
 *  matching on message text, and never turns a refusal into an allowance. */
export class OutsideWorkspaceError extends Error {}

/** Lexical + canonical path check, including existing parent for new/deleted files. */
function lexicalWorkspaceTarget(cwd: string, root: string, requested: string): string {
  const lexicalRoot = resolve(cwd), target = resolve(lexicalRoot, requested)
  const inside = (base: string): boolean => { const part = relative(base, target); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
  if (inside(lexicalRoot)) return resolve(root, relative(lexicalRoot, target))
  if (inside(root)) return target
  throw new OutsideWorkspaceError('File is outside the session workspace')
}
export async function workspacePath(cwd: string, requested: string, allowMissing = false): Promise<string> {
  if (!requested || requested.includes('\0') || (process.platform === 'win32' && /^(?:\/|[a-z]:[^\\/])/i.test(requested))) throw new OutsideWorkspaceError('Invalid workspace path; WSL paths require an explicit mapping')
  const root = await realpath(cwd), target = lexicalWorkspaceTarget(cwd, root, requested)
  const inside = (candidate: string): boolean => { const part = relative(root, candidate); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
  if (!inside(target)) throw new OutsideWorkspaceError('File is outside the session workspace')
  try {
    const canonical = await realpath(target)
    if (!inside(canonical)) throw new OutsideWorkspaceError('Symlink or junction leaves the session workspace')
    return canonical
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = await realpath(dirname(target))
    if (!inside(parent)) throw new OutsideWorkspaceError('Parent junction leaves the session workspace')
    return resolve(parent, basename(target))
  }
}

/** The snapshot target for one path a tool is about to touch, or null when this feature simply
 *  has nothing to capture: the path lives outside the workspace (a memory file under the user
 *  profile, a temp file, a sibling project), or it is not addressable yet because a parent
 *  directory the tool is about to create does not exist. Both are ordinary, so they are skipped
 *  silently — the containment refusal is still a refusal, it just is not an incident to report.
 *  Anything else (unreadable, permission denied) is a real failure and still propagates. */
async function snapshotTarget(cwd: string, requested: string): Promise<string | null> {
  try { return await workspacePath(cwd, requested, true) }
  catch (error) {
    if (error instanceof OutsideWorkspaceError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function textVersion(path: string, reserve?: (bytes: number) => boolean): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Binary, non-file, or oversized snapshot is unsupported')
    const file = await open(path, 'r')
    try {
      const actual = await file.stat()
      if (!actual.isFile() || actual.size > 2 * 1024 * 1024) throw new Error('Binary, non-file, or oversized snapshot is unsupported')
      // Reserve conservatively before allocating/reading, including concurrent captures.
      if (reserve && !reserve(actual.size * 2)) return null
      const buffer = Buffer.alloc(actual.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset > actual.size) throw new Error('File grew while capturing its snapshot')
      const bytes = buffer.subarray(0, offset), text = bytes.toString('utf8')
      if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Binary or non-UTF-8 snapshot is unsupported')
      return text
    } finally { await file.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

interface PendingSnapshot {
  sessionId: string
  versions: Map<string, string | null>
  bytes: number
  ready: Promise<void>
  finishing: boolean
}

export class AgentArtifacts {
  private before = new Map<string, PendingSnapshot>()
  private beforeBytes = 0
  private locks = new Set<string>()
  constructor(private store: StructuredAgentStore) {}
  async beforeTool(sessionId: string, cwd: string, itemId: string, paths: string[]): Promise<void> {
    const key = `${sessionId}:${itemId}`
    const existing = this.before.get(key)
    if (existing) return existing.ready
    if (this.before.size >= 128) throw new Error('Pending file snapshot allowance reached')
    const capture: PendingSnapshot = { sessionId, versions: new Map(), bytes: 0, ready: Promise.resolve(), finishing: false }
    // Identity is reserved before the first await. A discard or replacement invalidates it.
    this.before.set(key, capture)
    capture.ready = (async () => {
      for (const requested of paths.slice(0, 100)) {
        if (this.before.get(key) !== capture) return
        const path = await snapshotTarget(cwd, requested)
        if (this.before.get(key) !== capture) return
        if (path === null || capture.versions.has(path)) continue
        const version = await textVersion(path, (bytes) => {
          if (this.before.get(key) !== capture) return false
          if (this.beforeBytes + bytes > 32 * 1024 * 1024) throw new Error('Pending file snapshots exceed the 32 MiB memory allowance')
          capture.bytes += bytes
          this.beforeBytes += bytes
          return true
        })
        if (this.before.get(key) !== capture) return
        capture.versions.set(path, version)
      }
    })()
    try { await capture.ready } catch (error) { this.releaseCapture(key, capture); throw error }
  }
  discardSession(sessionId: string): void {
    for (const [key, capture] of this.before) if (capture.sessionId === sessionId) this.releaseCapture(key, capture)
  }
  private releaseCapture(key: string, capture: PendingSnapshot): void {
    if (this.before.get(key) !== capture) return
    this.beforeBytes -= capture.bytes
    capture.bytes = 0
    this.before.delete(key)
  }
  async afterTool(sessionId: string, cwd: string, itemId: string, paths: string[], success: boolean): Promise<FileChange[]> {
    const key = `${sessionId}:${itemId}`, capture = this.before.get(key)
    if (!capture) return []
    if (!success) { this.releaseCapture(key, capture); return [] }
    await capture.ready
    if (this.before.get(key) !== capture || capture.finishing) return []
    capture.finishing = true
    try {
      const snapshots: Array<Omit<DiffArtifact, 'id'>> = []
      for (const requested of paths.slice(0, 100)) {
        const path = await snapshotTarget(cwd, requested)
        if (this.before.get(key) !== capture) return []
        if (path === null || !capture.versions.has(path)) continue
        const before = capture.versions.get(path)!, after = await textVersion(path)
        if (this.before.get(key) !== capture) return []
        if (before === after) continue
        const name = relative(await realpath(cwd), path).replace(/\\/g, '/')
        if (snapshots.some(snapshot => snapshot.path === name)) continue
        const patch = createTwoFilesPatch(before === null ? '/dev/null' : name, after === null ? '/dev/null' : name, before ?? '', after ?? '')
        snapshots.push({ sessionId, path: name, before, after, patch, ...patchCounts(patch), canUndo: true, limitation: 'Hook-scoped snapshot. External filesystem writes are not serialized with the provider.' })
      }
      // No async gap between the final lifecycle check and immutable artifact publication.
      if (this.before.get(key) !== capture) return []
      return snapshots.map(snapshot => {
        const artifact = this.store.putArtifact(sessionId, snapshot)
        return { path: snapshot.path, kind: snapshot.before === null ? 'add' : snapshot.after === null ? 'delete' : 'update', artifactId: artifact.id, additions: artifact.additions, deletions: artifact.deletions, status: 'applied' }
      })
    } finally { this.releaseCapture(key, capture) }
  }
  fromPatch(sessionId: string, change: FileChange, cwd?: string): FileChange {
    if (change.artifactId || !change.patch) return change
    try {
      const counts = patchCounts(change.patch)
      const parsed = parsePatch(change.patch)
      if (!parsed.some(file => file.hunks.length)) return { ...change, additions: undefined, deletions: undefined, limitation: 'Provider change data contains no parseable unified hunks; line counts are unknown.' }
      let before: string | null = null, after: string | null = null, canUndo = false
      let limitation = 'Authoritative provider patch; complete before/after bytes were not supplied. Snapshot undo is unavailable.'
      if (cwd && change.status === 'applied' && parsed.length === 1) {
        try {
          const root = realpathSync.native(cwd), target = lexicalWorkspaceTarget(cwd, root, change.path)
          const assertInside = (value: string): void => { const part = relative(root, value); if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Path outside workspace') }
          assertInside(target)
          let bytes: Buffer | null = null
          try { assertInside(realpathSync.native(target)); const stat = lstatSync(target); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Unsupported snapshot'); bytes = readFileSync(target) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; assertInside(realpathSync.native(dirname(target))) }
          if (bytes && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) throw new Error('Non-UTF-8 snapshot')
          const observed = bytes?.toString('utf8') ?? ''
          const reversed = applyPatch(observed, reversePatch(parsed[0]!))
          if (reversed === false || applyPatch(reversed, parsed[0]!) !== observed) throw new Error('Provider patch does not match current bytes')
          if ((change.kind === 'add' && reversed !== '') || (change.kind === 'delete' && bytes !== null)) throw new Error('Patch kind does not match file state')
          before = change.kind === 'add' ? null : reversed
          after = bytes === null ? null : observed
          canUndo = !change.oldPath
          limitation = 'Versions reconstructed from the authoritative patch and verified against bytes at completion. Undo refuses later changes; external writers are not locked.'
        } catch { /* Preserve the immutable patch when complete versions cannot be established. */ }
      }
      const root = cwd ? realpathSync.native(cwd) : undefined
      const displayedPath = cwd && root ? relative(root, lexicalWorkspaceTarget(cwd, root, change.path)).replace(/\\/g, '/') : change.path
      const artifact = this.store.putArtifact(sessionId, { sessionId, path: displayedPath, oldPath: change.oldPath, before, after, patch: change.patch, ...counts, canUndo, limitation })
      return { ...change, path: displayedPath, ...counts, artifactId: artifact.id, limitation: artifact.limitation }
    } catch { return { ...change, limitation: 'Provider diff is not a supported unified patch; inspect the raw event.' } }
  }
  async undo(cwd: string, artifact: DiffArtifact): Promise<{ outcome: 'reverted' | 'conflict'; message?: string }> {
    if (!artifact.canUndo || artifact.oldPath) return { outcome: 'conflict', message: artifact.limitation ?? 'This change has no complete restorable snapshots' }
    return this.restore(cwd, artifact.path, artifact.after, artifact.before)
  }
  /** Compare-and-write the only bytes we are willing to overwrite. `expected` is the version
   *  this snapshot left behind: anything else on disk is someone else's work, so the restore
   *  refuses rather than choosing a winner. */
  private async restore(cwd: string, requested: string, expected: string | null, target: string | null): Promise<{ outcome: 'reverted' | 'conflict'; message?: string }> {
    const path = await workspacePath(cwd, requested, true)
    if (this.locks.has(path)) return { outcome: 'conflict', message: 'Another restore is in progress' }
    this.locks.add(path)
    try {
      if (await textVersion(path) !== expected) return { outcome: 'conflict', message: 'The file changed after this activity. Current work was preserved; review the reverse patch manually.' }
      // Recheck canonical target immediately before touching bytes.
      await workspacePath(cwd, requested, true)
      if (expected === null) {
        const handle = await open(path, 'wx', 0o600)
        try { await handle.writeFile(target ?? '', 'utf8'); await handle.sync() } finally { await handle.close() }
      } else if (target === null) {
        if (await textVersion(path) !== expected) return { outcome: 'conflict', message: 'File changed during restore' }
        await unlink(path)
      } else {
        const handle = await open(path, 'r+')
        try {
          const current = await handle.readFile()
          if (!current.equals(Buffer.from(expected))) return { outcome: 'conflict', message: 'File changed during restore' }
          const bytes = Buffer.from(target)
          await handle.write(bytes, 0, bytes.length, 0)
          await handle.truncate(bytes.length)
          await handle.sync()
        } finally { await handle.close() }
      }
      return { outcome: 'reverted' }
    } catch (error) {
      if (['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return { outcome: 'conflict', message: 'File changed during restore' }
      throw error
    } finally { this.locks.delete(path) }
  }

  /** Every file this conversation touched, grouped by turn and by file, with the disk state
   *  and cross-conversation conflicts that decide whether each restore is still exact. */
  async changeHistory(sessionId: string, cwd: string): Promise<AgentChangeHistory> {
    const state = this.store.snapshot(sessionId)
    if (!state) throw new Error('Session not found')
    const history = buildChangeHistory(sessionId, cwd, state.items, state.truncated)
    const others = this.otherConversationEdits(sessionId)
    for (const file of history.files) {
      const newest = file.edits.filter(edit => edit.artifactId && edit.status === 'applied' && !edit.reverted).at(-1)
      let expected: string | null | undefined
      if (newest?.artifactId) { try { expected = this.store.artifact(sessionId, newest.artifactId).after } catch { expected = undefined } }
      if (expected !== undefined) {
        try {
          const current = await textVersion(await workspacePath(cwd, file.path, true))
          file.disk = current === expected ? 'matches-snapshot' : current === null ? 'missing' : 'changed-since-snapshot'
        } catch { file.disk = 'unreadable' }
      }
      const rival = others.get(pathKey(file.path))
      if (rival && newest && rival.at > newest.timestamp) block(file.revert, file.path, `${rival.title} edited this file after this conversation did. Restoring would discard that work.`)
      else if (file.disk === 'changed-since-snapshot' || file.disk === 'missing') block(file.revert, file.path, 'This file changed on disk after the snapshot. Restoring would discard that edit.')
      else if (file.disk === 'unreadable') block(file.revert, file.path, 'This file can no longer be read as text in the workspace.')
    }
    for (const turn of history.turns) for (const entry of [...turn.revert.restore]) {
      const file = history.files.find(candidate => pathKey(candidate.path) === pathKey(entry.path))
      const reason = file?.revert.blocked.find(blocked => pathKey(blocked.path) === pathKey(entry.path))?.reason
      if (reason) block(turn.revert, entry.path, reason)
    }
    if (!history.files.length) history.note = 'This conversation has not written any files yet.'
    else if (history.truncated) history.note = 'The oldest activity in this conversation was compacted; earlier edits may be missing.'
    return history
  }

  /** Newest edit per path made by any other conversation in the same project. Projections
   *  are already in memory, so this stays a read of state Conductor holds, not a disk scan. */
  private otherConversationEdits(sessionId: string): Map<string, { title: string; at: string }> {
    const found = new Map<string, { title: string; at: string }>()
    const projectId = this.store.spec<{ projectId?: string }>(sessionId)?.projectId
    if (!projectId) return found
    for (const row of this.store.history(projectId)) {
      if (row.id === sessionId) continue
      for (const item of this.store.snapshot(row.id)?.items ?? []) {
        if (item.data.type !== 'changes') continue
        for (const change of item.data.changes) {
          if (change.status !== 'applied') continue
          const key = pathKey(change.path), previous = found.get(key)
          if (!previous || previous.at < item.timestamp) found.set(key, { title: row.title || 'Another conversation', at: item.timestamp })
        }
      }
    }
    return found
  }

  /** Restore one edit, one file, or a whole turn. Each path is checked independently so a
   *  single unsafe file never silently cancels — or silently permits — the rest. */
  async revertChanges(sessionId: string, cwd: string, scope: RevertScope): Promise<RevertOutcome> {
    const history = await this.changeHistory(sessionId, cwd)
    const selection = selectEdits(history, scope)
    if (!selection.length) return { reverted: [], blocked: [], message: 'That change is no longer part of this conversation.' }
    const plan = scope.kind === 'turn' ? history.turns.find(turn => turn.key === scope.turnKey)!.revert
      : scope.kind === 'file' ? history.files.find(file => pathKey(file.path) === pathKey(scope.path))!.revert
      : planRevert(history, selection)
    const blocked = [...plan.blocked]
    if (scope.kind === 'edit') for (const file of history.files) for (const reason of file.revert.blocked) {
      if (plan.restore.some(entry => pathKey(entry.path) === pathKey(reason.path)) && !blocked.some(existing => pathKey(existing.path) === pathKey(reason.path))) blocked.push(reason)
    }
    const reverted: RevertOutcome['reverted'] = []
    for (const entry of plan.restore) {
      if (blocked.some(existing => pathKey(existing.path) === pathKey(entry.path))) continue
      try {
        const expected = this.store.artifact(sessionId, entry.expectedArtifactId).after
        const target = this.store.artifact(sessionId, entry.fromArtifactId).before
        if (expected === target) { blocked.push({ path: entry.path, reason: 'This file already matches the version before the change.' }); continue }
        const result = await this.restore(cwd, entry.path, expected, target)
        if (result.outcome === 'reverted') reverted.push({ path: entry.path, artifactIds: entry.artifactIds })
        else blocked.push({ path: entry.path, reason: result.message ?? 'The file changed since the snapshot.' })
      } catch (error) { blocked.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) }) }
    }
    const message = reverted.length && blocked.length ? `Restored ${reverted.length} of ${reverted.length + blocked.length} files; the rest were left untouched.`
      : reverted.length ? `Restored ${reverted.length} file${reverted.length === 1 ? '' : 's'} to the version before this change.`
      : 'Nothing was restored. Every file in this selection was left exactly as it is.'
    return { reverted, blocked, message }
  }
}

function block(plan: RevertPlan, path: string, reason: string): void {
  plan.restore = plan.restore.filter(entry => pathKey(entry.path) !== pathKey(path))
  if (!plan.blocked.some(existing => pathKey(existing.path) === pathKey(path))) plan.blocked.push({ path, reason })
}

/** Bound private snapshot storage the way the event journal is bounded: history stays
 *  readable, but the heavy `before`/`after` bytes behind old edits are dropped once they are
 *  past the retention window or over budget. A pruned artifact keeps its patch and its id, so
 *  the timeline still renders and a restore refuses instead of failing to find its snapshot. */
export function pruneDiffSnapshots(directory: string, now = Date.now(), maxAgeMs = 30 * 24 * 60 * 60 * 1000, budgetBytes = 128 * 1024 * 1024): { pruned: number; freedBytes: number } {
  let entries: Array<{ file: string; size: number; at: number }>
  try {
    entries = readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => {
      const stat = statSync(join(directory, name))
      return { file: join(directory, name), size: stat.size, at: stat.mtimeMs }
    }).sort((left, right) => right.at - left.at)
  } catch { return { pruned: 0, freedBytes: 0 } }
  let kept = 0, pruned = 0, freedBytes = 0
  for (const entry of entries) {
    kept += entry.size
    if (now - entry.at <= maxAgeMs && kept <= budgetBytes) continue
    try {
      const artifact = JSON.parse(readFileSync(entry.file, 'utf8')) as DiffArtifact & { snapshotPruned?: boolean }
      if (artifact.snapshotPruned || (artifact.before === null && artifact.after === null)) continue
      const replacement: DiffArtifact & { snapshotPruned: true } = {
        ...artifact, before: null, after: null, canUndo: false, snapshotPruned: true,
        patch: artifact.patch.slice(0, 64 * 1024),
        limitation: 'The stored before/after versions for this edit were pruned to bound local snapshot storage. The patch is kept; restoring is no longer possible.'
      }
      const data = JSON.stringify(replacement)
      writeFileSync(entry.file, data, { mode: 0o600 })
      kept -= entry.size - Buffer.byteLength(data)
      freedBytes += entry.size - Buffer.byteLength(data)
      pruned++
    } catch { /* An unreadable or concurrently written artifact is left exactly as it is. */ }
  }
  return { pruned, freedBytes }
}
