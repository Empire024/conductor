import type { Json, ProviderCapabilities } from '../../../shared/structured-agent'
import { findSlashCommand, slashHandling, supportedSlashCommands } from '../../../shared/slash-commands'
export interface ComposerCommand { name: string; description: string; insert?: string; trigger?: '/' | '@'; argumentHint?: string }
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
 *  then what the runtime itself reported (Claude commands and skills, Codex `$skills`). */
export function composerCommands(capabilities?: ProviderCapabilities, discovery?: Json): ComposerCommand[] {
  const provider = capabilities?.provider
  const commands: ComposerCommand[] = supportedSlashCommands(provider)
    .filter(entry => entry.handling.kind !== 'conductor' || (entry.handling.action !== 'plan' || capabilities?.plans) && (entry.handling.action !== 'fork' || capabilities?.fork))
    .map(entry => ({ name: entry.name, description: entry.description, ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}) }))
  commands.push({ name: 'browser', description: 'Attach the browser preview to this turn', trigger: '@' })
  const data = object(discovery)
  const initialized = object(data.initialize), configuration = object(data.configuration)
  const add = (value: unknown, skill = false): void => {
    const item = object(value)
    const raw = typeof value === 'string' ? value : item.name
    if (typeof raw !== 'string' || item.enabled === false) return
    const name = raw.replace(/^[/\$]/, '')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name) || commands.some(command => command.name === name)) return
    // A reported command Conductor maps (Claude's /clear, /model) is already listed under its Conductor name.
    const spec = skill ? undefined : findSlashCommand(name)
    const handling = spec && slashHandling(spec, provider)
    if (handling && handling.kind !== 'unsupported') return
    commands.push({ name, description: typeof item.description === 'string' ? item.description : skill ? 'Use this configured skill' : 'Provider command', insert: (skill ? '$' : '/') + name + ' ', ...(typeof item.argumentHint === 'string' && item.argumentHint ? { argumentHint: item.argumentHint } : {}) })
  }
  for (const list of [initialized.commands, configuration.slash_commands, configuration.commands]) if (Array.isArray(list)) list.forEach(value => add(value))
  const skillGroups = object(object(data.skills).payload).data
  if (Array.isArray(skillGroups)) for (const group of skillGroups) { const skills = object(group).skills; if (Array.isArray(skills)) skills.forEach(value => add(value, true)) }
  return commands
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
  const matches = candidates.filter(command => command.name.toLowerCase().startsWith(query))
  // An alias (/approvals, /clear, /cost) finds the command it names.
  const spec = trigger === '/' && query ? findSlashCommand(query) : undefined
  const aliased = spec && !matches.some(command => command.name === spec.name) ? candidates.filter(command => command.name === spec.name) : []
  return [...matches, ...aliased].slice(0, 60)
}
