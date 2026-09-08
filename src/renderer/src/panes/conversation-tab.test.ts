import { describe, expect, it } from 'vitest'
import { emptyProjection } from '../../../shared/structured-agent-reducer'
import type { ProviderCapabilities } from '../../../shared/structured-agent'
import type { PaneTab } from '../../../shared/models'
import { bindConversationTab, conversationIdentity } from './conversation-tab'

describe('persistent conversation tab identity', () => {
  it('retargets the runtime used for control while retaining the original pane identity and preferences', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Original', resourceId: 'old-runtime', state: { provider: 'codex', continueOnLimit: true, viewMode: 'cli' } }
    const saved = { ...emptyProjection('resumed-runtime'), title: 'Saved conversation', settings: { permission: 'default' as const, plan: false, model: 'claude-opus-4-6', effort: 'high' as const }, capabilities: { provider: 'claude', models: [] } as unknown as ProviderCapabilities }
    const next = bindConversationTab(tab, conversationIdentity(saved, 'codex'))
    expect(next).toMatchObject({ id: 'pane', resourceId: 'resumed-runtime', title: 'Saved conversation', state: { provider: 'claude', model: 'claude-opus-4-6', effort: 'high', continueOnLimit: true, viewMode: 'visual', resume: true } })
    expect(tab.resourceId).toBe('old-runtime')
  })
  it('records a fork under its new session without changing the source tab snapshot', () => {
    const original: PaneTab = { id: 'same-pane', kind: 'agent', title: 'Original', resourceId: 'source' }
    const snapshot = { ...emptyProjection('fork'), title: 'Original (fork)' }
    const next = bindConversationTab(original, conversationIdentity(snapshot, 'codex'))
    expect(next.resourceId).toBe('fork')
    expect(next.id).toBe(original.id)
    expect(next.title).toBe('Original (fork)')
    expect(next.state?.model).not.toBe('default')
    expect(original).toEqual({ id: 'same-pane', kind: 'agent', title: 'Original', resourceId: 'source' })
  })
})
