import { ipcMain } from 'electron'
import type {
  AgentCollaborationMessageQuery,
  AgentPresenceQuery,
  AnnounceFilePresenceInput,
  FileConflictQuery,
  PostAgentCollaborationMessageInput
} from '../shared/agent-collaboration'
import type { AgentCollaborationStore } from './agent-collaboration-store'

export const agentCollaborationIpcChannels = [
  'collaboration:snapshot',
  'collaboration:briefing',
  'collaboration:messages:post',
  'collaboration:messages:list',
  'collaboration:presence:announce',
  'collaboration:presence:list',
  'collaboration:presence:conflicts',
  'collaboration:presence:release'
] as const

/** Register collaboration IPC and return a hot-reload-friendly disposer. */
export const registerAgentCollaborationIpc = (store: AgentCollaborationStore): (() => void) => {
  ipcMain.handle('collaboration:snapshot', (_event, query: AgentCollaborationMessageQuery) =>
    store.snapshot(query)
  )
  ipcMain.handle('collaboration:briefing', (_event, agentSessionId: string) =>
    store.buildBriefing(agentSessionId)
  )
  ipcMain.handle(
    'collaboration:messages:post',
    (_event, input: PostAgentCollaborationMessageInput) => store.postMessage(input)
  )
  ipcMain.handle('collaboration:messages:list', (_event, query: AgentCollaborationMessageQuery) =>
    store.listMessages(query)
  )
  ipcMain.handle(
    'collaboration:presence:announce',
    (_event, input: AnnounceFilePresenceInput) => store.announcePresence(input)
  )
  ipcMain.handle('collaboration:presence:list', (_event, query: AgentPresenceQuery) =>
    store.listPresence(query)
  )
  ipcMain.handle('collaboration:presence:conflicts', (_event, query: FileConflictQuery) =>
    store.detectConflicts(query)
  )
  ipcMain.handle(
    'collaboration:presence:release',
    (_event, agentSessionId: string, path?: string) => store.releasePresence(agentSessionId, path)
  )

  return () => {
    for (const channel of agentCollaborationIpcChannels) ipcMain.removeHandler(channel)
  }
}
