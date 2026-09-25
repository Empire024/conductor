import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IdeaActor, IdeaDetail } from '../../shared/ideas'
import {
  IDEA_ACTION_LABELS, IDEA_RUN_FINAL, type DecideCheckpointInput, type IdeaRun, type IdeaRunCheckpoint, type IdeaRunStatus,
  type StartIdeaRunInput
} from '../../shared/idea-runs'
import type { SessionPhase } from '../../shared/structured-agent'
import type { LoopRecordInput, LogicLoopDefinition, LoopProposalRecord, UsageReportForBudget } from '../logic-loops'
import { decisionsBrief, occurrenceBrief, planReminderBrief, planningBrief, reminderBrief, stageBrief } from './briefs'
import { stageOverBudget, weeklyCapCheck } from './budget'
import { adjustLoopFile, loopFileFor, loopIdFor } from './loop-file'
import { parsePlanAnswer } from './plan'
import { MONEY_ACTIONS, screenAction } from './policy'
import { parseStageReport, type StageReport } from './report'
import type { IdeaRunStore, StoredRun, StoredStage } from './store'

/** What the controller reads of a conversation: where it is and what it last answered. */
export interface AgentTurnView {
  sequence: number
  phase: SessionPhase
  /** The newest assistant text after `sequence`, or null. */
  answerAfter(sequence: number): string | null
  /** Anything the turn produced after `sequence` besides the prompt itself (tools, status, text). */
  producedAfter(sequence: number): boolean
}

/** The part of LogicLoops (src/main/logic-loops) a run uses, for one project. */
export interface IdeaRunLoops {
  root: string
  get(id: string): LogicLoopDefinition
  run(id: string, inputs: unknown): { runId: string; status: 'ready' | 'paused'; budget: { steps: Record<string, { status: string; reason?: string }> } }
  record(input: LoopRecordInput): unknown
  propose(input: { id: string; change: string; evidence: string }): LoopProposalRecord
  apply(proposalId: string, sovereign: boolean, appliedBy: 'agent' | 'owner' | 'wizard'): LoopProposalRecord
}

export interface IdeaRunNotification { runId: string; ideaId: string; title: string; body: string; attention: boolean }

export interface IdeaRunDeps {
  store: IdeaRunStore
  ideas: {
    get(ideaId: string): Pick<IdeaDetail, 'id' | 'title' | 'text'>
    event(ideaId: string, message: string, actor: IdeaActor, data?: Record<string, unknown>): void
    link(ideaId: string, input: { kind: 'artifact' | 'agent-session'; targetId: string; label: string; projectId: string; createdByAgentSessionId?: string }, actor: IdeaActor): void
  }
  agents: {
    /** Opens a visible agent tab; `note` says when the model or effort had to change to one models.list offers. */
    open(request: { projectId: string; provider: string; model: string; effort?: string; title: string }): Promise<{ agentSessionId: string; model?: string; note?: string }>
    submit(agentSessionId: string, prompt: string): Promise<void>
    interrupt(agentSessionId: string): Promise<void>
    view(agentSessionId: string): AgentTurnView | null
  }
  loops(projectId: string): IdeaRunLoops | null
  /** The project's idea-run scheduled task, created or tightened to fire at least this often. */
  schedule(projectId: string, everyMinutes: number): string
  usage(): UsageReportForBudget[]
  /** Phone notification; resolves to what happened ("sent to 1 phone", "No phone has notifications on."). */
  notify(notification: IdeaRunNotification): Promise<string>
  now?(): Date
  /** Put in front of every prompt: the offline fixture marker in a test launch, else nothing. */
  promptPrefix?: string
  log?(message: string, error?: unknown): void
}

const AUTOPILOT: IdeaActor = { kind: 'conductor', label: 'Idea autopilot' }
const SETTLED = new Set<SessionPhase>(['idle', 'completed', 'failed', 'interrupted', 'disconnected'])
const ENDED = new Set<SessionPhase>(['failed', 'interrupted', 'disconnected'])
const ACTIVE: ReadonlySet<IdeaRunStatus> = new Set(['planning', 'running'])
const MAX_PLANNER_TURNS = 2
const MAX_TICK_FAILURES = 3

type TurnOutcome = { state: 'waiting' } | { state: 'answered'; text: string } | { state: 'ended'; phase: SessionPhase }

