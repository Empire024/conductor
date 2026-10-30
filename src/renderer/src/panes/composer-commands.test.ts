import { describe, expect, it } from 'vitest'
import { composerCommands, matchingComposerCommands, nativeCommandNames } from './composer-commands'
import type { ProviderCapabilities } from '../../../shared/structured-agent'
describe('chat command discovery', () => {
  it('lists the supported commands before connecting and only advertises supported modes', () => {
    const names = composerCommands().map(command => command.name)
    expect(names).toEqual(expect.arrayContaining(['permissions', 'model', 'compact', 'status', 'new', 'attach', 'settings', 'history', 'stop', 'resume', 'help', 'browser']))
    expect(names).not.toContain('plan')
    expect(names).not.toContain('fork')
    const capabilities = { provider: 'codex', plans: true, fork: true } as ProviderCapabilities
    expect(composerCommands(capabilities).map(command => command.name)).toEqual(expect.arrayContaining(['plan', 'fork', 'review', 'init']))
  })
  it('lists the Claude commands stream-json runs, and none that only exist in the terminal UI', () => {
    const names = composerCommands({ provider: 'claude' } as ProviderCapabilities).map(command => command.name)
    expect(names).toEqual(expect.arrayContaining(['permissions', 'compact', 'context', 'init']))
    expect(names).not.toContain('review')
    expect(names).not.toContain('vim')
  })
  it('merges discovered Claude commands without overriding app actions or guessing unrelated names', () => {
    const commands = composerCommands({ provider: 'claude' } as ProviderCapabilities, { initialize: { commands: [{ name: 'code-review', description: 'Review changes', argumentHint: '[level]' }, { name: 'history' }, { name: 'clear', description: 'Start a new session' }, { name: 'bad path' }] }, configuration: { slash_commands: ['/test'], name: 'not-a-command' } })
    expect(commands.find(command => command.name === 'code-review')).toEqual({ name: 'code-review', description: 'Review changes', insert: '/code-review ', argumentHint: '[level]' })
    expect(commands.find(command => command.name === 'test')).toMatchObject({ insert: '/test ' })
    expect(commands.filter(command => command.name === 'history')).toEqual([{ name: 'history', description: 'Browse saved conversations' }])
    // Claude's /clear is Conductor's /new: listed once, under the name that does what it says.
    expect(commands.some(command => command.name === 'clear')).toBe(false)
    expect(commands.some(command => command.name === 'bad path' || command.name === 'not-a-command')).toBe(false)
  })
  it('turns Codex skills into /skill:name entries that draft $ tokens', () => {
    const commands = composerCommands(undefined, { skills: { status: 'available', payload: { data: [{ skills: [{ name: 'research', enabled: true }, { name: 'disabled', enabled: false }] }] } } })
    expect(commands.find(command => command.name === 'skill:research')).toMatchObject({ insert: '$research ', kind: 'skill' })
    expect(commands.some(command => command.name.endsWith('disabled'))).toBe(false)
  })
  it('reads the names a runtime reported, or nothing before discovery', () => {
    expect(nativeCommandNames(undefined)).toBeUndefined()
    expect(nativeCommandNames({ skills: {} })).toBeUndefined()
    expect(nativeCommandNames({ initialize: { commands: [{ name: 'compact' }, { name: 'off', enabled: false }] }, configuration: { slash_commands: ['/context'] } })).toEqual(['compact', 'context'])
  })
  it('filters only a leading slash command token', () => {
    const commands = composerCommands()
    expect(matchingComposerCommands('/MO', commands).map(command => command.name)).toEqual(['model'])
    for (const text of ['Use /model please', '/model argument', '/file.ts', 'ordinary text', '']) expect(matchingComposerCommands(text, commands)).toEqual([])
  })
  it('finds a command by its CLI alias', () => {
    const commands = composerCommands({ provider: 'codex' } as ProviderCapabilities)
    expect(matchingComposerCommands('/approvals', commands).map(command => command.name)).toEqual(['permissions'])
    expect(matchingComposerCommands('/clear', commands).map(command => command.name)).toEqual(['new'])
  })
  it('keeps @browser separate from slash commands', () => {
    const commands = composerCommands()
    expect(matchingComposerCommands('@', commands).map(command => command.name)).toEqual(['browser'])
    expect(matchingComposerCommands('@bro', commands)).toEqual([{ name: 'browser', description: 'Attach the browser preview to this turn', trigger: '@' }])
    expect(matchingComposerCommands('@model', commands)).toEqual([])
    expect(matchingComposerCommands('/browser', commands)).toEqual([])
    for (const text of ['Use @browser please', '@browser argument', '@file.ts']) expect(matchingComposerCommands(text, commands)).toEqual([])
  })
})
