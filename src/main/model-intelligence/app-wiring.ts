import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProviderInfo } from '../../shared/models'
import { localStopOf } from '../../shared/local-stop'
import type { AgentEvent, TimelineItem } from '../../shared/structured-agent'
import type { HandoffPort, StageResultInput } from '../durable-jobs/ports'
import type { LocalModelRunner } from '../local-assist/contract'
import type { LocalModelConfig } from '../local-models/config'
import type { ThresholdSettings } from './decision-service'
import { cloudRunPort, dockerCommandPort, hostCommandPort, localRunPort, type CloudTurn } from './evaluation-ports'
import { bundledSuites, createModelIntelligence, type ModelIntelligence } from './index'
import type { ConfiguredLocalModel } from './ingest/configured'
import type { LatestModelsOutputs } from './ingest/latest-models'
import { fileCache } from './ingest/openrouter'
import type { ModelsListEntry } from './ingest/runtime'

/**
 * The app's side of model intelligence (src/main/index.ts calls this once, in the background):
 * real sources, the local-assist runner for the local decider and for local evaluations, the
 * docker sandbox for command graders, and the observers index.ts registers. Each piece degrades
 * to "not available" on its own; nothing here can hold up startup.
 */

export interface ModelIntelligenceAppDeps {
  dbPath: string
  userData: string
  settings: ThresholdSettings
  providers(): AgentProviderInfo[]
  /** loadConfig().models, or null when the local stack is not set up. */
  localModels(): LocalModelConfig[] | null
  /** resourceRequirements(model).vramBytes, or null without a reviewed envelope. */
  vramBytes(model: LocalModelConfig): number | null
  /** loadConfig().sandbox.image, or null. */
  sandboxImage(): string | null
  /** docker present and the sandbox image built (local-models/sandbox.ts). */
  sandboxReady(image: string): Promise<boolean>
  runtimeCatalog(): ModelsListEntry[]
  latestModelsOutputs(): LatestModelsOutputs
  runningLocalModels(): string[]
  /** OpenRouter is fetched only when true (never in test profiles or offline runs). */
  network: boolean
  /** A createLocalModelRunner preferring one model, for local evaluations of that model. */
  runner(preferred: string): Promise<LocalModelRunner>
  /** The local-assist runner (local-assist/wiring.ts), shared by the local decider; null without local assist. */
  localRunner: LocalModelRunner | null
  /** One evaluation turn on a cloud model through the native provider path (AgentControl.evaluationTurn). */
  cloudTurn?: CloudTurn
  /** A provider's current weekly usage percent, null when unknown. */
  weeklyUsage(provider: string): number | null
}

/** Public benchmark scores the owner keeps beside the app (ingest/benchmarks.ts format); none are
 *  shipped, so without this file benchmarks contribute nothing and the source stays quiet. */
export const BENCHMARKS_FILE = ['model-intelligence', 'benchmarks.json'] as const
const NO_BENCHMARKS = JSON.stringify({ source: { name: 'none' }, observedAt: '1970-01-01T00:00:00Z', results: [] })

export async function startModelIntelligence(deps: ModelIntelligenceAppDeps): Promise<ModelIntelligence> {
  const runners = new Map<string, Promise<LocalModelRunner>>()
  let hostCommand: ReturnType<typeof hostCommandPort> | undefined
  const runnerFor = (model: string): Promise<LocalModelRunner> => { if (!runners.has(model)) runners.set(model, deps.runner(model)); return runners.get(model)! }
  const run = localRunPort(model => ({ ask: async request => (await runnerFor(model)).ask(request) }))
  const service = createModelIntelligence({
    dbPath: deps.dbPath, settings: deps.settings, localRunner: deps.localRunner,
    // The decider only uses a server that is already up; the shadow never loads a model (D6).
    localServerRunning: () => deps.runningLocalModels().length > 0,
    sources: {
      configured: { catalogs: () => ({ providers: deps.providers(), localModels: localFacts(deps) }) },
      runtime: { modelsList: () => deps.runtimeCatalog() },
      latestModels: { outputs: () => deps.latestModelsOutputs() },
      benchmarks: { read: () => { const file = join(deps.userData, ...BENCHMARKS_FILE); return existsSync(file) ? readFileSync(file, 'utf8') : NO_BENCHMARKS } },
      ...(deps.network ? { openrouter: { cache: fileCache(join(deps.userData, 'model-intelligence', 'openrouter-models.json')) } } : {})
    },
    evaluation: {
      runLocal: run,
      ...(deps.cloudTurn ? { runCloud: cloudRunPort(deps.cloudTurn) } : {}),
      usage: provider => deps.weeklyUsage(provider),
      // The docker sandbox where it is built, else a confined host node check (probed once per app run).
      command: async () => { const image = deps.sandboxImage(); return image && await deps.sandboxReady(image) ? dockerCommandPort(image) : await (hostCommand ??= hostCommandPort().catch(() => null)) },
      precheck: key => { const other = deps.runningLocalModels().filter(model => model !== key.model); return other.length ? `${other.join(', ')} holds the GPU; stop it with local.stop first, or evaluate that model` : null },
      writeReport: (name, markdown) => { const folder = join(deps.userData, 'model-evaluations'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, name), markdown, 'utf8') },
      readReport: runId => evaluationReport(join(deps.userData, 'model-evaluations'), runId),
      suites: bundledSuites
    }
  })
  service.start()
  return service
}

