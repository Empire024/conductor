import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import { ScheduleStore, scriptDigest, type BuiltinSchedule } from './schedule-store'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-schedules-')), path = join(root, 'state.db')
  const database = new ConductorDatabase(path), project = database.upsertProject(root, 'Schedules')
  let store: ScheduleStore | null = null
  cleanup.push(() => { store?.close(); database.close(); rmSync(root, { recursive: true, force: true }) })
  return { path, project, open: () => (store = new ScheduleStore(path)) }
}

const builtin = (patch: Partial<BuiltinSchedule> = {}): BuiltinSchedule => ({
  kind: 'latest-models-methods', name: 'Latest models and CLI compatibility', prompt: 'Keep Conductor working with the installed CLIs.',
  everyMinutes: 1_440, timing: 'night', brain: true, timeoutMs: 30 * 60_000, agent: { provider: 'claude', model: 'opus' },
  scripts: [
    { name: 'cli-catalogs', description: 'Ask the CLIs', language: 'node', format: 'json', runWhen: 'always', timeoutSec: 180, order: 1, content: 'console.log("{}")' },
    { name: 'offline-tests', description: 'Run tests', language: 'node', format: 'json', runWhen: 'changed', timeoutSec: 900, order: 5, content: 'console.log("[]")' }
  ],
  ...patch
})

/** The exact schema the first schedules release created, so the migration runs against what an
 *  installed Conductor really has on disk. */
