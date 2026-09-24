import { ipcMain } from 'electron'
import type { LogicLoopProposal, LogicLoopsSnapshot } from '../../shared/logic-loops'
import type { ConductorDatabase } from '../database'
import { LogicLoops, type UsageReportForBudget } from '.'

export const logicLoopsIpcChannels = ['logic-loops:snapshot', 'logic-loops:apply', 'logic-loops:reject'] as const

/** The Scheduled tasks and Project tasks panels are the owner acting, so an apply here is always
 *  the owner's authority: no dialog, and a locked/budget change is allowed the same as any other. */
export function registerLogicLoopsIpc(options: {
  database: ConductorDatabase
  usage(): UsageReportForBudget[]
  authorize(event: Electron.IpcMainInvokeEvent, projectId: string): void
  projectPath(projectId: string): string
  changed(projectId: string): void
}): () => void {
  const loopsFor = (projectId: string): LogicLoops => new LogicLoops(options.projectPath(projectId), projectId, options.database, { usage: options.usage })
  const done = <T>(projectId: string, value: T): T => { options.changed(projectId); return value }
  ipcMain.handle('logic-loops:snapshot', (event, projectId: string): LogicLoopsSnapshot => {
    options.authorize(event, projectId)
    const loops = loopsFor(projectId)
    const summaries = loops.list()
    return { loops: summaries, runs: Object.fromEntries(summaries.map(loop => [loop.id, loops.recentRuns(loop.id, 5)])), proposals: loops.listProposals() }
  })
  ipcMain.handle('logic-loops:apply', (event, projectId: string, proposalId: string): LogicLoopProposal => {
    options.authorize(event, projectId)
    return done(projectId, loopsFor(projectId).apply(proposalId, true, 'owner'))
  })
  ipcMain.handle('logic-loops:reject', (event, projectId: string, proposalId: string): LogicLoopProposal => {
    options.authorize(event, projectId)
    return done(projectId, loopsFor(projectId).reject(proposalId))
  })
  return () => { for (const channel of logicLoopsIpcChannels) ipcMain.removeHandler(channel) }
}
