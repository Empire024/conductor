import { ipcMain } from 'electron'
import type { CreateScheduleInput, ScheduleAgentOption, ScheduleDefinition, ScheduleSnapshot, UpdateScheduleInput } from '../shared/schedules'
import type { ScheduleRunner } from './schedule-runner'
import type { ScheduleStore } from './schedule-store'

export const scheduleIpcChannels = ['schedules:snapshot', 'schedules:create', 'schedules:update', 'schedules:remove', 'schedules:run-now', 'schedules:open-artifact', 'schedules:open-conversation', 'schedules:assign-scripts', 'schedules:delete-script'] as const

const HISTORY_SHOWN = 20
/** The panel polls while a run is going; the provider list resolves executables, so it is reused. */
const AGENTS_TTL_MS = 60_000
const OWNER = { kind: 'owner' as const, title: 'You' }

/** The Schedules panel is the owner acting: no dialogs here (the panel confirms deletions itself),
 *  only the project check every renderer channel makes. */
export function registerScheduleIpc(options: {
  store: ScheduleStore
  runner: ScheduleRunner
  authorize(event: Electron.IpcMainInvokeEvent, projectId: string): void
  reveal(path: string): void
  agents(projectId: string): Promise<ScheduleAgentOption[]>
  openConversation(projectId: string, agentSessionId: string, title: string): Promise<void>
  /** Opens a visible tab with the task's assigned agent, briefed to write its scripts. */
  assignScripts(projectId: string, schedule: ScheduleDefinition): Promise<{ agentSessionId: string; tabId: string }>
  changed(projectId: string): void
}): () => void {
  const { store, runner } = options
  const done = <T>(projectId: string, value: T): T => { options.changed(projectId); return value }
  const agentCache = new Map<string, { at: number; value: ScheduleAgentOption[] }>()
  const agents = async (projectId: string): Promise<ScheduleAgentOption[]> => {
    const cached = agentCache.get(projectId)
    if (cached && Date.now() - cached.at < AGENTS_TTL_MS) return cached.value
    const value = await options.agents(projectId).catch(() => cached?.value ?? [])
    agentCache.set(projectId, { at: Date.now(), value })
    return value
  }
  ipcMain.handle('schedules:snapshot', async (event, projectId: string): Promise<ScheduleSnapshot> => {
    options.authorize(event, projectId)
    const schedules = store.list(projectId)
    return {
      schedules,
      runs: Object.fromEntries(schedules.map(schedule => [schedule.id, store.runs(schedule.id, HISTORY_SHOWN)])),
      scripts: Object.fromEntries(schedules.map(schedule => [schedule.id, store.scripts(schedule.id)])),
      gate: runner.lastVerdict(),
      running: runner.running(),
      agents: await agents(projectId)
    }
  })
  ipcMain.handle('schedules:create', (event, input: CreateScheduleInput) => {
    options.authorize(event, input?.projectId)
    const { projectId, name, prompt, everyMinutes, timing, urgent, agent, churnModel, brain, enabled } = input
    return done(projectId, store.create({ projectId, name, prompt, everyMinutes, timing, urgent, agent, churnModel, brain, enabled, kind: 'agent', createdBy: OWNER }))
  })
  ipcMain.handle('schedules:update', (event, projectId: string, scheduleId: string, input: UpdateScheduleInput) => {
    options.authorize(event, projectId)
    const updated = store.update(projectId, scheduleId, input)
    runner.forget(scheduleId)
    return done(projectId, updated)
  })
  ipcMain.handle('schedules:remove', (event, projectId: string, scheduleId: string) => {
    options.authorize(event, projectId)
    if (runner.running()?.scheduleId === scheduleId) throw new Error('This task is running; delete it once the run has finished')
    store.remove(projectId, scheduleId)
    done(projectId, undefined)
  })
  ipcMain.handle('schedules:run-now', (event, projectId: string, scheduleId: string) => {
    options.authorize(event, projectId); return runner.runNow(projectId, scheduleId)
  })
  ipcMain.handle('schedules:open-artifact', (event, projectId: string, runId: string) => {
    options.authorize(event, projectId)
    const run = store.runForProject(projectId, runId)
    if (!run.artifactPath) throw new Error('This run has no saved evidence')
    options.reveal(run.artifactPath)
  })
  ipcMain.handle('schedules:open-conversation', async (event, projectId: string, runId: string) => {
    options.authorize(event, projectId)
    const run = store.runForProject(projectId, runId)
    const agentSessionId = run.brain?.agentSessionId
    if (!agentSessionId) throw new Error('No agent answered this run')
    const schedule = store.list(projectId).find(candidate => candidate.id === run.scheduleId)
    await options.openConversation(projectId, agentSessionId, `Scheduled: ${schedule?.name ?? 'task'}`)
  })
  ipcMain.handle('schedules:assign-scripts', async (event, projectId: string, scheduleId: string) => {
    options.authorize(event, projectId)
    const schedule = store.get(projectId, scheduleId)
    if (!schedule.agent) throw new Error('Assign an agent to this task first')
    if (schedule.agent.provider === 'local') throw new Error('A local model cannot write scripts that run on this computer unattended. Assign a Claude, Codex or Grok agent to write them; the local model still summarizes their output')
    return done(projectId, await options.assignScripts(projectId, schedule))
  })
  ipcMain.handle('schedules:delete-script', (event, projectId: string, scheduleId: string, name: string) => {
    options.authorize(event, projectId)
    store.deleteScript(projectId, scheduleId, name)
    done(projectId, undefined)
  })
  return () => { for (const channel of scheduleIpcChannels) ipcMain.removeHandler(channel) }
}

/** The first prompt of the tab the owner hands a task's scripts to. */
export function scriptBrief(schedule: ScheduleDefinition, scripts: string[]): string {
  return [
    `The owner assigned you the scripts of the scheduled task "${schedule.name}" (taskId ${schedule.id}) in this project. You may now maintain this task through app control.`,
    `Goal:\n${schedule.prompt || '(none written yet: ask the owner what this task should watch for, then save it with schedules.update)'}`,
    `Current scripts: ${scripts.length ? scripts.join(', ') : 'none'}.`,
    [
      'Write deterministic scripts that gather the evidence this goal needs and save each with schedules.scripts.save({taskId, name, content, language, format, runWhen, description}); read tools.list for the script contract.',
      'Their stdout is digested, and a run whose scripts print the same thing as last time asks no model anything, so print a compact, stable summary: no timestamps, durations or random ordering.',
      'Put expensive checks (tests, builds) in runWhen "changed" scripts so they only run after something moved. Run each script once yourself before saving it.',
      `When they are saved, start one run with schedules.runNow({taskId:"${schedule.id}"}), read its result with schedules.get, and tell the owner in a few lines what the task now checks.`
    ].join(' ')
  ].join('\n\n')
}
