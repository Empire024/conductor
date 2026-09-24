import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleDefinition, ScheduleRun } from '../shared/schedules'
import { ConductorDatabase } from './database'
import type { AgentTurnRequest, AgentTurnResult } from './schedule-agent-turn'
import type { ChurnRequest, ChurnResult } from './schedule-churn'
import { createScheduleExecutor, lineDiff, type ScheduleExecutorDeps } from './schedule-executor'
import { judgeScript, ScheduleScriptRunner } from './schedule-scripts'
import { ScheduleStore } from './schedule-store'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

/** Real scripts through the real runner, with the owner's own node (process.execPath is node
 *  under vitest). Only the two model tiers are fakes. */
const fixture = (options: { agent?: ScheduleDefinition['agent']; brain?: boolean; answer?: Partial<AgentTurnResult>; churn?: Partial<ChurnResult> & { ok: boolean }; allowance?: string | null } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-executor-')), path = join(root, 'state.db')
  const database = new ConductorDatabase(path), project = database.upsertProject(root, 'Executor'), store = new ScheduleStore(path)
  cleanup.push(() => { store.close(); database.close(); rmSync(root, { recursive: true, force: true }) })
  const task = store.create({ projectId: project.id, name: 'Watch versions', prompt: 'Tell me when the pinned version moves.', agent: options.agent === undefined ? { provider: 'claude', model: 'opus' } : options.agent, brain: options.brain ?? true })
  const churn = vi.fn(async (request: ChurnRequest): Promise<ChurnResult> => options.churn?.ok === false
    ? { ok: false, model: null, note: options.churn.note ?? 'No local model is set up' }
    : { ok: true, model: 'local/qwen', text: `local summary of ${request.input.length} chars` })
  const agentTurn = vi.fn(async (request: AgentTurnRequest): Promise<AgentTurnResult> => ({ ok: true, agentSessionId: 'agent-brain', answer: 'Bump the pin in version.txt.', ...options.answer, ...{ _prompt: request.prompt } }))
  const deps: ScheduleExecutorDeps = {
    store, projectPath: () => root, dataDirectory: join(root, 'tasks'), artifactDirectory: join(root, 'evidence'),
    scripts: new ScheduleScriptRunner({ node: () => ({ command: process.execPath, args: [] }), powershell: () => ({ command: 'powershell.exe', args: ['-NoProfile', '-File'] }) }),
    churn: { summarize: churn }, agentTurn, allowance: () => options.allowance ?? null
  }
  const execute = createScheduleExecutor(deps)
  let clock = Date.parse('2026-09-24T01:00:00Z')
  const run = async () => {
    const current = store.get(project.id, task.id)
    const begun: ScheduleRun = store.begin(current, new Date(clock += 60_000))
    const result = await execute({ schedule: current, run: begun, now: new Date(clock), signal: new AbortController().signal, deadline: Date.now() + 20 * 60_000 })
    return store.finish(begun.id, result.outcome, result.detail, result)
  }
  const save = (name: string, content: string, extra: Record<string, unknown> = {}) => store.saveScript(project.id, task.id, { name, content, ...extra }, 'agent', { kind: 'agent', agentSessionId: 'agent-1' })
  return { root, store, project, task, run, save, churn, agentTurn }
}
const printFile = (file: string) => `import { readFileSync } from 'node:fs'\nprocess.stdout.write(readFileSync(${JSON.stringify(file)}, 'utf8'))\n`

