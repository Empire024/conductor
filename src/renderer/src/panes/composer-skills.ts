import type { Json, StructuredProvider } from '../../../shared/structured-agent'
import { cleanSkillDescription, isSkillName, SKILL_COMMAND_PREFIX, SKILL_LIMITS, skillSourceLabel, skillSyntax, type SkillSource, type SkillSyntax } from '../../../shared/skill-catalog'
import { skillCommandCollision } from '../../../shared/slash-commands'
import type { ComposerCommand } from './composer-commands'

/**
 * The skills a conversation can invoke, as the composer's `/skill:name` entries
 * (docs/skill-discovery.md). Read from provider discovery: Claude's `skillCatalog` (main-process
 * file scan) and Codex's `skills/list`. Choosing one only writes its native syntax into the draft;
 * nothing is sent until the owner sends the message.
 */
export interface ComposerSkill { name: string; description?: string; source: SkillSource; syntax: SkillSyntax; location?: string }
export interface ComposerSkills {
  state: 'loading' | 'ready' | 'error' | 'unsupported'
  skills: ComposerSkill[]
  /** For the owner: why the list is empty or incomplete. */
  message?: string
}
/** Set on the composer's discovery value when the provider's discovery call failed. */
export const DISCOVERY_ERROR = 'discoveryError'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
const CODEX_SCOPES: Record<string, SkillSource> = { repo: 'project', user: 'user', system: 'system', admin: 'admin' }
const SOURCE_ORDER: Record<SkillSource, number> = { project: 0, user: 1, plugin: 2, admin: 3, system: 4, other: 5 }

function claudeSkills(discovery: Record<string, unknown>): ComposerSkills | undefined {
  const catalog = object(discovery.skillCatalog)
  if (!Array.isArray(catalog.skills)) return undefined
  if (catalog.status === 'unavailable') return { state: 'error', skills: [], message: text(catalog.message) ?? 'Skills are unavailable for this conversation.' }
  const skills = catalog.skills.flatMap((value): ComposerSkill[] => {
    const skill = object(value)
    const name = text(skill.name)
    // An agent-only skill (user-invocable: false) or one switched off in settings is not offered;
    // nor is one whose name a command holds, since `/name` would run that command.
    if (!name || !isSkillName(name) || skill.enabled === false || skill.userInvocable === false || skillCommandCollision(name)) return []
    const description = cleanSkillDescription(text(skill.description))
    const source = typeof skill.source === 'string' && skill.source in SOURCE_ORDER ? skill.source as SkillSource : 'other'
    return [{ name, ...(description ? { description } : {}), source, syntax: '/', ...(text(skill.location) ? { location: text(skill.location) } : {}) }]
  })
  const hidden = catalog.skills.length - skills.length
  const notes = [catalog.truncated === true ? 'Only the first skills found are listed.' : '', hidden > 0 ? `${hidden} skill${hidden === 1 ? ' is' : 's are'} agent-only, switched off or named like a command.` : ''].filter(Boolean)
  return { state: 'ready', skills, ...(notes.length ? { message: notes.join(' ') } : {}) }
}
function codexSkills(discovery: Record<string, unknown>): ComposerSkills | undefined {
  const report = object(discovery.skills)
  if (!Object.keys(report).length) return undefined
  if (report.status === 'unavailable') return { state: 'error', skills: [], message: text(report.message) ? 'Skills are unavailable: ' + text(report.message) : 'Skills are unavailable for this conversation.' }
  const groups = object(report.payload).data
  const skills = (Array.isArray(groups) ? groups : []).flatMap(group => {
    const list = object(group).skills
    return (Array.isArray(list) ? list : []).flatMap((value): ComposerSkill[] => {
      const skill = object(value)
      const name = text(skill.name)?.replace(/^\$/, '')
      if (!name || !isSkillName(name) || skill.enabled === false) return []
      const description = cleanSkillDescription(text(object(skill.interface).shortDescription) ?? text(skill.shortDescription) ?? text(skill.description))
      const source: SkillSource = skill.pluginId ? 'plugin' : CODEX_SCOPES[String(skill.scope)] ?? 'other'
      return [{ name, ...(description ? { description } : {}), source, syntax: '$' }]
    })
  })
  return { state: 'ready', skills }
}
/** The conversation's skills: deduplicated by name (first report wins), sorted by name, bounded. */
export function composerSkills(provider: StructuredProvider | undefined, discovery: Json | undefined, loading = false): ComposerSkills {
  const data = object(discovery)
  // Before the runtime reports its capabilities, the discovery's own shape says whose it is.
  const syntax = skillSyntax(provider) ?? (provider !== undefined ? undefined : Array.isArray(object(data.skillCatalog).skills) ? '/' : Object.keys(object(data.skills)).length ? '$' : undefined)
  if (discovery === undefined) return { state: provider !== undefined && !syntax ? 'unsupported' : loading ? 'loading' : 'ready', skills: [] }
  if (!syntax) return { state: provider === undefined ? 'ready' : 'unsupported', skills: [] }
  if (text(data[DISCOVERY_ERROR])) return { state: 'error', skills: [], message: 'Skills could not be loaded: ' + text(data[DISCOVERY_ERROR]) }
  const found = (syntax === '/' ? claudeSkills(data) : codexSkills(data)) ?? { state: 'ready' as const, skills: [] }
  const seen = new Set<string>()
  const skills = found.skills.filter(skill => !seen.has(skill.name.toLowerCase()) && Boolean(seen.add(skill.name.toLowerCase())))
    .sort((left, right) => left.name.localeCompare(right.name) || SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source])
  const bounded = skills.slice(0, SKILL_LIMITS.skills)
  return { ...found, skills: bounded, ...(bounded.length < skills.length ? { message: [found.message, 'Only the first skills found are listed.'].filter(Boolean).join(' ') } : {}) }
}
/** The names `/skill:name` may resolve to, or undefined until discovery has answered. */
export function invocableSkillNames(provider: StructuredProvider | undefined, discovery: Json | undefined): string[] | undefined {
  const found = composerSkills(provider, discovery)
  return discovery === undefined || found.state !== 'ready' ? undefined : found.skills.map(skill => skill.name)
}
/** `/skill:name` entries for the `/` list. Each inserts the native syntax (`/name ` or `$name `). */
export function skillComposerCommands(skills: ComposerSkills): ComposerCommand[] {
  return skills.skills.map(skill => ({
    name: SKILL_COMMAND_PREFIX + skill.name,
    description: skill.description ?? 'No description',
    insert: skill.syntax + skill.name + ' ',
    kind: 'skill' as const,
    source: skillSourceLabel(skill.source)
  }))
}
/** The line above the list while `/skill…` is typed: loading, failed, none, or a note on what is left out. */
export function skillStatusText(skills: ComposerSkills, listed: boolean): string | undefined {
  if (skills.state === 'loading' && !listed) return 'Loading skills…'
  if (skills.state === 'unsupported') return 'This runtime has no skills Conductor can list.'
  if (skills.state === 'error') return skills.message ?? 'Skills could not be loaded.'
  if (!skills.skills.length) return [skills.message, 'No skills found. Claude reads .claude/skills in the project and ~/.claude/skills; Codex reports its own.'].filter(Boolean).join(' ')
  if (!listed) return `No skill matches. ${skills.skills.length} skill${skills.skills.length === 1 ? '' : 's'} available; type /skill: to list them.`
  return skills.message
}
