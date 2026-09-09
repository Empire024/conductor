import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentArtifacts, pruneDiffSnapshots } from './agent-artifacts'
import { StructuredAgentStore } from './structured-store'
import type { AgentEvent, AgentEventData, FileChange } from '../shared/structured-agent'
import type { DiffArtifact } from '../shared/structured-agent'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

function fixture(sessions = ['session']) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-history-fixture-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)')
  for (const id of sessions) db.prepare('INSERT INTO agent_sessions(id) VALUES(?)').run(id)
  const store = new StructuredAgentStore(db, root)
  for (const id of sessions) store.register(id, 'project', 'claude', { id, projectId: 'project', cwd: workspace })
  const sequences = new Map<string, number>()
  let clock = Date.parse('2026-01-01T10:00:00.000Z')
  const append = (sessionId: string, data: AgentEventData): AgentEvent => {
    const sequence = (sequences.get(sessionId) ?? 0) + 1
    sequences.set(sessionId, sequence)
    clock += 1000
    return store.append({
      schemaVersion: 1, id: randomUUID(), sequence, sessionId, runtimeId: 'runtime', provider: 'claude',
      projectId: 'project', workspaceId: 'workspace', cwd: workspace, timestamp: new Date(clock).toISOString(), data
    })
  }
  const say = (sessionId: string, text: string): void => { append(sessionId, { type: 'text', role: 'user', text, mode: 'snapshot' }) }
  const artifacts = new AgentArtifacts(store)
  /** Drive a real capture so the recorded change is a genuine before/after snapshot. */
  const edit = async (sessionId: string, name: string, write: string | null): Promise<FileChange[]> => {
    const itemId = randomUUID(), path = join(workspace, name)
    await artifacts.beforeTool(sessionId, workspace, itemId, [name])
    if (write === null) rmSync(path, { force: true })
    else writeFileSync(path, write)
    const changes = await artifacts.afterTool(sessionId, workspace, itemId, [name], true)
    if (changes.length) append(sessionId, { type: 'changes', changes })
    return changes
  }
  return { root, workspace, store, artifacts, append, say, edit, read: (name: string) => readFileSync(join(workspace, name), 'utf8'), path: (name: string) => join(workspace, name) }
}

const original = 'one\ntwo\nthree\n'

