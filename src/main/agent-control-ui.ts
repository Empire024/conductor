import { app, BrowserWindow, ipcMain, powerMonitor, webContents, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { AgentControlUiRequest, AgentControlUiResponse, AgentControlScope } from '../shared/agent-control'
import type { AgentControl } from './agent-control'
import { isStructuredRendererUrl } from './structured-ipc-policy'
import { waitForOwnerPause, type OwnerInput } from './owner-typing'

/** Actions that only change what a tab is called or how it is configured, or close it: none of
 *  them is a reason to raise the window over whatever the owner is doing. */
const quietActions = new Set<AgentControlUiRequest['action']>(['tabs.list', 'tabs.open', 'tabs.close', 'tabs.rename', 'agents.configure', 'agents.configure-confirmed', 'agents.grant-confirmed', 'workspace.rename'])

/** Keys pressed in any Conductor window, plus the system idle time. A parked test instance never
 *  takes OS focus, so it ignores the owner's real keyboard and waits only for its own. */
function electronOwnerInput(): OwnerInput {
  let lastKeyAt = 0
  const watched = new WeakSet<WebContents>()
  const watch = (contents: WebContents): void => {
    if (watched.has(contents)) return
    watched.add(contents)
    contents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') lastKeyAt = Date.now() })
  }
  app.on('web-contents-created', (_event, contents) => watch(contents))
  for (const contents of webContents.getAllWebContents()) watch(contents)
  const parked = Boolean(process.env.CONDUCTOR_TEST_USER_DATA)
  return { lastKeyAt: () => lastKeyAt, systemIdleSeconds: () => parked ? undefined : powerMonitor.getSystemIdleTime() }
}

interface Pending { senderId: number; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class AgentControlUi {
  private pending = new Map<string, Pending>()
  private readonly input: OwnerInput
  constructor(private readonly rendererPath: string, private readonly windowFor: (request: AgentControlUiRequest) => BrowserWindow | null, input?: OwnerInput) {
    this.input = input ?? electronOwnerInput()
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
  request = async (request: AgentControlUiRequest): Promise<unknown> => {
    // A focus an agent asked for waits until the owner stops typing (FX21); if they never do, the
    // tab stays where it is rather than being yanked into view minutes later.
    if (request.params.whenIdle === true && !await waitForOwnerPause(this.input)) throw new Error('The owner kept typing, so the tab was not brought into view')
    const window = this.windowFor(request)
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('Open the workspace in Conductor before controlling its tabs')
    // Opening, closing, renaming or configuring a tab is something an agent does on its own
    // initiative; raising the window for it is exactly the focus-stealing this silences. A focus,
    // split or detach is a deliberate ask to look at something, and so is an open with focus:true.
    if (!quietActions.has(request.action) || request.action === 'tabs.open' && request.params.focus === true) {
      if (window.isMinimized()) window.restore()
      window.show(); window.focus()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.id); reject(new Error('Workspace did not acknowledge the action. Inspect the UI before retrying.')) }, 30000)
      this.pending.set(request.id, { senderId: window.webContents.id, resolve, reject, timer })
      window.webContents.send('agent-control:request', request)
    })
  }
  register(control: AgentControl): void {
    ipcMain.handle('agent-control:open-uri', async (event, uri: string) => { this.trusted(event); if (typeof uri !== 'string' || uri.length > 8000) throw new Error('Invalid Conductor link'); await control.openUri(uri) })
    ipcMain.handle('agent-control:links', (event, projectId: string, sessionId: string) => { this.trusted(event); return control.listLinks(projectId, sessionId) })
    ipcMain.handle('agent-control:app-activity', event => { this.trusted(event); return control.appActivity() })
    ipcMain.handle('agent-control:release', (event, targetAgentSessionId: string) => { this.trusted(event); control.releaseByOwner(targetAgentSessionId) })
    ipcMain.handle('agent-control:focus-tab', async (event, projectId: string, sessionId: string, tabId: string) => {
      this.trusted(event)
      const scope: AgentControlScope = { projectId, sessionId, agentSessionId: '' }
      if (!control.tabs(scope).some(tab => tab.id === tabId)) throw new Error('Tab is no longer open')
      await this.request({ ...scope, id: randomUUID(), action: 'tabs.focus', params: { tabId } })
    })
    ipcMain.handle('agent-control:focus-origin', async (event, agentSessionId: string) => {
      this.trusted(event)
      if (typeof agentSessionId !== 'string' || !agentSessionId || agentSessionId.length > 160) throw new Error('Invalid originating agent')
      await control.focusOrigin(agentSessionId)
    })
  }
  close(): void {
    ipcMain.removeListener('agent-control:response', this.response)
    for (const channel of ['agent-control:links', 'agent-control:app-activity', 'agent-control:release', 'agent-control:focus-tab', 'agent-control:focus-origin', 'agent-control:open-uri']) ipcMain.removeHandler(channel)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Conductor is shutting down')) }
    this.pending.clear()
  }
}
