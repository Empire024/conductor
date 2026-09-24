import type { DurableJob, DurableJobReport, DurableJobStage } from '../../shared/durable-jobs'
import type { SessionProjection } from '../../shared/structured-agent'
import { buildStagePrompt, extractHandoff, modelWindow, shouldRollover, stageKind, stageTooling, usageFromStopReport, visibleContent, type ModelWindowSource } from './handoff'
import { LoopGuard, type LoopGuardSnapshot } from './loop-guard'
import { JOB_STATUS_CONTINUE, JOB_STATUS_DONE, type HandoffPort, type LoopGuardPort, type ReportPort, type ServerContext, type ServerLifecyclePort, type StageRuntime, type WatchdogPort } from './ports'
import { buildDurableJobReport, parseTestResult, writeDurableJobReport } from './report'
import { ServerSupervisor, type LocalGenerationGate, type ServerLifecyclePorts } from './server-lifecycle'
import type { DurableJobStore } from './store'
import { localModelId } from './structured-runtime'
import { Watchdog, type DurableJobEventDraft, type HealthProbe, type WatchdogOptions } from './watchdog'

/**
 * Plugs the handoff (handoff.ts), server lifecycle, watchdog and loop guard (server-lifecycle.ts,
 * watchdog.ts, loop-guard.ts) and report (report.ts) modules into the controller's ports
 * (ports.ts). The controller runs each stage attempt as one structured local conversation, so the
 * per-call hooks those modules offer are driven from the outside here: the watchdog and the loop
 * guard read the stage conversation's durable projection on every tick (new events are token
 * progress, finished tool items are observed calls), and the generation gate is taken per stage.
 *
 * Ports never change job state; they append events under the job's lease epoch (a superseded
 * epoch drops the event) and return decisions the controller persists.
 */

export interface DurableJobsWiringOptions {
  store: DurableJobStore
  /** The stage conversation's projection (database.structured.snapshot). */
  snapshot(agentSessionId: string): SessionProjection | null
  /** The live model's window, by bare model id; null when it is not configured. */
  modelConfig(modelId: string): ModelWindowSource | null
  /** Health of the job model's server: llama.cpp /health plus /slots is_processing. */
  probeHealth(modelId: string): Promise<HealthProbe>
  /** Ports over the real llama-server for one model (server-lifecycle.ts createLlamaServerPorts). */
  serverPorts(modelId: string, emit: (event: DurableJobEventDraft) => void): Promise<ServerLifecyclePorts>
  /** Set when a test endpoint stands in for llama-server: no server is supervised. */
  endpointOverride(): string | null
  gate: LocalGenerationGate
  now?: () => number
  watchdog?: Partial<WatchdogOptions>
}

const clip = (text: string, max: number): string => { const flat = text.trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }
const FALLBACK_WINDOW = 32_768

/** Appends an event for the job under the epoch the port was called with; a superseded epoch
 *  (the owner paused, cancelled or a restart took over) silently drops it. */
function eventSink(store: DurableJobStore, context: ServerContext | undefined) {
  return (draft: DurableJobEventDraft): void => {
    if (!context) return
    try { store.event(context.jobId, { epoch: context.epoch }, draft.kind, draft.message, draft.data) } catch { /* superseded */ }
  }
}

export function windowFor(options: Pick<DurableJobsWiringOptions, 'modelConfig'>, model: string): ModelWindowSource {
  const id = localModelId(model)
  return options.modelConfig(id) ?? { id, contextTokens: FALLBACK_WINDOW }
}

// --- Handoff ---------------------------------------------------------------------------------

const statusLine = new RegExp(`^.*(${JOB_STATUS_DONE}|${JOB_STATUS_CONTINUE}).*$`, 'gim')

