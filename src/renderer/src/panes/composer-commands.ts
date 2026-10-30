import type { Json, ProviderCapabilities } from '../../../shared/structured-agent'
import { findSlashCommand, slashHandling, supportedSlashCommands } from '../../../shared/slash-commands'
import { SKILL_COMMAND_PREFIX } from '../../../shared/skill-catalog'
import { composerSkills, skillComposerCommands, type ComposerSkills } from './composer-skills'
export interface ComposerCommand { name: string; description: string; insert?: string; trigger?: '/' | '@'; argumentHint?: string
  /** A discovered skill (`/skill:name`, composer-skills.ts); `source` says where it was found. */
  kind?: 'skill'; source?: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** The names a runtime reported it runs itself (Claude's initialize commands and init
 *  slash_commands); undefined until discovery has answered. */
export function nativeCommandNames(discovery?: Json): string[] | undefined {
  const data = object(discovery)
  const initialized = object(data.initialize), configuration = object(data.configuration)
  const lists = [initialized.commands, configuration.slash_commands, configuration.commands].filter(Array.isArray) as unknown[][]
  if (!lists.length) return undefined
  return lists.flat().flatMap(value => {
    const raw = typeof value === 'string' ? value : object(value).name
    return typeof raw === 'string' && object(value).enabled !== false ? [raw.replace(/^\//, '')] : []
  })
}
/** The `/` list for a conversation: the provider's supported commands (shared/slash-commands.ts),
 *  then what the runtime itself reported (Claude commands), then its skills as `/skill:name`. */
export function composerCommands(capabilities?: ProviderCapabilities, discovery?: Json, skills: ComposerSkills = composerSkills(capabilities?.provider, discovery)): ComposerCommand[] {
  const provider = capabilities?.provider
  const commands: ComposerCommand[] = supportedSlashCommands(provider)
    .filter(entry => entry.handling.kind !== 'conductor' || (entry.handling.action !== 'plan' || capabilities?.plans) && (entry.handling.action !== 'fork' || capabilities?.fork))
    .map(entry => ({ name: entry.name, description: entry.description, ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}) }))
  commands.push({ name: 'browser', description: 'Attach the browser preview to this turn', trigger: '@' })
  const data = object(discovery)
  const initialized = object(data.initialize), configuration = object(data.configuration)
  // A reported command that is also a listed skill is listed once, as /skill:name.
  const skillNames = new Set(skills.skills.map(skill => skill.name.toLowerCase()))
  const add = (value: unknown): void => {
    const item = object(value)
    const raw = typeof value === 'string' ? value : item.name
    if (typeof raw !== 'string' || item.enabled === false) return
    const name = raw.replace(/^[/\$]/, '')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name) || commands.some(command => command.name === name) || skillNames.has(name.toLowerCase())) return
    // A reported command Conductor maps (Claude's /clear, /model) is already listed under its Conductor name.
    const spec = findSlashCommand(name)
    const handling = spec && slashHandling(spec, provider)
    if (handling && handling.kind !== 'unsupported') return
    commands.push({ name, description: typeof item.description === 'string' ? item.description : 'Provider command', insert: '/' + name + ' ', ...(typeof item.argumentHint === 'string' && item.argumentHint ? { argumentHint: item.argumentHint } : {}) })
  }
  for (const list of [initialized.commands, configuration.slash_commands, configuration.commands]) if (Array.isArray(list)) list.forEach(value => add(value))
  commands.push(...skillComposerCommands(skills))
  return commands
}
export type ComposerCommandChoice = { action: 'browser' } | { action: 'draft'; text: string } | { action: 'send'; text: string }
/** What choosing a list entry does. A skill (or a `$skill`) only goes into the draft, in the
 *  runtime's own syntax: choosing it never sends anything. Tab puts a command that takes arguments
 *  into the draft; otherwise the command runs as if typed and sent. */
export function composerCommandChoice(command: ComposerCommand, complete = false): ComposerCommandChoice {
  if (command.name === 'browser' && command.trigger === '@') return { action: 'browser' }
  if (command.kind === 'skill' || command.insert?.startsWith('$') || complete && (command.insert || command.argumentHint)) return { action: 'draft', text: command.insert ?? '/' + command.name + ' ' }
  return { action: 'send', text: '/' + command.name }
}
const triggerPatterns: Record<'/' | '@', RegExp> = { '/': /^\/[a-zA-Z0-9:_-]*$/, '@': /^@[a-zA-Z0-9:_-]*$/ }
/** The draft while it can open the / or @ command list, '' otherwise: all matchingComposerCommands needs of it. */
export function composerCommandQuery(message: string): string {
  const trigger = message.startsWith('@') ? '@' : message.startsWith('/') ? '/' : undefined
  return trigger && triggerPatterns[trigger].test(message) ? message : ''
}
export function matchingComposerCommands(message: string, commands: ComposerCommand[]): ComposerCommand[] {
  if (!composerCommandQuery(message)) return []
  const trigger = message[0] as '/' | '@'
  const query = message.slice(1).toLowerCase()
  const candidates = commands.filter(command => (command.trigger ?? '/') === trigger)
  // A skill is found by /skill:name and by its bare name (/rev finds /skill:review-pr).
  const matches = candidates.filter(command => command.name.toLowerCase().startsWith(query) || command.kind === 'skill' && query && command.name.slice(SKILL_COMMAND_PREFIX.length).toLowerCase().startsWith(query))
  // An alias (/approvals, /clear, /cost) finds the command it names.
  const spec = trigger === '/' && query ? findSlashCommand(query) : undefined
  const aliased = spec && !matches.some(command => command.name === spec.name) ? candidates.filter(command => command.name === spec.name) : []
  return [...matches, ...aliased].slice(0, 60)
}
