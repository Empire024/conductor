import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedDirectoryNames, claudeSkillCatalog, discoverClaudeSkills, parseSkillFrontmatter } from './skill-discovery'
import { SKILL_LIMITS } from '../shared/skill-catalog'

let base: string, project: string, home: string, outside: string
const skill = async (root: string, name: string, body: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), body)
}
const md = (fields: string, body = 'Do the thing.'): string => `---\n${fields}\n---\n${body}\n`
const discover = (environment: NodeJS.ProcessEnv = {}) => discoverClaudeSkills({ cwd: project, home, environment })

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'conductor-skills-'))
  project = join(base, 'project'); home = join(base, 'home'); outside = join(base, 'outside')
  await Promise.all([mkdir(join(project, '.claude', 'skills'), { recursive: true }), mkdir(join(home, '.claude', 'skills'), { recursive: true }), mkdir(outside, { recursive: true })])
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('Claude skill discovery', () => {
  it('lists project and user skills by name, user first on a collision, with where each came from', async () => {
    await skill(join(project, '.claude', 'skills'), 'review-pr', md('name: review-pr\ndescription: Review the open pull request'))
    await skill(join(project, '.claude', 'skills'), 'deploy', md('description: "Ship it: carefully"'))
    await skill(join(home, '.claude', 'skills'), 'deploy', md('description: My personal deploy'))
    await skill(join(home, '.claude', 'skills'), 'notes', 'No frontmatter at all.')
    const catalog = await discover()
    expect(catalog.status).toBe('available')
    expect(catalog.skills).toEqual([
      { name: 'deploy', description: 'My personal deploy', source: 'user', enabled: true, userInvocable: true, modelInvocable: true, location: '~/.claude/skills/deploy/SKILL.md' },
      { name: 'notes', source: 'user', enabled: true, userInvocable: true, modelInvocable: true, location: '~/.claude/skills/notes/SKILL.md' },
      { name: 'review-pr', description: 'Review the open pull request', source: 'project', enabled: true, userInvocable: true, modelInvocable: true, location: '.claude/skills/review-pr/SKILL.md' }
    ])
    expect(catalog.shadowed).toEqual([{ name: 'deploy', source: 'project', by: 'user' }])
    expect(catalog.roots).toEqual([{ source: 'user', location: '~/.claude/skills', state: 'read' }, { source: 'project', location: '.claude/skills', state: 'read' }])
  })

  it('reads the user root from CLAUDE_CONFIG_DIR and reports missing roots', async () => {
    const config = join(base, 'config')
    await skill(join(config, 'skills'), 'from-config', md('description: Configured'))
    await rm(join(project, '.claude'), { recursive: true })
    const catalog = await discover({ CLAUDE_CONFIG_DIR: config })
    expect(catalog.skills.map(entry => entry.name)).toEqual(['from-config'])
    expect(catalog.roots).toEqual([{ source: 'user', location: join(config, 'skills'), state: 'read' }, { source: 'project', location: '.claude/skills', state: 'missing' }])
  })

  it('skips malformed, oversized, binary and badly named skills without failing the scan', async () => {
    const root = join(project, '.claude', 'skills')
    await skill(root, 'good', md('description: Fine'))
    await skill(root, 'unclosed', '---\ndescription: never closed\n')
    await skill(root, 'not-yaml', md('- a list item'))
    await skill(root, 'huge', md('description: big', 'x'.repeat(SKILL_LIMITS.fileBytes)))
    await skill(root, 'binary', md('description: has\u0000nul'))
    await skill(root, 'bad name!', md('description: spaces'))
    await mkdir(join(root, 'no-skill-file'))
    await writeFile(join(root, 'loose-file.md'), 'not a folder')
    await skill(root, '.hidden', md('description: hidden'))
    const catalog = await discover()
    expect(catalog.skills.map(entry => entry.name)).toEqual(['good'])
    expect(catalog.skipped).toBe(5)
  })

  it('ignores symlinks that leave their root, and a project skills folder outside the project', async () => {
    const root = join(project, '.claude', 'skills')
    await skill(outside, 'escaped', md('description: Outside the project'))
    await symlink(join(outside, 'escaped'), join(root, 'escaped'), 'dir')
    await mkdir(join(root, 'linked-file'))
    await symlink(join(outside, 'escaped', 'SKILL.md'), join(root, 'linked-file', 'SKILL.md'))
    await skill(root, 'real', md('description: Inside'))
    await symlink(join(root, 'real'), join(root, 'alias'), 'dir')
    const catalog = await discover()
    expect(catalog.skills.map(entry => entry.name)).toEqual(['alias', 'real'])
    expect(catalog.skipped).toBe(2)

    await rm(root, { recursive: true })
    await symlink(outside, root, 'dir')
    const moved = await discover()
    expect(moved.skills).toEqual([])
    expect(moved.roots?.[1]).toEqual({ source: 'project', location: '.claude/skills', state: 'outside-project' })
  })

  it('applies invocation frontmatter and settings overrides, ignoring a settings file Claude would reject', async () => {
    const root = join(project, '.claude', 'skills')
    await skill(root, 'agent-only', md('description: For the model\nuser-invocable: false'))
    await skill(root, 'owner-only', md('description: For the owner\ndisable-model-invocation: yes'))
    await skill(root, 'switched-off', md('description: Off in settings'))
    await skill(root, 'kept', md('description: Kept'))
    await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { 'switched-off': 'off', 'kept': 'user-invocable-only' } }))
    await writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { kept: 'off', other: true } }))
    const byName = Object.fromEntries((await discover()).skills.map(entry => [entry.name, entry]))
    expect(byName['agent-only']).toMatchObject({ userInvocable: false, enabled: true })
    expect(byName['owner-only']).toMatchObject({ userInvocable: true, modelInvocable: false })
    expect(byName['switched-off']).toMatchObject({ enabled: false })
    expect(byName.kept).toMatchObject({ enabled: true, modelInvocable: false })
  })

  it('stops at the skill bound with a deterministic, sorted prefix', async () => {
    const root = join(project, '.claude', 'skills')
    const names = Array.from({ length: SKILL_LIMITS.skills + 5 }, (_, index) => `s${String(SKILL_LIMITS.skills + 4 - index).padStart(3, '0')}`)
    for (const name of names) await skill(root, name, md('description: x'))
    const catalog = await discover()
    expect(catalog.truncated).toBe(true)
    expect(catalog.skills).toHaveLength(SKILL_LIMITS.skills)
    expect(catalog.skills[0]!.name).toBe('s000')
    expect(catalog.skills.at(-1)!.name).toBe(`s${String(SKILL_LIMITS.skills - 1).padStart(3, '0')}`)
  })

  it('counts hidden entries toward the per-root bound, so a root of dot entries is still read a bounded amount', async () => {
    // An endless directory of hidden names: enumeration must stop at the bound, not run forever.
    let yielded = 0, closed = false
    const endless = async () => ({
      async *[Symbol.asyncIterator]() { for (;;) { yielded++; yield { name: `.hidden-${yielded}` } } },
      async close() { closed = true }
    })
    expect(await boundedDirectoryNames('/unused', 5, endless)).toEqual({ names: [], truncated: true })
    expect(yielded).toBe(6)
    expect(closed).toBe(true)
    // Exactly at the bound is complete, not truncated; visible names among the counted entries are kept.
    const listing = (names: string[]) => async () => ({ async *[Symbol.asyncIterator]() { for (const name of names) yield { name } }, async close() {} })
    expect(await boundedDirectoryNames('/unused', 3, listing(['.a', 'b', '.c']))).toEqual({ names: ['b'], truncated: false })
    expect(await boundedDirectoryNames('/unused', 3, listing(['.a', '.b', '.c', 'late']))).toEqual({ names: [], truncated: true })

    const root = join(project, '.claude', 'skills')
    await Promise.all(Array.from({ length: SKILL_LIMITS.entriesPerRoot + 1 }, (_, index) => writeFile(join(root, `.dot-${index}`), '')))
    const catalog = await discover()
    expect(catalog.truncated).toBe(true)
    expect(catalog.skills).toEqual([])
    expect(catalog.roots?.[1]).toEqual({ source: 'project', location: '.claude/skills', state: 'read', truncated: true })
  })

  it('cleans untrusted descriptions to one bounded line', async () => {
    await skill(join(project, '.claude', 'skills'), 'noisy', md(`description: >\n  First line\n  second‮ line\u0007 ${'y'.repeat(300)}`))
    const [entry] = (await discover()).skills
    expect(entry!.description!.startsWith('First line second line y')).toBe(true)
    expect(entry!.description!.length).toBe(SKILL_LIMITS.description)
    expect(entry!.description!.endsWith('…')).toBe(true)
  })

  it('reports isolated runtimes and scan failures as unavailable rather than failing discovery', async () => {
    expect(await claudeSkillCatalog({ cwd: project, home, environment: {}, isolated: true })).toEqual({ status: 'unavailable', skills: [], message: 'This runtime is started without skills.' })
    const catalog = await claudeSkillCatalog({ cwd: project, home, environment: { CLAUDE_CONFIG_DIR: join(base, 'missing') } })
    expect(catalog.status).toBe('available')
  })
})

describe('SKILL.md frontmatter', () => {
  it('reads the keys the menu needs from the YAML subset skills use', () => {
    expect(parseSkillFrontmatter('---\nname: x\ndescription: \'It\'\'s fine\' # note\nuser-invocable: "false"\n---\nbody')).toEqual({ kind: 'parsed', name: 'x', description: 'It\'s fine', userInvocable: false })
    expect(parseSkillFrontmatter('﻿---\r\ndescription: |\r\n  one\r\n  two\r\ndisable-model-invocation: on\r\n---\r\n')).toEqual({ kind: 'parsed', description: 'one\ntwo', disableModelInvocation: true })
    expect(parseSkillFrontmatter('---\ndescription: plain # comment\n  continued\nallowed-tools:\n  - Bash\n---')).toEqual({ kind: 'parsed', description: 'plain continued' })
    expect(parseSkillFrontmatter('# Title\n---\n')).toEqual({ kind: 'missing' })
    expect(parseSkillFrontmatter('---\ndescription: "unterminated\n---')).toEqual({ kind: 'malformed' })
  })
})
