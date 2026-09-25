import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IDEA_RUNS_IPC } from '../../shared/idea-runs'
import type { IdeaActor } from '../../shared/ideas'
import type { AgentSpec } from '../../shared/models'
import type { PhoneNotification } from '../../shared/phone-access'
import type { AgentControl } from '../agent-control'
import type { ConductorDatabase } from '../database'
import type { IdeasService } from '../ideas/service'
import { LogicLoops, type UsageReportForBudget } from '../logic-loops'
import { registerPhoneApiRoute } from '../phone-access-server'
import type { ScheduleStore } from '../schedule-store'
import { registerScheduleKindExecutor } from '../schedule-wiring'
import { ideaRunMethods, ideaRunSignatures, ideaRunsCall, type IdeaRunsControlCaller } from './control'
import { IdeaRunController, type AgentTurnView, type IdeaRunNotification } from './controller'
import { chooseModel, type CatalogEntry } from './models'
import { ideaRunsPhoneRoute } from './phone'
import { IdeaRunStore } from './store'

export interface IdeaRunsRegistrationDeps {
  databasePath: string
  database: ConductorDatabase
  control: AgentControl
  ideas: IdeasService
  schedules: ScheduleStore
  usage(): UsageReportForBudget[]
  /** Delivers a phone notification (PhoneAccessService.announce); resolves to what happened. */
  phone(notification: PhoneNotification): Promise<string>
  publish(channel: string, payload: unknown): void
  /** A test launch talks to the offline fixture agents, which answer marked prompts only. */
  offline: boolean
  tickMs?: number
}

/** What agent-control needs to serve ideas.run* (docs/idea-autopilot.md). */
export interface IdeaRunsControl {
  signatures: Record<string, string>
  methods: ReadonlySet<string>
  call(caller: IdeaRunsControlCaller, method: string, args: unknown): Promise<unknown>
}

export interface IdeaRunsRegistration {
  controller: IdeaRunController
  control: IdeaRunsControl
  registerIpc(authorize: (event: IpcMainInvokeEvent) => void): () => void
  dispose(): void
}

const OWNER: IdeaActor = { kind: 'owner', label: 'owner' }
const BOOKKEEPING = new Set(['session', 'queue', 'steering', 'input_delivery'])

/**
 * Builds the idea autopilot and plugs it into the app: its tables in conductor.db, a controller
 * that opens visible agent tabs through app control (so every stage is a normal conversation the
 * owner can watch and steer), the project's idea-run scheduled task that fires recurring stages,
 * logic loops in the run's project, the phone's /api/idea-runs, and the renderer IPC.
 */
