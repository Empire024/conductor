import { describe, expect, it } from 'vitest'
import { conversationStatusText, lastAssistantText, matchConversationMode, matchEffort, matchModel } from './slash-command-actions'
import { conversationModes } from './composer-settings'
import { emptyProjection } from '../../../shared/structured-agent-reducer'
import type { ProviderCapabilities, TimelineItem } from '../../../shared/structured-agent'

const codex = { provider: 'codex', permissions: ['default', 'auto', 'read-only'], plans: true, models: [], effort: [], limitations: [] } as unknown as ProviderCapabilities

describe('slash command arguments', () => {
  it('finds the mode a /permissions argument names, in Conductor’s or the CLI’s words', () => {
    const modes = conversationModes(codex)
    expect(matchConversationMode(modes, 'auto')?.id).toBe('auto')
    expect(matchConversationMode(modes, 'Ask')?.id).toBe('default')
    expect(matchConversationMode(modes, 'on-request')?.id).toBe('default')
    expect(matchConversationMode(modes, 'read only')?.id).toBe('read-only')
    expect(matchConversationMode(modes, 'plan')?.change).toEqual({ plan: true })
    expect(matchConversationMode(modes, 'sideways')).toBeUndefined()
  })
  it('finds a model by id, label or unique words', () => {
    const models = [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effort: [] }, { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', effort: [] }, { id: 'claude-opus-5-5', label: 'Opus 5.5', effort: [] }]
    expect(matchModel(models, 'GPT-6.1-SOL')?.id).toBe('gpt-6.1-sol')
    expect(matchModel(models, 'opus')?.id).toBe('claude-opus-5-5')
    expect(matchModel(models, 'sol')).toBeUndefined()
    expect(matchModel(models, '6.1 sol')?.id).toBe('gpt-6.1-sol')
    expect(matchEffort(['low', 'high'], 'HIGH')).toBe('high')
    expect(matchEffort(['low', 'high'], 'max')).toBeUndefined()
  })
  it('copies the latest top-level answer', () => {
    const item = (id: string, role: 'user' | 'assistant', text: string, parentId?: string) => ({ id, data: { type: 'text', role, text }, ...(parentId ? { parentId } : {}) }) as unknown as TimelineItem
    expect(lastAssistantText([item('1', 'assistant', 'first'), item('2', 'user', 'again'), item('3', 'assistant', 'second'), item('4', 'assistant', 'subagent', 'tool')])).toBe('second')
    expect(lastAssistantText([item('1', 'user', 'hello')])).toBeUndefined()
  })
  it('states the model, mode, workspace and session for /status', () => {
    const projection = { ...emptyProjection('session'), phase: 'idle' as const, nativeSessionId: 'thread-9', capabilities: { ...codex, runtimeVersion: '0.159.1', authentication: 'cli' } as ProviderCapabilities }
    const text = conversationStatusText({ name: 'Codex', projection, settings: { permission: 'auto', plan: false, effort: 'high' }, modelLabel: 'GPT-6.1 Sol', modeLabel: 'Auto', workspace: 'C:\\work' })
    expect(text).toContain('Codex 0.159.1 · idle')
    expect(text).toContain('Model: GPT-6.1 Sol · effort high')
    expect(text).toContain('Mode: Auto')
    expect(text).toContain('Workspace: C:\\work')
    expect(text).toContain('Session: thread-9')
    expect(text).toContain('Context: not reported yet')
  })
})