export function handoffPort(options: Pick<DurableJobsWiringOptions, 'modelConfig'>): HandoffPort {
  return {
    stagePrompt({ job, stage, handoff, retryOf }) {
      const model = windowFor(options, job.model.model)
      const tooling = stageTooling(stage.kind ?? stageKind(stage), job.cwd)
      const built = buildStagePrompt(job, stage, handoff, model, { ...(job.budgets.stagePromptBudgetTokens ? { budgetTokens: job.budgets.stagePromptBudgetTokens } : {}), systemPrompt: tooling.systemPrompt, tools: tooling.tools })
      // A stage whose fixed part does not fit a fresh context cannot run: the controller blocks
      // the job with this message (resumable once the stage is split or its inputs shrunk).
      if (!built.ok) throw built.error
      return [
        built.prompt,
        ...(retryOf ? ['', 'PREVIOUS ATTEMPT', `The previous attempt at this stage did not finish: ${clip(retryOf, 600)}`, 'Do not repeat what failed; check the current files first.'] : []),
        '', `End your final answer with one line: "${JOB_STATUS_DONE}" when the whole job objective is met, or "${JOB_STATUS_CONTINUE}: <the concrete next step>" when more work remains.`
      ].join('\n')
    },
    afterStage({ job, stage, stages, observation, succeeded }) {
      const next = stages.filter(candidate => candidate.index > stage.index && candidate.status === 'pending').sort((a, b) => a.index - b.index)[0]
      const answer = visibleContent(observation.lastAnswer).text
      const extracted = extractHandoff(job.handoff, observation.report, undefined, undefined, { stage, ...(next ? { nextStage: next } : {}), finalText: observation.lastAnswer })
      const continued = new RegExp(`${JOB_STATUS_CONTINUE}\\s*:?\\s*(.+)$`, 'im').exec(answer)?.[1]?.trim()
      const done = succeeded && answer.includes(JOB_STATUS_DONE)
      const handoff = {
        ...extracted,
        filesChanged: [...new Set([...extracted.filesChanged, ...observation.filesChanged])].slice(-200),
        ...(!succeeded && !observation.report ? { unresolvedIssues: [...extracted.unresolvedIssues, `Stage ${stage.index + 1} "${clip(stage.title, 120)}": ${clip(observation.lastError ?? 'the attempt ended without a stop report', 240)}`].slice(-40) } : {}),
        ...(succeeded && continued && !next ? { nextAction: clip(continued, 600) } : {})
      }
      const before = new Set(job.handoff.testResults)
      const tests: DurableJobReport['tests'] = handoff.testResults.filter(entry => !before.has(entry)).map(entry => {
        const match = /^(pass|fail)(?: \(exit (-?\d+)\))?: (.+)$/.exec(entry)
        return match ? { command: match[3]!, outcome: match[1] as 'pass' | 'fail', ...(match[2] ? { detail: `exit ${match[2]}` } : {}) } : parseTestResult(entry)
      })
      const rollover = observation.report ? shouldRollover(usageFromStopReport(observation.report), modelWindow(windowFor(options, job.model.model)), job.budgets) : undefined
      return {
        handoff, tests,
        result: clip(answer.replace(statusLine, '').trim(), 1_200),
        jobDone: done,
        contextRollover: Boolean(rollover?.rollover),
        nextStage: succeeded && continued && !done && !next ? { title: `Stage ${stages.length + 1}`, objective: clip(continued, 8_000), completionCriteria: [] } : undefined
      }
    }
  }
}

// --- Watchdog and loop guard -----------------------------------------------------------------

