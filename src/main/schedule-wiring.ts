import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { makeId, type AgentProviderInfo, type AgentSpec, type PaneTab } from '../shared/models'
import { DEFAULT_LOCAL_MODEL } from '../shared/local-models'
import { SCHEDULE_AGENT_PROVIDERS, type ScheduleAgentOption, type ScheduleDefinition } from '../shared/schedules'
import type { AgentControlUiRequest } from '../shared/agent-control'
import type { AccountLimitsReport } from '../shared/usage-accounting'
import type { SystemMetricsSnapshot } from '../shared/system-metrics'
import type { StructuredProvider } from '../shared/structured-agent'
import type { AgentControl } from './agent-control'
import type { ConductorDatabase } from './database'
import { createLlamaServerPorts, type LocalGenerationGate } from './durable-jobs/server-lifecycle'
import { chatCompletion } from './local-models/client'
import { loadConfig, readApiKey } from './local-models/config'
import { health, stopServer } from './local-models/llama'
import { runScheduledAgentTurn } from './schedule-agent-turn'
import { LATEST_MODELS_BUILTIN } from './schedule-builtins/latest-models'
import { createLocalChurn, type LocalChurnDeps } from './schedule-churn'
import type { ScheduleControlService } from './schedule-control'
import { createScheduleExecutor } from './schedule-executor'
import { ScheduleGateProbe } from './schedule-gate'
import { scriptBrief } from './schedule-ipc'
import { ScheduleRunner } from './schedule-runner'
import { ScheduleScriptRunner } from './schedule-scripts'
import type { BuiltinSchedule, ScheduleStore } from './schedule-store'
import type { StructuredSessions } from './structured-sessions'
import { localServerTargets } from './system-metrics'

/** A frontier provider whose allowance is this far spent gets no scheduled brain request: the
 *  owner's interactive work comes first, and the local summary still reports the change. */
export const BRAIN_MAX_USED_PERCENT = 80

export function allowanceNote(report: AccountLimitsReport | undefined, maxUsedPercent = BRAIN_MAX_USED_PERCENT): string | null {
  const spent = report?.windows.filter(window => window.state === 'current' && window.usedPercent >= maxUsedPercent) ?? []
  if (!spent.length) return null
  const worst = spent.sort((a, b) => b.usedPercent - a.usedPercent)[0]!
  return `${report!.provider} ${worst.label.toLowerCase()} allowance is ${Math.round(worst.usedPercent)}% used, so the review waits for it to reset; the local summary stands in.`
}

/** The built-in "latest models and CLI compatibility" task, reviewed by Claude Opus by default. */
export const latestModelsBuiltin = (): BuiltinSchedule => ({ ...LATEST_MODELS_BUILTIN, agent: { provider: 'claude', model: 'opus[1m]' } })

export interface ScheduledTasksWiring {
  store: ScheduleStore
  userData: string
  database: ConductorDatabase
  sessions: StructuredSessions
  control: AgentControl
  ui(request: AgentControlUiRequest): Promise<unknown>
  providers(): AgentProviderInfo[]
  metrics(): Promise<SystemMetricsSnapshot>
  idleSeconds(): number | null
  screenLocked(): boolean
  deliveryRunning(): boolean
  localUpdateBuilding(): boolean
  durableJobsRunning(): number
  generationGate: LocalGenerationGate
  localTurnsInFlight(): boolean
  changed(projectId: string): void
}

function localChurnDeps(wiring: ScheduledTasksWiring): LocalChurnDeps {
  const key = (): string | null => { try { return readApiKey() } catch { return null } }
  return {
    models: () => {
      try {
        const configured = loadConfig().models
        const ids = [...new Set([DEFAULT_LOCAL_MODEL, ...Object.keys(configured)])].filter(id => configured[id])
        return ids.map(id => ({ id, label: configured[id]!.label, contextTokens: configured[id]!.contextTokens }))
      } catch { return null }
    },
    apiKey: key,
    running: () => localServerTargets().filter(server => server.running).map(server => ({ model: server.model, port: server.port })),
    healthy: async port => { const apiKey = key(); return apiKey ? (await health(port, apiKey, 4000)).ok : false },
    ensure: async modelId => {
      const ports = await createLlamaServerPorts(modelId, () => undefined)
      const ensured = await ports.ensure({ allowSwitch: false })
      return ensured.ok ? { ok: true, port: ensured.port } : { ok: false, message: ensured.message }
    },
    stop: async modelId => { const model = loadConfig().models[modelId]; if (model) await stopServer(model) },
    mayStop: () => !wiring.localTurnsInFlight() && wiring.generationGate.holder() === null,
    acquire: (holder, signal) => wiring.generationGate.acquire(holder, signal),
    complete: request => chatCompletion(request)
  }
}

/** Every script inherits the app's environment, minus Electron's own switches, plus the CLI
 *  executables Conductor resolved, so a script asks the same Claude Code and Codex the tabs use. */
