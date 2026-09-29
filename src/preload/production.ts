import { ipcRenderer } from 'electron'
import { PRODUCTION_IPC as channel, type ProductionBridge } from '../shared/production'

/** The Production panel's bridge (docs/production-agent.md); handlers live in src/main/production-ipc.ts. */
export const productionBridge: ProductionBridge = {
  snapshot: projectId => ipcRenderer.invoke(channel.snapshot, projectId),
  queue: () => ipcRenderer.invoke(channel.queue),
  registry: () => ipcRenderer.invoke(channel.registry),
  designate: (projectId, designation) => ipcRenderer.invoke(channel.designate, projectId, designation),
  updateProfile: (projectId, update) => ipcRenderer.invoke(channel.updateProfile, projectId, update),
  answerQuestion: (projectId, questionId, answer) => ipcRenderer.invoke(channel.answerQuestion, projectId, questionId, answer),
  dismissQuestion: (projectId, questionId, reason) => ipcRenderer.invoke(channel.dismissQuestion, projectId, questionId, reason),
  audit: (projectId, request) => ipcRenderer.invoke(channel.audit, projectId, request),
  retest: (projectId, findingIds) => ipcRenderer.invoke(channel.retest, projectId, findingIds),
  verify: (projectId, findingIds) => ipcRenderer.invoke(channel.verify, projectId, findingIds),
  pause: (projectId, runId) => ipcRenderer.invoke(channel.pause, projectId, runId),
  resume: (projectId, runId) => ipcRenderer.invoke(channel.resume, projectId, runId),
  cancel: (projectId, runId, reason) => ipcRenderer.invoke(channel.cancel, projectId, runId, reason),
  run: (projectId, runId) => ipcRenderer.invoke(channel.run, projectId, runId),
  createFixTasks: (projectId, findingIds) => ipcRenderer.invoke(channel.createFixTasks, projectId, findingIds),
  waive: (projectId, request) => ipcRenderer.invoke(channel.waive, projectId, request),
  revokeWaiver: (projectId, waiverId, reason) => ipcRenderer.invoke(channel.revokeWaiver, projectId, waiverId, reason),
  authorizeWrites: (projectId, request) => ipcRenderer.invoke(channel.authorizeWrites, projectId, request),
  revokeWrites: (projectId, authorizationId) => ipcRenderer.invoke(channel.revokeWrites, projectId, authorizationId),
  openEvidence: (projectId, runId, evidenceId) => ipcRenderer.invoke(channel.openEvidence, projectId, runId, evidenceId),
  openReport: (projectId, runId) => ipcRenderer.invoke(channel.openReport, projectId, runId),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, projectId: string): void => callback(projectId)
    ipcRenderer.on(channel.changed, listener)
    return () => ipcRenderer.removeListener(channel.changed, listener)
  }
}
