import type { StructuredProvider } from './structured-agent'

/**
 * What a `/command` typed into a Chat conversation does, per provider (docs/slash-commands.md).
 * Each CLI's terminal UI runs its own built-in commands; over the structured protocols Conductor
 * speaks (Claude stream-json, the Codex App Server) a typed `/permissions` is either plain text for
 * the model or, for Claude, "isn't available in this environment". So every built-in either maps to
 * the Conductor control that does the same job, runs through the runtime's own protocol call, is
 * passed through to a runtime that executes it headless, or answers inline with why it is not
 * available. A command is never sent to the model by accident.
 */
export type ConductorSlashAction =
  | 'attach' | 'archive' | 'connections' | 'copy' | 'diff' | 'edit' | 'effort' | 'events' | 'export' | 'fork'
  | 'help' | 'history' | 'model' | 'new' | 'permissions' | 'plan' | 'rename' | 'resume' | 'settings' | 'status' | 'stop'
/** A command Conductor runs through the runtime's own protocol method (structured.command). */
export type NativeSlashCommand = 'compact' | 'review'
export type SlashHandling =
  /** A Conductor control does the same job. */
  | { kind: 'conductor'; action: ConductorSlashAction }
  /** The runtime executes the typed command itself (Claude Code runs these headless); `as` sends another spelling. */
  | { kind: 'native'; as?: string }
  /** Conductor calls the runtime's protocol method for it. */
  | { kind: 'protocol'; command: NativeSlashCommand }
  /** The CLI's command is a canned prompt; Conductor sends the same request as a message. */
  | { kind: 'prompt'; prompt: string }
  | { kind: 'unsupported'; reason: string }
type Handler = SlashHandling | ((args: string) => SlashHandling)
export interface SlashCommandSpec {
  name: string
  aliases?: string[]
  description: string
  argumentHint?: string
  /** Every provider, unless the provider has its own entry. */
  all?: Handler
  claude?: Handler
  codex?: Handler
}

const TERMINAL_ONLY = 'is a setting of the terminal UI; Conductor’s chat has no terminal to configure.'
const conductor = (action: ConductorSlashAction): SlashHandling => ({ kind: 'conductor', action })
const unsupported = (reason: string): SlashHandling => ({ kind: 'unsupported', reason })
const native: SlashHandling = { kind: 'native' }

export const CODEX_INIT_PROMPT = 'Generate a file named AGENTS.md that serves as a contributor guide for this repository. Survey the project first: its layout, how to build, test and run it, the coding style and naming conventions, how tests are organized, and the commit and pull-request conventions visible in its history. Write concise, specific instructions an agent can follow (about 200-400 words), using headings such as Project structure, Build and test commands, Coding style, Testing, and Commits and pull requests. If an AGENTS.md already exists, improve it rather than replacing what is still accurate.'
export const RECAP_PROMPT = 'Give a short recap of this conversation so far: the goal, what has been done, what is still open, and the next step. Do not change anything.'

