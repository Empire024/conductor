import { describe, expect, it } from 'vitest'
import { composerCommands, matchingComposerCommands } from './composer-commands'
import type { ProviderCapabilities } from '../../../shared/structured-agent'
describe('chat command discovery', () => {
  it('keeps useful local commands before connecting and only advertises supported modes', () => {
    expect(composerCommands().map(command => command.name)).toEqual(['attach', 'model', 'settings', 'history', 'stop', 'resume', 'browser'])
    const capabilities = { plans: true, fork: true } as ProviderCapabilities
    expect(composerCommands(capabilities).map(command => command.name)).toContain('plan')
    expect(composerCommands(capabilities).map(command => command.name)).toContain('fork')
  })
  it('merges discovered Claude commands without overriding app actions or guessing unrelated names', () => {
    const commands = composerCommands(undefined, { initialize: { commands: [{ name: 'review', description: 'Review changes' }, { name: 'history' }, { name: 'bad path' }] }, configuration: { slash_commands: ['/test'], name: 'not-a-command' } })
    expect(commands.find(command => command.name === 'review')).toEqual({ name: 'review', description: 'Review changes', insert: '/review ' })
    expect(commands.find(command => command.name === 'test')?.insert).toBe('/test ')
    expect(commands.filter(command => command.name === 'history')).toHaveLength(1)
    expect(commands.some(command => ['bad path', 'not-a-command'].includes(command.name))).toBe(false)
  })
  it('inserts the native Codex skill syntax and excludes disabled skills', () => {
    const commands = composerCommands(undefined, { skills: { status: 'available', payload: { data: [{ skills: [{ name: 'research', enabled: true }, { name: 'disabled', enabled: false }] }] } } })
    expect(commands.find(command => command.name === 'research')?.insert).toBe('$research ')
    expect(commands.some(command => command.name === 'disabled')).toBe(false)
  })
  it('offers completion only while typing a slash command token', () => {
    const commands = composerCommands()
    expect(matchingComposerCommands('/MO', commands).map(command => command.name)).toEqual(['model'])
    for (const text of ['Use /model please', '/model argument', '/file.ts', 'ordinary text', '']) expect(matchingComposerCommands(text, commands)).toEqual([])
  })
  it('recognizes @browser as a mention token like the VS Code Claude integration, not literal text', () => {
    const commands = composerCommands()
    expect(matchingComposerCommands('@', commands).map(command => command.name)).toEqual(['browser'])
    expect(matchingComposerCommands('@bro', commands)).toEqual([{ name: 'browser', description: 'Attach the browser preview to this turn', trigger: '@' }])
    expect(matchingComposerCommands('@model', commands)).toEqual([])
    expect(matchingComposerCommands('/browser', commands)).toEqual([])
    for (const text of ['Use @browser please', '@browser argument', '@file.ts']) expect(matchingComposerCommands(text, commands)).toEqual([])
  })
})
