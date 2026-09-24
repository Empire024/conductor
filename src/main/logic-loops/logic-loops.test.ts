import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConductorDatabase } from '../database'
import { LogicLoops, checkLoopBudget, classifyLoopChange, evaluateAutoRevert, parseLogicLoop } from '.'

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
    // Every file must parse; the set itself is not fixed here, since other loops are added over time.
    const directory = join(process.cwd(), '.conductor', 'loops')
    const loops = readdirSync(directory).filter(file => file.endsWith('.md')).map(file => parseLogicLoop(readFileSync(join(directory, file), 'utf8'), file))
    expect(loops.map(loop => loop.id).sort()).toEqual(expect.arrayContaining(['batch-delivery', 'task-triage', 'update-readback']))
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

const proposalSource = `---
id: proposal-loop
version: 1
title: Proposal loop
trigger: [manual]
inputs: []
budget:
  claudeWeeklyMax: 75
steps:
  - id: contract
    role: architect
    model: claude:opus[1m]
    effort: high
  - id: implement
    role: implementer
    model: claude:sonnet
    effort: high
  - id: churn
    role: churn
    model: local:qwen3.6-35b-a3b
    optional: true
  - id: review
    role: reviewer
    model: claude:claude-fable-5-1
    effort: high
  - id: ship
    role: controller
    action: git.ship
locked: [budget, steps.review, steps.ship]
---

# Proposal loop

## Run log

- 2026-09-24 v1: seeded for tests.
`

describe('classifyLoopChange', () => {
  const current = parseLogicLoop(proposalSource, 'proposal-loop.md')

  it('auto-applies model/effort, wording, reordering unlocked steps and dropping an optional step', () => {
    const proposed = parseLogicLoop(proposalSource
      .replace('model: claude:sonnet', 'model: claude:opus[1m]')
      .replace('title: Proposal loop', 'title: Proposal loop (revised wording)')
      .replace(/  - id: churn\n    role: churn\n    model: local:qwen3\.6-35b-a3b\n    optional: true\n/, ''), 'proposal-loop.md')
    expect(classifyLoopChange(current, proposed)).toEqual({ autoApplicable: true, reasons: [] })
  })

  it('needs owner approval for a budget change, a locked step edit, removing review/ship, and adding a step', () => {
    expect(classifyLoopChange(current, parseLogicLoop(proposalSource.replace('claudeWeeklyMax: 75', 'claudeWeeklyMax: 90'), 'proposal-loop.md')).autoApplicable).toBe(false)
    const lockedStepEdited = parseLogicLoop(proposalSource.replace('role: reviewer\n    model: claude:claude-fable-5-1\n    effort: high', 'role: reviewer\n    model: claude:claude-fable-5-1\n    effort: low'), 'proposal-loop.md')
    expect(classifyLoopChange(current, lockedStepEdited).reasons).toEqual(expect.arrayContaining([expect.stringMatching(/step review is locked/)]))
    const droppedReview = parseLogicLoop(proposalSource
      .replace(/  - id: review\n    role: reviewer\n    model: claude:claude-fable-5-1\n    effort: high\n/, '')
      .replace('locked: [budget, steps.review, steps.ship]', 'locked: [budget, steps.ship]'), 'proposal-loop.md')
    expect(classifyLoopChange(current, droppedReview).reasons).toEqual(expect.arrayContaining([expect.stringMatching(/removing locked step review/)]))
    const addedStep = parseLogicLoop(proposalSource.replace('locked: [budget, steps.review, steps.ship]', '  - id: extra\n    role: churn\n    model: local:qwen3.6-35b-a3b\nlocked: [budget, steps.review, steps.ship]'), 'proposal-loop.md')
    expect(classifyLoopChange(current, addedStep).reasons).toEqual(expect.arrayContaining([expect.stringMatching(/adding step extra/)]))
  })
})

describe('evaluateAutoRevert', () => {
  it('does not revert until two runs have landed', () => {
    expect(evaluateAutoRevert(100, [])).toEqual({ revert: false })
    expect(evaluateAutoRevert(100, [{ runId: 'r1', value: 200 }])).toEqual({ revert: false })
  })
  it('reverts only when both of the next two runs are worse than the baseline', () => {
    expect(evaluateAutoRevert(100, [{ runId: 'r1', value: 150 }, { runId: 'r2', value: 50 }])).toEqual({ revert: false })
    expect(evaluateAutoRevert(100, [{ runId: 'r1', value: 100 }, { runId: 'r2', value: 100 }])).toEqual({ revert: false })
    const verdict = evaluateAutoRevert(100, [{ runId: 'r1', value: 150 }, { runId: 'r2', value: 120 }])
    expect(verdict.revert).toBe(true)
    expect(verdict.reason).toMatch(/150.*120.*100/)
  })
})

