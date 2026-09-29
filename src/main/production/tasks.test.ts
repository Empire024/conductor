import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimedFixed, closeFixedTask, ensureFixTasks, autoTaskFindings } from './tasks'
import { OWNER } from './store'
import { ENV_ID, fakeBoard, finding, fingerprint, seedProfile, tempStore, type TempStore } from './testkit'

let temp: TempStore
beforeEach(() => { temp = tempStore(); seedProfile(temp.store) })
afterEach(() => temp.close())

function seedFindings() {
  const { store } = temp
  const run = store.createRun({ projectId: 'project-a', kind: 'audit', environmentId: ENV_ID, trigger: { kind: 'manual', by: { kind: 'owner', agentSessionId: null, title: null }, at: new Date().toISOString(), changes: [], detail: '' }, fingerprint: fingerprint(), controls: ['C03'], steps: [{ kind: 'control', controlId: 'C03' }], artifactsDir: temp.dir })
  store.transition(run.id, 'running', 'test', OWNER)
  const applicability = { status: 'applicable' as const, rationale: 'r', factsUsed: [], ruleIndex: null }
  const findings = store.upsertFindings(run.id, OWNER, [
    { draft: finding('C03', 'consent', 'tracker', { severity: 'critical' }), applicability },
    { draft: finding('C03', 'consent', 'minor', { severity: 'low' }), applicability },
  ])
  return { run, findings }
}

describe('fix tasks', () => {
  it('files one task per finding and never a second one (dedup across report steps)', () => {
    const board = fakeBoard()
    const { findings } = seedFindings()
    const auto = autoTaskFindings(findings)
    expect(auto.map(item => item.key)).toEqual(['tracker'])
    const first = ensureFixTasks(temp.store, board, 'project-a', auto)
    expect(first).toEqual([{ findingId: auto[0]!.id, taskId: 'task-1', created: true, reopened: false }])
    expect(temp.store.finding(auto[0]!.id)!.taskId).toBe('task-1')
    expect(board.tasks.get('task-1')).toMatchObject({ title: '[C03] C03 tracker', status: 'ready', priority: 'urgent' })
    expect(board.tasks.get('task-1')!.description).toMatch(/only an independent verification marks the finding fixed/)
    const second = ensureFixTasks(temp.store, board, 'project-a', auto)
    expect(second).toEqual([{ findingId: auto[0]!.id, taskId: 'task-1', created: false, reopened: false }])
    expect(board.created).toBe(1)
    // Creating a task never changes the finding's status.
    expect(temp.store.finding(auto[0]!.id)!.status).toBe('open')
  })

  it('reopens the closed task of a finding that is open again, and closes the task of a verified fix', () => {
    const board = fakeBoard()
    const { findings } = seedFindings()
    const [tracker] = findings
    ensureFixTasks(temp.store, board, 'project-a', [tracker!])
    board.updateTask('task-1', { status: 'done' })
    expect(claimedFixed(board, temp.store.finding(tracker!.id)!)).toBe(true)
    const again = ensureFixTasks(temp.store, board, 'project-a', [tracker!])
    expect(again).toEqual([{ findingId: tracker!.id, taskId: 'task-1', created: false, reopened: true }])
    expect(board.tasks.get('task-1')!.status).toBe('ready')
    expect(board.created).toBe(1)
    expect(closeFixedTask(board, { ...temp.store.finding(tracker!.id)!, status: 'fixed' })).toBe(true)
    expect(board.tasks.get('task-1')!.status).toBe('done')
    expect(closeFixedTask(board, temp.store.finding(tracker!.id)!)).toBe(false)
  })

  it('refuses a finding of another project', () => {
    const { findings } = seedFindings()
    expect(() => ensureFixTasks(temp.store, fakeBoard(), 'project-b', findings)).toThrow(/not a finding of project-b/)
  })
})
