import { describe, expect, it } from 'vitest'
import { emptyProjection } from '../../../shared/structured-agent-reducer'
import type { ProviderCapabilities } from '../../../shared/structured-agent'
import type { PaneTab } from '../../../shared/models'
import { deriveConversationTitle } from '../../../shared/conversation-title'
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

describe('first-message auto-naming', () => {
  const prompt = 'Please refactor the authentication module to use the new session token format across every API route'
  const identity = { id: 'agent-1', provider: 'codex' as const, title: prompt, model: 'gpt-6-astra', effort: 'auto' as const, auto: true }

  it('names a still-generic tab from its first message and locks the title', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Codex', resourceId: 'agent-1' }
    const next = bindConversationTab(tab, identity)
    expect(next.title).toBe(deriveConversationTitle(prompt))
    expect(next.titleLocked).toBe(true)
  })

  it('keeps a remote tab\'s machine suffix when auto-naming', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Codex · office-pc', resourceId: 'agent-1', state: { machineId: 'machine-2' } }
    const next = bindConversationTab(tab, identity)
    expect(next.title).toBe(`${deriveConversationTitle(prompt)} · office-pc`)
  })

  it('never renames a tab the owner already renamed by hand', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Login bugfix', resourceId: 'agent-1', titleLocked: true }
    const next = bindConversationTab(tab, identity)
    expect(next.title).toBe('Login bugfix')
  })

  it('records an explicit rename and locks the title', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Codex', resourceId: 'agent-1' }
    const next = bindConversationTab(tab, { id: 'agent-1', provider: 'codex', title: 'Payment retries', model: 'gpt-6-astra', effort: 'auto', manual: true })
    expect(next.title).toBe('Payment retries')
    expect(next.titleLocked).toBe(true)
  })

  it('lets an explicit rename override a tab already auto-named from its first message', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Codex', resourceId: 'agent-1' }
    const autoNamed = bindConversationTab(tab, identity)
    expect(autoNamed.titleLocked).toBe(true)
    const renamed = bindConversationTab(autoNamed, { id: 'agent-1', provider: 'codex', title: 'Payment retries', model: 'gpt-6-astra', effort: 'auto', manual: true })
    expect(renamed.title).toBe('Payment retries')
  })

  it('does not re-derive the title from a second message', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Codex', resourceId: 'agent-1' }
    const first = bindConversationTab(tab, identity)
    const second = bindConversationTab(first, { ...identity, title: 'Now also update the docs and add tests for the refresh path' })
    expect(second.title).toBe(first.title)
  })

  it('leaves the tab untouched when the first prompt has nothing to derive from', () => {
    const tab: PaneTab = { id: 'pane', kind: 'agent', title: 'Codex', resourceId: 'agent-1' }
    const next = bindConversationTab(tab, { ...identity, title: '   ' })
    expect(next.title).toBe('Codex')
  })
})
