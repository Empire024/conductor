import { describe, expect, it } from 'vitest'
import { findSlashCommand, parseSlashCommand, resolveSlashCommand, SLASH_COMMANDS, supportedSlashCommands } from './slash-commands'

// Claude Code 2.1.301's headless initialize commands (a subset): what stream-json runs itself.
const CLAUDE_NATIVE = ['compact', 'clear', 'context', 'init', 'mcp', 'model', 'effort', 'rename', 'usage', 'config', 'color', 'import', 'code-review', 'goal', 'recap', 'debug']
// Codex 0.159's TUI built-ins (codex-rs/tui slash_command.rs), every one of which must resolve to something.
const CODEX_BUILTINS = ['model', 'permissions', 'approvals', 'keymap', 'vim', 'setup-default-sandbox', 'experimental', 'memories', 'skills', 'import', 'hooks', 'review', 'rename', 'new', 'archive', 'delete', 'resume', 'fork', 'worktree', 'app', 'init', 'compact', 'recap', 'plan', 'voice', 'goal', 'side', 'btw', 'copy', 'export', 'raw', 'diff', 'mention', 'status', 'daemon', 'cd', 'pwd', 'usage', 'debug-config', 'statusline', 'title', 'theme', 'pets', 'mcp', 'apps', 'plugins', 'logout', 'quit', 'exit', 'feedback', 'rollout', 'ps', 'clear', 'ide']
// Claude Code's terminal-only built-ins that stream-json answers "isn't available in this environment".
const CLAUDE_TUI_ONLY = ['permissions', 'help', 'resume', 'login', 'logout', 'status', 'memory', 'hooks', 'agents', 'ide', 'vim', 'terminal-setup', 'export', 'add-dir', 'bug', 'release-notes', 'privacy-settings', 'exit', 'rewind', 'theme', 'statusline', 'diff', 'copy', 'plan', 'tasks', 'btw', 'upgrade', 'install-github-app', 'pr-comments']

describe('slash command parsing', () => {
  it('takes a name and its arguments, and leaves paths and prose alone', () => {
    expect(parseSlashCommand('/permissions')).toEqual({ name: 'permissions', args: '' })
    expect(parseSlashCommand('  /Model  gpt-6.1-sol ')).toEqual({ name: 'model', args: 'gpt-6.1-sol' })
    expect(parseSlashCommand('/review focus on\nthe IPC layer')).toEqual({ name: 'review', args: 'focus on\nthe IPC layer' })
    expect(parseSlashCommand('/anthropic-skills:pdf merge these')).toEqual({ name: 'anthropic-skills:pdf', args: 'merge these' })
    for (const text of ['/src/main/index.ts is broken', 'please run /compact', '/', '/ space', 'plain']) expect(parseSlashCommand(text)).toBeUndefined()
  })
  it('sends // as a literal slash message', () => {
    expect(resolveSlashCommand('codex', '//permissions is what I typed')).toEqual({ kind: 'literal', text: '/permissions is what I typed' })
    expect(resolveSlashCommand('codex', 'not a command')).toEqual({ kind: 'message' })
  })
})

