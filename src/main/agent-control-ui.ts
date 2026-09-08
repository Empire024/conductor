import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { AgentControlUiRequest, AgentControlUiResponse, AgentControlScope } from '../shared/agent-control'
import type { AgentControl } from './agent-control'
import { isStructuredRendererUrl } from './structured-ipc-policy'

interface Pending { senderId: number; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class AgentControlUi {
  private pending = new Map<string, Pending>()
  constructor(private readonly rendererPath: string, private readonly windowFor: (request: AgentControlUiRequest) => BrowserWindow | null) {
    ipcMain.on('agent-control:response', this.response)
  }
  private trusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isStructuredRendererUrl(event.senderFrame.url, process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(this.rendererPath).href)) throw new Error('App control requires a trusted workspace window')
  }
  private response = (event: IpcMainEvent, response: AgentControlUiResponse): void => {
    try { this.trusted(event) } catch { return }
    const pending = this.pending.get(response?.id)
    if (!pending || pending.senderId !== event.sender.id) return
    clearTimeout(pending.timer); this.pending.delete(response.id)
    if (response.error) pending.reject(new Error(response.error)); else pending.resolve(response.result)
  }
  request = (request: AgentControlUiRequest): Promise<unknown> => {
    const window = this.windowFor(request)
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.reject(new Error('Open the workspace in Conductor before controlling its tabs'))
    if (window.isMinimized()) window.restore()
    window.show(); window.focus()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.id); reject(new Error('Workspace did not acknowledge the action. Inspect the UI before retrying.')) }, 30000)
      this.pending.set(request.id, { senderId: window.webContents.id, resolve, reject, timer })
      window.webContents.send('agent-control:request', request)
    })
  }
  register(control: AgentControl): void {
    ipcMain.handle('agent-control:open-uri', async (event, uri: string) => { this.trusted(event); if (typeof uri !== 'string' || uri.length > 8000) throw new Error('Invalid Conductor link'); await control.openUri(uri) })
    ipcMain.handle('agent-control:links', (event, projectId: string, sessionId: string) => { this.trusted(event); return control.listLinks(projectId, sessionId) })
    ipcMain.handle('agent-control:release', (event, targetAgentSessionId: string) => { this.trusted(event); control.releaseByOwner(targetAgentSessionId) })
    ipcMain.handle('agent-control:focus-tab', async (event, projectId: string, sessionId: string, tabId: string) => {
      this.trusted(event)
      const scope: AgentControlScope = { projectId, sessionId, agentSessionId: '' }
      if (!control.tabs(scope).some(tab => tab.id === tabId)) throw new Error('Tab is no longer open')
      await this.request({ ...scope, id: randomUUID(), action: 'tabs.focus', params: { tabId } })
    })
  }
  close(): void {
    ipcMain.removeListener('agent-control:response', this.response)
    for (const channel of ['agent-control:links', 'agent-control:release', 'agent-control:focus-tab', 'agent-control:open-uri']) ipcMain.removeHandler(channel)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Conductor is shutting down')) }
    this.pending.clear()
  }
}