/** The catalog. Order is the order the composer lists them in. */
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: 'permissions', aliases: ['approvals'], description: 'Choose what the agent may do without asking (conversation mode)', argumentHint: '[ask|auto|edit|read-only|plan]', all: conductor('permissions') },
  { name: 'model', description: 'Choose the model for this conversation', argumentHint: '[model]', all: conductor('model') },
  { name: 'effort', description: 'Set the reasoning effort for the next message', argumentHint: '[level]', all: conductor('effort') },
  { name: 'plan', description: 'Plan before making changes', argumentHint: '[prompt]', all: conductor('plan') },
  { name: 'edit', description: 'Work on the task and make changes', all: conductor('edit') },
  { name: 'compact', description: 'Summarize the conversation to free up context', argumentHint: '[instructions]', claude: native, codex: { kind: 'protocol', command: 'compact' }, all: { kind: 'protocol', command: 'compact' } },
  { name: 'review', description: 'Review the current changes and find issues', argumentHint: '[instructions]', codex: { kind: 'protocol', command: 'review' }, claude: unsupported('Claude Code 2.1 has no built-in /review. Use /code-review or /security-review, or ask for a review in a message.') },
  { name: 'init', description: 'Create an instructions file (CLAUDE.md / AGENTS.md) for this repository', claude: native, codex: { kind: 'prompt', prompt: CODEX_INIT_PROMPT } },
  { name: 'status', description: 'Show this conversation’s model, mode, runtime and session', all: conductor('status') },
  { name: 'context', description: 'Show context usage', claude: native, codex: conductor('status') },
  { name: 'usage', aliases: ['cost'], description: 'Show usage and plan limits', claude: { kind: 'native', as: '/usage' }, codex: conductor('status') },
  { name: 'diff', aliases: ['rewind', 'undo'], description: 'Show the files this conversation changed, with revert', all: conductor('diff') },
  { name: 'new', aliases: ['clear'], description: 'Start a new conversation in a new tab', all: conductor('new') },
  { name: 'fork', description: 'Continue in a copy of this conversation', all: conductor('fork') },
  { name: 'rename', description: 'Rename this conversation', argumentHint: '[name]', all: conductor('rename') },
  { name: 'resume', description: 'Reconnect this conversation, or pick a saved one', all: conductor('resume') },
  { name: 'history', description: 'Browse saved conversations', all: conductor('history') },
  { name: 'stop', description: 'Stop the current turn', all: conductor('stop') },
  { name: 'attach', aliases: ['mention', 'add-file'], description: 'Find a workspace file to attach', all: conductor('attach') },
  { name: 'mcp', description: 'Show MCP servers, skills and connections', argumentHint: '[reconnect|enable|disable …]', claude: args => args ? native : conductor('connections'), all: conductor('connections') },
  { name: 'skills', aliases: ['apps', 'plugins', 'hooks', 'agents'], description: 'Show configured skills, plugins and connections', all: conductor('connections') },
  { name: 'settings', aliases: ['config', 'debug-config'], description: 'Open conversation settings', argumentHint: '[key=value]', claude: args => args ? native : conductor('settings'), all: conductor('settings') },
  { name: 'copy', description: 'Copy the last response', all: conductor('copy') },
  { name: 'export', description: 'Copy the whole conversation as Markdown', all: conductor('export') },
  { name: 'archive', description: 'Archive or unarchive this conversation', all: conductor('archive') },
  { name: 'diagnostics', aliases: ['events'], description: 'Open the provider event log', claude: args => args ? native : conductor('events'), all: conductor('events') },
  { name: 'recap', description: 'Recap the conversation so far', claude: native, codex: { kind: 'prompt', prompt: RECAP_PROMPT } },
  { name: 'help', description: 'List the commands this conversation supports', all: conductor('help') },
  // Commands that cannot work in Chat, answered inline instead of reaching the model.
  { name: 'goal', description: 'Set a long-running native goal', claude: native, codex: unsupported('A Codex native goal keeps starting turns on its own, outside the turns Conductor supervises. Describe the goal in a message instead.') },
  { name: 'login', aliases: ['logout'], description: 'Sign in or out of the CLI', claude: unsupported('Conductor uses your existing Claude Code sign-in. Run `claude` in a terminal and use /login or /logout there.'), codex: unsupported('Conductor uses your existing Codex sign-in. Run `codex login` or `codex logout` in a terminal.'), all: unsupported('Conductor uses the runtime’s existing sign-in; sign in or out where that runtime is configured.') },
  { name: 'quit', aliases: ['exit'], description: 'Leave the CLI', all: unsupported('There is no CLI session to leave. Use /stop to stop the turn, or close the tab.') },
  { name: 'side', aliases: ['btw'], description: 'Ask a side question', all: unsupported('Side conversations need the CLI’s side panel. Use /fork to ask in a copy of this conversation.') },
  { name: 'memory', aliases: ['memories'], description: 'Edit the CLI’s memory', all: unsupported('Conductor keeps project memory itself. Edit CLAUDE.md or AGENTS.md in the project to change the CLI’s instructions.') },
  { name: 'add-dir', aliases: ['cd', 'worktree'], description: 'Change the working directories', all: unsupported('A Chat conversation runs in its project folder. Open the other folder as a project, or add writable roots in the project settings.') },
  { name: 'pwd', description: 'Show the working directory', all: conductor('status') },
  { name: 'experimental', aliases: ['setup-default-sandbox', 'sandbox-add-read-dir'], description: 'Change CLI features and sandbox setup', all: unsupported('Conductor manages the sandbox and protocol features it starts the CLI with. Change CLI features with `codex features` in a terminal (docs/codex-compatibility.md).') },
  { name: 'feedback', aliases: ['bug'], description: 'Send feedback to the CLI’s maintainers', all: unsupported('Run the CLI in a terminal to send feedback with its logs.') },
  { name: 'ps', aliases: ['tasks', 'bashes'], description: 'List background terminals', all: unsupported('Background commands appear in the conversation’s activity and in the agent roster; /stop stops the turn.') },
  { name: 'rollout', aliases: ['app', 'daemon', 'import', 'delete', 'voice', 'release-notes', 'upgrade', 'install-github-app', 'privacy-settings', 'pr-comments'], description: 'CLI-only command', all: unsupported('This command only exists in the CLI’s terminal UI. Open the conversation in the CLI view (the CLI button) to use it.') },
  { name: 'vim', aliases: ['keymap', 'theme', 'statusline', 'title', 'raw', 'pets', 'terminal-setup', 'ide', 'tui', 'output-style', 'color', 'focus'], description: 'Terminal UI setting', all: unsupported('This command ' + TERMINAL_ONLY) }
]