function turnOutcome(view: AgentTurnView, after: number): TurnOutcome {
  if (!SETTLED.has(view.phase)) return { state: 'waiting' }
  const text = view.answerAfter(after)
  if (text) return { state: 'answered', text }
  // Settled with no answer: a turn that produced something, or one that failed after the prompt
  // landed, has ended; otherwise the prompt has not started a turn yet.
  if (view.producedAfter(after) || (ENDED.has(view.phase) && view.sequence > after)) return { state: 'ended', phase: view.phase }
  return { state: 'waiting' }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text

/**
 * The idea autopilot's run controller (docs/idea-autopilot.md). One instance serves every run:
 * a periodic tick advances planning and running runs, the project's idea-run scheduled task fires
 * recurring stages through runDue, and the owner's answers arrive through decide. Every public
 * method runs on one queue, so a tick, a scheduled occurrence and an answer never interleave.
 */
export class IdeaRunController {
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  /** Consecutive failed ticks per run: a window not ready yet at launch is retried, not fatal. */
  private readonly failures = new Map<string, number>()

  constructor(private readonly deps: IdeaRunDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date() }
  private serial<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The run as the view, the phone and app control show it. */
  view(run: StoredRun): IdeaRun {
    let ideaTitle = ''
    try { ideaTitle = this.deps.ideas.get(run.ideaId).title } catch { ideaTitle = '(deleted idea)' }
    const { plannerAwaitSequence: _a, plannerTurns: _t, planner: _p, stages, ...rest } = run
    return { ...rest, ideaTitle, stages: stages.map(({ awaitSequence: _s, loopRunId: _l, ...stage }) => stage) }
  }

  list(query: { ideaId?: string } = {}): IdeaRun[] { return this.deps.store.list(query).map(run => this.view(run)) }
  get(runId: string): IdeaRun { return this.view(this.deps.store.get(runId)) }
  pendingCheckpoints(): Array<IdeaRunCheckpoint & { ideaId: string; ideaTitle: string; stageTitle: string; dryRun: boolean }> {
    return this.deps.store.pendingCheckpoints().map(checkpoint => {
      const run = this.get(checkpoint.runId)
      return { ...checkpoint, ideaId: run.ideaId, ideaTitle: run.ideaTitle, stageTitle: run.stages.find(stage => stage.id === checkpoint.stageId)?.title ?? checkpoint.stageId, dryRun: run.dryRun }
    })
  }

  attach(intervalMs = 5_000): () => void {
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    this.timer.unref?.()
    void this.tick()
    return () => { if (this.timer) clearInterval(this.timer); this.timer = null }
  }

  private event(run: Pick<StoredRun, 'id' | 'ideaId'>, text: string, data: Record<string, unknown> = {}, actor: IdeaActor = AUTOPILOT): void {
    try { this.deps.ideas.event(run.ideaId, clip(text, 2000), actor, { runId: run.id, ...data }) } catch (error) { this.deps.log?.('Idea run: timeline event failed', error) }
  }

  private async notify(run: StoredRun, title: string, body: string, attention: boolean): Promise<void> {
    let outcome: string
    try { outcome = await this.deps.notify({ runId: run.id, ideaId: run.ideaId, title, body: clip(body, 400), attention }) } catch (error) { outcome = `Phone notification failed: ${message(error)}` }
    this.event(run, `Phone notification: ${title}`, { notification: { title, body: clip(body, 400), attention, outcome } })
  }

  /* ----------------------------------------------------------------------- *
   * Owner and agent entry points
   * ----------------------------------------------------------------------- */

  start(input: StartIdeaRunInput, actor: IdeaActor): Promise<IdeaRun> {
    return this.serial(async () => {
      const idea = this.deps.ideas.get(String(input.ideaId ?? ''))
      const projectId = String(input.projectId ?? '')
      if (!projectId) throw new Error('Choose a project for the run')
      const active = this.deps.store.list({ ideaId: idea.id }).find(run => !IDEA_RUN_FINAL.has(run.status))
      if (active) throw new Error(`This idea already has a run that is ${active.status} (${active.id}); stop it before starting another`)
      const provider = input.planner?.provider === 'codex' ? 'codex' : 'claude'
      const model = input.planner?.model?.trim() || (provider === 'codex' ? 'gpt-6-astra' : 'opus[1m]')
      const run = this.deps.store.create({ ideaId: idea.id, projectId, dryRun: input.dryRun === true, planner: { provider, model } })
      this.event(run, `Idea run started${run.dryRun ? ' (dry run)' : ''}: ${provider} ${model} is writing the staged plan; nothing runs until you approve it`, { provider, model }, actor)
      try {
        const opened = await this.deps.agents.open({ projectId, provider, model, effort: 'high', title: clip(`Idea plan: ${idea.title}`, 120) })
        if (opened.note) this.event(run, `Planner model: ${opened.note}`)
        const sequence = this.deps.agents.view(opened.agentSessionId)?.sequence ?? 0
        this.deps.store.setPlanner(run.id, { agentSessionId: opened.agentSessionId, awaitSequence: sequence, turns: 1 })
        this.deps.ideas.link(idea.id, { kind: 'agent-session', targetId: opened.agentSessionId, label: clip(`Planner for idea run ${run.id}`, 300), projectId, createdByAgentSessionId: opened.agentSessionId }, AUTOPILOT)
        await this.deps.agents.submit(opened.agentSessionId, this.prompt(planningBrief(idea, { dryRun: run.dryRun, runId: run.id })))
      } catch (error) {
        this.deps.store.setStatus(run.id, 'failed', `The planner could not start: ${message(error)}`)
        this.event(run, `Idea run failed: the planner could not start (${message(error)})`)
        throw error
      }
      return this.get(run.id)
    })
  }

  approve(runId: string, actor: IdeaActor): Promise<IdeaRun> {
    return this.serial(() => {
      const run = this.deps.store.get(runId)
      if (run.status !== 'awaiting-approval' || !run.plan) throw new Error(`This run is ${run.status}; only a plan waiting for approval can be approved`)
      this.deps.store.approve(run.id)
      this.event(run, `Plan approved: ${run.plan.stages.length} stages will run (${run.plan.stages.map(stage => stage.title).join(' → ')})`, {}, actor)
      this.kick()
      return this.get(run.id)
    })
  }

  decide(input: DecideCheckpointInput, actor: IdeaActor): Promise<IdeaRun> {
    return this.serial(async () => {
      const checkpoint = this.deps.store.checkpoint(String(input.checkpointId ?? ''))
      if (!checkpoint) throw new Error('No checkpoint with that id exists')
      if (input.decision !== 'approve' && input.decision !== 'deny') throw new Error('decision must be approve or deny')
      const run = this.deps.store.get(checkpoint.runId)
      if (IDEA_RUN_FINAL.has(run.status)) throw new Error(`This run is ${run.status}`)
      const by = actor.label || 'owner'
      const status = input.decision === 'approve' ? 'approved' : 'denied'
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : undefined
      const decided = [this.deps.store.decideCheckpoint(checkpoint.id, status, by, note)]
      this.event(run, `${status === 'approved' ? 'Approved' : 'Denied'} by ${by}: ${IDEA_ACTION_LABELS[checkpoint.action.type]} — ${checkpoint.action.summary}${note ? ` (${note})` : ''}`, { checkpointId: checkpoint.id, decision: status }, actor)
      if (input.standing) {
        this.deps.store.setRule(run.id, checkpoint.action.type, input.decision, by)
        this.event(run, `Standing rule for this run: always ${input.decision} "${IDEA_ACTION_LABELS[checkpoint.action.type]}"`, { actionType: checkpoint.action.type }, actor)
        for (const other of this.deps.store.get(run.id).checkpoints.filter(item => item.status === 'pending' && item.action.type === checkpoint.action.type)) {
          decided.push(this.deps.store.decideCheckpoint(other.id, status, 'standing rule', `Standing rule set by ${by}.`))
        }
      }
      for (const item of decided) {
        if (item.status === 'approved' && MONEY_ACTIONS.has(item.action.type) && item.action.amountEur) {
          const stage = this.deps.store.get(run.id).stages.find(entry => entry.id === item.stageId)
          if (stage) this.deps.store.updateStage(run.id, stage.index, { spentEur: stage.spentEur + item.action.amountEur })
        }
      }
      // A paused run hears the answers when it resumes (the tick delivers them then).
      const fresh = this.deps.store.get(run.id)
      if (fresh.status === 'waiting-owner' || fresh.status === 'running') await this.afterDecisions(fresh)
      this.kick()
      return this.get(run.id)
    })
  }

  pause(runId: string, actor: IdeaActor): Promise<IdeaRun> {
    return this.serial(() => {
      const run = this.deps.store.get(runId)
      if (IDEA_RUN_FINAL.has(run.status) || run.status === 'paused') throw new Error(`This run is ${run.status}`)
      this.deps.store.setStatus(run.id, 'paused', `Paused by ${actor.label || 'the owner'}`)
      this.event(run, `Run paused by ${actor.label || 'the owner'}; a turn already running finishes and is read on resume`, {}, actor)
      return this.get(run.id)
    })
  }

  resume(runId: string, actor: IdeaActor): Promise<IdeaRun> {
    return this.serial(async () => {
      const run = this.deps.store.get(runId)
      if (run.status !== 'paused') throw new Error(`This run is ${run.status}; only a paused run resumes`)
      const status: IdeaRunStatus = !run.approvedAt ? (run.plan ? 'awaiting-approval' : 'planning') : run.checkpoints.some(item => item.status === 'pending') ? 'waiting-owner' : 'running'
      this.deps.store.setStatus(run.id, status)
      // A stage stopped by its budget gets another budget of the same size from now.
      for (const stage of run.stages.filter(entry => entry.status === 'paused')) {
        const original = run.plan?.stages.find(entry => entry.id === stage.id)?.budget ?? stage.budget
        this.deps.store.setStageBudget(run.id, stage.index, { maxMinutes: original.maxMinutes, maxTurns: original.maxTurns, maxEur: Math.max(stage.budget.maxEur, stage.spentEur + original.maxEur) })
        this.deps.store.updateStage(run.id, stage.index, { status: stage.agentSessionId ? 'running' : 'pending', startedAt: this.now().toISOString(), turns: 0 })
        if (stage.agentSessionId && status === 'running') await this.submitTurn(this.deps.store.get(run.id), this.deps.store.get(run.id).stages[stage.index]!, reminderBrief(stage, 'continue'))
      }
      this.event(run, `Run resumed by ${actor.label || 'the owner'}`, {}, actor)
      this.kick()
      return this.get(run.id)
    })
  }

  stop(runId: string, actor: IdeaActor): Promise<IdeaRun> {
    return this.serial(async () => {
      const run = this.deps.store.get(runId)
      if (IDEA_RUN_FINAL.has(run.status)) throw new Error(`This run is already ${run.status}`)
      for (const stage of run.stages.filter(entry => entry.status === 'running' && entry.agentSessionId)) {
        try { await this.deps.agents.interrupt(stage.agentSessionId!) } catch { /* the turn may already be over */ }
      }
      this.deps.store.setStatus(run.id, 'stopped', `Stopped by ${actor.label || 'the owner'}`)
      this.event(run, `Run stopped by ${actor.label || 'the owner'}`, {}, actor)
      return this.get(run.id)
    })
  }

  /* ----------------------------------------------------------------------- *
   * The tick: planning and running runs move on
   * ----------------------------------------------------------------------- */

  private kick(): void { queueMicrotask(() => { void this.tick() }) }

  tick(): Promise<void> {
    return this.serial(async () => {
      for (const run of this.deps.store.list().filter(entry => ACTIVE.has(entry.status))) {
        try {
          if (run.status === 'planning') await this.advancePlanning(run)
          else await this.advanceRunning(run)
          this.failures.delete(run.id)
        } catch (error) {
          this.deps.log?.(`Idea run ${run.id}: tick failed`, error)
          const failures = (this.failures.get(run.id) ?? 0) + 1
          this.failures.set(run.id, failures)
          if (failures < MAX_TICK_FAILURES) continue
          this.failures.delete(run.id)
          this.deps.store.setStatus(run.id, 'paused', `Conductor hit an error and paused the run: ${message(error)}`)
          this.event(run, `Run paused: Conductor hit an error (${message(error)})`)
        }
      }
    })
  }

  private prompt(text: string): string { return `${this.deps.promptPrefix ?? ''}${text}` }

  private async advancePlanning(run: StoredRun): Promise<void> {
    if (!run.plannerAgentSessionId || run.plannerAwaitSequence === null) return
    const view = this.deps.agents.view(run.plannerAgentSessionId)
    if (!view) { this.fail(run, 'The planner conversation is gone'); return }
    const outcome = turnOutcome(view, run.plannerAwaitSequence)
    if (outcome.state === 'waiting') return
    const idea = this.deps.ideas.get(run.ideaId)
    if (outcome.state === 'answered') {
      try {
        const plan = parsePlanAnswer(outcome.text, { ideaText: idea.text, author: { ...(run.planner ?? { provider: 'claude', model: '' }), agentSessionId: run.plannerAgentSessionId } })
        this.deps.store.setPlan(run.id, plan)
        this.event(run, `Plan ready for your approval: ${plan.stages.map((stage, index) => `${index + 1}. ${stage.title}${stage.recurrence ? ` (every ${stage.recurrence.everyMinutes} min × ${stage.recurrence.times})` : ''}`).join('; ')}${plan.warnings.length ? `. Conductor changed: ${plan.warnings.join(' ')}` : ''}`, { stages: plan.stages.length, warnings: plan.warnings })
        await this.notify(run, `Idea plan ready: ${clip(idea.title, 60)}`, `${plan.stages.length} stages. ${plan.summary}`, true)
        return
      } catch (error) {
        if (run.plannerTurns < MAX_PLANNER_TURNS) {
          this.deps.store.setPlanner(run.id, { awaitSequence: view.sequence, turns: run.plannerTurns + 1 })
          await this.deps.agents.submit(run.plannerAgentSessionId, this.prompt(planReminderBrief()))
          this.event(run, `The plan did not parse (${message(error)}); asked the planner once more`)
          return
        }
        this.fail(run, `The planner's plan did not parse: ${message(error)}`)
        return
      }
    }
    this.fail(run, `The planner's turn ended (${outcome.phase}) without a plan`)
  }

  private fail(run: StoredRun, reason: string): void {
    this.deps.store.setStatus(run.id, 'failed', reason)
    this.event(run, `Run failed: ${reason}`)
  }

  private async pauseRun(run: StoredRun, reason: string, attention = true): Promise<void> {
    this.deps.store.setStatus(run.id, 'paused', reason)
    this.event(run, `Run paused: ${reason}`)
    if (attention) await this.notify(run, 'Idea run paused', reason, true)
  }

  private async advanceRunning(start: StoredRun): Promise<void> {
    // Several stages can finish in one tick (a stage done, the next one recurring); the bound keeps
    // a confused state from spinning.
    for (let guard = 0; guard < 4; guard++) {
      const run = this.deps.store.get(start.id)
      if (run.status !== 'running') return
      const stage = run.stages.find(entry => entry.status !== 'done')
      if (!stage) { await this.complete(run); return }
      const before = `${stage.status}:${stage.turns}:${stage.occurrences}`
      if (stage.status === 'pending') await this.startStage(run, stage)
      else if (stage.status === 'running') await this.checkTurn(run, stage)
      else if (stage.status === 'waiting-owner') await this.afterDecisions(run)
      else if (stage.status === 'recurring') {
        if (stage.occurrences >= (stage.recurrence?.times ?? 1)) this.finishStage(run, stage, stage.summary || `${stage.occurrences} occurrences done`)
      }
      const after = this.deps.store.get(run.id).stages[stage.index]!
      if (`${after.status}:${after.turns}:${after.occurrences}` === before && after.status !== 'done') return
    }
  }

  private async complete(run: StoredRun): Promise<void> {
    this.deps.store.setStatus(run.id, 'completed')
    this.event(run, `Idea run completed: all ${run.stages.length} stages done`)
    await this.notify(run, 'Idea run completed', `${run.stages.length} stages done${run.dryRun ? ' (dry run)' : ''}.`, false)
  }

  private capBlocked(run: StoredRun, stage: StoredStage): string | null {
    const check = weeklyCapCheck(stage.agent, run.plan?.weeklyCaps ?? { claude: 85, codex: 95 }, this.deps.usage())
    return check.ok ? null : check.reason ?? 'A weekly usage cap is reached'
  }

  private async startStage(run: StoredRun, stage: StoredStage): Promise<void> {
    const blocked = this.capBlocked(run, stage)
    if (blocked) { await this.pauseRun(run, blocked); return }
    if (stage.recurrence) { await this.setupRecurrence(run, stage); return }
    const idea = this.deps.ideas.get(run.ideaId)
    const agentSessionId = await this.openStageAgent(run, stage, idea.title)
    this.deps.store.updateStage(run.id, stage.index, { status: 'running', agentSessionId, startedAt: this.now().toISOString(), turns: 0 })
    const fresh = this.deps.store.get(run.id)
    await this.submitTurn(fresh, fresh.stages[stage.index]!, stageBrief(this.view(fresh), fresh.stages[stage.index]!, idea))
    this.event(run, `Stage ${stage.index + 1} started: ${stage.title} (${stage.agent.provider} ${stage.agent.model})`, { stageId: stage.id, agentSessionId })
  }

  private async openStageAgent(run: StoredRun, stage: StoredStage, ideaTitle: string): Promise<string> {
    const opened = await this.deps.agents.open({ projectId: run.projectId, provider: stage.agent.provider, model: stage.agent.model, ...(stage.agent.effort ? { effort: stage.agent.effort } : {}), title: clip(`Idea: ${ideaTitle} · ${stage.title}`, 120) })
    if (opened.note) this.event(run, `Stage ${stage.index + 1} model: ${opened.note}`, { stageId: stage.id })
    this.deps.ideas.link(run.ideaId, { kind: 'agent-session', targetId: opened.agentSessionId, label: clip(`Stage ${stage.index + 1} "${stage.title}" of idea run ${run.id}`, 300), projectId: run.projectId, createdByAgentSessionId: opened.agentSessionId }, AUTOPILOT)
    return opened.agentSessionId
  }

  /** Sends one turn; false when a weekly cap paused the run instead. */
  private async submitTurn(run: StoredRun, stage: StoredStage, prompt: string): Promise<boolean> {
    if (!stage.agentSessionId) throw new Error(`Stage ${stage.id} has no conversation`)
    const blocked = this.capBlocked(run, stage)
    if (blocked) { this.deps.store.updateStage(run.id, stage.index, { status: 'paused', awaitSequence: null }); await this.pauseRun(run, blocked); return false }
    const sequence = this.deps.agents.view(stage.agentSessionId)?.sequence ?? 0
    await this.deps.agents.submit(stage.agentSessionId, this.prompt(prompt))
    this.deps.store.updateStage(run.id, stage.index, { status: 'running', awaitSequence: sequence, turns: stage.turns + 1 })
    return true
  }

  private async checkTurn(run: StoredRun, stage: StoredStage): Promise<void> {
    if (!stage.agentSessionId) return
    if (stage.awaitSequence === null) {
      // A turn that never went out (the submit failed, or Conductor stopped in between) goes again.
      if (stage.turns > 0) { await this.submitTurn(run, stage, reminderBrief(stage, 'interrupted')); return }
      const idea = this.deps.ideas.get(run.ideaId)
      const loops = stage.loopRunId && stage.loopId ? this.deps.loops(run.projectId) : null
      await this.submitTurn(run, stage, loops ? occurrenceBrief(this.view(run), stage, loops.get(stage.loopId!), stage.occurrences + 1) : stageBrief(this.view(run), stage, idea))
      return
    }
    const over = stageOverBudget(stage, this.now())
    const view = this.deps.agents.view(stage.agentSessionId)
    if (!view) { await this.pauseRun(run, `The conversation for stage "${stage.title}" is gone`); return }
    const outcome = turnOutcome(view, stage.awaitSequence)
    if (outcome.state === 'waiting') {
      if (!over) return
      try { await this.deps.agents.interrupt(stage.agentSessionId) } catch { /* already over */ }
      this.deps.store.updateStage(run.id, stage.index, { status: 'paused', awaitSequence: null })
      await this.pauseRun(run, `${over} Resume to give it another budget of the same size.`)
      return
    }
    if (outcome.state === 'ended') {
      if (stage.turns < stage.budget.maxTurns) { await this.submitTurn(run, stage, reminderBrief(stage, 'interrupted')); return }
      this.deps.store.updateStage(run.id, stage.index, { status: 'paused', awaitSequence: null })
      await this.pauseRun(run, `Stage "${stage.title}" ended its turn (${outcome.phase}) without a report and has no turns left.`)
      return
    }
    this.deps.store.updateStage(run.id, stage.index, { awaitSequence: null })
    await this.handleReport(this.deps.store.get(run.id), this.deps.store.get(run.id).stages[stage.index]!, outcome.text)
  }

  private async handleReport(run: StoredRun, stage: StoredStage, text: string): Promise<void> {
    const report = parseStageReport(text)
    if (!report) {
      if (stage.turns < stage.budget.maxTurns) { await this.submitTurn(run, stage, reminderBrief(stage, 'no-report')); return }
      this.deps.store.updateStage(run.id, stage.index, { status: 'paused' })
      await this.pauseRun(run, `Stage "${stage.title}" never ended a turn with its report and has no turns left.`)
      return
    }
    const label = `Stage ${stage.index + 1} "${stage.title}"${stage.loopRunId ? `, occurrence ${stage.occurrences + 1}` : ''}`
    for (const artifact of report.artifacts) {
      try {
        this.deps.ideas.link(run.ideaId, { kind: 'artifact', targetId: artifact.target, label: clip(artifact.label || artifact.target, 300), projectId: run.projectId, ...(stage.agentSessionId ? { createdByAgentSessionId: stage.agentSessionId } : {}) }, { kind: 'agent', ...(stage.agentSessionId ? { agentSessionId: stage.agentSessionId } : {}), label })
      } catch (error) { this.deps.log?.('Idea run: artifact link failed', error) }
    }
    for (const decision of report.decisions) this.event(run, `Decision (${label}): ${decision}`, { stageId: stage.id, kind: 'decision' }, { kind: 'agent', ...(stage.agentSessionId ? { agentSessionId: stage.agentSessionId } : {}), label })
    if (report.spentEur) this.deps.store.updateStage(run.id, stage.index, { spentEur: stage.spentEur + report.spentEur })

    const rules = this.deps.store.get(run.id).rules
    const created: IdeaRunCheckpoint[] = []
    for (const action of report.actions) {
      const verdict = screenAction(action, rules)
      const checkpoint = this.deps.store.addCheckpoint(run.id, stage.id, action, verdict.status === 'pending' ? { status: 'pending' } : { status: verdict.status, by: verdict.by, note: verdict.note })
      created.push(checkpoint)
      this.event(run, checkpoint.status === 'pending'
        ? `Checkpoint (${label}): ${IDEA_ACTION_LABELS[action.type]} — ${action.summary}. Waiting for you.`
        : `Checkpoint (${label}) ${checkpoint.status} by ${checkpoint.decidedBy}: ${action.summary}`, { checkpointId: checkpoint.id, actionType: action.type, action })
    }
    const pending = created.filter(item => item.status === 'pending')
    if (pending.length) {
      this.deps.store.updateStage(run.id, stage.index, { status: 'waiting-owner', summary: report.summary })
      this.deps.store.setStatus(run.id, 'waiting-owner', `${pending.length} action${pending.length === 1 ? '' : 's'} waiting for your approval`)
      for (const checkpoint of pending) {
        const body = `${checkpoint.action.summary}${checkpoint.action.target ? ` → ${checkpoint.action.target}` : ''}${checkpoint.action.amountEur ? ` (€${checkpoint.action.amountEur.toFixed(2)})` : ''}. ${checkpoint.action.detail}`
        await this.notify(run, `Approve? ${IDEA_ACTION_LABELS[checkpoint.action.type]}${run.dryRun ? ' (dry run)' : ''}`, body, true)
      }
      return
    }
    if (created.length) { await this.deliverDecisions(this.deps.store.get(run.id), this.deps.store.get(run.id).stages[stage.index]!); return }

    const fresh = this.deps.store.get(run.id).stages[stage.index]!
    if (report.status === 'blocked') {
      this.deps.store.updateStage(run.id, stage.index, { status: 'paused', summary: report.summary })
      await this.pauseRun(run, `${label} needs you: ${report.summary}`)
      return
    }
    if (report.status === 'continue') {
      if (fresh.turns < fresh.budget.maxTurns) { await this.submitTurn(run, fresh, reminderBrief(fresh, 'continue')); return }
      this.deps.store.updateStage(run.id, stage.index, { status: 'paused', summary: report.summary })
      await this.pauseRun(run, `Stage "${stage.title}" used its ${fresh.budget.maxTurns} turns without finishing. Resume to give it another budget.`)
      return
    }
    if (fresh.loopRunId) { await this.finishOccurrence(run, fresh, report); return }
    this.finishStage(run, fresh, report.summary)
  }

  private finishStage(run: StoredRun, stage: StoredStage, summary: string): void {
    this.deps.store.updateStage(run.id, stage.index, { status: 'done', finishedAt: this.now().toISOString(), summary, awaitSequence: null, loopRunId: null, nextDueAt: null })
    this.event(run, `Stage ${stage.index + 1} done: ${stage.title}. ${summary}`, { stageId: stage.id })
  }

  /** All checkpoints of the waiting stage answered: tell its agent, and the run moves again. */
  private async afterDecisions(run: StoredRun): Promise<void> {
    const pendingAnywhere = run.checkpoints.some(item => item.status === 'pending')
    for (const stage of run.stages.filter(entry => entry.status === 'waiting-owner')) {
      if (run.checkpoints.some(item => item.stageId === stage.id && item.status === 'pending')) continue
      await this.deliverDecisions(run, stage)
    }
    const fresh = this.deps.store.get(run.id)
    if (!pendingAnywhere && fresh.status === 'waiting-owner') this.deps.store.setStatus(run.id, 'running')
  }

  private async deliverDecisions(run: StoredRun, stage: StoredStage): Promise<void> {
    const decided = this.deps.store.undelivered(run.id, stage.id)
    if (!decided.length) { this.deps.store.updateStage(run.id, stage.index, { status: 'running' }); return }
    if (await this.submitTurn(run, { ...stage, status: 'running' }, decisionsBrief(this.view(run), stage, decided))) this.deps.store.markDelivered(decided.map(item => item.id))
  }

  /* ----------------------------------------------------------------------- *
   * Recurring stages: a logic loop, fired by the project's scheduled task
   * ----------------------------------------------------------------------- */

  private async setupRecurrence(run: StoredRun, stage: StoredStage): Promise<void> {
    const recurrence = stage.recurrence!
    const loops = this.deps.loops(run.projectId)
    if (!loops) { await this.pauseRun(run, 'The run\'s project is not on this machine, so its loop cannot be written'); return }
    const scheduleId = this.deps.schedule(run.projectId, recurrence.everyMinutes)
    const loopId = loopIdFor(run.id, stage.id)
    const path = join(loops.root, '.conductor', 'loops', `${loopId}.md`)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, loopFileFor({ loopId, scheduleId, runId: run.id, ideaTitle: this.deps.ideas.get(run.ideaId).title, stageId: stage.id, stageTitle: stage.title, recurrence, caps: run.plan?.weeklyCaps ?? { claude: 85, codex: 95 } }))
    }
    const loop = loops.get(loopId)
    this.deps.store.updateStage(run.id, stage.index, { status: 'recurring', loopId, startedAt: this.now().toISOString(), nextDueAt: this.now().toISOString(), occurrences: 0 })
    this.event(run, `Stage ${stage.index + 1} is recurring: logic loop ${loop.id} v${loop.version} (${loop.steps.map(step => step.id).join(' → ')}), fired by scheduled task ${scheduleId} every ${recurrence.everyMinutes} minutes, ${recurrence.times} times`, { stageId: stage.id, loopId, scheduleId, loopPath: loop.path })
  }

  /** The idea-run scheduled task's run (schedule kind 'idea-run'): fire every due occurrence in the project. */
  runDue(projectId: string): Promise<{ outcome: 'dispatched' | 'unchanged' | 'skipped'; detail: string }> {
    return this.serial(async () => {
      const now = this.now()
      const fired: string[] = [], waiting: string[] = []
      for (const run of this.deps.store.list().filter(entry => entry.projectId === projectId && entry.status === 'running')) {
        const stage = run.stages.find(entry => entry.status !== 'done')
        if (!stage || stage.status !== 'recurring' || !stage.loopId || !stage.recurrence) continue
        if (stage.occurrences >= stage.recurrence.times) continue
        if (stage.nextDueAt && Date.parse(stage.nextDueAt) > now.getTime()) { waiting.push(`${stage.title} due ${stage.nextDueAt}`); continue }
        try { fired.push(await this.fireOccurrence(run, stage)) } catch (error) {
          await this.pauseRun(run, `The scheduled occurrence of "${stage.title}" could not start: ${message(error)}`)
        }
      }
      if (fired.length) return { outcome: 'dispatched', detail: fired.join(' ') }
      return { outcome: 'unchanged', detail: waiting.length ? `Nothing due: ${waiting.join('; ')}.` : 'No idea run has a recurring stage waiting.' }
    })
  }

  private async fireOccurrence(run: StoredRun, stage: StoredStage): Promise<string> {
    const loops = this.deps.loops(run.projectId)
    if (!loops) throw new Error('the project is not on this machine')
    const blocked = this.capBlocked(run, stage)
    if (blocked) { await this.pauseRun(run, blocked); return `Paused ${stage.title}: ${blocked}` }
    const occurrence = stage.occurrences + 1
    const planned = loops.run(stage.loopId!, { runId: run.id, stageId: stage.id, occurrence })
    if (planned.status === 'paused') {
      const reason = Object.values(planned.budget.steps).find(step => step.status === 'blocked')?.reason ?? 'the loop budget is reached'
      await this.pauseRun(run, `Loop ${stage.loopId} paused: ${reason}`)
      return `Paused ${stage.title}: ${reason}`
    }
    const agentSessionId = stage.agentSessionId ?? await this.openStageAgent(run, stage, this.deps.ideas.get(run.ideaId).title)
    this.deps.store.updateStage(run.id, stage.index, { status: 'running', agentSessionId, loopRunId: planned.runId, startedAt: this.now().toISOString(), turns: 0 })
    const fresh = this.deps.store.get(run.id)
    const loop = loops.get(stage.loopId!)
    await this.submitTurn(fresh, fresh.stages[stage.index]!, occurrenceBrief(this.view(fresh), fresh.stages[stage.index]!, loop, occurrence))
    this.event(run, `Scheduled task fired occurrence ${occurrence} of ${stage.recurrence!.times} for "${stage.title}": loop ${loop.id} v${loop.version}, loop run ${planned.runId}`, { stageId: stage.id, loopId: loop.id, loopRunId: planned.runId, occurrence })
    return `Fired occurrence ${occurrence} of "${stage.title}" (loop ${loop.id} v${loop.version}).`
  }

  private async finishOccurrence(run: StoredRun, stage: StoredStage, report: StageReport): Promise<void> {
    const loops = this.deps.loops(run.projectId)
    const occurrence = stage.occurrences + 1
    const finishedAt = this.now().toISOString(), startedAt = stage.startedAt ?? finishedAt
    const outcomes: string[] = []
    if (loops && stage.loopId && stage.loopRunId) {
      const loop = loops.get(stage.loopId)
      for (const step of loop.steps) {
        const reported = report.loop?.steps.find(entry => entry.id === step.id)
        const outcome = reported?.outcome ?? 'not-reported'
        outcomes.push(`${step.id} ${outcome}`)
        try { loops.record({ runId: stage.loopRunId, stepId: step.id, model: step.model ?? step.action ?? 'unknown', startedAt, finishedAt, outcome, ...(reported?.note ? { note: reported.note } : {}) }) } catch (error) { this.deps.log?.('Idea run: loop step record failed', error) }
      }
      this.event(run, `Loop ${loop.id} v${loop.version} occurrence ${occurrence} recorded: ${outcomes.join(', ')}`, { stageId: stage.id, loopId: loop.id, loopRunId: stage.loopRunId })
      const adjust = report.loop?.adjust
      if (adjust) {
        try {
          const current = readFileSync(join(loops.root, loop.path), 'utf8')
          const proposal = loops.propose({ id: loop.id, change: adjustLoopFile(current, adjust.stepId, adjust), evidence: `Idea run ${run.id}, occurrence ${occurrence}: ${adjust.reason}` })
          try {
            const applied = loops.apply(proposal.id, false, 'agent')
            this.event(run, `Loop ${loop.id} advanced to v${applied.appliedVersion}: step ${adjust.stepId}${adjust.model ? ` now uses ${adjust.model}` : ''}${adjust.effort ? ` at ${adjust.effort} effort` : ''} (${adjust.reason})`, { loopId: loop.id, proposalId: proposal.id, version: applied.appliedVersion })
          } catch (error) {
            this.event(run, `Loop ${loop.id} change proposed and waiting for you in Logic loops: ${message(error)}`, { loopId: loop.id, proposalId: proposal.id })
          }
        } catch (error) { this.event(run, `Loop ${loop.id} change could not be proposed: ${message(error)}`, { loopId: loop.id }) }
      }
    }
    const times = stage.recurrence?.times ?? 1
    if (occurrence >= times) {
      this.deps.store.updateStage(run.id, stage.index, { occurrences: occurrence, loopRunId: null })
      this.finishStage(run, this.deps.store.get(run.id).stages[stage.index]!, `${occurrence} of ${times} occurrences done. ${report.summary}`)
      return
    }
    const nextDueAt = new Date(this.now().getTime() + (stage.recurrence?.everyMinutes ?? 1440) * 60_000).toISOString()
    this.deps.store.updateStage(run.id, stage.index, { status: 'recurring', occurrences: occurrence, loopRunId: null, awaitSequence: null, nextDueAt, summary: report.summary })
    this.event(run, `Occurrence ${occurrence} of ${times} of "${stage.title}" done; the next is due ${nextDueAt}. ${report.summary}`, { stageId: stage.id, nextDueAt })
  }
}
