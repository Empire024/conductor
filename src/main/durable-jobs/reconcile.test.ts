import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableJobsServiceImpl } from './index'
import { DurableJobStore } from './store'
import { FakeRuntime, FakeWorktrees, tick, until, type ScriptedOutcome } from './test-fakes'
import { gitWorktrees } from './worktree'

const dirs: string[] = []
const services: DurableJobsServiceImpl[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }

function launch(store: DurableJobStore, runtime: FakeRuntime, ownerId: string, dir: string, worktrees = new FakeWorktrees()) {
  const service = new DurableJobsServiceImpl({ store, runtime, worktrees, logRoot: dir, projectPath: () => dir, ownerId, sleep: tick, pollMs: 0, interruptGraceMs: 200 })
  services.push(service)
  return service
}

/** A first "process" starts a job whose conversation is mid-turn, then dies without writing. */
async function crashMidStage(script: ScriptedOutcome[] = [{ kind: 'hang' }], worktrees = new FakeWorktrees()) {
  const dir = temp('durable-reconcile-')
  const store = new DurableJobStore(':memory:')
  const runtime = new FakeRuntime(script)
  const first = launch(store, runtime, 'pid:1:launch-a', dir, worktrees)
  const created = await first.create({ projectId: 'p', title: 'Night', objective: 'Work', model: 'local/qwen' })
  await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
  first.dispose()
  expect(store.get(created.id).status).toBe('running')
  return { dir, store, runtime, jobId: created.id, agentSessionId: runtime.opened[0]!, worktrees }
}

