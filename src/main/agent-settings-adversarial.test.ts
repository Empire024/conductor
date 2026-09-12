import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl, type AgentControlDependencies } from './agent-control'
import type { AgentControlUiRequest } from '../shared/agent-control'

afterEach(() => vi.unstubAllEnvs())

function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  const scope = { projectId: 'project-a', sessionId: 'workspace-a', agentSessionId: 'controller' }
  const specs: Record<string, any> = Object.fromEntries(['controller', 'worker'].map(id => [id, { id, projectId: scope.projectId, sessionId: scope.sessionId, cwd: 'C:/project-a', provider: 'codex', title: id }]))
  const states: Record<string, any> = Object.fromEntries(['controller', 'worker'].map(id => [id, { sessionId: id, phase: 'idle', settings: { permission: 'default', plan: false, model: 'old-model', effort: 'high' }, capabilities: { provider: 'codex', models: [{ id: 'old-model', effort: ['high'] }, { id: 'new-model', effort: ['high'] }, { id: 'owner-model', effort: ['high'] }] } }]))
  const tabs = ['controller', 'worker'].map(id => ({ id: id + '-tab', kind: 'agent', resourceId: id, title: id, state: { provider: 'codex', model: 'old-model', effort: 'high' } }))
  const workspace = { id: scope.sessionId, projectId: scope.projectId, layout: { root: { type: 'group', id: 'group-a', activeTabId: tabs[0]!.id, tabs } } }
  const bindings = new Map([['agentControlParent:worker', JSON.stringify({ projectId: scope.projectId, sessionId: scope.sessionId, controllerAgentSessionId: 'controller', targetAgentSessionId: 'worker', controllerTabId: 'controller-tab', controlledTabId: 'worker-tab' })]])
  let afterUi: (() => void) | undefined
  const ui = vi.fn(async (request: AgentControlUiRequest) => {
    const tab = tabs.find(value => value.id === request.params.tabId)!
    tab.state = { ...tab.state, model: String(request.params.model), effort: String(request.params.effort ?? 'auto') }
    const callback = afterUi; afterUi = undefined; callback?.()
    return tab
  })
  const saveSettings = vi.fn((id: string, settings: unknown) => { states[id].settings = settings })
  const deps = {
    database: { structured: { spec: (id: string) => specs[id], snapshot: (id: string) => states[id] }, getSession: () => workspace, listSessions: () => [workspace], listDetachedWindows: () => [], getSetting: (key: string) => bindings.get(key) ?? null },
    sessions: { saveSettings }, ui
  } as unknown as AgentControlDependencies
  return { control: new AgentControl(deps), scope, specs, states, tabs, bindings, ui, saveSettings, afterUi: (callback: () => void) => { afterUi = callback } }
}

describe('coworker settings authority boundaries', () => {
  it('refuses local settings writes for a durable remote owner with stale local tab metadata', async () => {
    const f = fixture()
    f.specs.worker.machineId = 'remote-machine-a'
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: 'worker', model: 'new-model', effort: 'high' })).rejects.toThrow(/machine|remote/i)
    expect(f.saveSettings).not.toHaveBeenCalled()
    expect(f.ui).not.toHaveBeenCalled()
  })

  it('does not roll back over an owner change after the control relationship is released', async () => {
    const f = fixture()
    f.afterUi(() => {
      f.states.worker.settings = { ...f.states.worker.settings, model: 'owner-model' }
      f.tabs[1]!.state.model = 'owner-model'
      f.bindings.delete('agentControlParent:worker')
    })
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: 'worker', model: 'new-model', effort: 'high' })).rejects.toThrow()
    expect(f.tabs[1]!.state.model).toBe('owner-model')
    expect(f.states.worker.settings.model).toBe('owner-model')
    expect(f.saveSettings).not.toHaveBeenCalled()
  })
})