export function registerIdeaRuns(deps: IdeaRunsRegistrationDeps): IdeaRunsRegistration {
  const { database, control } = deps
  const store = new IdeaRunStore(deps.databasePath)
  const projectOf = (agentSessionId: string): string => {
    const spec = database.structured.spec<AgentSpec>(agentSessionId)
    if (!spec) throw new Error('That conversation is no longer available')
    return spec.projectId
  }
  const view = (agentSessionId: string): AgentTurnView | null => {
    const state = database.structured.snapshot(agentSessionId)
    if (!state) return null
    return {
      sequence: state.sequence, phase: state.phase,
      answerAfter(after) {
        const texts = state.items.filter(item => item.sequence > after && item.data.type === 'text' && item.data.role === 'assistant')
        const last = texts.sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence))[0]
        return last && last.data.type === 'text' && last.data.text.trim() ? last.data.text : null
      },
      producedAfter: after => state.items.some(item => item.sequence > after && !BOOKKEEPING.has(item.data.type) && !(item.data.type === 'text' && item.data.role === 'user'))
    }
  }
  const ensureSchedule = (projectId: string, everyMinutes: number): string => {
    const existing = deps.schedules.list(projectId).find(schedule => schedule.kind === 'idea-run')
    if (existing) {
      if (existing.everyMinutes > everyMinutes) deps.schedules.update(projectId, existing.id, { everyMinutes })
      return existing.id
    }
    const created = deps.schedules.create({
      projectId, kind: 'idea-run', name: 'Idea autopilot',
      prompt: 'Fires the recurring stages of idea runs in this project (docs/idea-autopilot.md): each due stage runs its logic loop once through its agent. Pausing this task pauses every recurrence here.',
      everyMinutes, timing: 'idle', brain: false, createdBy: { kind: 'conductor', title: 'Idea autopilot' }, timeoutMs: 2 * 60_000
    })
    deps.publish('schedules:changed', projectId)
    return created.id
  }

  const controller = new IdeaRunController({
    store,
    ideas: {
      get: ideaId => deps.ideas.get(ideaId),
      event: (ideaId, message, actor, data) => deps.ideas.store.event(ideaId, 'autopilot', message, actor, data),
      link: (ideaId, input, actor) => { deps.ideas.store.link(ideaId, { ...input, createdFromIdeaId: ideaId }, actor, { workedOn: true }) }
    },
    agents: {
      async open(request) {
        const owner = control.ownerScope({ projectId: request.projectId })
        const choice = chooseModel(await control.call(owner, 'models.list', {}) as CatalogEntry[], request)
        const opened = await control.call(owner, 'tabs.open', {
          provider: request.provider, ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}), title: request.title
        }) as { id: string; resourceId?: string }
        if (!opened.resourceId) throw new Error('The agent tab did not open')
        return { agentSessionId: opened.resourceId, ...(choice.model ? { model: choice.model } : {}), ...(choice.note ? { note: choice.note } : {}) }
      },
      async submit(agentSessionId, prompt) { await control.call(control.ownerScope({ projectId: projectOf(agentSessionId) }), 'agents.submit', { agentSessionId, prompt }) },
      async interrupt(agentSessionId) { await control.call(control.ownerScope({ projectId: projectOf(agentSessionId) }), 'agents.interrupt', { agentSessionId }) },
      view
    },
    loops: projectId => {
      const project = database.getProject(projectId)
      if (!project || project.remote) return null
      const loops = new LogicLoops(project.path, projectId, database, { usage: deps.usage })
      return { root: project.path, get: id => loops.get(id), run: (id, inputs) => loops.run(id, inputs), record: input => loops.record(input), propose: input => loops.propose(input), apply: (proposalId, sovereign, by) => loops.apply(proposalId, sovereign, by) }
    },
    schedule: ensureSchedule,
    usage: deps.usage,
    notify: (notification: IdeaRunNotification) => deps.phone({
      id: randomUUID(), kind: notification.attention ? 'attention' : 'done', sessionId: null,
      title: notification.title, body: notification.body, at: new Date().toISOString(), url: '/#/idea-runs'
    }),
    promptPrefix: deps.offline ? 'SYNTHETIC IDEA-RUN ' : '',
    log: (text, error) => console.warn(text, error ?? '')
  })

  const disposers: Array<() => void> = []
  disposers.push(store.onChange(change => deps.publish(IDEA_RUNS_IPC.changed, change)))
  disposers.push(registerScheduleKindExecutor('idea-run', async context => controller.runDue(context.schedule.projectId)))
  disposers.push(registerPhoneApiRoute('/api/idea-runs', (method, path, body, _query, device) => ideaRunsPhoneRoute(controller, method, path, body, device)))
  disposers.push(controller.attach(deps.tickMs ?? (deps.offline ? 1_500 : 5_000)))

  const registerIpc = (authorize: (event: IpcMainInvokeEvent) => void): (() => void) => {
    const channels: string[] = []
    const handle = (channel: string, listener: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => { authorize(event); return listener(...args) })
      channels.push(channel)
    }
    handle(IDEA_RUNS_IPC.list, query => controller.list(query ?? {}))
    handle(IDEA_RUNS_IPC.get, runId => controller.get(String(runId)))
    handle(IDEA_RUNS_IPC.start, input => controller.start(input ?? {}, OWNER))
    handle(IDEA_RUNS_IPC.approve, runId => controller.approve(String(runId), OWNER))
    handle(IDEA_RUNS_IPC.decide, input => controller.decide(input ?? {}, OWNER))
    handle(IDEA_RUNS_IPC.pause, runId => controller.pause(String(runId), OWNER))
    handle(IDEA_RUNS_IPC.resume, runId => controller.resume(String(runId), OWNER))
    handle(IDEA_RUNS_IPC.stop, runId => controller.stop(String(runId), OWNER))
    return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
  }

  return {
    controller,
    control: { signatures: ideaRunSignatures, methods: ideaRunMethods, call: (caller, method, args) => ideaRunsCall(controller, caller, method, args) },
    registerIpc,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) { try { dispose() } catch { /* shutting down */ } }
      store.close()
    }
  }
}
