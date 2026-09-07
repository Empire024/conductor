import { realpath, lstat, open, unlink } from 'node:fs/promises'
import { realpathSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch, parsePatch, applyPatch, reversePatch } from 'diff'
import type { DiffArtifact, FileChange } from '../shared/structured-agent'
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

/** Lexical + canonical path check, including existing parent for new/deleted files. */
function lexicalWorkspaceTarget(cwd: string, root: string, requested: string): string {
  const lexicalRoot = resolve(cwd), target = resolve(lexicalRoot, requested)
  const inside = (base: string): boolean => { const part = relative(base, target); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
  if (inside(lexicalRoot)) return resolve(root, relative(lexicalRoot, target))
  if (inside(root)) return target
  throw new Error('File is outside the session workspace')
}
export async function workspacePath(cwd: string, requested: string, allowMissing = false): Promise<string> {
  if (!requested || requested.includes('\0') || (process.platform === 'win32' && /^(?:\/|[a-z]:[^\\/])/i.test(requested))) throw new Error('Invalid workspace path; WSL paths require an explicit mapping')
  const root = await realpath(cwd), target = lexicalWorkspaceTarget(cwd, root, requested)
  const inside = (candidate: string): boolean => { const part = relative(root, candidate); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
  if (!inside(target)) throw new Error('File is outside the session workspace')
  try {
    const canonical = await realpath(target)
    if (!inside(canonical)) throw new Error('Symlink or junction leaves the session workspace')
    return canonical
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = await realpath(dirname(target))
    if (!inside(parent)) throw new Error('Parent junction leaves the session workspace')
    return resolve(parent, basename(target))
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
        const path = await workspacePath(cwd, requested, true)
        if (this.before.get(key) !== capture) return
        if (capture.versions.has(path)) continue
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
        const path = await workspacePath(cwd, requested, true)
        if (this.before.get(key) !== capture) return []
        if (!capture.versions.has(path)) continue
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
    const path = await workspacePath(cwd, artifact.path, true)
    if (this.locks.has(path)) return { outcome: 'conflict', message: 'Another restore is in progress' }
    this.locks.add(path)
    try {
      if (await textVersion(path) !== artifact.after) return { outcome: 'conflict', message: 'The file changed after this activity. Current work was preserved; review the reverse patch manually.' }
      // Recheck canonical target immediately before touching bytes.
      await workspacePath(cwd, artifact.path, true)
      if (artifact.after === null) {
        const handle = await open(path, 'wx', 0o600)
        try { await handle.writeFile(artifact.before ?? '', 'utf8'); await handle.sync() } finally { await handle.close() }
      } else if (artifact.before === null) {
        if (await textVersion(path) !== artifact.after) return { outcome: 'conflict', message: 'File changed during restore' }
        await unlink(path)
      } else {
        const handle = await open(path, 'r+')
        try {
          const current = await handle.readFile()
          if (!current.equals(Buffer.from(artifact.after))) return { outcome: 'conflict', message: 'File changed during restore' }
          const bytes = Buffer.from(artifact.before)
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
}