describe('logic loop proposals', () => {
  const setup = (): { root: string; database: ConductorDatabase; loops: LogicLoops } => {
    const root = mkdtempSync(join(tmpdir(), 'logic-loops-proposals-')); roots.push(root)
    mkdirSync(join(root, '.conductor', 'loops'), { recursive: true })
    writeFileSync(join(root, '.conductor', 'loops', 'proposal-loop.md'), proposalSource)
    const database = new ConductorDatabase(join(root, 'conductor.db'))
    const project = database.upsertProject(root, 'Proposals')
    const loops = new LogicLoops(root, project.id, database, { usage: () => [] })
    return { root, database, loops }
  }

  it('auto-applies a proposal that only touches unlocked fields, bumping the version and logging why', () => {
    const { root, database, loops } = setup()
    try {
      const change = proposalSource.replace('model: claude:sonnet', 'model: claude:opus[1m]')
      const proposal = loops.propose({ id: 'proposal-loop', change, evidence: 'Opus passed review in 4/4 recent runs' })
      expect(proposal.status).toBe('pending')
      const applied = loops.apply(proposal.id, false, 'agent')
      expect(applied).toMatchObject({ status: 'applied', appliedVersion: 2, appliedBy: 'agent' })
      const written = readFileSync(join(root, '.conductor', 'loops', 'proposal-loop.md'), 'utf8')
      expect(written).toContain('version: 2')
      expect(written).toContain('model: claude:opus[1m]')
      expect(written).toMatch(/loops\.apply .*Opus passed review/)
      expect(loops.get('proposal-loop').version).toBe(2)
    } finally { database.close() }
  })

  it('refuses to apply an owner-required change without sovereign authority, and allows it with it', () => {
    const { database, loops } = setup()
    try {
      const change = proposalSource.replace('claudeWeeklyMax: 75', 'claudeWeeklyMax: 90')
      const proposal = loops.propose({ id: 'proposal-loop', change, evidence: 'Raise the cap' })
      expect(() => loops.apply(proposal.id, false, 'agent')).toThrow(/owner or a wizard tab/)
      expect(loops.apply(proposal.id, true, 'owner')).toMatchObject({ status: 'applied', appliedBy: 'owner' })
    } finally { database.close() }
  })

  it('rejects a proposal so it cannot be applied afterwards', () => {
    const { database, loops } = setup()
    try {
      const proposal = loops.propose({ id: 'proposal-loop', change: proposalSource.replace('model: claude:sonnet', 'model: claude:haiku'), evidence: 'try haiku' })
      expect(loops.reject(proposal.id)).toMatchObject({ status: 'rejected' })
      expect(() => loops.apply(proposal.id, true, 'owner')).toThrow(/already rejected/)
    } finally { database.close() }
  })

  it('auto-reverts once the next two recorded runs are worse on the metric the proposal cited', () => {
    const { root, database, loops } = setup()
    try {
      const change = proposalSource.replace('model: claude:sonnet', 'model: claude:opus[1m]')
      const proposal = loops.propose({ id: 'proposal-loop', change, evidence: 'try opus for implement', metric: 'tokens' })
      loops.apply(proposal.id, false, 'agent')
      const record = (tokens: number) => {
        const planned = loops.run('proposal-loop', {})
        loops.record({ runId: planned.runId, stepId: 'implement', model: 'claude:opus[1m]', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z', outcome: 'success', tokens: { total: tokens } })
      }
      record(50) // worse than baseline (0, since no prior run existed) -> triggers first bad run
      record(60) // second worse run -> reverts
      const written = readFileSync(join(root, '.conductor', 'loops', 'proposal-loop.md'), 'utf8')
      expect(written).toContain('version: 3')
      expect(written).toContain('model: claude:sonnet')
      expect(written).toMatch(/auto-revert of proposal/)
      const proposals = loops.listProposals('proposal-loop')
      expect(proposals.find(entry => entry.id === proposal.id)).toMatchObject({ status: 'reverted' })
    } finally { database.close() }
  })
})
