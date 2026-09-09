import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { AgentArtifacts, patchCounts, workspacePath } from './agent-artifacts'
import { StructuredAgentStore } from './structured-store'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-diff-fixture-')); roots.push(root)
  const workspace = join(root, 'Workspace 日本語 with spaces'); mkdirSync(workspace)
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY); INSERT INTO agent_sessions(id) VALUES(\'session\')')
  const store = new StructuredAgentStore(db, root); store.register('session', 'project', 'claude', {})
  return { root, workspace, store, artifacts: new AgentArtifacts(store) }
}
const beforePanel = "export function updatePanel(el, pinned) {\n  var wasOpen = el.classList.contains('is-open');\n  var wasPinned = pinned;\n  el.classList.add('is-loading');\n}\n"
const afterPanel = "export function updatePanel(el, pinned) {\n  el.classList.add('is-loading');\n}\n"

describe('immutable diff artifacts and conflict-safe snapshot restore', () => {
  it('counts exactly two actual deleted lines and restores a dirty initial version byte-for-byte', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, beforePanel)
    await f.artifacts.beforeTool('session', f.workspace, 'edit', ['panel.mjs'])
    writeFileSync(path, afterPanel)
    const changes = await f.artifacts.afterTool('session', f.workspace, 'edit', ['panel.mjs'], true)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ additions: 0, deletions: 2, status: 'applied', kind: 'update' })
    const artifact = f.store.artifact('session', changes[0]!.artifactId!)
    expect(artifact.before).toBe(beforePanel); expect(artifact.after).toBe(afterPanel)
    expect(await f.artifacts.undo(f.workspace, artifact)).toEqual({ outcome: 'reverted' })
    expect(readFileSync(path, 'utf8')).toBe(beforePanel)
  })
  it('opens immutable history after subsequent edits and refuses to overwrite later work', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, beforePanel)
    await f.artifacts.beforeTool('session', f.workspace, 'first', ['panel.mjs'])
    writeFileSync(path, afterPanel)
    const [first] = await f.artifacts.afterTool('session', f.workspace, 'first', ['panel.mjs'], true)
    const history = f.store.artifact('session', first!.artifactId!)
    await f.artifacts.beforeTool('session', f.workspace, 'second', ['panel.mjs'])
    writeFileSync(path, `${afterPanel}// later user/agent work\n`)
    const [second] = await f.artifacts.afterTool('session', f.workspace, 'second', ['panel.mjs'], true)
    expect(f.store.artifact('session', first!.artifactId!)).toEqual(history)
    expect((await f.artifacts.undo(f.workspace, history)).outcome).toBe('conflict')
    expect(readFileSync(path, 'utf8')).toContain('later user/agent work')
    expect((await f.artifacts.undo(f.workspace, f.store.artifact('session', second!.artifactId!))).outcome).toBe('reverted')
    expect((await f.artifacts.undo(f.workspace, history)).outcome).toBe('reverted')
  })
  it.each([
    ['CRLF Unicode and missing final newline', 'one\r\nárvíz 日本語\r\nlast', 'one\r\nchanged 😀\r\nlast'],
    ['multiple hunks', Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(''), Array.from({ length: 30 }, (_, i) => i === 2 || i === 26 ? `changed ${i}\n` : `line ${i}\n`).join('')]
  ])('retains exact bytes for %s', async (_name, before, after) => {
    const f = fixture(), filename = 'long 日本語 file with spaces.txt', path = join(f.workspace, filename)
    writeFileSync(path, before!)
    await f.artifacts.beforeTool('session', f.workspace, 'edit', [filename])
    writeFileSync(path, after!)
    const [change] = await f.artifacts.afterTool('session', f.workspace, 'edit', [filename], true)
    const artifact = f.store.artifact('session', change!.artifactId!)
    expect(artifact.before).toBe(before); expect(artifact.after).toBe(after)
    expect((await f.artifacts.undo(f.workspace, artifact)).outcome).toBe('reverted')
    expect(readFileSync(path)).toEqual(Buffer.from(before!))
  })
  it('handles creation and deletion while refusing recreated-file conflicts', async () => {
    const f = fixture(), path = join(f.workspace, 'created.txt')
    await f.artifacts.beforeTool('session', f.workspace, 'create', ['created.txt'])
    writeFileSync(path, 'new\n')
    const [created] = await f.artifacts.afterTool('session', f.workspace, 'create', ['created.txt'], true)
    expect(created).toMatchObject({ kind: 'add', additions: 1, deletions: 0 })
    await f.artifacts.beforeTool('session', f.workspace, 'delete', ['created.txt'])
    unlinkSync(path)
    const [deleted] = await f.artifacts.afterTool('session', f.workspace, 'delete', ['created.txt'], true)
    expect(deleted).toMatchObject({ kind: 'delete', additions: 0, deletions: 1 })
    const artifact = f.store.artifact('session', deleted!.artifactId!)
    writeFileSync(path, 'user recreated this file')
    expect((await f.artifacts.undo(f.workspace, artifact)).outcome).toBe('conflict')
    unlinkSync(path)
    expect((await f.artifacts.undo(f.workspace, artifact)).outcome).toBe('reverted')
    expect(readFileSync(path, 'utf8')).toBe('new\n')
    expect((await f.artifacts.undo(f.workspace, f.store.artifact('session', created!.artifactId!))).outcome).toBe('reverted')
  })
  it('does not call a failed/denied/proposed tool an applied change', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, beforePanel)
    await f.artifacts.beforeTool('session', f.workspace, 'denied', ['panel.mjs'])
    expect(await f.artifacts.afterTool('session', f.workspace, 'denied', ['panel.mjs'], false)).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(beforePanel)
    expect(await f.artifacts.afterTool('session', f.workspace, 'missing-hook', ['panel.mjs'], true)).toEqual([])
  })
  it('reconstructs immutable versions from an authoritative applied patch only after exact roundtrip verification', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    const patch = createTwoFilesPatch('panel.mjs', 'panel.mjs', beforePanel, afterPanel)
    writeFileSync(path, afterPanel)
    const change = f.artifacts.fromPatch('session', { path: 'panel.mjs', kind: 'update', status: 'applied', patch }, f.workspace)
    const artifact = f.store.artifact('session', change.artifactId!)
    expect(artifact).toMatchObject({ before: beforePanel, after: afterPanel, canUndo: true, additions: 0, deletions: 2 })
    expect((await f.artifacts.undo(f.workspace, artifact)).outcome).toBe('reverted')
    writeFileSync(path, 'unrelated current content\n')
    const mismatch = f.artifacts.fromPatch('session', { path: 'panel.mjs', kind: 'update', status: 'applied', patch }, f.workspace)
    expect(f.store.artifact('session', mismatch.artifactId!)).toMatchObject({ canUndo: false, patch })
    const proposed = f.artifacts.fromPatch('session', { path: 'panel.mjs', kind: 'update', status: 'proposed', patch }, f.workspace)
    expect(f.store.artifact('session', proposed.artifactId!).canUndo).toBe(false)
  })
  it('keeps rename and patch-only limitations explicit', () => {
    const f = fixture(), patch = createTwoFilesPatch('old.txt', 'new.txt', 'old\n', 'new\n')
    writeFileSync(join(f.workspace, 'new.txt'), 'new\n')
    const rename = f.artifacts.fromPatch('session', { path: 'new.txt', oldPath: 'old.txt', kind: 'rename', status: 'applied', patch }, f.workspace)
    expect(f.store.artifact('session', rename.artifactId!).canUndo).toBe(false)
    const patchOnly = f.artifacts.fromPatch('session', { path: 'new.txt', kind: 'update', status: 'applied', patch })
    expect(f.store.artifact('session', patchOnly.artifactId!)).toMatchObject({ before: null, after: null, canUndo: false })
    expect(patchCounts(patch)).toEqual({ additions: 1, deletions: 1 })
  })

  it('skips out-of-workspace and not-yet-addressable targets quietly and still snapshots the workspace file in the same call', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    const outside = join(f.root, 'memory'); mkdirSync(outside)
    const note = join(outside, 'note.md'); writeFileSync(note, 'before memory\n')
    writeFileSync(path, beforePanel)
    const wsl = process.platform === 'win32' ? '/mnt/c/Users/owner/memory.md' : '/etc/conductor-fixture-passwd'
    const targets = ['../memory/note.md', wsl, 'panel.mjs', 'not-created-yet/deep/new.txt']
    await expect(f.artifacts.beforeTool('session', f.workspace, 'edit', targets)).resolves.toBeUndefined()
    writeFileSync(note, 'after memory\n')
    writeFileSync(path, afterPanel)
    mkdirSync(join(f.workspace, 'not-created-yet', 'deep'), { recursive: true })
    writeFileSync(join(f.workspace, 'not-created-yet', 'deep', 'new.txt'), 'created\n')
    const changes = await f.artifacts.afterTool('session', f.workspace, 'edit', targets, true)
    expect(changes.map((change) => change.path)).toEqual(['panel.mjs'])
    expect(f.store.artifact('session', changes[0]!.artifactId!)).toMatchObject({ before: beforePanel, after: afterPanel })
    expect(readFileSync(note, 'utf8')).toBe('after memory\n')
  })

  it('rejects path traversal, external junctions, binary and oversized files', async () => {
    const f = fixture(), outside = join(f.root, 'outside'); mkdirSync(outside)
    writeFileSync(join(outside, 'outside.txt'), 'private fixture')
    await expect(workspacePath(f.workspace, '../outside/outside.txt')).rejects.toThrow('outside')
    symlinkSync(outside, join(f.workspace, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(workspacePath(f.workspace, 'junction/outside.txt')).rejects.toThrow('junction')
    await expect(workspacePath(f.workspace, 'junction/new.txt', true)).rejects.toThrow('junction')
    writeFileSync(join(f.workspace, 'binary'), Buffer.from([0, 255]))
    await expect(f.artifacts.beforeTool('session', f.workspace, 'binary', ['binary'])).rejects.toThrow('Binary')
    writeFileSync(join(f.workspace, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    await expect(f.artifacts.beforeTool('session', f.workspace, 'large', ['large'])).rejects.toThrow('oversized')
  })

  it('preserves the original before version when a native tool ID is declared again', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, beforePanel)
    await f.artifacts.beforeTool('session', f.workspace, 'same-id', ['panel.mjs'])
    writeFileSync(path, afterPanel)
    await f.artifacts.beforeTool('session', f.workspace, 'same-id', ['panel.mjs'])
    const [change] = await f.artifacts.afterTool('session', f.workspace, 'same-id', ['panel.mjs'], true)
    expect(f.store.artifact('session', change!.artifactId!)).toMatchObject({ before: beforePanel, after: afterPanel, deletions: 2 })
  })

  it('discards pending captures and prevents an in-flight pre-hook from resurrecting one', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, beforePanel)
    const preparing = f.artifacts.beforeTool('session', f.workspace, 'in-flight', ['panel.mjs'])
    f.artifacts.discardSession('session')
    await preparing
    writeFileSync(path, afterPanel)
    expect(await f.artifacts.afterTool('session', f.workspace, 'in-flight', ['panel.mjs'], true)).toEqual([])
    await f.artifacts.beforeTool('session', f.workspace, 'ready', ['panel.mjs'])
    f.artifacts.discardSession('session')
    expect(await f.artifacts.afterTool('session', f.workspace, 'ready', ['panel.mjs'], true)).toEqual([])
  })

  it('does not publish artifacts when a post-hook completes after its session was discarded', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, beforePanel)
    await f.artifacts.beforeTool('session', f.workspace, 'edit', ['panel.mjs'])
    writeFileSync(path, afterPanel)
    const publish = vi.spyOn(f.store, 'putArtifact')
    const completing = f.artifacts.afterTool('session', f.workspace, 'edit', ['panel.mjs'], true)
    f.artifacts.discardSession('session')
    expect(await completing).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it('reserves concurrent capture slots before awaiting filesystem reads and releases them on discard', async () => {
    const f = fixture()
    const results = await Promise.allSettled(Array.from({ length: 129 }, (_, index) => f.artifacts.beforeTool('session', f.workspace, `slot-${index}`, ['not-created.txt'])))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(128)
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.status === 'rejected' ? String(rejected[0]!.reason) : '').toContain('allowance reached')
    f.artifacts.discardSession('session')
    await expect(f.artifacts.beforeTool('session', f.workspace, 'fresh-slot', ['not-created.txt'])).resolves.toBeUndefined()
  })

  it('rejects captures beyond the 32 MiB memory allowance and permits new capture after discard', async () => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'large.txt'), 'A'.repeat(2 * 1024 * 1024))
    for (let index = 0; index < 8; index++) await f.artifacts.beforeTool('session', f.workspace, `memory-${index}`, ['large.txt'])
    await expect(f.artifacts.beforeTool('session', f.workspace, 'overflow', ['large.txt'])).rejects.toThrow('32 MiB memory allowance')
    f.artifacts.discardSession('session')
    await expect(f.artifacts.beforeTool('session', f.workspace, 'after-discard', ['large.txt'])).resolves.toBeUndefined()
    f.artifacts.discardSession('session')
  })

  it('returns canonical targets for existing files and missing files reached through an internal junction', async () => {
    const f = fixture(), target = join(f.workspace, 'target'); mkdirSync(target)
    writeFileSync(join(target, 'file.txt'), 'canonical fixture')
    symlinkSync(target, join(f.workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await workspacePath(f.workspace, 'alias/file.txt')).toBe(join(realpathSync.native(target), 'file.txt'))
    expect(await workspacePath(f.workspace, join(f.workspace, 'alias', 'file.txt'))).toBe(join(realpathSync.native(target), 'file.txt'))
    expect(await workspacePath(f.workspace, 'alias/new.txt', true)).toBe(join(realpathSync.native(target), 'new.txt'))
  })
})
