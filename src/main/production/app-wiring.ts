import { watch } from 'node:fs'
import { join, sep } from 'node:path'
import { PRODUCTION_SCHEDULE_KIND, type DriftSettings } from '../../shared/production'
import type { ModelKey, RouteConstraints, TaskFeatures } from '../../shared/model-routing'
import type { OrchestrationStore } from '../orchestration-store'
import type { ScheduleStore } from '../schedule-store'
import type { LocalModelRunner } from '../local-assist/contract'
import { productionDriftExecutor } from './drift'
import { createProductionService, type ProductionDeps, type ProductionService } from './index'
import type { InterpreterPorts } from './interpret'
import { ProductionStore } from './store'

/**
 * Production audits in the running app (docs/production-agent.md section 2, M8): one
 * ProductionService over conductor.db with the real ports. src/main/index.ts builds it, hands it to
 * AgentControl (production.*) and the Production panel's IPC, registers the `production-drift`
 * schedule executor, and starts it a few seconds after launch like durable jobs.
 */

export interface ProductionAppDeps {
  databasePath: string
  userData: string
  orchestration: OrchestrationStore
  schedules: ScheduleStore
  projectRoot(projectId: string): string | null
  projectName(projectId: string): string
  /** Routing with the live facts of the audited project (AgentControl.routeForHost). */
  route(projectId: string, features: TaskFeatures, constraints: Partial<RouteConstraints>): Promise<{ decisionId: string | null; key: ModelKey }>
  /** One cloud evaluation turn (AgentControl.evaluationTurn, lean profile), in the audited project's workspace. */
  evaluationTurn: EvaluationTurn
  /** The process's local model runner (local assist); null when it is not running. */
  localRunner(): LocalModelRunner | null
  /** An interactive local conversation is mid-turn: the audit never starts a model server then. */
  localTurnsInFlight(): boolean
  weeklyStop(provider: string): number | null
  usagePercent(provider: string): number | null
  registerScheduleKindExecutor: typeof import('../schedule-wiring').registerScheduleKindExecutor
  schedulesChanged(projectId: string): void
  /** Offline tests: no model is asked anything (routing refuses, the local model is not used), so a
   *  parked smoke never spends a cloud allowance or takes the owner's GPU. */
  offline?: boolean
  log?(line: string): void
}

export type EvaluationTurn = (key: ModelKey, prompt: { system: string; user: string }, signal: AbortSignal, options: { maxTokens: number; scope: { projectId: string } }) => Promise<{ answer: string; tokens: number | null; costUsd: number | null; inputTokens: number | null }>

/**
 * The interpreter's cloud port over an evaluation turn. The turn's background read-only tab opens in
 * the audited project (its first workspace), not in whichever project happens to be first, so the
 * owner sees an audit's model call beside the audit.
 */
export function evaluationCloudTurn(evaluationTurn: EvaluationTurn): InterpreterPorts['cloudTurn'] {
  return async (key, prompt, signal, maxTokens, context) => {
    const turn = await evaluationTurn(key, { system: '', user: prompt }, signal, { maxTokens, scope: { projectId: context.projectId } })
    const inputTokens = turn.inputTokens ?? 0
    return { text: turn.answer, inputTokens, outputTokens: Math.max(0, (turn.tokens ?? inputTokens) - inputTokens), costUsd: turn.costUsd }
  }
}

export interface ProductionApp {
  service: ProductionService
  store: ProductionStore
  dispose(): Promise<void>
}

export function createProductionApp(deps: ProductionAppDeps): ProductionApp {
  const store = new ProductionStore(deps.databasePath)
  const log = deps.log ?? (line => console.log(`[production] ${line}`))

  const interpreter: InterpreterPorts = {
    route: async (features, constraints) => {
      if (deps.offline) throw new Error('offline test profile: no model is asked')
      return deps.route(features.projectId ?? '', features, constraints)
    },
    cloudTurn: evaluationCloudTurn(deps.evaluationTurn),
    localAsk: async request => {
      const runner = deps.offline ? null : deps.localRunner()
      if (!runner) return null
      const outcome = await runner.ask({ system: request.system, user: request.user, maxTokens: request.maxTokens, signal: request.signal, noStart: deps.localTurnsInFlight() })
      if (!outcome.ok) { log(`local model not used: ${outcome.reason}`); return null }
      return { text: outcome.answer.text, model: outcome.answer.model, inputTokens: outcome.answer.inputTokens, outputTokens: outcome.answer.outputTokens }
    },
    weeklyStop: provider => deps.weeklyStop(provider),
    usagePercent: provider => deps.usagePercent(provider),
  }

  const board: ProductionDeps['board'] = {
    createTask: input => deps.orchestration.createTask(input),
    updateTask: (id, input) => deps.orchestration.updateTask(id, input),
    task: (projectId, id) => deps.orchestration.listTasks(projectId).find(task => task.id === id) ?? null,
  }

  /** The drift schedule mirrors the profile's drift settings: created disabled, enabled only from them. */
  const ensureSchedule = (projectId: string, settings: DriftSettings): void => {
    const existing = deps.schedules.list(projectId).find(schedule => schedule.kind === PRODUCTION_SCHEDULE_KIND)
    if (!existing) {
      deps.schedules.create({
        projectId, kind: PRODUCTION_SCHEDULE_KIND, name: 'Production drift check',
        prompt: 'Recomputes the production target fingerprint (commit, build, config, policy pages, dependencies, routes) and compares it with the last completed audit (docs/production-agent.md). Unchanged: nothing happens. Changed: the results are marked stale, or a change audit re-tests the affected controls. Enable it from the Production panel.',
        everyMinutes: settings.everyMinutes, timing: 'idle', brain: false, enabled: settings.enabled, createdBy: { kind: 'conductor', title: 'Production' }, timeoutMs: 30 * 60_000,
      })
    } else if (existing.enabled !== settings.enabled || existing.everyMinutes !== settings.everyMinutes) {
      deps.schedules.update(projectId, existing.id, { enabled: settings.enabled, everyMinutes: settings.everyMinutes })
    } else return
    deps.schedulesChanged(projectId)
  }

  const service = createProductionService({
    store, userData: deps.userData, interpreter, board,
    projectRoot: deps.projectRoot, projectName: deps.projectName,
    schedules: { ensure: ensureSchedule },
    watch: (_projectId, root, onChange) => {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
          if (!name) return
          const path = String(name)
          if (path.startsWith(`node_modules${sep}`) || path.startsWith(`.git${sep}objects`) || path.startsWith(`.git${sep}logs`)) return
          onChange([join(root, path)])
        })
        watcher.on('error', error => log(`the watcher of ${root} stopped: ${String(error)}`))
        return () => watcher.close()
      } catch (error) {
        log(`${root} cannot be watched: ${String(error)}`)
        return () => undefined
      }
    },
    log,
  })

  const disposeExecutor = deps.registerScheduleKindExecutor(PRODUCTION_SCHEDULE_KIND, productionDriftExecutor(service.driftPorts))
  return {
    service, store,
    async dispose() {
      disposeExecutor()
      await service.stop().catch(error => log(`stop failed: ${String(error)}`))
      store.close()
    },
  }
}