function scriptEnvironment(providers: AgentProviderInfo[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.startsWith('ELECTRON_')) env[name] = value
  for (const provider of providers) if (provider.executable && (provider.id === 'claude' || provider.id === 'codex')) env[`CONDUCTOR_${provider.id.toUpperCase()}_PATH`] = provider.executable
  return env
}

export function createScheduledTasks(wiring: ScheduledTasksWiring): {
  runner: ScheduleRunner
  control: ScheduleControlService
  agents(projectId: string): Promise<ScheduleAgentOption[]>
  openConversation(projectId: string, agentSessionId: string, title: string): Promise<void>
  assignScripts(projectId: string, schedule: ScheduleDefinition): Promise<{ agentSessionId: string; tabId: string }>
} {
  const { store, database, sessions, control } = wiring
  const execute = createScheduleExecutor({
    store,
    projectPath: projectId => { const project = database.getProject(projectId); return project && !project.remote ? project.path : null },
    dataDirectory: join(wiring.userData, 'schedule-tasks'),
    artifactDirectory: join(wiring.userData, 'schedule-evidence'),
    scripts: new ScheduleScriptRunner(),
    churn: createLocalChurn(localChurnDeps(wiring)),
    agentTurn: request => runScheduledAgentTurn({ sessions, database }, request),
    allowance: provider => allowanceNote(sessions.usageLimits(provider as StructuredProvider)[0]),
    environment: () => scriptEnvironment(wiring.providers())
  })
  const probe = new ScheduleGateProbe({
    idleSeconds: wiring.idleSeconds, screenLocked: wiring.screenLocked, sample: wiring.metrics,
    conductorTurns: () => sessions.turnsInFlight(), deliveryRunning: wiring.deliveryRunning,
    localUpdateBuilding: wiring.localUpdateBuilding, durableJobsRunning: wiring.durableJobsRunning
  })
  const runner = new ScheduleRunner({ store, execute, signals: () => probe.signals(), changed: wiring.changed })
  return {
    runner,
    control: { store, runner, changed: wiring.changed },
    async agents(projectId) {
      const catalog = await control.call(control.ownerScope({ projectId }), 'models.list') as Array<{ provider: string; available: boolean; models: Array<{ id: string; label: string; effort?: string[] }> }>
      const names = new Map(wiring.providers().map(provider => [provider.id as string, provider.displayName]))
      return catalog.filter(entry => SCHEDULE_AGENT_PROVIDERS.includes(entry.provider as ScheduleAgentOption['provider'])).map(entry => ({
        provider: entry.provider as ScheduleAgentOption['provider'], label: names.get(entry.provider) ?? entry.provider, available: entry.available,
        models: entry.models.map(model => ({ id: model.id, label: model.label, ...(model.effort?.length ? { effort: model.effort } : {}) }))
      }))
    },
    async openConversation(projectId, agentSessionId, title) {
      const spec = database.structured.spec<AgentSpec>(agentSessionId)
      if (!spec || spec.projectId !== projectId) throw new Error('That conversation is no longer available')
      if (database.structured.snapshot(agentSessionId)?.archived) await sessions.archive(agentSessionId, false).catch(() => undefined)
      const workspaceId = database.listSessions(projectId).find(workspace => workspace.id === spec.sessionId)?.id ?? database.listSessions(projectId)[0]?.id
      if (!workspaceId) throw new Error('Open a workspace in this project first')
      const scope = { projectId, sessionId: workspaceId, agentSessionId: '' }
      const existing = control.tabs(scope).find(tab => tab.resourceId === agentSessionId)
      if (existing) { await wiring.ui({ ...scope, id: randomUUID(), action: 'tabs.focus', params: { tabId: existing.id } }); return }
      const tab: PaneTab = { id: makeId('tab'), kind: 'agent', resourceId: agentSessionId, title: title.slice(0, 120), state: { provider: spec.provider, model: database.structured.snapshot(agentSessionId)?.settings.model ?? spec.model, viewMode: 'visual' } }
      await wiring.ui({ ...scope, id: randomUUID(), action: 'tabs.open', params: { tab } })
    },
    async assignScripts(projectId, schedule) {
      const agent = schedule.agent!
      const owner = control.ownerScope({ projectId })
      const opened = await control.call(owner, 'tabs.open', { provider: agent.provider, model: agent.model, ...(agent.effort ? { effort: agent.effort } : {}), title: `Scripts: ${schedule.name}`.slice(0, 120) }) as { id: string; resourceId?: string }
      if (!opened.resourceId) throw new Error('The agent tab did not open')
      // Before the brief is sent, so the agent's first schedules.scripts.save is already allowed.
      store.setDelegate(projectId, schedule.id, opened.resourceId)
      await control.call(owner, 'agents.submit', { agentSessionId: opened.resourceId, prompt: scriptBrief(schedule, store.scripts(schedule.id).map(script => script.name)) })
      return { agentSessionId: opened.resourceId, tabId: opened.id }
    }
  }
}
