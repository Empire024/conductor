import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConductorDatabase } from '../database'
import { LogicLoops, checkLoopBudget, parseLogicLoop } from '.'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const source = `---
id: sample-loop
version: 2
title: Sample loop
trigger: [manual, event:sample]
inputs: [taskId]
budget:
  claudeWeeklyMax: 75
steps:
  - id: inspect
    role: architect
    model: claude:opus[1m]
    effort: high
    fallback: codex:gpt-6-astra
  - id: ship
    role: controller
    action: git.ship
locked: [budget, steps.ship]
---

# Sample
Follow the steps.
`

describe('logic loop front matter', () => {
  it('parses and validates the checked-in subset of YAML', () => {
    const loop = parseLogicLoop(source, 'sample-loop.md')
    expect(loop).toMatchObject({ id: 'sample-loop', version: 2, title: 'Sample loop', inputs: ['taskId'], budget: { claudeWeeklyMax: 75 } })
    expect(loop.steps).toEqual([
      expect.objectContaining({ id: 'inspect', model: 'claude:opus[1m]', effort: 'high', fallback: 'codex:gpt-6-astra' }),
      expect.objectContaining({ id: 'ship', action: 'git.ship' })
    ])
    expect(loop.body).toContain('Follow the steps.')
  })

  it('rejects identity mismatches, duplicate steps and malformed front matter', () => {
    expect(() => parseLogicLoop(source.replace('id: sample-loop', 'id: other'), 'sample-loop.md')).toThrow(/must match/i)
    expect(() => parseLogicLoop(source.replace('  - id: ship', '  - id: inspect'), 'sample-loop.md')).toThrow(/duplicate/i)
    expect(() => parseLogicLoop(source.replace('version: 2', 'version: nope'), 'sample-loop.md')).toThrow(/version/i)
    expect(() => parseLogicLoop('# no front matter', 'sample-loop.md')).toThrow(/front matter/i)
  })

  it('validates every checked-in seed loop', () => {
    const directory = join(process.cwd(), '.conductor', 'loops')
    const loops = readdirSync(directory).filter(file => file.endsWith('.md')).map(file => parseLogicLoop(readFileSync(join(directory, file), 'utf8'), file))
    expect(loops.map(loop => loop.id).sort()).toEqual(['batch-delivery', 'task-triage', 'update-readback'])
  })
})

describe('logic loop runs', () => {
  it('lists, reads, histories, plans and records a run durably', async () => {
    const root = mkdtempSync(join(tmpdir(), 'logic-loops-test-')); roots.push(root)
    mkdirSync(join(root, '.conductor', 'loops'), { recursive: true })
    writeFileSync(join(root, '.conductor', 'loops', 'sample-loop.md'), source)
    const database = new ConductorDatabase(join(root, 'conductor.db'))
    const project = database.upsertProject(root, 'Loops')
    const loops = new LogicLoops(root, project.id, database, {
      usage: () => [{ provider: 'claude', status: 'reported', unknown: [], windows: [{ bucket: 'claude', key: 'seven_day', label: 'Weekly', kind: 'weekly', scope: 'provider', usedPercent: 80, windowMinutes: 10080, resetsAt: null, state: 'current', observedAt: new Date().toISOString(), ageSeconds: 0, source: { projectId: project.id, agentSessionId: 'a1' } }] }],
      git: async () => 'abc123\u00002026-09-24T10:00:00Z\u0000Add loop\n'
    })
    try {
      expect(loops.list()).toEqual([expect.objectContaining({ id: 'sample-loop', version: 2 })])
      expect(loops.get('sample-loop').body).toContain('# Sample')
      expect(await loops.history('sample-loop')).toEqual([{ commit: 'abc123', at: '2026-09-24T10:00:00Z', subject: 'Add loop' }])
      const planned = loops.run('sample-loop', { taskId: 'task-1' })
      expect(planned.status).toBe('ready')
      expect(planned.steps[0]).toMatchObject({ id: 'inspect', model: 'codex:gpt-6-astra', requestedModel: 'claude:opus[1m]', budget: { status: 'fallback' } })
      expect(database.getLoopRun(planned.runId)).toMatchObject({ projectId: project.id, loopId: 'sample-loop', loopVersion: 2, status: 'ready' })
      const recorded = loops.record({ runId: planned.runId, stepId: 'inspect', model: 'codex:gpt-6-astra', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z', outcome: 'success', tokens: { input: 10, output: 5 }, note: 'done' })
      expect(recorded).toMatchObject({ runId: planned.runId, stepId: 'inspect', outcome: 'success', tokens: { input: 10, output: 5 } })
      expect(database.listLoopStepRuns(planned.runId)).toEqual([expect.objectContaining({ stepId: 'inspect', note: 'done' })])
    } finally { database.close() }
  })

  it('pauses a plan when a hard budget is exceeded and no allowed fallback exists', () => {
    const loop = parseLogicLoop(source.replace('    fallback: codex:gpt-6-astra\n', ''), 'sample-loop.md')
    const budget = checkLoopBudget(loop, [{ provider: 'claude', status: 'reported', unknown: [], windows: [{ key: 'seven_day', kind: 'weekly', scope: 'provider', usedPercent: 80, state: 'current' }] }])
    expect(budget).toMatchObject({ status: 'paused', steps: { inspect: { status: 'blocked', usedPercent: 80, limit: 75 } } })
  })
})
