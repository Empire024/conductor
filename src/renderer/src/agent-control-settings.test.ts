import { describe, expect, it, vi } from 'vitest'
import { announceAgentControlGrants, announceAgentControlSettings, onAgentControlGrants, onAgentControlSettings } from './agent-control-settings'

describe('confirmed agent-control settings event', () => {
  it('updates only the exact subscribed conversation and can be detached', () => {
    class TestCustomEvent<T = unknown> extends Event { detail: T; constructor(type: string, init: CustomEventInit<T>) { super(type); this.detail = init.detail as T } }
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('CustomEvent', TestCustomEvent)
    const worker = vi.fn(), other = vi.fn()
    const offWorker = onAgentControlSettings('worker', worker)
    const offOther = onAgentControlSettings('other', other)
    announceAgentControlSettings({ agentSessionId: 'worker', model: 'gpt-5.6-sol', effort: 'high' })
    expect(worker).toHaveBeenCalledWith({ model: 'gpt-5.6-sol', effort: 'high' })
    expect(other).not.toHaveBeenCalled()
    offWorker(); offOther()
    announceAgentControlSettings({ agentSessionId: 'worker', model: 'newer', effort: 'low' })
    expect(worker).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
  it('delivers a confirmed grant change to the exact conversation only', () => {
    class TestCustomEvent<T = unknown> extends Event { detail: T; constructor(type: string, init: CustomEventInit<T>) { super(type); this.detail = init.detail as T } }
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('CustomEvent', TestCustomEvent)
    const worker = vi.fn(), other = vi.fn(), settings = vi.fn()
    const offWorker = onAgentControlGrants('worker', worker)
    const offOther = onAgentControlGrants('other', other)
    const offSettings = onAgentControlSettings('worker', settings)
    announceAgentControlGrants({ agentSessionId: 'worker', repository: true, research: false })
    expect(worker).toHaveBeenCalledWith({ repository: true, research: false })
    expect(other).not.toHaveBeenCalled()
    // A grant is not a model change; the two events stay apart.
    expect(settings).not.toHaveBeenCalled()
    offWorker(); offOther(); offSettings()
    announceAgentControlGrants({ agentSessionId: 'worker', repository: false, research: true })
    expect(worker).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
