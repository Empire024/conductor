import { ipcRenderer } from 'electron'
import { THREADS_CHANGED_CHANNEL, type ThreadsBridge } from '../shared/threads'

export const threadsBridge: ThreadsBridge = {
  newGeneral: () => ipcRenderer.invoke('threads:new-general'),
  generalProjectId: () => ipcRenderer.invoke('threads:general-id'),
  list: query => ipcRenderer.invoke('threads:list', query),
  handoff: (agentSessionId, targetProjectId) => ipcRenderer.invoke('threads:handoff', agentSessionId, targetProjectId),
  promote: name => ipcRenderer.invoke('threads:promote', name),
  // The notice carries nothing: the listener asks `threads:list`, which keeps its trusted-sender check.
  onChanged: listener => {
    const handler = (): void => { try { listener() } catch (error) { console.warn('Thread list listener failed', error) } }
    ipcRenderer.on(THREADS_CHANGED_CHANNEL, handler)
    return () => { ipcRenderer.removeListener(THREADS_CHANGED_CHANNEL, handler) }
  }
}