describe('scheduled task executor', () => {
  it('asks no model anything while every script prints what it printed last time', async () => {
    const f = fixture()
    f.save('version', 'console.log(JSON.stringify({ version: "1.0.0" }))', { format: 'json' })
    const first = await f.run()
    expect(first).toMatchObject({ outcome: 'changed', scripts: [expect.objectContaining({ name: 'version', status: 'ok', changed: true })] })
    expect(f.churn).toHaveBeenCalledOnce(); expect(f.agentTurn).toHaveBeenCalledOnce()
    const second = await f.run()
    expect(second).toMatchObject({ outcome: 'unchanged', detail: expect.stringContaining('No model was asked anything'), artifactPath: null })
    expect(f.churn).toHaveBeenCalledOnce(); expect(f.agentTurn).toHaveBeenCalledOnce()
  })

  it('sends a changed output to the local model and a bounded brief to the assigned agent, and saves the evidence', async () => {
    const f = fixture()
    const file = join(f.root, 'version.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, 'version: 1.0.0\nchannel: stable\n')
    f.save('version', printFile(file), { description: 'The pinned version' })
    await f.run()
    writeFileSync(file, 'version: 1.1.0\nchannel: stable\n')
    const changed = await f.run()
    expect(changed).toMatchObject({ outcome: 'changed', churn: { provider: 'local', model: 'local/qwen', ok: true }, brain: { provider: 'claude', model: 'opus', ok: true, agentSessionId: 'agent-brain' } })
    expect(changed.detail).toContain('Changed: version.')
    expect(changed.detail).toContain('Bump the pin in version.txt.')
    const churnInput = f.churn.mock.calls[1]![0].input
    expect(churnInput).toContain('- version: 1.0.0')
    expect(churnInput).toContain('+ version: 1.1.0')
    expect(churnInput).not.toContain('channel: stable')
    const brainPrompt = f.agentTurn.mock.calls[1]![0].prompt
    expect(brainPrompt).toContain('Tell me when the pinned version moves.')
    expect(brainPrompt).toContain('local summary of')
    expect(brainPrompt).toContain('Answer from this evidence only')
    expect(brainPrompt.length).toBeLessThan(20_000)
    expect(changed.artifactPath && readFileSync(changed.artifactPath, 'utf8')).toContain('## Scripts')
    expect(readdirSync(join(f.root, 'evidence')).filter(name => name.endsWith('.json'))).toHaveLength(2)
    expect(existsSync(join(f.root, 'tasks', f.task.id, 'runs'))).toBe(true)
    expect(readdirSync(join(f.root, 'tasks', f.task.id, 'runs'))).toEqual([])
  })

  it('retries a review that did not happen instead of forgetting the change', async () => {
    const f = fixture({ answer: { ok: false, answer: '', note: 'The turn failed before it answered.' } })
    f.save('version', 'console.log("1.0.0")')
    const first = await f.run()
    expect(first).toMatchObject({ outcome: 'changed', brain: { ok: false, note: 'The turn failed before it answered.' } })
    expect(first.detail).toContain('local summary of')
    const second = await f.run()
    expect(second.outcome).toBe('changed')
    expect(f.agentTurn).toHaveBeenCalledTimes(2)
  })

  it('does not spend a nearly exhausted frontier allowance, and falls back to a plain diff without a local model', async () => {
    const f = fixture({ allowance: 'Claude weekly allowance is 93% used.', churn: { ok: false, note: 'No local model is set up on this machine, so the change is reported as a plain diff.' } })
    f.save('version', 'console.log("1.0.0")')
    const run = await f.run()
    expect(f.agentTurn).not.toHaveBeenCalled()
    expect(run).toMatchObject({ outcome: 'changed', brain: { ok: false, note: 'Claude weekly allowance is 93% used.' }, churn: { ok: false } })
    expect(run.detail).toContain('First output of this check')
  })

  it('treats a failing or invalid script as evidence, keeps the last good digest, and runs changed-only checks after it', async () => {
    const f = fixture({ agent: { provider: 'local', model: 'local/qwen' } })
    f.save('version', 'console.log(JSON.stringify({ v: 1 }))', { format: 'json', order: 0 })
    f.save('tests', 'console.log(process.env.CONDUCTOR_SCHEDULE_CHANGED + ":" + require("node:fs").readFileSync(process.env.CONDUCTOR_SCHEDULE_RUN_DIR + "/version.out", "utf8"))'.replace('require("node:fs")', '(await import("node:fs"))'), { runWhen: 'changed', order: 1 })
    const first = await f.run()
    expect(first.scripts.map(script => [script.name, script.status])).toEqual([['version', 'ok'], ['tests', 'ok']])
    expect(first.scripts[1]!.excerpt).toBe('1:{"v":1}')
    // A local agent has no separate brain request: the local summary is the answer.
    expect(f.agentTurn).not.toHaveBeenCalled()
    const quiet = await f.run()
    expect(quiet.scripts.map(script => [script.name, script.status])).toEqual([['version', 'ok'], ['tests', 'skipped']])
    f.save('version', 'console.log("not json"); process.exitCode = 0', { format: 'json', order: 0 })
    const invalid = await f.run()
    expect(invalid).toMatchObject({ outcome: 'failed', scripts: [expect.objectContaining({ status: 'invalid', error: expect.stringContaining('did not print one JSON document') }), expect.objectContaining({ status: 'ok' })] })
    f.save('version', 'console.log(JSON.stringify({ v: 1 }))', { format: 'json', order: 0 })
    const restored = await f.run()
    // The failed run did not overwrite the good digest, so the good output reads as unchanged again.
    expect(restored.scripts[0]).toMatchObject({ status: 'ok', changed: false })
  })

  it('answers a script-less goal with one bounded agent turn', async () => {
    const f = fixture({ answer: { answer: 'Three new releases this week.' } })
    const run = await f.run()
    expect(run).toMatchObject({ outcome: 'dispatched', detail: 'Three new releases this week.', brain: { ok: true } })
    expect(f.agentTurn.mock.calls[0]![0].prompt).toContain('It has no scripts yet')
    expect(f.churn).not.toHaveBeenCalled()
  })

  it('skips a task with neither scripts nor an agent', async () => {
    const f = fixture({ agent: null })
    expect(await f.run()).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('nothing to run') })
  })

  it('refuses a script whose stored text no longer matches its digest', async () => {
    const f = fixture()
    f.save('version', 'console.log(1)')
    const raw = new (await import('node:sqlite')).DatabaseSync(join(f.root, 'state.db'))
    raw.prepare('UPDATE schedule_scripts SET content = ? WHERE name = ?').run('console.log(2)', 'version')
    raw.close()
    const run = await f.run()
    expect(run.scripts[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('does not match the digest') })
  })
})

describe('script runner', () => {
  it('kills a script at its timeout and reports it', async () => {
    const f = fixture()
    f.save('hang', 'setInterval(() => {}, 1000)', { timeoutSec: 1 })
    const run = await f.run()
    expect(run.scripts[0]).toMatchObject({ status: 'timeout', error: 'Timed out after 1 s' })
  }, 20_000)

  it('judges oversized output as invalid evidence', () => {
    const script = { name: 'big', format: 'text', runWhen: 'always' } as never
    const { result } = judgeScript(script, { exitCode: 0, stdout: 'x', stderr: '', timedOut: false, durationMs: 1, truncated: true }, null)
    expect(result).toMatchObject({ status: 'invalid', changed: true })
  })

  it('diffs lines by content, counting duplicates', () => {
    expect(lineDiff(['a', 'b', 'b', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['- b', '+ d'])
    expect(lineDiff([], Array.from({ length: 5 }, (_, index) => String(index)), 3)).toEqual(['+ 0', '+ 1', '+ 2', '… 2 more changed lines'])
  })
})
