import { describe, expect, it, vi } from 'vitest'
import { announceAgentControlSettings, onAgentControlSettings } from './agent-control-settings'

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
})