describe('reconciliation after a restart', () => {
  it('takes the lease over, fails the cut-off model call and resumes the stage in a fresh conversation', async () => {
    const { dir, store, runtime, jobId, agentSessionId } = await crashMidStage([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const before = store.get(jobId).lease!.epoch
    const second = launch(store, runtime, 'pid:2:launch-b', dir)
    const outcomes = await second.start()
    expect(outcomes).toMatchObject([{ jobId, decision: 'resume', lostSessions: [agentSessionId] }])
    expect(outcomes[0]!.operations).toMatchObject([{ kind: 'model-call', status: 'failed' }])
    expect(outcomes[0]!.operations[0]!.reconciliation).toContain('cut off by the restart')
    await until(() => store.get(jobId).status === 'completed')
    const job = second.get(jobId)
    expect(job.lease).toBeUndefined()
    expect(job.counters.recoveries).toBe(1)
    expect(runtime.opened).toHaveLength(2)
    expect(job.stages[0]).toMatchObject({ status: 'completed', attempt: 2, agentSessionId: runtime.opened[1] })
    const transitions = second.events(jobId).filter(event => event.kind === 'transition').map(event => event.data?.to)
    expect(transitions).toEqual(['queued', 'running', 'recovering', 'running', 'completed'])
    expect(store.events(jobId).some(event => event.kind === 'note' && Number(event.data?.epoch) > before)).toBe(true)
  })

  it('blocks with a practical next action when a tool call was pending, and never replays it', async () => {
    const { dir, store, runtime, jobId, agentSessionId } = await crashMidStage([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    runtime.set(agentSessionId, { phase: 'running', stopSequence: 0, lastAnswer: '', filesChanged: [], execution: { lifecycle: 'running', nextAction: '', pending: { id: 'call_7', name: 'run_command', arguments: '{"command":"npm run migrate"}' } } })
    const second = launch(store, runtime, 'pid:2', dir)
    const outcomes = await second.start()
    expect(outcomes[0]!.decision).toBe('blocked')
    const job = second.get(jobId)
    expect(job.status).toBe('blocked')
    expect(job.handoff.nextAction).toContain('npm run migrate')
    expect(job.handoff.nextAction).toContain('Nothing was replayed')
    const unknown = store.operations(jobId, 'unknown')
    expect(unknown.map(op => op.kind).sort()).toEqual(['model-call', 'shell'])
    for (let i = 0; i < 20; i++) await tick()
    expect(runtime.opened).toHaveLength(1)
    expect(runtime.prompts).toHaveLength(1)

    // The owner inspected and resumes: a fresh conversation, the old tool call still not replayed.
    await second.resume(jobId)
    await until(() => store.get(jobId).status === 'completed')
    expect(runtime.opened).toHaveLength(2)
    expect(runtime.prompts[1]).not.toContain('npm run migrate')
  })

  it('accepts a stage that finished just before the restart without opening a new conversation', async () => {
    const { dir, store, runtime, jobId, agentSessionId } = await crashMidStage()
    runtime.set(agentSessionId, { phase: 'completed', stopSequence: 1, stop: { reason: 'completed', detail: '', filesChanged: ['a.ts'] }, lastAnswer: 'All done.\nJOB STATUS: DONE', filesChanged: ['a.ts'] })
    const second = launch(store, runtime, 'pid:2', dir)
    const outcomes = await second.start()
    expect(outcomes[0]).toMatchObject({ decision: 'resume', lostSessions: [], operations: [{ kind: 'model-call', status: 'done' }] })
    await until(() => store.get(jobId).status === 'completed')
    expect(runtime.opened).toHaveLength(1)
    expect(second.get(jobId).stages[0]).toMatchObject({ status: 'completed', attempt: 1, result: 'All done.' })
  })

  it('decides git, snapshot and shell operations from durable evidence only', async () => {
    const worktrees = new FakeWorktrees('C:/repo')
    const { dir, store, runtime, jobId } = await crashMidStage([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }], worktrees)
    const stageId = store.stages(jobId)[0]!.id
    const owner = { owner: true as const }
    const committed = store.intend(jobId, owner, { stageId, kind: 'git', description: 'Checkpoint commit' })
    worktrees.committed.set(committed.id, 'f'.repeat(40))
    const missing = store.intend(jobId, owner, { stageId, kind: 'git', description: 'Checkpoint commit' })
    const shell = store.intend(jobId, owner, { stageId, kind: 'shell', description: 'npm test' })
    const second = launch(store, runtime, 'pid:2', dir, worktrees)
    const outcomes = await second.start()
    const byId = new Map(outcomes[0]!.operations.map(op => [op.id, op]))
    expect(byId.get(committed.id)).toMatchObject({ status: 'done' })
    expect(byId.get(missing.id)).toMatchObject({ status: 'failed' })
    expect(byId.get(shell.id)).toMatchObject({ status: 'unknown' })
    expect(outcomes[0]!.decision).toBe('blocked')
  })

  it('retries a stage blocked on an approval in a fresh conversation after restarts, instead of re-blocking on the dead one', async () => {
    const dir = temp('durable-reconcile-blocked-')
    const store = new DurableJobStore(':memory:')
    const runtime = new FakeRuntime([{ kind: 'approval' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const first = launch(store, runtime, 'pid:1:launch-a', dir)
    const created = await first.create({ projectId: 'p', title: 'Night', objective: 'Work', model: 'local/qwen' })
    await until(() => store.get(created.id).status === 'blocked')
    const [waiting] = runtime.opened
    expect(store.stages(created.id)[0]).toMatchObject({ status: 'running', agentSessionId: waiting })
    first.dispose()
    // That conversation died with the first process; its persisted projection still reads waiting_approval.
    const second = launch(store, runtime, 'pid:2:launch-b', dir)
    expect(await second.start()).toMatchObject([{ jobId: created.id, decision: 'blocked', lostSessions: [waiting], operations: [{ kind: 'model-call', status: 'failed' }] }])
    expect(store.operations(created.id, 'intended')).toHaveLength(0)
    second.dispose()
    // A further restart before the owner resumes settles nothing new and writes nothing.
    const events = store.events(created.id).length
    const third = launch(store, runtime, 'pid:3:launch-c', dir)
    expect(await third.start()).toMatchObject([{ jobId: created.id, decision: 'blocked', lostSessions: [waiting], operations: [] }])
    expect(store.events(created.id)).toHaveLength(events)
    expect(store.get(created.id).status).toBe('blocked')
    for (let i = 0; i < 20; i++) await tick()
    expect(runtime.opened).toHaveLength(1)
    await third.resume(created.id)
    await until(() => store.get(created.id).status !== 'running' && !third.controller.isRunning(created.id))
    expect(store.get(created.id).status).toBe('completed')
    expect(runtime.opened).toHaveLength(2)
    expect(third.events(created.id).filter(event => event.kind === 'approval')).toHaveLength(1)
    expect(third.get(created.id).stages[0]).toMatchObject({ status: 'completed', attempt: 2, agentSessionId: runtime.opened[1] })
  })

  it('does not count the time Conductor was down as active time', async () => {
    let now = Date.parse('2026-09-24T00:00:00.000Z')
    const clock = () => new Date(now)
    const dir = temp('durable-reconcile-active-')
    const store = new DurableJobStore(':memory:', clock)
    const runtime = new FakeRuntime([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const make = (ownerId: string) => { const service = new DurableJobsServiceImpl({ store, runtime, worktrees: new FakeWorktrees(), logRoot: dir, projectPath: () => dir, ownerId, sleep: tick, pollMs: 0, interruptGraceMs: 200, clock }); services.push(service); return service }
    const first = make('pid:1')
    const created = await first.create({ projectId: 'p', title: 'Night', objective: 'Work', model: 'local/qwen' })
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    now += 5_000
    store.event(created.id, { owner: true }, 'note', 'last sign of life')
    first.dispose()
    now += 3_600_000
    await make('pid:2').start()
    expect(store.get(created.id).activeMs).toBe(5_000)
  })

  it('refuses the owner\'s pause or cancel until reconciliation has settled a job left running', async () => {
    const { dir, store, runtime, jobId, agentSessionId } = await crashMidStage([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    runtime.set(agentSessionId, { phase: 'running', stopSequence: 0, lastAnswer: '', filesChanged: [], execution: { lifecycle: 'running', nextAction: '', pending: { id: 'call_7', name: 'run_command', arguments: '{"command":"npm run migrate"}' } } })
    const second = launch(store, runtime, 'pid:2', dir)
    expect(() => second.pause(jobId)).toThrow(/reconciling/)
    await expect(second.cancel(jobId)).rejects.toThrow(/reconciling/)
    expect(store.operations(jobId, 'intended')).toHaveLength(1)
    expect((await second.start())[0]!.decision).toBe('blocked')
    expect(store.operations(jobId, 'unknown').map(op => op.kind).sort()).toEqual(['model-call', 'shell'])
    expect((await second.cancel(jobId)).status).toBe('cancelled')
  })

  it('stops a superseded controller from writing', async () => {
    const dir = temp('durable-stale-')
    const store = new DurableJobStore(':memory:')
    const runtime = new FakeRuntime([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const first = launch(store, runtime, 'pid:1', dir)
    const created = await first.create({ projectId: 'p', title: 'Night', objective: 'Work', model: 'local/qwen' })
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    // A second owner takes over while the first loop is still alive (it is not disposed).
    const second = launch(store, runtime, 'pid:2', dir)
    await second.start()
    await first.controller.idle(created.id)
    await until(() => store.get(created.id).status === 'completed')
    expect(store.get(created.id).counters.recoveries).toBe(1)
    expect(first.controller.isRunning(created.id)).toBe(false)
  })
})

describe('git worktree checkpoints', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

  it('works in its own worktree from HEAD, never touches the owner\'s dirty tree and finds its checkpoint commit', async () => {
    const repo = temp('durable-repo-')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'owner@example.invalid'); git(repo, 'config', 'user.name', 'Owner')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base')
    writeFileSync(join(repo, 'a.txt'), 'owner edit in progress\n')
    const target = join(temp('durable-wt-'), 'worktree')
    const tree = await gitWorktrees.create(repo, 'job_x', target)
    expect(tree.branch).toBe('conductor-job/job_x')
    expect(readFileSync(join(tree.path, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n')
    writeFileSync(join(tree.path, 'b.txt'), 'job output\n')
    const commit = await gitWorktrees.commit(tree.path, 'Durable job checkpoint: test', 'jobop_123')
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(await gitWorktrees.commit(tree.path, 'nothing', 'jobop_124')).toBeUndefined()
    expect(await gitWorktrees.findCommit(tree.path, 'jobop_123')).toBe(commit)
    expect(await gitWorktrees.findCommit(tree.path, 'jobop_999')).toBeUndefined()
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('owner edit in progress\n')
    expect(existsSync(join(repo, 'b.txt'))).toBe(false)
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M a.txt')
    git(repo, 'worktree', 'remove', '--force', tree.path)
  })

  it('snapshots files for a folder without git and marks completion with a manifest', async () => {
    const cwd = temp('durable-plain-')
    writeFileSync(join(cwd, 'notes.md'), 'hello')
    const directory = join(temp('durable-snap-'), 'snap')
    const refs = await gitWorktrees.snapshot(cwd, ['notes.md', '../outside.txt', 'missing.txt'], directory)
    expect(gitWorktrees.snapshotComplete(directory)).toBe(true)
    expect(refs).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).files).toMatchObject([{ path: 'notes.md', bytes: 5 }])
  })
})

describe('reconciliation in the launch that started the job', () => {
  it('leaves a job this process started before the pass ran alone, so it keeps running', async () => {
    const dir = temp('durable-reconcile-live-')
    const store = new DurableJobStore(':memory:')
    const runtime = new FakeRuntime([{ kind: 'hang' }])
    const service = launch(store, runtime, 'pid:2:launch-b', dir)
    const created = await service.create({ projectId: 'p', title: 'Early', objective: 'Work', model: 'local/qwen' })
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    const epoch = store.get(created.id).lease!.epoch
    expect(await service.start()).toEqual([])
    expect(store.get(created.id)).toMatchObject({ status: 'running', lease: { epoch } })
    expect(store.get(created.id).counters.recoveries).toBe(0)
  })
})
