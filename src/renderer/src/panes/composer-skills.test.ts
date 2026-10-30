import { describe, expect, it } from 'vitest'
import { composerCommandChoice, composerCommands, matchingComposerCommands, nativeCommandNames } from './composer-commands'
import { composerSkills, DISCOVERY_ERROR, invocableSkillNames, skillStatusText } from './composer-skills'
import { resolveSlashCommand } from '../../../shared/slash-commands'
import type { Json, ProviderCapabilities } from '../../../shared/structured-agent'

const claude = { provider: 'claude' } as ProviderCapabilities
const codex = { provider: 'codex' } as ProviderCapabilities
const entry = (name: string, extra: { [key: string]: Json } = {}): Json => ({ name, enabled: true, userInvocable: true, modelInvocable: true, source: 'project', ...extra })
const claudeDiscovery: Json = {
  initialize: { commands: [{ name: 'compact' }, { name: 'review-pr', description: 'Reported by the CLI' }, { name: 'code-review', description: 'Review changes' }] },
  configuration: { slash_commands: ['/compact', '/review-pr', '/code-review'] },
  skillCatalog: { status: 'available', skills: [
    entry('review-pr', { description: 'Review the open pull request', location: '.claude/skills/review-pr/SKILL.md' }),
    entry('deploy', { source: 'user', description: 'Ship it' }),
    entry('model', { description: 'Named like a command' }),
    entry('helper', { userInvocable: false }),
    entry('retired', { enabled: false })
  ] }
}
const codexDiscovery: Json = { skills: { status: 'available', payload: { data: [{ skills: [
  { name: 'research', description: 'Long description', interface: { shortDescription: 'Research a topic' }, scope: 'repo', enabled: true, pluginId: null },
  { name: 'gh:fix-ci', description: 'Fix CI', scope: 'user', enabled: true, pluginId: 'gh@local' },
  { name: 'disabled', description: 'Off', scope: 'user', enabled: false }
] }, { skills: [{ name: 'research', description: 'Duplicate from another root', scope: 'user', enabled: true }] }] } } }

