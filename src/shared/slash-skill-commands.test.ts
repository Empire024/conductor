import { describe, expect, it } from 'vitest'
import { resolveSlashCommand, skillCommandCollision } from './slash-commands'

describe('/skill:name', () => {
  it('runs a listed Claude skill as its native /name, keeping the typed case and arguments', () => {
    expect(resolveSlashCommand('claude', '/skill:Review-PR 42 please', [], ['review-pr'])).toEqual({ kind: 'command', invocation: { name: 'skill:review-pr', args: '42 please' }, handling: { kind: 'native', as: '/review-pr' } })
    // Before discovery answers, Claude is the judge, as for any other Claude command.
    expect(resolveSlashCommand('claude', '/skill:New-One')).toMatchObject({ kind: 'command', handling: { kind: 'native', as: '/New-One' } })
    // A plugin skill the CLI reported is invocable even though the file scan does not list plugins.
    expect(resolveSlashCommand('claude', '/skill:tools:lint', ['tools:lint'], [])).toMatchObject({ kind: 'command', handling: { kind: 'native', as: '/tools:lint' } })
  })

  it('refuses a skill discovery did not find, without reaching the model', () => {
    const resolution = resolveSlashCommand('claude', '/skill:missing', ['compact'], ['review-pr'])
    expect(resolution).toMatchObject({ kind: 'unknown' })
    if (resolution.kind === 'unknown') expect(resolution.reason).toContain('No skill named missing')
    expect(resolveSlashCommand('codex', '/skill:missing', undefined, ['research'])).toMatchObject({ kind: 'unknown' })
    expect(resolveSlashCommand('claude', '/skill:', [], [])).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('needs a skill name') })
  })

  it('never lets a skill named like a command run that command instead', () => {
    for (const name of ['model', 'clear', 'compact', 'skills']) {
      const resolution = resolveSlashCommand('claude', `/skill:${name}`, [name], [name])
      expect(resolution, name).toMatchObject({ kind: 'unknown' })
    }
    expect(skillCommandCollision('clear')).toContain('another name for /new')
    expect(skillCommandCollision('review-pr')).toBeUndefined()
  })

  it('sends a Codex skill as a $name message, since Codex has no slash form for skills', () => {
    expect(resolveSlashCommand('codex', '/skill:research find the bug', undefined, ['research'])).toEqual({ kind: 'command', invocation: { name: 'skill:research', args: 'find the bug' }, handling: { kind: 'skill', text: '$research' } })
    // Codex skills never collide with slash commands.
    expect(resolveSlashCommand('codex', '/skill:model', undefined, ['model'])).toMatchObject({ handling: { kind: 'skill', text: '$model' } })
  })

  it('answers inline on runtimes without skills', () => {
    for (const provider of ['local', 'grok'] as const) expect(resolveSlashCommand(provider, '/skill:research', undefined, undefined)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('has no skills') })
  })

  it('leaves existing commands, the // escape and paths as they were', () => {
    expect(resolveSlashCommand('claude', '/skills', [], ['skills'])).toMatchObject({ kind: 'command', handling: { kind: 'conductor', action: 'connections' } })
    expect(resolveSlashCommand('claude', '//skill:review-pr now', [], ['review-pr'])).toEqual({ kind: 'literal', text: '/skill:review-pr now' })
    expect(resolveSlashCommand('codex', '/skill/notes.md is wrong')).toEqual({ kind: 'message' })
    expect(resolveSlashCommand('claude', '/model', ['model'], ['model'])).toMatchObject({ kind: 'command', handling: { kind: 'conductor', action: 'model' } })
    // A listed skill typed bare runs natively even when the CLI's own list predates it.
    expect(resolveSlashCommand('claude', '/review-pr', ['compact'], ['review-pr'])).toMatchObject({ kind: 'command', handling: { kind: 'native' } })
    expect(resolveSlashCommand('claude', '/review-pr', ['compact'], [])).toMatchObject({ kind: 'unknown' })
  })
})