describe('per-conversation change history', () => {
  it('groups every write by turn and by file, keeping the net effect per file', async () => {
    const f = fixture()
    writeFileSync(f.path('kept.txt'), original)
    f.say('session', 'First ask\nwith a second line')
    await f.edit('session', 'kept.txt', 'one\nTWO\nthree\n')
    await f.edit('session', 'added.txt', 'brand new\n')
    f.say('session', 'Second ask')
    await f.edit('session', 'kept.txt', 'one\nTWO\nTHREE\n')

    const history = await f.artifacts.changeHistory('session', f.workspace)
    expect(history.turns.map(turn => turn.label)).toEqual(['First ask', 'Second ask'])
    expect(history.turns[0]!.edits.map(edit => edit.path)).toEqual(['kept.txt', 'added.txt'])
    expect(history.turns[1]!.edits.map(edit => edit.path)).toEqual(['kept.txt'])
    expect(history.totals).toMatchObject({ files: 2, edits: 3 })
    const kept = history.files.find(file => file.path === 'kept.txt')!
    expect(kept.kind).toBe('update')
    expect(kept.edits).toHaveLength(2)
    expect(kept.disk).toBe('matches-snapshot')
    expect(history.files.find(file => file.path === 'added.txt')!.kind).toBe('add')
  })

  it('restores a whole turn across several files and records each snapshot as undone', async () => {
    const f = fixture()
    writeFileSync(f.path('a.txt'), original)
    writeFileSync(f.path('b.txt'), original)
    f.say('session', 'Change both files')
    await f.edit('session', 'a.txt', 'a changed\n')
    await f.edit('session', 'b.txt', 'b changed\n')

    const history = await f.artifacts.changeHistory('session', f.workspace)
    const turn = history.turns[0]!
    expect(turn.revert.restore.map(entry => entry.path)).toEqual(['a.txt', 'b.txt'])
    const outcome = await f.artifacts.revertChanges('session', f.workspace, { kind: 'turn', turnKey: turn.key })
    expect(outcome.blocked).toEqual([])
    expect(outcome.reverted.map(entry => entry.path)).toEqual(['a.txt', 'b.txt'])
    expect(f.read('a.txt')).toBe(original)
    expect(f.read('b.txt')).toBe(original)
  })

  it('collapses several edits of one file back to the version before the conversation touched it', async () => {
    const f = fixture()
    writeFileSync(f.path('kept.txt'), original)
    f.say('session', 'Edit repeatedly')
    await f.edit('session', 'kept.txt', 'one\nTWO\nthree\n')
    await f.edit('session', 'kept.txt', 'one\nTWO\nTHREE\n')
    await f.edit('session', 'kept.txt', 'ONE\nTWO\nTHREE\n')

    const outcome = await f.artifacts.revertChanges('session', f.workspace, { kind: 'file', path: 'kept.txt' })
    expect(outcome.reverted).toHaveLength(1)
    expect(outcome.reverted[0]!.artifactIds).toHaveLength(3)
    expect(f.read('kept.txt')).toBe(original)
    // Every collapsed snapshot is now history: offering any of them again would be a lie.
    // `StructuredSessions.revertChanges` records exactly these review events for the timeline.
    for (const artifactId of outcome.reverted[0]!.artifactIds) f.append('session', { type: 'review', artifactId, outcome: 'reverted' })
    const after = await f.artifacts.changeHistory('session', f.workspace)
    const kept = after.files.find(file => file.path === 'kept.txt')!
    expect(kept.edits.every(edit => edit.reverted)).toBe(true)
    expect(kept.revert.restore).toEqual([])
    expect(kept.revert.blocked[0]!.reason).toMatch(/Already restored/)
  })

  it('recreates a file the agent deleted and removes one it created', async () => {
    const f = fixture()
    writeFileSync(f.path('doomed.txt'), original)
    f.say('session', 'Delete one, add one')
    await f.edit('session', 'doomed.txt', null)
    await f.edit('session', 'fresh.txt', 'new file\n')
    expect(existsSync(f.path('doomed.txt'))).toBe(false)

    const outcome = await f.artifacts.revertChanges('session', f.workspace, { kind: 'turn', turnKey: (await f.artifacts.changeHistory('session', f.workspace)).turns[0]!.key })
    expect(outcome.blocked).toEqual([])
    expect(f.read('doomed.txt')).toBe(original)
    expect(existsSync(f.path('fresh.txt'))).toBe(false)
  })

  it('refuses when the file changed on disk after the snapshot, and leaves the new bytes alone', async () => {
    const f = fixture()
    writeFileSync(f.path('kept.txt'), original)
    f.say('session', 'Edit it')
    await f.edit('session', 'kept.txt', 'agent version\n')
    writeFileSync(f.path('kept.txt'), 'hand-typed by the owner\n')

    const history = await f.artifacts.changeHistory('session', f.workspace)
    const kept = history.files[0]!
    expect(kept.disk).toBe('changed-since-snapshot')
    expect(kept.revert.restore).toEqual([])
    expect(kept.revert.blocked[0]!.reason).toMatch(/changed on disk/)
    const outcome = await f.artifacts.revertChanges('session', f.workspace, { kind: 'file', path: 'kept.txt' })
    expect(outcome.reverted).toEqual([])
    expect(outcome.blocked[0]!.reason).toMatch(/changed on disk/)
    expect(f.read('kept.txt')).toBe('hand-typed by the owner\n')
  })

  it('names the other conversation rather than clobbering its later edit', async () => {
    const f = fixture(['session', 'rival'])
    f.store.update('rival', { title: 'Sidebar cleanup' })
    writeFileSync(f.path('shared.txt'), original)
    f.say('session', 'Edit shared file')
    await f.edit('session', 'shared.txt', 'first agent\n')
    f.say('rival', 'Also edit it')
    await f.edit('rival', 'shared.txt', 'second agent\n')

    const history = await f.artifacts.changeHistory('session', f.workspace)
    const shared = history.files[0]!
    expect(shared.revert.restore).toEqual([])
    expect(shared.revert.blocked[0]!.reason).toContain('Sidebar cleanup')
    const outcome = await f.artifacts.revertChanges('session', f.workspace, { kind: 'file', path: 'shared.txt' })
    expect(outcome.reverted).toEqual([])
    expect(f.read('shared.txt')).toBe('second agent\n')
    // The conversation that actually owns the newest snapshot can still take it back.
    expect((await f.artifacts.revertChanges('rival', f.workspace, { kind: 'file', path: 'shared.txt' })).reverted).toHaveLength(1)
    expect(f.read('shared.txt')).toBe('first agent\n')
  })

  it('will not undo an older edit while a later edit in the same conversation stands', async () => {
    const f = fixture()
    writeFileSync(f.path('kept.txt'), original)
    f.say('session', 'Two passes')
    const [first] = await f.edit('session', 'kept.txt', 'pass one\n')
    await f.edit('session', 'kept.txt', 'pass two\n')

    const history = await f.artifacts.changeHistory('session', f.workspace)
    const older = history.files[0]!.edits[0]!
    expect(older.artifactId).toBe(first!.artifactId)
    const outcome = await f.artifacts.revertChanges('session', f.workspace, { kind: 'edit', itemId: older.itemId, index: older.index })
    expect(outcome.reverted).toEqual([])
    expect(outcome.blocked[0]!.reason).toMatch(/later edit in this conversation/)
    expect(f.read('kept.txt')).toBe('pass two\n')
    // The newest edit alone is still exactly restorable.
    const newest = history.files[0]!.edits[1]!
    expect((await f.artifacts.revertChanges('session', f.workspace, { kind: 'edit', itemId: newest.itemId, index: newest.index })).reverted).toHaveLength(1)
    expect(f.read('kept.txt')).toBe('pass one\n')
  })

  it('reports an empty conversation instead of an empty list', async () => {
    const f = fixture()
    f.say('session', 'Just talking')
    const history = await f.artifacts.changeHistory('session', f.workspace)
    expect(history.files).toEqual([])
    expect(history.note).toMatch(/not written any files/)
  })
})