/** A run's report in the evaluation reports folder: the one file named <date>-<key>-<runId>.md. */
export function evaluationReport(folder: string, runId: string): string | null {
  if (!existsSync(folder)) return null
  const name = readdirSync(folder).find(file => file.endsWith(`-${runId}.md`))
  return name ? readFileSync(join(folder, name), 'utf8') : null
}

function localFacts(deps: ModelIntelligenceAppDeps): ConfiguredLocalModel[] | null {
  const models = deps.localModels()
  return models && models.map(model => { let vramBytes: number | null = null; try { vramBytes = deps.vramBytes(model) } catch { /* no reviewed envelope */ } return { ...model, vramBytes } })
}

/** The agent-manager broadcast observer: a settled session phase of a dispatched agent, and the stop
 *  report of any local agent turn, are captured on the next tick from the projection the store already
 *  keeps in memory. */
export function turnObserver(service: () => ModelIntelligence | undefined, snapshot: (id: string) => { items: TimelineItem[]; settings?: { model?: string } } | null | undefined): (channel: string, payload: unknown) => void {
  return (channel, payload) => {
    const current = service()
    if (!current || channel !== 'structured:events' || !Array.isArray(payload)) return
    for (const event of payload as AgentEvent[]) {
      const report = event?.data ? localStopOf(event.data) : undefined
      if (report && event.turnId && event.provider === 'local') {
        const stopped = { agentSessionId: event.sessionId, turnId: event.turnId, runtimeId: event.runtimeId, projectId: event.projectId, report }
        setImmediate(() => { current.localTurnStopped(stopped, () => snapshot(event.sessionId)) })
        continue
      }
      if (event?.data?.type !== 'session' || !['completed', 'failed', 'interrupted'].includes(event.data.phase) || !current.binding(event.sessionId)) continue
      const { phase, limitResumeAt } = event.data
      setImmediate(() => { current.turnSettled({ agentSessionId: event.sessionId, runtimeId: event.runtimeId, ...(event.turnId ? { turnId: event.turnId } : {}), phase, limited: typeof limitResumeAt === 'string' }, () => snapshot(event.sessionId)) })
    }
  }
}

/** The durable-jobs handoff port with stage capture after afterStage; the job controller sees the
 *  same decision, and capture runs after it on its own, never failing the stage. */
export function withStageCapture<T extends { handoff: HandoffPort }>(ports: T, settled: (input: StageResultInput) => void): T {
  const handoff = ports.handoff
  return {
    ...ports,
    handoff: {
      stagePrompt: input => handoff.stagePrompt(input),
      afterStage: input => {
        const decision = handoff.afterStage(input)
        queueMicrotask(() => { try { settled(input) } catch (error) { console.warn('[model-intelligence] stage capture failed', error) } })
        return decision
      }
    }
  }
}

/** Calls `ran` when the latest-models scripts produced newer output than last seen: the schedule's
 *  change notice fires for many reasons, and only a finished run is new evidence. */
export function latestModelsWatcher(read: () => LatestModelsOutputs, ran: () => void): () => void {
  const newest = (): string => { const outputs = read(); return [outputs.cliCatalogs?.at ?? '', outputs.primarySources?.at ?? ''].sort().at(-1)! }
  let seen = newest()
  return () => {
    try { const at = newest(); if (at > seen) { seen = at; ran() } } catch (error) { console.warn('[model-intelligence] latest-models output unreadable', error) }
  }
}

/** docs/machine-profile.md: MAIN's RTX 5070 has 12 GB. Used when nvidia-smi cannot be read. */
export const MACHINE_PROFILE_VRAM_GB = 12
let measuredVram: number | null | undefined
/** The card's total VRAM in GB (nvidia-smi memory.total, read once), for routing's fits-VRAM filter. */
export function vramTotalGb(read: () => string = () => execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })): number {
  if (measuredVram === undefined) {
    try {
      const rows = read().split(/\r?\n/).map(line => Number(line.trim())).filter(value => Number.isFinite(value) && value > 0)
      measuredVram = rows.length === 1 ? Math.round(rows[0]! / 1024 * 10) / 10 : null
    } catch { measuredVram = null }
  }
  return measuredVram ?? MACHINE_PROFILE_VRAM_GB
}
export const resetVramForTests = (): void => { measuredVram = undefined }

/** The newest full outputs of the latest-models schedule's scripts, from the scheduler's own source
 *  state (the whole normalized stdout), never the 4000-character tail kept on the run. */
export function latestModelsFromSchedules(schedules: { all(): Array<{ id: string; kind: string }>; source(scheduleId: string, sourceId: string): { normalized: string; fetchedAt: string } | null }): LatestModelsOutputs {
  const read = (id: string, name: string) => { const state = schedules.source(id, `script:${name}`); return state ? { stdout: state.normalized, at: state.fetchedAt } : null }
  let best: LatestModelsOutputs = { cliCatalogs: null, primarySources: null }, newest = ''
  for (const schedule of schedules.all()) {
    if (schedule.kind !== 'latest-models-methods') continue
    const outputs = { cliCatalogs: read(schedule.id, 'cli-catalogs'), primarySources: read(schedule.id, 'primary-sources') }
    const at = [outputs.cliCatalogs?.at ?? '', outputs.primarySources?.at ?? ''].sort().at(-1)!
    if (at > newest) { newest = at; best = outputs }
  }
  return best
}