export interface SlashInvocation { name: string; args: string }
export type SlashResolution =
  /** Not a command: send the draft as typed. */
  | { kind: 'message' }
  /** `//text`: the escape that sends a message starting with a slash. */
  | { kind: 'literal'; text: string }
  | { kind: 'command'; invocation: SlashInvocation; spec?: SlashCommandSpec; handling: SlashHandling }
  | { kind: 'unknown'; invocation: SlashInvocation; reason: string }

const NAME = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)(?:\s+([\s\S]*))?$/
/** A draft that is a command: `/name` then nothing or whitespace and arguments. `/src/app.ts` is a path, not a command. */
export function parseSlashCommand(text: string): SlashInvocation | undefined {
  const match = NAME.exec(text.trim())
  return match ? { name: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() } : undefined
}
export function findSlashCommand(name: string): SlashCommandSpec | undefined {
  const key = name.toLowerCase()
  return SLASH_COMMANDS.find(spec => spec.name === key || spec.aliases?.includes(key))
}
export function slashHandling(spec: SlashCommandSpec, provider: StructuredProvider | undefined, args = ''): SlashHandling | undefined {
  const handler = (provider === 'claude' ? spec.claude : provider === 'codex' ? spec.codex : undefined) ?? spec.all
  return typeof handler === 'function' ? handler(args) : handler
}
const runtimeName = (provider: StructuredProvider | undefined): string => provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : provider === 'grok' ? 'Grok' : provider === 'local' ? 'the local model' : 'this runtime'

/**
 * What the draft does when sent. `nativeCommands` are the names the runtime reported it runs headless
 * (Claude's initialize commands and init slash_commands); undefined while discovery has not answered.
 * A Conductor mapping wins over a native one (the composer owns model, mode and the session), a
 * reported native command wins over an "unsupported" entry, and anything else is unknown.
 */
export function resolveSlashCommand(provider: StructuredProvider | undefined, text: string, nativeCommands?: readonly string[]): SlashResolution {
  const trimmed = text.trim()
  if (trimmed.startsWith('//')) return { kind: 'literal', text: trimmed.slice(1) }
  const invocation = parseSlashCommand(trimmed)
  if (!invocation) return { kind: 'message' }
  const spec = findSlashCommand(invocation.name)
  const handling = spec && slashHandling(spec, provider, invocation.args)
  const reported = provider === 'claude' && Boolean(nativeCommands?.some(name => name.toLowerCase() === invocation.name))
  if (handling && handling.kind !== 'unsupported' && handling.kind !== 'native') return { kind: 'command', invocation, spec, handling }
  if (reported) return { kind: 'command', invocation, spec, handling: handling?.kind === 'native' ? handling : native }
  if (handling?.kind === 'native') {
    // Claude runs these headless; before discovery answers, the CLI itself is the judge.
    if (provider === 'claude') return { kind: 'command', invocation, spec, handling }
    return { kind: 'unknown', invocation, reason: `/${invocation.name} is a Claude Code command; ${runtimeName(provider)} has no equivalent.` }
  }
  if (handling) return { kind: 'command', invocation, spec, handling }
  // Claude's custom commands and skills are only known from discovery; until it answers, let the CLI decide.
  if (provider === 'claude' && nativeCommands === undefined) return { kind: 'command', invocation, handling: native }
  return { kind: 'unknown', invocation, reason: `/${invocation.name} is not a ${runtimeName(provider)} or Conductor command. Type /help for the list, or start the message with // to send it as text.` }
}

export interface SlashMenuEntry { name: string; description: string; argumentHint?: string; handling: SlashHandling }
/** The commands the composer offers for a provider: everything that does something (no
 *  unsupported entries), aliases left out so each job is listed once. */
export function supportedSlashCommands(provider: StructuredProvider | undefined): SlashMenuEntry[] {
  return SLASH_COMMANDS.flatMap(spec => {
    const handling = slashHandling(spec, provider)
    if (!handling || handling.kind === 'unsupported') return []
    if (handling.kind === 'native' && provider !== 'claude') return []
    return [{ name: spec.name, description: spec.description, ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}), handling }]
  })
}
