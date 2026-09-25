import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IdeaRunRule } from '../../shared/idea-runs'
import type { SessionPhase } from '../../shared/structured-agent'
import { ConductorDatabase } from '../database'
import { IdeaStore } from '../ideas/store'
import { LogicLoops, classifyLoopChange, parseLogicLoop, type UsageReportForBudget } from '../logic-loops'
import { stageOverBudget, weeklyCapCheck } from './budget'
import { IdeaRunController, type AgentTurnView, type IdeaRunNotification } from './controller'
import { ideaRunsCall } from './control'
import { adjustLoopFile, loopFileFor, loopIdFor } from './loop-file'
import { chooseModel } from './models'
import { normalizePlan } from './plan'
import { asksToStripProvenance, screenAction } from './policy'
import { parseStageReport } from './report'
import { IdeaRunStore } from './store'

const roots: string[] = []
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) { try { close() } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fence = (name: string, value: unknown): string => `Here it is.\n\`\`\`${name}\n${JSON.stringify(value)}\n\`\`\`\n`
const author = { provider: 'claude', model: 'opus[1m]' }
const weekly = (provider: string, usedPercent: number): UsageReportForBudget => ({ provider, status: 'reported', windows: [{ key: 'seven_day', kind: 'weekly', scope: 'provider', usedPercent, state: 'current' }] })

describe('idea run plans', () => {
  it('puts a brand/copyright check before anything public, pauses public stages, and caps budgets at the owner defaults', () => {
    const plan = normalizePlan({
      summary: 'Make a mask brand', weeklyCaps: { claude: 99, codex: 50 },
      stages: [
        { id: 'research', title: 'Research', kind: 'research', goal: 'Find competitors', doneCriteria: ['10 competitors listed'] },
        { id: 'launch', title: 'Launch the account', kind: 'public', goal: 'Post the first videos', budget: { maxMinutes: 99999, maxTurns: 0, maxEur: -5 } }
      ]
    }, { ideaText: 'a mask brand', author })
    expect(plan.stages.map(stage => stage.kind)).toEqual(['research', 'brand-check', 'public'])
    expect(plan.stages[2]!.checkpoints).toContain('publish')
    expect(plan.stages[2]!.budget).toEqual({ maxMinutes: 1440, maxTurns: 1, maxEur: 0 })
    expect(plan.stages[2]!.doneCriteria[0]).toMatch(/goal is met/)
    expect(plan.weeklyCaps).toEqual({ claude: 85, codex: 50 })
    expect(plan.warnings.join(' ')).toMatch(/Inserted "Brand and copyright check"/)
    expect(plan.rules.join(' ')).toMatch(/EU AI Act/)
  })

  it('refuses the part of an idea that strips AI disclosure, and keeps a recurrence as a loop', () => {
    const plan = normalizePlan({
      stages: [
        { id: 'check', title: 'Check', kind: 'brand-check', goal: 'check' },
        { id: 'post', title: 'Post daily', kind: 'public', goal: 'post', recurrence: { everyMinutes: 1, times: 2, loop: { steps: [{ id: 'post', role: 'publisher', model: 'sonnet' }] } } }
      ],
      rules: ['strip the AI metadata from every file before uploading']
    }, { ideaText: 'strip any way of telling it\'s ai from the file before uploading the file to IG', author })
    expect(plan.warnings.join(' ')).toMatch(/Refused part of the idea/)
    expect(plan.rules.some(rule => /strip the AI metadata/.test(rule))).toBe(false)
    expect(plan.stages[1]!.recurrence).toEqual({ everyMinutes: 5, times: 2, loop: { title: 'Post daily', steps: [{ id: 'post', role: 'publisher', model: 'claude:sonnet' }] } })
  })
})

describe('checkpoints and provenance', () => {
  it('recognises requests to strip or hide AI provenance', () => {
    expect(asksToStripProvenance('strip any way of telling it\'s ai from the file')).toBe(true)
    expect(asksToStripProvenance('remove the C2PA metadata before upload')).toBe(true)
    expect(asksToStripProvenance('post it without the AI label')).toBe(true)
    expect(asksToStripProvenance('make sure nobody can tell it\'s AI')).toBe(true)
    expect(asksToStripProvenance('upload the video with its AI label and caption')).toBe(false)
  })

  it('denies provenance stripping outright, answers from standing rules, and leaves everything else to the owner', () => {
    const rules: IdeaRunRule[] = [{ runId: 'r', actionType: 'message', decision: 'approve', createdAt: '', createdBy: 'owner' }]
    expect(screenAction({ type: 'publish', summary: 'Upload video', detail: 'Remove the AI watermark, then upload' }, rules)).toMatchObject({ status: 'denied', by: 'Conductor (provenance rule)' })
    expect(screenAction({ type: 'message', summary: 'Reply to a comment', detail: 'Thanks!' }, rules)).toMatchObject({ status: 'approved', by: 'standing rule' })
    expect(screenAction({ type: 'purchase', summary: 'Buy 10 masks', detail: 'order lines', amountEur: 40 }, rules)).toEqual({ status: 'pending' })
  })

  it('parses a stage report; an unknown action type still pauses as an outside action', () => {
    const report = parseStageReport(fence('idea-run-report', {
      status: 'done', summary: 'Posted', spentEur: 1.5, artifacts: ['notes.md', { url: 'https://example.test/x', label: 'x' }],
      actions: [{ type: 'teleport', summary: 'Do a thing', detail: 'exactly this' }, { summary: '' }],
      loop: { steps: [{ id: 'post', outcome: 'ok' }], adjust: { stepId: 'post', model: 'claude:haiku', reason: 'cheaper' } }
    }))
    expect(report).toMatchObject({ status: 'done', spentEur: 1.5, artifacts: [{ target: 'notes.md' }, { target: 'https://example.test/x', label: 'x' }], actions: [{ type: 'external', summary: 'Do a thing' }] })
    expect(report?.loop).toEqual({ steps: [{ id: 'post', outcome: 'ok' }], adjust: { stepId: 'post', model: 'claude:haiku', reason: 'cheaper' } })
    expect(parseStageReport('no block here')).toBeNull()
  })
})

describe('budgets', () => {
  it('stops at the weekly cap from usage.limits and never caps a local model', () => {
    const caps = { claude: 85, codex: 95 }
    expect(weeklyCapCheck({ provider: 'claude', model: 'opus[1m]' }, caps, [weekly('claude', 86)])).toMatchObject({ ok: false, usedPercent: 86, cap: 85 })
    expect(weeklyCapCheck({ provider: 'claude', model: 'opus[1m]' }, caps, [weekly('claude', 40)])).toMatchObject({ ok: true })
    expect(weeklyCapCheck({ provider: 'codex', model: 'gpt-6-astra' }, caps, [])).toMatchObject({ ok: true, reason: expect.stringMatching(/No current weekly/) })
    expect(weeklyCapCheck({ provider: 'local', model: 'qwen' }, caps, [weekly('local', 100)])).toEqual({ ok: true })
  })

  it('stops a stage over its minutes, turns or money', () => {
    const base = { title: 'S', budget: { maxMinutes: 10, maxTurns: 2, maxEur: 5 }, startedAt: '2026-09-25T10:00:00.000Z', turns: 1, spentEur: 0 }
    expect(stageOverBudget(base, new Date('2026-09-25T10:05:00.000Z'))).toBeNull()
    expect(stageOverBudget(base, new Date('2026-09-25T10:11:00.000Z'))).toMatch(/10-minute budget/)
    expect(stageOverBudget({ ...base, turns: 3 }, new Date('2026-09-25T10:01:00.000Z'))).toMatch(/2-turn budget/)
    expect(stageOverBudget({ ...base, spentEur: 6 }, new Date('2026-09-25T10:01:00.000Z'))).toMatch(/€5.00 budget/)
  })
})

describe('recurring stage loops', () => {
  it('writes a valid loop file and adjusts a step as an auto-safe change', () => {
    const loopId = loopIdFor('idearun_mugx6gkj_dpiqsfm', 'daily-post')
    expect(loopId).toBe('idea-daily-post-dpiqsfm')
    const content = loopFileFor({ loopId, scheduleId: 'schedule_1', runId: 'idearun_1', ideaTitle: 'Masks', stageId: 'daily-post', stageTitle: 'Daily post', caps: { claude: 85, codex: 95 },
      recurrence: { everyMinutes: 1440, times: 3, loop: { title: 'Post, measure, adjust', steps: [{ id: 'post', role: 'publisher', model: 'claude:sonnet', done: 'posted: with label # yes' }, { id: 'measure', role: 'analyst', model: 'claude:haiku' }] } } })
    const loop = parseLogicLoop(content, `${loopId}.md`)
    expect(loop).toMatchObject({ id: loopId, version: 1, trigger: ['schedule:schedule_1'], inputs: ['runId', 'stageId', 'occurrence'], budget: { claudeWeeklyMax: 85, codexWeeklyMax: 95 }, locked: ['budget'] })
    expect(loop.steps.map(step => [step.id, step.model])).toEqual([['post', 'claude:sonnet'], ['measure', 'claude:haiku']])
    const adjusted = parseLogicLoop(adjustLoopFile(content, 'measure', { model: 'claude:sonnet', effort: 'low' }), `${loopId}.md`)
    expect(adjusted.steps[1]).toMatchObject({ model: 'claude:sonnet', effort: 'low' })
    expect(classifyLoopChange(loop, adjusted)).toEqual({ autoApplicable: true, reasons: [] })
    expect(() => adjustLoopFile(content, 'nope', { model: 'x' })).toThrow(/no step nope/)
  })
})

/* ------------------------------------------------------------------------- *
 * The controller, end to end, with fixture agents and the real loops
 * ------------------------------------------------------------------------- */

interface FakeSession { id: string; items: Array<{ sequence: number; role: 'user' | 'assistant'; text: string }>; sequence: number; phase: SessionPhase; prompts: string[] }

function harness(options: { usage?: UsageReportForBudget[]; respond(prompt: string, session: FakeSession): string | null }) {
  const root = mkdtempSync(join(tmpdir(), 'idea-runs-test-')); roots.push(root)
  const database = new ConductorDatabase(join(root, 'conductor.db'))
  const project = database.upsertProject(root, 'Idea project')
  const ideas = new IdeaStore(':memory:')
  const store = new IdeaRunStore(':memory:')
  closers.push(() => store.close(), () => ideas.close(), () => database.close())
  const sessions = new Map<string, FakeSession>()
  const notifications: IdeaRunNotification[] = []
  const schedules: Array<{ projectId: string; everyMinutes: number }> = []
  let clock = new Date('2026-09-25T10:00:00.000Z')
  const usage = options.usage ?? []
  const view = (id: string): AgentTurnView | null => {
    const session = sessions.get(id)
    if (!session) return null
    return {
      sequence: session.sequence, phase: session.phase,
      answerAfter: after => [...session.items].reverse().find(item => item.sequence > after && item.role === 'assistant')?.text ?? null,
      producedAfter: after => session.items.some(item => item.sequence > after && item.role === 'assistant')
    }
  }
  const controller = new IdeaRunController({
    store,
    ideas: {
      get: ideaId => ideas.get(ideaId),
      event: (ideaId, message, actor, data) => ideas.event(ideaId, 'autopilot', message, actor, data),
      link: (ideaId, input, actor) => { ideas.link(ideaId, { ...input, createdFromIdeaId: ideaId }, actor, { workedOn: true }) }
    },
    agents: {
      async open() { const id = `session-${sessions.size + 1}`; sessions.set(id, { id, items: [], sequence: 0, phase: 'idle', prompts: [] }); return { agentSessionId: id } },
      async submit(id, prompt) {
        const session = sessions.get(id)!
        session.prompts.push(prompt)
        session.items.push({ sequence: ++session.sequence, role: 'user', text: prompt })
        const answer = options.respond(prompt, session)
        if (answer === null) { session.phase = 'running'; return }
        session.items.push({ sequence: ++session.sequence, role: 'assistant', text: answer })
        session.phase = 'completed'
      },
      async interrupt(id) { sessions.get(id)!.phase = 'interrupted' },
      view
    },
    loops: () => {
      const loops = new LogicLoops(root, project.id, database, { usage: () => usage })
      return { root, get: id => loops.get(id), run: (id, inputs) => loops.run(id, inputs), record: input => loops.record(input), propose: input => loops.propose(input), apply: (id, sovereign, by) => loops.apply(id, sovereign, by) }
    },
    schedule: (projectId, everyMinutes) => { schedules.push({ projectId, everyMinutes }); return 'schedule_idea' },
    usage: () => usage,
    notify: async notification => { notifications.push(notification); return 'pushed to 1 phone' },
    now: () => clock,
    promptPrefix: 'SYNTHETIC IDEA-RUN '
  })
  const idea = ideas.capture({ text: 'Dry run: a harmless paper-mask brand.\nStrip the AI label before posting.', source: 'desktop' }, { kind: 'owner' })
  return { root, database, project, ideas, store, sessions, notifications, schedules, controller, idea, advance(minutes: number) { clock = new Date(clock.getTime() + minutes * 60_000) } }
}

const PLAN = {
  summary: 'Research, check the brand, then post daily.',
  stages: [
    { id: 'research', title: 'Research competitors', kind: 'research', goal: 'List paper-mask competitors', doneCriteria: ['3 competitors'], agent: { provider: 'claude', model: 'opus[1m]' } },
    { id: 'brand-check', title: 'Brand check', kind: 'brand-check', goal: 'Check the name and logo', doneCriteria: ['no conflicts'] },
    { id: 'daily-post', title: 'Daily post', kind: 'public', goal: 'Post a photo each day', doneCriteria: ['posted'], generatesMedia: true,
      recurrence: { everyMinutes: 1440, times: 1, loop: { title: 'Post, measure, adjust', steps: [{ id: 'post', role: 'publisher', model: 'claude:sonnet' }, { id: 'measure', role: 'analyst', model: 'claude:haiku' }] } } }
  ]
}

function scripted(prompt: string, session: FakeSession): string {
  const key = prompt.replace(/^SYNTHETIC IDEA-RUN /, '').split('\n', 1)[0]!
  if (key === 'PLAN') return fence('idea-run-plan', PLAN)
  if (key === 'STAGE research') return fence('idea-run-report', { status: 'done', summary: 'Found 3 competitors.', artifacts: [{ path: 'research/competitors.md', label: 'Competitors' }], decisions: ['Focus on the EU'] })
  if (key === 'STAGE brand-check') return fence('idea-run-report', { status: 'done', summary: 'No conflicts; AI labels kept.' })
  if (key.startsWith('OCCURRENCE daily-post')) return fence('idea-run-report', { status: 'continue', summary: 'Drafted post 1.', actions: [{ type: 'publish', summary: 'Post photo 1', detail: 'Caption: "Paper mask no. 1 #madewithai" with the AI label on', target: 'instagram test account' }] })
  if (key.startsWith('DECISIONS daily-post')) return fence('idea-run-report', { status: 'done', summary: 'Posted (simulated).', loop: { steps: [{ id: 'post', outcome: 'ok' }, { id: 'measure', outcome: 'ok', note: '0 views (dry run)' }], adjust: { stepId: 'measure', model: 'claude:sonnet', reason: 'haiku missed the comment sentiment' } } })
  void session
  return 'unexpected prompt'
}

describe('the idea run controller', () => {
  it('plans, waits for approval, runs three stages with a scheduled loop occurrence and a phone checkpoint, and records each step', async () => {
    const h = harness({ respond: scripted })
    const run = await h.controller.start({ ideaId: h.idea.id, projectId: h.project.id, dryRun: true }, { kind: 'owner' })
    expect(run.status).toBe('planning')
    expect(h.sessions.get('session-1')!.prompts[0]).toMatch(/^SYNTHETIC IDEA-RUN PLAN\n/)
    await h.controller.tick()
    let current = h.controller.get(run.id)
    expect(current.status).toBe('awaiting-approval')
    expect(current.plan!.warnings.join(' ')).toMatch(/Refused part of the idea/)
    expect(h.notifications.at(-1)).toMatchObject({ attention: true, title: expect.stringMatching(/plan ready/i) })
    await h.controller.tick()
    expect(h.controller.get(run.id).status).toBe('awaiting-approval')

    await h.controller.approve(run.id, { kind: 'owner' })
    await h.controller.tick() // research: brief, answered at once, done; brand check likewise; then the recurring stage waits for its schedule
    await h.controller.tick()
    await h.controller.tick()
    current = h.controller.get(run.id)
    expect(current.stages.map(stage => stage.status)).toEqual(['done', 'done', 'recurring'])
    expect(h.schedules).toEqual([{ projectId: h.project.id, everyMinutes: 1440 }])
    const loopId = current.stages[2]!.loopId!
    expect(readFileSync(join(h.root, '.conductor', 'loops', `${loopId}.md`), 'utf8')).toMatch(/trigger: \[schedule:schedule_idea\]/)

    const fired = await h.controller.runDue(h.project.id)
    expect(fired.outcome).toBe('dispatched')
    await h.controller.tick()
    current = h.controller.get(run.id)
    expect(current.status).toBe('waiting-owner')
    const checkpoint = current.checkpoints.find(item => item.status === 'pending')!
    expect(checkpoint.action).toMatchObject({ type: 'publish', summary: 'Post photo 1' })
    expect(h.notifications.at(-1)).toMatchObject({ attention: true, title: expect.stringMatching(/Approve\? Publish/), body: expect.stringContaining('#madewithai') })
    expect((await h.controller.runDue(h.project.id)).outcome).toBe('unchanged')

    await h.controller.decide({ checkpointId: checkpoint.id, decision: 'approve', standing: true }, { kind: 'owner', label: 'phone Pixel' })
    const decisionPrompt = h.sessions.get(current.stages[2]!.agentSessionId!)!.prompts.at(-1)!
    expect(decisionPrompt).toMatch(/^SYNTHETIC IDEA-RUN DECISIONS daily-post/)
    expect(decisionPrompt).toMatch(/APPROVED publish: Post photo 1\. Dry run: do not perform it/)
    await h.controller.tick()
    current = h.controller.get(run.id)
    expect(current.status).toBe('completed')
    expect(current.rules).toEqual([expect.objectContaining({ actionType: 'publish', decision: 'approve', createdBy: 'phone Pixel' })])
    const loops = new LogicLoops(h.root, h.project.id, h.database)
    expect(loops.get(loopId)).toMatchObject({ version: 2 })
    expect(loops.get(loopId).steps.find(step => step.id === 'measure')!.model).toBe('claude:sonnet')
    expect(loops.recentRuns(loopId)[0]!.steps.map(step => [step.stepId, step.outcome])).toEqual([['post', 'ok'], ['measure', 'ok']])

    const timeline = h.ideas.get(h.idea.id).events.map(event => event.message)
    for (const pattern of [/Idea run started \(dry run\)/, /Plan ready for your approval/, /Plan approved: 3 stages/, /Stage 1 started: Research competitors/, /Decision .*Focus on the EU/,
      /Stage 1 done/, /Stage 2 done/, /Stage 3 is recurring: logic loop/, /Scheduled task fired occurrence 1 of 1/, /Checkpoint .*Publish or upload publicly — Post photo 1\. Waiting for you/,
      /Phone notification: Approve\?/, /Approved by phone Pixel/, /Standing rule for this run/, /Loop .* occurrence 1 recorded: post ok, measure ok/, /advanced to v2: step measure now uses claude:sonnet/,
      /Stage 3 done/, /Idea run completed/]) {
      expect(timeline.some(message => pattern.test(message)), String(pattern)).toBe(true)
    }
    expect(h.ideas.get(h.idea.id).links.some(link => link.kind === 'artifact' && link.targetId === 'research/competitors.md')).toBe(true)
  })

  it('pauses before a stage at the Claude weekly cap, and pauses a stage over its time budget', async () => {
    const capped = harness({ usage: [weekly('claude', 90)], respond: scripted })
    const run = await capped.controller.start({ ideaId: capped.idea.id, projectId: capped.project.id }, { kind: 'owner' })
    await capped.controller.tick()
    await capped.controller.approve(run.id, { kind: 'owner' })
    await capped.controller.tick()
    expect(capped.controller.get(run.id)).toMatchObject({ status: 'paused', reason: expect.stringMatching(/Claude weekly usage is 90%, at or above this run's cap of 85%/) })
    expect(capped.sessions.size).toBe(1) // only the planner; no stage agent was opened

    const slow = harness({ respond: (prompt, session) => prompt.includes('STAGE research') ? null : scripted(prompt, session) })
    const second = await slow.controller.start({ ideaId: slow.idea.id, projectId: slow.project.id }, { kind: 'owner' })
    await slow.controller.tick()
    await slow.controller.approve(second.id, { kind: 'owner' })
    await slow.controller.tick()
    slow.advance(61)
    await slow.controller.tick()
    const paused = slow.controller.get(second.id)
    expect(paused).toMatchObject({ status: 'paused', reason: expect.stringMatching(/over its 60-minute budget/) })
    expect(paused.stages[0]!.status).toBe('paused')
    expect(slow.sessions.get(paused.stages[0]!.agentSessionId!)!.phase).toBe('interrupted')
    await slow.controller.resume(second.id, { kind: 'owner' })
    expect(slow.controller.get(second.id).stages[0]).toMatchObject({ status: 'running', turns: 1 })
  })

  it('asks the planner once more for an unparseable plan, then fails', async () => {
    const h = harness({ respond: () => 'I think we should do it.' })
    const run = await h.controller.start({ ideaId: h.idea.id, projectId: h.project.id }, { kind: 'owner' })
    await h.controller.tick()
    expect(h.sessions.get('session-1')!.prompts).toHaveLength(2)
    await h.controller.tick()
    expect(h.controller.get(run.id)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/did not parse/) })
    await expect(h.controller.start({ ideaId: h.idea.id, projectId: h.project.id }, { kind: 'owner' })).resolves.toMatchObject({ status: 'planning' })
    await expect(h.controller.start({ ideaId: h.idea.id, projectId: h.project.id }, { kind: 'owner' })).rejects.toThrow(/already has a run/)
  })

  it('app control: only the owner approves plans and answers checkpoints; a local model only reads', async () => {
    const h = harness({ respond: scripted })
    const agent = { projectId: h.project.id, agentSessionId: 'agent-1', title: 'Wizard', owner: false, sovereign: true, readOnly: false }
    const run = await ideaRunsCall(h.controller, agent, 'ideas.run', { ideaId: h.idea.id, dryRun: true }) as { id: string }
    await h.controller.tick()
    await expect(ideaRunsCall(h.controller, agent, 'ideas.run.approve', { runId: run.id })).rejects.toThrow(/owner's answer/)
    await expect(ideaRunsCall(h.controller, { ...agent, sovereign: false, readOnly: true }, 'ideas.run.pause', { runId: run.id })).rejects.toThrow(/may only read/)
    await expect(ideaRunsCall(h.controller, { ...agent, readOnly: true }, 'ideas.runs', { runId: run.id })).resolves.toMatchObject({ status: 'awaiting-approval' })
    await expect(ideaRunsCall(h.controller, { ...agent, owner: true, agentSessionId: '' }, 'ideas.run.approve', { runId: run.id })).resolves.toMatchObject({ status: 'running' })
    await expect(ideaRunsCall(h.controller, agent, 'ideas.run', { ideaId: h.idea.id, extra: 1 })).rejects.toThrow(/does not accept extra/)
  })
})

describe('stage models', () => {
  const catalog = [
    { provider: 'claude', available: true, models: [{ id: 'sonnet', label: 'Claude Sonnet 5', isDefault: true, effort: ['low', 'high'] }, { id: 'opus[1m]', label: 'Claude Opus 5.5 (1M)', effort: ['high', 'max'] }] },
    { provider: 'codex', available: false, models: [{ id: 'gpt-6-astra' }] }
  ]
  it('takes exact ids, maps a planner\'s names onto models.list, and falls back to the default with a note', () => {
    expect(chooseModel(catalog, { provider: 'claude', model: 'opus[1m]', effort: 'high' })).toEqual({ model: 'opus[1m]', effort: 'high' })
    expect(chooseModel(catalog, { provider: 'claude', model: 'claude-opus' })).toEqual({ model: 'opus[1m]', note: 'claude-opus opened as opus[1m]' })
    expect(chooseModel(catalog, { provider: 'claude', model: 'fable-5', effort: 'max' })).toEqual({ model: 'sonnet', note: expect.stringMatching(/fable-5 is not in models.list; using sonnet; effort max is not offered/) })
    expect(() => chooseModel(catalog, { provider: 'codex', model: 'gpt-6-astra' })).toThrow(/codex is unavailable/)
  })
})
