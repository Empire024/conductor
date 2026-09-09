import { describe, expect, it, vi } from 'vitest'
import { AgentControlUi } from './agent-control-ui'
import type { AgentControlUiRequest } from '../shared/agent-control'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: {}
}))

vi.mock('./structured-ipc-policy', () => ({ isStructuredRendererUrl: () => true }))

function fakeWindow() {
  const send = vi.fn()
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { id: 1, isDestroyed: () => false, send }
  }
}

const scope = { projectId: 'project', sessionId: 'session', agentSessionId: 'controller' }
const request = (action: AgentControlUiRequest['action'], params: Record<string, unknown> = {}): AgentControlUiRequest =>
  ({ ...scope, id: 'request', action, params })

describe('AgentControlUi window focus', () => {
  it('does not raise the window for a plain agent-initiated tab open', () => {
    const window = fakeWindow()
    const ui = new AgentControlUi('renderer/index.html', () => window as never)
    void ui.request(request('tabs.open', { tab: { id: 'tab' } }))
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(window.webContents.send).toHaveBeenCalled()
  })
  it('still raises the window when a tab open explicitly asks for focus', () => {
    const window = fakeWindow()
    const ui = new AgentControlUi('renderer/index.html', () => window as never)
    void ui.request(request('tabs.open', { tab: { id: 'tab' }, focus: true }))
    expect(window.show).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
  })
  it('raises the window for actions other than tabs.open, like an explicit tab focus', () => {
    const window = fakeWindow()
    const ui = new AgentControlUi('renderer/index.html', () => window as never)
    void ui.request(request('tabs.focus', { tabId: 'tab' }))
    expect(window.show).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
  })
})