/** Tool output that says the runtime refused something only the owner can allow. */
const PERMISSION_REFUSAL = /\b(refus(?:ed|ing)|not permitted|permission denied|requires? (?:the owner'?s? )?(?:approval|permission)|not allowed|outside the workspace|no network access)\b/i

interface StageGuards {
  loop: LoopGuard
  /** Set when the live guard gave up on the stage: the loop port reports it after the attempt. */
  verdict?: { detail: string; kind: 'loop' | 'approval' }
}

/**
 * The watchdog and the loop guard share per-stage state: the watch feeds the stage's tool calls to
 * a LoopGuard as they finish, and the loop port reads its verdict when the controller assesses a
 * failed attempt. A replan interrupts the attempt with the guard's instruction (the controller's
 * retry prompt carries it); a second loop, or repeated refusals, block the job.
 */
export function supervisionPorts(options: DurableJobsWiringOptions): { watchdog: WatchdogPort; loopGuard: LoopGuardPort } {
  const now = options.now ?? (() => Date.now())
  const guards = new Map<string, StageGuards>()
  /** The loop guard's replan count survives a restart through its loop-detected events. */
  const restore = (job: DurableJob, stage: DurableJobStage): LoopGuardSnapshot | undefined => {
    const replans = options.store.matchingEvents(job.id, { kind: 'loop-detected', stageId: stage.id, dataType: { replan: 'number' } }).length
    return replans ? { stageId: stage.id, replans, lastProgressAt: now() } : undefined
  }
  const guardFor = (job: DurableJob, stage: DurableJobStage): StageGuards => {
    let entry = guards.get(stage.id)
    if (!entry) guards.set(stage.id, entry = { loop: new LoopGuard(stage.id, now, {}, restore(job, stage)) })
    return entry
  }

  const watchdog: WatchdogPort = {
    watch({ job, stage, agentSessionId }, onStuck) {
      const context = job.lease ? { jobId: job.id, epoch: job.lease.epoch } : undefined
      const emit = eventSink(options.store, context)
      const guard = guardFor(job, stage)
      guard.verdict = undefined
      const dog = new Watchdog(job.budgets, { now, probeHealth: () => options.endpointOverride() ? Promise.resolve({ healthy: true }) : options.probeHealth(localModelId(job.model.model)), emit }, options.watchdog)
      // One model-call watch while the model works: a finished tool round starts the next call's
      // budget. A running tool is not model work: it gets a tool-call watch on toolCallTimeoutMs
      // instead, where silence is not a stall (a test suite or a build may print nothing).
      let call: string | null = dog.begin('model-call', `stage ${stage.index + 1} round 1`, `${stage.id}:call`)
      let rounds = 1, lastSequence = options.snapshot(agentSessionId)?.sequence ?? 0, stopped = false
      const seen = new Set<string>()
      const tools = new Map<string, string>()
      const toolStarted = (itemId: string, name: string): void => {
        if (tools.has(itemId)) return
        if (call) { dog.end(call); call = null }
        tools.set(itemId, dog.begin('tool-call', name, `${stage.id}:tool:${name}`))
      }
      const toolFinished = (itemId: string): void => {
        const watch = tools.get(itemId)
        if (watch) { dog.end(watch); tools.delete(itemId) }
        if (tools.size) return
        if (call) dog.end(call)
        call = dog.begin('model-call', `stage ${stage.index + 1} round ${++rounds}`, `${stage.id}:call`)
      }
      // After the attempt settled (dispose), a verdict is still recorded but nothing is interrupted.
      let settled = false
      const stop = (reason: string): void => { if (!stopped) { stopped = true; if (!settled) onStuck(reason) } }
      const giveUp = (detail: string, kind: 'loop' | 'approval'): void => { guard.verdict = { detail, kind }; stop(kind === 'approval' ? `needs the owner: ${detail}` : `loop: ${detail}`) }
      const refusals = new Map<string, number>()

      /** Feeds the conversation's finished tool calls to the loop guard; true when the stage must stop. */
      const scan = (): boolean => {
        const state = options.snapshot(agentSessionId)
        if (state && state.sequence > lastSequence) { if (call) dog.signal(call, { kind: 'tokens', count: state.sequence - lastSequence }); lastSequence = state.sequence }
        for (const item of state?.items ?? []) {
          const data = item.data
          if (data.type === 'changes') { if (!seen.has(item.id)) { seen.add(item.id); for (const change of data.changes) guard.loop.observeProgress({ kind: 'file-diff', path: change.path }) } continue }
          if (data.type !== 'tool' || seen.has(item.id)) continue
          if (data.status === 'preparing' || data.status === 'running') { toolStarted(item.id, data.name); continue }
          if (data.status === 'awaiting_approval') continue
          seen.add(item.id)
          toolFinished(item.id)
          if (data.status !== 'completed' && data.status !== 'failed') continue
          const input = data.input && typeof data.input === 'object' && !Array.isArray(data.input) ? data.input as Record<string, unknown> : {}
          const output = String(data.output ?? '')
          const failed = data.status === 'failed'
          if (failed && PERMISSION_REFUSAL.test(output)) {
            const key = `${data.name}|${JSON.stringify(input)}`
            const count = (refusals.get(key) ?? 0) + 1
            refusals.set(key, count)
            if (count >= 2) { giveUp(`${data.name} was refused ${count} times: ${clip(output.split('\n').find(line => PERMISSION_REFUSAL.test(line)) ?? output, 240)}`, 'approval'); return true }
          }
          if (!failed && ['write_file', 'edit_file', 'apply_edits'].includes(data.name)) guard.loop.observeProgress({ kind: 'file-diff', path: String(input.path ?? input.file ?? '') })
          const verdict = guard.loop.observeToolCall({ name: data.name, arguments: input, output, failed })
          if (verdict.action === 'replan') { emit(verdict.event); stop(`loop guard replan: ${verdict.instruction}`); return true }
          if (verdict.action === 'block') { emit(verdict.event); giveUp(verdict.reason, 'loop'); return true }
        }
        return false
      }

      const tick = async (): Promise<void> => {
        if (stopped || scan()) return
        const idle = guard.loop.checkStage()
        if (idle.action === 'replan') { emit(idle.event); stop(`loop guard replan: ${idle.instruction}`); return }
        if (idle.action === 'block') { emit(idle.event); giveUp(idle.reason, 'loop'); return }
        for (const decision of await dog.tick()) {
          if (decision.action !== 'interrupt') continue
          const budget = Math.round(Number(decision.diagnostics.deadlineMs) / 1000)
          stop(decision.reason === 'server-unhealthy' ? `the local model server stopped answering (${String(decision.diagnostics.health ?? 'unhealthy')})` : decision.reason === 'stalled' ? `no progress for ${Math.round(Number(decision.diagnostics.sinceProgressMs) / 1000)}s and the server is not processing` : decision.scope === 'tool-call' ? `the tool call ${decision.label} ran past its ${budget}s tool-call budget` : `a model call ran past its ${budget}s budget`)
          return
        }
      }
      let running = false
      const timer = setInterval(() => { if (running) return; running = true; void tick().catch(error => console.warn('Durable job watchdog tick failed', error)).finally(() => { running = false }) }, options.watchdog?.tickMs ?? 15_000)
      timer.unref?.()
      return {
        dispose() {
          clearInterval(timer)
          if (call) dog.end(call, false)
          for (const watch of tools.values()) dog.end(watch, false)
          // Calls the last tick missed still count toward the loop port's verdict.
          settled = true
          if (!stopped) scan()
          stopped = true
        }
      }
    }
  }

  const loopGuard: LoopGuardPort = {
    assess({ stage, error, previousErrors }) {
      const verdict = guards.get(stage.id)?.verdict
      if (verdict) { guards.get(stage.id)!.verdict = undefined; return { loop: true, detail: verdict.detail, kind: verdict.kind } }
      // Across attempts: the same failure three attempts running is a loop, as before.
      if (error && previousErrors.length >= 2 && previousErrors.slice(-2).every(previous => previous === error)) return { loop: true, detail: `The same failure repeated on three attempts: ${clip(error, 300)}` }
      return { loop: false }
    }
  }
  return { watchdog, loopGuard }
}

// --- Server lifecycle ------------------------------------------------------------------------

/** One ServerSupervisor per model; its events go to whichever job asked last. */
export function serverPort(options: Pick<DurableJobsWiringOptions, 'store' | 'serverPorts' | 'endpointOverride'>): ServerLifecyclePort {
  const supervisors = new Map<string, { supervisor: Promise<ServerSupervisor>; context?: ServerContext }>()
  const supervisorFor = (model: string, context?: ServerContext): Promise<ServerSupervisor> => {
    const id = localModelId(model)
    let entry = supervisors.get(id)
    if (!entry) {
      const created: { supervisor: Promise<ServerSupervisor>; context?: ServerContext } = { supervisor: Promise.resolve(null as never) }
      created.supervisor = options.serverPorts(id, draft => eventSink(options.store, created.context)(draft)).then(ports => new ServerSupervisor(id, ports))
      created.supervisor.catch(() => supervisors.delete(id))
      supervisors.set(id, entry = created)
    }
    entry.context = context
    return entry.supervisor
  }
  return {
    async ensureReady(model, context) {
      if (options.endpointOverride()) return { ready: true }
      const readiness = await (await supervisorFor(model, context)).ensureReady()
      // The supervisor already waited and backed off; its block is final for this attempt.
      return readiness.ok ? { ready: true } : { ready: false, reason: `${readiness.blocked.reason} Next: ${readiness.blocked.nextAction}`, retryable: false }
    },
    async recover(model, _reason, context) {
      if (options.endpointOverride()) return false
      const readiness = await (await supervisorFor(model, context)).ensureReady()
      return readiness.ok && readiness.restarted
    }
  }
}

// --- Report ----------------------------------------------------------------------------------

export const reportPort: ReportPort = {
  async write({ job, stages, events, checkpoints, now }) {
    const withStages = { ...job, stages }
    return writeDurableJobReport(buildDurableJobReport({ job: withStages, events, checkpoints, now: now.getTime() }), withStages)
  }
}

export function durableJobPorts(options: DurableJobsWiringOptions): { handoff: HandoffPort; watchdog: WatchdogPort; loopGuard: LoopGuardPort; server: ServerLifecyclePort; report: ReportPort } {
  return { handoff: handoffPort(options), ...supervisionPorts(options), server: serverPort(options), report: reportPort }
}

// --- Generation gate -------------------------------------------------------------------------

const SETTLED = new Set<string>(['completed', 'failed', 'interrupted', 'disconnected', 'missing'])
const ACTIVE_PHASES = new Set<string>(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
const WAITING_ON_OWNER = new Set<string>(['waiting_approval', 'waiting_input'])

/**
 * Takes the process-wide LocalGenerationGate for each stage attempt: a stage does not start while
 * an interactive local turn is in flight (llama-server runs one slot), and an interactive turn
 * that starts while a job holds the gate is noted as demand. A running stage is not cut short:
 * the one-slot server serves requests in order, so an interactive turn waits at most for the
 * job's current request, which modelCallTimeoutMs bounds.
 *
 * A conversation waiting on the owner (an approval or a question) generates nothing, and the
 * controller blocks its job and stops observing it, so the gate is released as soon as that wait
 * is observed: another job runs meanwhile. The attempt stays parked, with the baseline of its
 * original submit. The owner's answer in the tab continues the same conversation; the job's
 * resume re-attaches through `reattach`, which takes the gate again (behind whichever job holds
 * it) before the controller watches the attempt, and never resubmits the prompt.
 */
export function gatedRuntime(runtime: StageRuntime, gate: LocalGenerationGate, onTurnStart?: (listener: () => void) => () => void): StageRuntime & { reattach(id: string): Promise<void>; dispose(): void } {
  /** Attempts this runtime submitted; `release` is absent while the attempt is parked on the owner. */
  const held = new Map<string, { release?: () => void; baseline: number }>()
  const jobs = new Map<string, string>()
  /** Interrupts per conversation, so a re-attach that was waiting for the gate sees one. */
  const interrupts = new Map<string, number>()
  let submitting = 0
  const unsubscribe = onTurnStart?.(() => { if (!submitting && gate.holder() !== null) gate.noteInteractiveDemand() })
  const release = (id: string): void => { held.get(id)?.release?.(); held.delete(id) }
  const park = (id: string): void => { const entry = held.get(id); if (entry?.release) { entry.release(); delete entry.release } }
  return {
    async open(request) {
      const opened = await runtime.open(request)
      jobs.set(opened.agentSessionId, request.job.id)
      return opened
    },
    async submit(id, prompt) {
      const lease = await gate.acquire(jobs.get(id) ?? id)
      held.set(id, { release: lease.release, baseline: runtime.observe(id).stopSequence })
      submitting++
      try { await runtime.submit(id, prompt) } catch (error) { release(id); throw error } finally { submitting-- }
    },
    async reattach(id) {
      const observation = runtime.observe(id)
      // Still waiting on the owner (the controller blocks again at once) or already stopped:
      // nothing will generate, so the gate is not taken.
      if (!ACTIVE_PHASES.has(observation.phase) || WAITING_ON_OWNER.has(observation.phase)) return
      const entry = held.get(id)
      if (entry?.release) return
      // Queue behind the holder only: this generation is already under way, and a local
      // conversation's own turn would otherwise count as the interactive work to yield to.
      const before = interrupts.get(id) ?? 0
      const lease = await gate.acquire(jobs.get(id) ?? id, undefined, { yieldToInteractive: false })
      if ((interrupts.get(id) ?? 0) !== before) { lease.release(); return }
      held.set(id, { release: lease.release, baseline: entry?.baseline ?? observation.stopSequence })
    },
    observe(id) {
      const observation = runtime.observe(id)
      const entry = held.get(id)
      if (entry && SETTLED.has(observation.phase) && (observation.stopSequence > entry.baseline || observation.phase === 'missing')) release(id)
      else if (entry && WAITING_ON_OWNER.has(observation.phase)) park(id)
      return observation
    },
    async interrupt(id) {
      interrupts.set(id, (interrupts.get(id) ?? 0) + 1)
      try { await runtime.interrupt(id) } finally { release(id) }
    },
    dispose() { unsubscribe?.(); for (const id of [...held.keys()]) release(id) }
  }
}