describe('Codex built-ins', () => {
  it('maps /permissions to the conversation mode instead of sending it to the model (the reported bug)', () => {
    expect(resolveSlashCommand('codex', '/permissions')).toMatchObject({ kind: 'command', handling: { kind: 'conductor', action: 'permissions' } })
    expect(resolveSlashCommand('codex', '/approvals auto')).toMatchObject({ kind: 'command', invocation: { name: 'approvals', args: 'auto' }, handling: { kind: 'conductor', action: 'permissions' } })
  })
  it('runs /compact and /review through the App Server and /init as Codex’s own prompt', () => {
    expect(resolveSlashCommand('codex', '/compact')).toMatchObject({ handling: { kind: 'protocol', command: 'compact' } })
    expect(resolveSlashCommand('codex', '/review base main')).toMatchObject({ invocation: { args: 'base main' }, handling: { kind: 'protocol', command: 'review' } })
    expect(resolveSlashCommand('codex', '/init')).toMatchObject({ handling: { kind: 'prompt', prompt: expect.stringContaining('AGENTS.md') } })
  })
  it('resolves every Codex TUI built-in to an action or an inline reason; none reaches the model', () => {
    for (const name of CODEX_BUILTINS) {
      const resolution = resolveSlashCommand('codex', '/' + name)
      expect(resolution.kind, name).toBe('command')
      if (resolution.kind === 'command') expect(resolution.handling.kind, name).not.toBe('native')
      if (resolution.kind === 'command' && resolution.handling.kind === 'unsupported') expect(resolution.handling.reason.length, name).toBeGreaterThan(20)
    }
  })
  it('answers an unknown command inline and names the escape', () => {
    const resolution = resolveSlashCommand('codex', '/frobnicate now')
    expect(resolution).toMatchObject({ kind: 'unknown', invocation: { name: 'frobnicate' } })
    if (resolution.kind === 'unknown') expect(resolution.reason).toMatch(/\/help.*\/\//)
  })
})

describe('Claude built-ins', () => {
  it('passes the commands Claude runs headless through as typed', () => {
    for (const name of ['compact', 'context', 'init', 'goal', 'recap', 'code-review', 'color', 'import', 'debug']) expect(resolveSlashCommand('claude', `/${name} x`, CLAUDE_NATIVE), name).toMatchObject({ kind: 'command', handling: { kind: 'native' } })
    expect(resolveSlashCommand('claude', '/cost', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'native', as: '/usage' } })
    expect(resolveSlashCommand('claude', '/config theme=dark', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'native' } })
    expect(resolveSlashCommand('claude', '/mcp reconnect fixture', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'native' } })
  })
  it('keeps the model, effort, mode, name and session with the composer, not the CLI', () => {
    expect(resolveSlashCommand('claude', '/model opus', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'conductor', action: 'model' } })
    expect(resolveSlashCommand('claude', '/effort high', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'conductor', action: 'effort' } })
    expect(resolveSlashCommand('claude', '/rename Build fix', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'conductor', action: 'rename' } })
    expect(resolveSlashCommand('claude', '/clear', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'conductor', action: 'new' } })
    expect(resolveSlashCommand('claude', '/config', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'conductor', action: 'settings' } })
    expect(resolveSlashCommand('claude', '/mcp', CLAUDE_NATIVE)).toMatchObject({ handling: { kind: 'conductor', action: 'connections' } })
  })
  it('never passes a terminal-only command to stream-json, where it would answer "isn’t available"', () => {
    for (const name of CLAUDE_TUI_ONLY) {
      const resolution = resolveSlashCommand('claude', '/' + name, CLAUDE_NATIVE)
      expect(resolution.kind, name).toBe('command')
      if (resolution.kind === 'command') expect(resolution.handling.kind, name).not.toBe('native')
    }
  })
  it('lets the CLI judge an unrecognised name only until discovery has answered', () => {
    expect(resolveSlashCommand('claude', '/my-custom-command', undefined)).toMatchObject({ kind: 'command', handling: { kind: 'native' } })
    expect(resolveSlashCommand('claude', '/my-custom-command', CLAUDE_NATIVE)).toMatchObject({ kind: 'unknown' })
    expect(resolveSlashCommand('claude', '/my-custom-command', [...CLAUDE_NATIVE, 'my-custom-command'])).toMatchObject({ kind: 'command', handling: { kind: 'native' } })
  })
})

describe('the catalog', () => {
  it('has unique names and aliases', () => {
    const names = SLASH_COMMANDS.flatMap(spec => [spec.name, ...spec.aliases ?? []])
    expect(new Set(names).size).toBe(names.length)
    expect(findSlashCommand('APPROVALS')?.name).toBe('permissions')
  })
  it('lists only commands that do something for the provider', () => {
    const codex = supportedSlashCommands('codex').map(entry => entry.name)
    expect(codex).toEqual(expect.arrayContaining(['permissions', 'model', 'compact', 'review', 'init', 'status', 'diff', 'new', 'mcp', 'help']))
    expect(codex).not.toContain('vim')
    expect(codex).not.toContain('goal')
    const claude = supportedSlashCommands('claude').map(entry => entry.name)
    expect(claude).toEqual(expect.arrayContaining(['permissions', 'compact', 'context', 'init', 'goal']))
    expect(claude).not.toContain('review')
    expect(supportedSlashCommands('local').map(entry => entry.name)).toContain('compact')
  })
})