describe('composer skills', () => {
  it('lists Claude skills the owner can invoke as /skill:name, with source and native draft syntax', () => {
    const skills = composerSkills('claude', claudeDiscovery)
    expect(skills.state).toBe('ready')
    expect(skills.skills.map(skill => skill.name)).toEqual(['deploy', 'review-pr'])
    expect(skills.message).toContain('3 skills are agent-only, switched off or named like a command')
    const commands = composerCommands(claude, claudeDiscovery, skills)
    expect(commands.filter(command => command.kind === 'skill')).toEqual([
      { name: 'skill:deploy', description: 'Ship it', insert: '/deploy ', kind: 'skill', source: 'User skill' },
      { name: 'skill:review-pr', description: 'Review the open pull request', insert: '/review-pr ', kind: 'skill', source: 'Project skill' }
    ])
    // The CLI's own report of the same skill is not listed a second time; other commands stay.
    expect(commands.filter(command => command.name === 'review-pr')).toEqual([])
    expect(commands.find(command => command.name === 'code-review')).toMatchObject({ insert: '/code-review ' })
    expect(commands.find(command => command.name === 'model')).toMatchObject({ description: 'Choose the model for this conversation' })
  })

  it('lists Codex skills once each, as $name drafts, preferring their short description', () => {
    const skills = composerSkills('codex', codexDiscovery)
    expect(skills.skills).toEqual([
      { name: 'gh:fix-ci', description: 'Fix CI', source: 'plugin', syntax: '$' },
      { name: 'research', description: 'Research a topic', source: 'project', syntax: '$' }
    ])
    const commands = composerCommands(codex, codexDiscovery, skills).filter(command => command.kind === 'skill')
    expect(commands.map(command => [command.name, command.insert])).toEqual([['skill:gh:fix-ci', '$gh:fix-ci '], ['skill:research', '$research ']])
  })

  it('offers no skills on runtimes without them, and says why', () => {
    for (const provider of ['local', 'grok'] as const) {
      const skills = composerSkills(provider, claudeDiscovery)
      expect(skills).toEqual({ state: 'unsupported', skills: [] })
      expect(composerCommands({ provider } as ProviderCapabilities, claudeDiscovery, skills).some(command => command.kind === 'skill')).toBe(false)
      expect(skillStatusText(skills, false)).toBe('This runtime has no skills Conductor can list.')
    }
  })

  it('reports loading, failure and an empty catalog', () => {
    expect(composerSkills('claude', undefined, true)).toEqual({ state: 'loading', skills: [] })
    expect(skillStatusText(composerSkills('claude', undefined, true), false)).toBe('Loading skills…')
    const failed = composerSkills('claude', { [DISCOVERY_ERROR]: 'Resume the native conversation before discovering runtime features' })
    expect(failed.state).toBe('error')
    expect(skillStatusText(failed, false)).toContain('Resume the native conversation')
    const isolated = composerSkills('claude', { skillCatalog: { status: 'unavailable', skills: [], message: 'This runtime is started without skills.' } })
    expect(skillStatusText(isolated, false)).toBe('This runtime is started without skills.')
    expect(composerSkills('codex', { skills: { status: 'unavailable', message: 'skills/list failed' } })).toMatchObject({ state: 'error', message: 'Skills are unavailable: skills/list failed' })
    expect(skillStatusText(composerSkills('claude', { skillCatalog: { status: 'available', skills: [] } }), false)).toContain('No skills found')
    expect(invocableSkillNames('claude', undefined)).toBeUndefined()
    expect(invocableSkillNames('claude', { [DISCOVERY_ERROR]: 'x' })).toBeUndefined()
  })

  it('filters by /skill:prefix and by bare name, in a deterministic bounded order', () => {
    const commands = composerCommands(claude, claudeDiscovery)
    expect(matchingComposerCommands('/skill:', commands).map(command => command.name)).toEqual(['skill:deploy', 'skill:review-pr'])
    expect(matchingComposerCommands('/skill:re', commands).map(command => command.name)).toEqual(['skill:review-pr'])
    expect(matchingComposerCommands('/rev', commands).map(command => command.name)).toEqual(['skill:review-pr'])
    expect(matchingComposerCommands('/skill', commands).map(command => command.name)).toEqual(['skills', 'skill:deploy', 'skill:review-pr'])
    expect(matchingComposerCommands('/skill:zzz', commands)).toEqual([])
    const many: Json = { skillCatalog: { status: 'available', skills: Array.from({ length: 260 }, (_, index) => entry(`s${String(259 - index).padStart(3, '0')}`)) } }
    const listed = composerSkills('claude', many)
    expect(listed.skills).toHaveLength(200)
    expect(listed.skills[0]!.name).toBe('s000')
    expect(listed.message).toContain('Only the first skills found are listed.')
    expect(matchingComposerCommands('/skill:', composerCommands(claude, many))).toHaveLength(60)
  })

  it('puts a chosen skill into the draft and never sends it on Enter, Tab or click', () => {
    const [review] = matchingComposerCommands('/skill:review', composerCommands(claude, claudeDiscovery))
    for (const complete of [false, true]) expect(composerCommandChoice(review!, complete)).toEqual({ action: 'draft', text: '/review-pr ' })
    const [research] = matchingComposerCommands('/skill:research', composerCommands(codex, codexDiscovery))
    expect(composerCommandChoice(research!)).toEqual({ action: 'draft', text: '$research ' })
    // Ordinary commands keep their behavior.
    const [status] = matchingComposerCommands('/status', composerCommands(claude))
    expect(composerCommandChoice(status!)).toEqual({ action: 'send', text: '/status' })
    expect(composerCommandChoice({ name: 'browser', description: '', trigger: '@' })).toEqual({ action: 'browser' })
  })

  it('sends the drafted skill in the runtime syntax once the owner sends it', () => {
    const names = invocableSkillNames('claude', claudeDiscovery)
    expect(names).toEqual(['deploy', 'review-pr'])
    expect(resolveSlashCommand('claude', '/review-pr check the auth change', nativeCommandNames(claudeDiscovery), names)).toMatchObject({ kind: 'command', handling: { kind: 'native' } })
    expect(resolveSlashCommand('claude', '/skill:deploy', nativeCommandNames(claudeDiscovery), names)).toMatchObject({ handling: { kind: 'native', as: '/deploy' } })
    // An agent-only or switched-off skill cannot be invoked by name from Chat.
    expect(resolveSlashCommand('claude', '/skill:helper', [], names)).toMatchObject({ kind: 'unknown' })
    expect(resolveSlashCommand('claude', '/skill:retired', [], names)).toMatchObject({ kind: 'unknown' })
    // A $skill draft is an ordinary message.
    expect(resolveSlashCommand('codex', '$research the cache', undefined, invocableSkillNames('codex', codexDiscovery))).toEqual({ kind: 'message' })
  })
})