describe('bounding local snapshot storage', () => {
  it('drops the stored versions of aged-out snapshots but keeps the patch and refuses to restore', async () => {
    const f = fixture()
    writeFileSync(f.path('kept.txt'), original)
    f.say('session', 'Edit it')
    const [change] = await f.edit('session', 'kept.txt', 'agent version\n')
    const before = f.store.artifact('session', change!.artifactId!)
    expect(before.before).toBe(original)

    const stale = Date.now() / 1000 - 90 * 24 * 60 * 60
    const file = join(f.store.artifactDirectory, change!.artifactId! + '.json')
    utimesSync(file, stale, stale)
    expect(pruneDiffSnapshots(f.store.artifactDirectory).pruned).toBe(1)

    const pruned = f.store.artifact('session', change!.artifactId!)
    expect(pruned.before).toBeNull()
    expect(pruned.after).toBeNull()
    expect(pruned.canUndo).toBe(false)
    expect(pruned.patch).toBe(before.patch)
    expect(pruned.limitation).toMatch(/pruned/)
    expect((await f.artifacts.undo(f.workspace, pruned)).outcome).toBe('conflict')
    expect(f.read('kept.txt')).toBe('agent version\n')
    // Pruning is idempotent: a second sweep has nothing left to take.
    expect(pruneDiffSnapshots(f.store.artifactDirectory).pruned).toBe(0)
  })

  it('keeps recent snapshots and prunes only what is over the byte budget', async () => {
    const f = fixture()
    f.say('session', 'Write a few files')
    const ids: string[] = []
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      const [change] = await f.edit('session', name, name.repeat(200))
      ids.push(change!.artifactId!)
    }
    const budget = readFileSync(join(f.store.artifactDirectory, ids.at(-1)! + '.json')).byteLength + 100
    expect(pruneDiffSnapshots(f.store.artifactDirectory, Date.now(), 30 * 24 * 60 * 60 * 1000, budget).pruned).toBe(2)
    const survivors = ids.filter(id => (JSON.parse(readFileSync(join(f.store.artifactDirectory, id + '.json'), 'utf8')) as DiffArtifact).after !== null)
    expect(survivors).toEqual([ids.at(-1)])
  })
})
