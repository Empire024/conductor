import { ipcMain } from 'electron'
import { CLOUD_CHANNELS as channel, type CloudRunSummary, type CloudStartInput } from '../../shared/cloud'
import type { CloudRuns } from './runs'

/**
 * The owner's window reaching cloud runs: the launcher starts one, a cloud tab shows and steers
 * it. Every invoke names its project and is authorized for it; a run of another project reads as
 * missing. Keystrokes and resizes are fire-and-forget like the other terminals'.
 */
export function registerCloudIpc(options: {
  runs: CloudRuns
  authorize(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, projectId: string): void
  /** The project's folder on this machine, or null. */
  projectPath(projectId: string): string | null
  /** Opens the run's tab in front, as the owner's own launcher choice. */
  openTab(run: CloudRunSummary): Promise<unknown>
}): () => void {
  const { runs } = options
  const path = (projectId: string): string => {
    const found = options.projectPath(projectId)
    if (!found) throw new Error('Cloud runs start from a project on this machine')
    return found
  }
  const handle = (name: string, listener: (projectId: string, ...args: any[]) => unknown): void => {
    ipcMain.handle(name, (event, projectId: string, ...args: unknown[]) => { options.authorize(event, projectId); return listener(projectId, ...args) })
  }
  const owned = (projectId: string, runId: unknown): CloudRunSummary => {
    if (typeof runId !== 'string') throw new Error('No cloud run with that id in this project')
    return runs.get(runId, projectId)
  }
  handle(channel.list, projectId => runs.list(projectId))
  handle(channel.get, (projectId, runId) => owned(projectId, runId))
  handle(channel.start, async (projectId, input: CloudStartInput) => {
    const run = runs.start({ projectId, workspaceId: String(input?.workspaceId ?? ''), cwd: path(projectId), prompt: input?.prompt, model: input?.model, effort: input?.effort, ref: input?.ref, title: input?.title, startedBy: 'owner' })
    await options.openTab(run).catch(() => undefined)
    return run
  })
  handle(channel.ensure, (projectId, runId) => { const run = owned(projectId, runId); void runs.refreshResult(run.id).catch(() => undefined); return { summary: run, ...runs.clientTranscript(run.id) } })
  handle(channel.interrupt, (projectId, runId) => runs.interrupt(owned(projectId, runId).id))
  handle(channel.stop, (projectId, runId) => runs.stop(owned(projectId, runId).id))
  handle(channel.attach, (projectId, runId) => runs.attach(owned(projectId, runId).id))
  handle(channel.fetch, (projectId, runId) => runs.fetch(owned(projectId, runId).id))
  handle(channel.transcript, (projectId, runId, refresh) => runs.transcript(owned(projectId, runId).id, refresh === true))
  const write = (event: Electron.IpcMainEvent, runId: unknown, data: unknown): void => {
    try { if (typeof runId !== 'string' || typeof data !== 'string') return; options.authorize(event, runs.get(runId).projectId); runs.write(runId, data) } catch { /* reject untrusted input */ }
  }
  const resize = (event: Electron.IpcMainEvent, runId: unknown, cols: unknown, rows: unknown): void => {
    try { if (typeof runId !== 'string') return; options.authorize(event, runs.get(runId).projectId); runs.resize(runId, Number(cols), Number(rows)) } catch { /* reject untrusted input */ }
  }
  ipcMain.on(channel.write, write)
  ipcMain.on(channel.resize, resize)
  return () => {
    for (const name of [channel.list, channel.get, channel.start, channel.ensure, channel.interrupt, channel.stop, channel.attach, channel.fetch, channel.transcript]) ipcMain.removeHandler(name)
    ipcMain.removeListener(channel.write, write)
    ipcMain.removeListener(channel.resize, resize)
  }
}