const createLegacySchema = (path: string, projectId: string): void => {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schedules (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, job_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, every_minutes INTEGER NOT NULL, catch_up TEXT NOT NULL DEFAULT 'collapse', timeout_ms INTEGER NOT NULL DEFAULT 120000,
      last_run_at TEXT, next_due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, job_id));
    CREATE INDEX schedules_due_idx ON schedules(enabled, next_due_at);
    CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE, started_at TEXT NOT NULL, finished_at TEXT,
      outcome TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', digest TEXT, valid_until TEXT, artifact_path TEXT);
    CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, started_at DESC);
    CREATE TABLE schedule_source_state (schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE, source_id TEXT NOT NULL, etag TEXT, last_modified TEXT,
      digest TEXT NOT NULL, normalized TEXT NOT NULL, fetched_at TEXT NOT NULL, valid_until TEXT NOT NULL, PRIMARY KEY(schedule_id, source_id));`)
  db.prepare(`INSERT INTO schedules VALUES ('schedule-legacy', ?, 'Latest models and methods', 'latest-models-methods', 0, 720, 'collapse', 120000,
    '2026-09-24T02:00:00.000Z', NULL, '2026-09-21T10:00:00.000Z', '2026-09-24T02:00:00.000Z')`).run(projectId)
  for (let index = 0; index < 3; index++) {
    db.prepare(`INSERT INTO schedule_runs VALUES (?, 'schedule-legacy', ?, ?, ?, ?, 'digest', NULL, ?)`)
      .run(`run-${index}`, `2026-09-2${2 + index}T02:00:00.000Z`, `2026-09-2${2 + index}T02:00:05.000Z`, index === 2 ? 'changed' : 'unchanged', `legacy detail ${index}`, index === 2 ? 'C:/evidence.json' : null)
  }
  db.prepare(`INSERT INTO schedule_source_state VALUES ('schedule-legacy', 'anthropic-models', '"etag"', NULL, 'abc', 'text', '2026-09-24T02:00:00.000Z', '2026-09-25T02:00:00.000Z')`).run()
  db.close()
}

describe('ScheduleStore migration', () => {
  it('turns the fixed latest-models job into a task without losing its history, source state or owner choices', () => {
    const f = fixture()
    createLegacySchema(f.path, f.project.id)
    const store = f.open()
    const [migrated] = store.list(f.project.id)
    expect(migrated).toMatchObject({ id: 'schedule-legacy', kind: 'latest-models-methods', enabled: false, everyMinutes: 720, prompt: '', createdBy: { kind: 'conductor' } })
    const runs = store.runs('schedule-legacy')
    expect(runs.map(run => run.detail)).toEqual(['legacy detail 2', 'legacy detail 1', 'legacy detail 0'])
    expect(runs[0]).toMatchObject({ outcome: 'changed', artifactPath: 'C:/evidence.json', trigger: 'schedule', scripts: [], churn: null, brain: null })
    expect(store.source('schedule-legacy', 'anthropic-models')?.etag).toBe('"etag"')

    // First seeding fills the task's goal and defaults but keeps the owner's disable and cadence.
    const seeded = store.ensureBuiltin(f.project.id, builtin())
    expect(seeded).toMatchObject({ id: 'schedule-legacy', enabled: false, everyMinutes: 720, name: 'Latest models and CLI compatibility', timing: 'night', timeoutMs: 30 * 60_000, agent: { provider: 'claude', model: 'opus' } })
    expect(store.scripts(seeded.id).map(script => [script.name, script.origin])).toEqual([['cli-catalogs', 'conductor'], ['offline-tests', 'conductor']])

    // The old UNIQUE(project, job) is gone: agent tasks coexist; the built-in stays one per project.
    store.create({ projectId: f.project.id, name: 'Nightly news digest', prompt: 'Summarize model news' })
    store.create({ projectId: f.project.id, name: 'Second task' })
    expect(() => store.create({ projectId: f.project.id, name: 'Duplicate built-in', kind: 'latest-models-methods' })).toThrow('already has that built-in task')

    // Foreign keys still cascade after the rebuild.
    const task = store.create({ projectId: f.project.id, name: 'Cascade check' })
    store.finish(store.begin(task, new Date()).id, 'unchanged', 'ok')
    const raw = new DatabaseSync(f.path)
    raw.exec('PRAGMA foreign_keys = ON')
    raw.prepare('DELETE FROM schedules WHERE id = ?').run(task.id)
    expect((raw.prepare('SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = ?').get(task.id) as { count: number }).count).toBe(0)
    expect((raw.prepare('SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = ?').get('schedule-legacy') as { count: number }).count).toBe(3)
    raw.close()
  })

  it('migrates once: reopening a migrated database changes nothing', () => {
    const f = fixture()
    createLegacySchema(f.path, f.project.id)
    f.open().close()
    const store = f.open()
    expect(store.list(f.project.id)).toHaveLength(1)
    expect(store.runs('schedule-legacy')).toHaveLength(3)
  })
})

describe('ScheduleStore tasks', () => {
  it('creates a task due at once and keeps 50 runs of history', () => {
    const f = fixture(), store = f.open()
    const schedule = store.create({ projectId: f.project.id, name: 'Watch releases', everyMinutes: 60, agent: { provider: 'codex', model: 'gpt-6-astra', effort: 'low' } }, new Date('2026-09-21T10:00:00Z'))
    expect(schedule).toMatchObject({ kind: 'agent', nextDueAt: '2026-09-21T10:00:00.000Z', timing: 'night', urgent: false, brain: true, agent: { provider: 'codex', model: 'gpt-6-astra', effort: 'low' } })
    for (let index = 0; index < 52; index++) {
      const run = store.begin(store.get(f.project.id, schedule.id), new Date(Date.parse('2026-09-21T11:00:00Z') + index * 60_000), 'manual')
      store.finish(run.id, 'unchanged', 'No source changed', { scripts: [{ name: 'check', status: 'ok', exitCode: 0, durationMs: 5, outputDigest: 'd', changed: false, excerpt: 'same' }] })
    }
    const runs = store.runs(schedule.id)
    expect(runs).toHaveLength(50)
    expect(runs[0]).toMatchObject({ trigger: 'manual', scripts: [expect.objectContaining({ name: 'check', status: 'ok' })] })
    expect(store.update(f.project.id, schedule.id, { enabled: false }).nextDueAt).toBeNull()
  })

  it('validates input by name and refuses to delete a built-in task', () => {
    const f = fixture(), store = f.open()
    expect(() => store.create({ projectId: f.project.id, name: '  ' })).toThrow('name')
    expect(() => store.create({ projectId: f.project.id, name: 'x', everyMinutes: 2 })).toThrow('between 5 minutes')
    expect(() => store.create({ projectId: f.project.id, name: 'x', timing: 'noon' as never })).toThrow('timing')
    expect(() => store.create({ projectId: f.project.id, name: 'x', agent: { provider: 'gemini', model: 'x' } as never })).toThrow('agent.provider')
    const seeded = store.ensureBuiltin(f.project.id, builtin())
    expect(() => store.remove(f.project.id, seeded.id)).toThrow('pause it instead')
    const task = store.create({ projectId: f.project.id, name: 'Removable' })
    store.remove(f.project.id, task.id)
    expect(() => store.get(f.project.id, task.id)).toThrow('No scheduled task')
  })

  it('records the first deferral of a window, updates its reason, and clears it when the run starts', () => {
    const f = fixture(), store = f.open()
    const task = store.create({ projectId: f.project.id, name: 'Deferred' }, new Date('2026-09-24T12:00:00Z'))
    expect(store.defer(task.id, 'You are using this computer.', new Date('2026-09-24T12:01:00Z'))).toBe(true)
    expect(store.defer(task.id, 'You are using this computer.', new Date('2026-09-24T12:06:00Z'))).toBe(false)
    store.defer(task.id, 'Waits for the night window (01:00-06:00).', new Date('2026-09-24T12:30:00Z'))
    expect(store.get(f.project.id, task.id)).toMatchObject({ deferredAt: '2026-09-24T12:01:00.000Z', deferredReason: 'Waits for the night window (01:00-06:00).' })
    store.begin(store.get(f.project.id, task.id), new Date('2026-09-25T01:00:00Z'))
    expect(store.get(f.project.id, task.id)).toMatchObject({ deferredAt: null, deferredReason: null })
  })

  it('reconciles abandoned running evidence after its timeout', () => {
    const f = fixture(), store = f.open()
    const schedule = store.create({ projectId: f.project.id, name: 'Slow' }, new Date('2026-09-21T10:00:00Z'))
    const run = store.begin(schedule, new Date('2026-09-21T10:00:00Z'))
    expect(store.reconcileInterrupted(new Date('2026-09-21T10:21:00Z'))).toEqual([expect.objectContaining({ id: run.id, outcome: 'failed' })])
  })
})

describe('ScheduleStore built-ins and scripts', () => {
  it('seeds a built-in once, preserves an owner disable, and keeps its shipped scripts current', () => {
    const f = fixture(), store = f.open()
    const seeded = store.ensureBuiltin(f.project.id, builtin(), new Date('2026-09-21T10:00:00Z'))
    expect(seeded).toMatchObject({ enabled: true, everyMinutes: 1_440, nextDueAt: '2026-09-22T10:00:00.000Z', createdBy: { kind: 'conductor' } })
    store.update(f.project.id, seeded.id, { enabled: false, timing: 'idle' })
    const next = builtin({ scripts: [{ ...builtin().scripts[0]!, content: 'console.log("{\\"v\\":2}")' }] })
    const again = store.ensureBuiltin(f.project.id, next)
    expect(again).toMatchObject({ enabled: false, timing: 'idle' })
    expect(store.list(f.project.id)).toHaveLength(1)
    expect(store.scripts(seeded.id).map(script => [script.name, script.digest])).toEqual([['cli-catalogs', scriptDigest('console.log("{\\"v\\":2}")')]])
  })

  it('lets agents add scripts but never overwrite or delete the ones Conductor ships', () => {
    const f = fixture(), store = f.open()
    const seeded = store.ensureBuiltin(f.project.id, builtin())
    const author = { kind: 'agent' as const, agentSessionId: 'agent-1', title: 'Claude' }
    expect(() => store.saveScript(f.project.id, seeded.id, { name: 'cli-catalogs', content: 'x' }, 'agent', author)).toThrow('Conductor ships')
    expect(() => store.deleteScript(f.project.id, seeded.id, 'cli-catalogs')).toThrow('cannot be deleted')
    const added = store.saveScript(f.project.id, seeded.id, { name: 'grok-catalog', content: 'console.log(1)', format: 'text' }, 'agent', author)
    expect(added).toMatchObject({ origin: 'agent', author, language: 'node', runWhen: 'always', timeoutSec: 120, order: 2, digest: scriptDigest('console.log(1)') })
    const updated = store.saveScript(f.project.id, seeded.id, { name: 'grok-catalog', content: 'console.log(2)' }, 'agent', author)
    expect(updated).toMatchObject({ order: 2, digest: scriptDigest('console.log(2)') })
    store.deleteScript(f.project.id, seeded.id, 'grok-catalog')
    expect(store.script(seeded.id, 'grok-catalog')).toBeNull()
  })

  it('validates script names, size, language, timeout and count', () => {
    const f = fixture(), store = f.open()
    const task = store.create({ projectId: f.project.id, name: 'Scripts' })
    const author = { kind: 'owner' as const }
    expect(() => store.saveScript(f.project.id, task.id, { name: 'Bad Name', content: 'x' }, 'owner', author)).toThrow('script name')
    expect(() => store.saveScript(f.project.id, task.id, { name: 'big', content: 'x'.repeat(64 * 1024 + 1) }, 'owner', author)).toThrow('64 KB')
    expect(() => store.saveScript(f.project.id, task.id, { name: 'lang', content: 'x', language: 'bash' as never }, 'owner', author)).toThrow('language')
    expect(() => store.saveScript(f.project.id, task.id, { name: 'slow', content: 'x', timeoutSec: 5_000 }, 'owner', author)).toThrow('timeoutSec')
    for (let index = 0; index < 12; index++) store.saveScript(f.project.id, task.id, { name: `s${index}`, content: 'x' }, 'owner', author)
    expect(() => store.saveScript(f.project.id, task.id, { name: 's12', content: 'x' }, 'owner', author)).toThrow('at most 12')
  })
})
