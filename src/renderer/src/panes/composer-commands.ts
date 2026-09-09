import type { Json, ProviderCapabilities } from '../../../shared/structured-agent'
export interface ComposerCommand { name: string; description: string; insert?: string; trigger?: '/' | '@' }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function composerCommands(capabilities?: ProviderCapabilities, discovery?: Json): ComposerCommand[] {
  const commands: ComposerCommand[] = [
    { name: 'attach', description: 'Find a workspace file to attach' },
    { name: 'model', description: 'Choose the model for this conversation' },
    { name: 'settings', description: 'Open conversation settings' },
    { name: 'history', description: 'Browse saved conversations' },
    { name: 'stop', description: 'Stop the current turn' },
    { name: 'resume', description: 'Reconnect this conversation' },
    { name: 'browser', description: 'Attach the browser preview to this turn', trigger: '@' }
  ]
  if (capabilities?.plans) commands.push({ name: 'plan', description: 'Plan before making changes' }, { name: 'edit', description: 'Work on the task and make changes' })
  if (capabilities?.fork) commands.push({ name: 'fork', description: 'Continue in a copy of this conversation' })
  const data = object(discovery)
  const initialized = object(data.initialize), configuration = object(data.configuration)
  const add = (value: unknown, skill = false): void => {
    const item = object(value)
    const raw = typeof value === 'string' ? value : item.name
    if (typeof raw !== 'string' || item.enabled === false) return
    const name = raw.replace(/^[/\$]/, '')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name) || commands.some(command => command.name === name)) return
    commands.push({ name, description: typeof item.description === 'string' ? item.description : skill ? 'Use this configured skill' : 'Provider command', insert: (skill ? '$' : '/') + name + ' ' })
  }
  for (const list of [initialized.commands, configuration.slash_commands, configuration.commands]) if (Array.isArray(list)) list.forEach(value => add(value))
  const skillGroups = object(object(data.skills).payload).data
  if (Array.isArray(skillGroups)) for (const group of skillGroups) { const skills = object(group).skills; if (Array.isArray(skills)) skills.forEach(value => add(value, true)) }
  return commands
}
const triggerPatterns: Record<'/' | '@', RegExp> = { '/': /^\/[a-zA-Z0-9:_-]*$/, '@': /^@[a-zA-Z0-9:_-]*$/ }
export function matchingComposerCommands(message: string, commands: ComposerCommand[]): ComposerCommand[] {
  const trigger = message.startsWith('@') ? '@' : message.startsWith('/') ? '/' : undefined
  if (!trigger || !triggerPatterns[trigger].test(message)) return []
  const query = message.slice(1).toLowerCase()
  return commands.filter(command => (command.trigger ?? '/') === trigger && command.name.toLowerCase().startsWith(query)).slice(0, 30)
}
