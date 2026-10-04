import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEvent, AgentEvent, Json, SessionSettings } from '../../shared/structured-agent'
import { replayAgentEvents } from '../../shared/structured-agent-reducer'
import { autoModeDenialOf } from '../../shared/auto-mode-denial'
import { ClaudeAdapter, CLAUDE_COMPATIBILITY, claudeCompatibility, claudeHookHealth, HOOK_FREE_READ_TOOLS, PRE_TOOL_USE_MATCHER, resetClaudeHookHealth } from './claude'
import { JsonLineDecoder, JsonLineTransport, type TransportOptions } from './transport'
import { SteeringUnavailableError, type AdapterOptions } from './adapter'
import { resolve, join } from 'node:path'
import { setClaudeTokenSource } from '../claude-login'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

const settings: SessionSettings = { permission: 'default', plan: false }
const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }
class FakeTransport {
  connected = false
  autoControlResponses = true
  sent: Json[] = []
  constructor(readonly options: TransportOptions, private autoInitialize = true) {}
  start(): void { this.connected = true }
  close(): void { this.connected = false }
  send(value: Json): void {
    if (!this.connected) throw new Error('Disconnected')
    this.sent.push(value)
    const message = value as { type?: string; request_id?: string; request?: { subtype?: string } }
    if (this.autoControlResponses && message.type === 'control_request' && (message.request?.subtype !== 'initialize' || this.autoInitialize)) queueMicrotask(() => this.receive({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id!, response: { models: [{ value: 'fixture-model', displayName: 'Synthetic model' }], ...(message.request?.subtype === 'initialize' ? { current_permission_mode: this.options.args[this.options.args.indexOf('--permission-mode') + 1] } : {}) } } }))
  }
  receive(value: Json): void { this.options.onMessage(value) }
}
const adapters: ClaudeAdapter[] = []
const imageRoots: string[] = []
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); for (const root of imageRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
function fixture(overrides: Partial<AdapterOptions> = {}, autoInitialize = true, runtimeVersion = CLAUDE_COMPATIBILITY) {
  const events: AdapterEvent[] = []
  let transport!: FakeTransport
  const adapter = new ClaudeAdapter({ executable: 'synthetic-claude', cwd: process.cwd(), runtimeId: 'incarnation-A', settings, emit: (event) => events.push(event), ...overrides }, {
    version: async () => runtimeVersion, createTransport: (options) => transport = new FakeTransport(options, autoInitialize)
  })
  adapters.push(adapter)
  return { adapter, events, get transport() { return transport }, projection: () => replayAgentEvents('session', events.map((event, i): AgentEvent => ({ schemaVersion: 1, id: `event-${i}`, sequence: i + 1, sessionId: 'session', runtimeId: 'incarnation-A', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: process.cwd(), timestamp: '2026-09-07T00:00:00.000Z', ...event }))) }
}
function toolUse(id: string, name: string, input: Json, parent: string | null = null): Json {
  return { type: 'assistant', uuid: `msg-${id}`, parent_tool_use_id: parent, message: { id: `native-${id}`, content: [{ type: 'tool_use', id, name, input }] } }
}
function permission(id: string, toolId: string, name: string, input: Json): Json {
  return { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_use_id: toolId, tool_name: name, input } }
}
function hook(requestId: string, callback: string, toolId: string, name: string, input: Json, response?: Json): Json {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: callback, tool_use_id: toolId, input: { tool_use_id: toolId, tool_name: name, tool_input: input, ...(response !== undefined ? { tool_response: response } : {}) } } }
}

describe('Claude CLI bridge — synthetic raw protocol, zero inference', () => {
  it('classifies a safeguards result as a refusal without mistaking a usage limit for one', async () => {
    const refused = fixture()
    await refused.adapter.start(); await refused.adapter.submit('Safe ordinary request', { ...settings, model: 'claude-fable-5-1' })
    refused.transport.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "API Error: Fable 5.1's safeguards flagged this message. This sometimes happens with safe, normal conversations.", usage: {} })
    expect(refused.events.find(event => event.data.type === 'error')?.data).toMatchObject({ type: 'error', code: 'provider_safeguard_refusal' })

    const limited = fixture()
    await limited.adapter.start(); await limited.adapter.submit('Long request', settings)
    limited.transport.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your session limit · resets in 2 hours", usage: {} })
    expect(limited.events.find(event => event.data.type === 'error')?.data).not.toHaveProperty('code')
  })
  it('fails a turn the CLI answered with an expired login as a lost login, never as a completed turn (logged-out-alert)', async () => {
    // The frames Claude Code 2.1.282 sent on 2026-10-01 when its OAuth refresh failed.
    const expired = fixture()
    await expired.adapter.start(); await expired.adapter.submit('Timer fired', settings)
    expired.transport.receive({ type: 'assistant', uuid: 'synthetic-auth', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'synthetic-auth-message', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }], usage: { input_tokens: 0, output_tokens: 0 } } })
    expired.transport.receive({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: null, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', usage: {} })
    const error = expired.events.find(event => event.data.type === 'error')?.data
    expect(error).toMatchObject({ type: 'error', code: 'provider_auth_expired', authSource: 'login', message: expect.stringMatching(/^Claude login expired: tap Log in on the phone/) })
    expect(error).toMatchObject({ message: expect.stringContaining('OAuth session expired') })
    expect(expired.events.filter(event => event.data.type === 'session').at(-1)?.data).toMatchObject({ phase: 'failed' })

    // Older wording, result frame only: still a lost login.
    const missing = fixture()
    await missing.adapter.start(); await missing.adapter.submit('Work', settings)
    missing.transport.receive({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} })
    expect(missing.events.find(event => event.data.type === 'error')?.data).toMatchObject({ code: 'provider_auth_expired' })

    // An ordinary failure is not one, and the flag never leaks into the next turn.
    const ordinary = fixture()
    await ordinary.adapter.start(); await ordinary.adapter.submit('Work', settings)
    ordinary.transport.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 500 overloaded', usage: {} })
    expect(ordinary.events.find(event => event.data.type === 'error')?.data).not.toHaveProperty('code')
  })

  it('starts the CLI with the long-lived token when one is active and says which login a refused turn used', async () => {
    const token = 'sk-ant-oat01-' + 'x'.repeat(40)
    setClaudeTokenSource(() => token)
    try {
      const f = fixture({ environment: { PATH: 'p' } })
      await f.adapter.start()
      expect(f.transport.options.environment).toEqual({ PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: token })
      expect(f.adapter.authEnvironment()).toBe('token')
      await f.adapter.submit('Work', settings)
      f.transport.receive({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}', usage: {} })
      expect(f.events.find(event => event.data.type === 'error')?.data).toMatchObject({ code: 'provider_auth_expired', authSource: 'token' })
      // The token never reaches an event a window or phone hears.
      expect(JSON.stringify(f.events)).not.toContain(token)
    } finally { setClaudeTokenSource(null) }
    const plain = fixture({ environment: { PATH: 'p' } })
    await plain.adapter.start()
    expect(plain.transport.options.environment).toEqual({ PATH: 'p' })
    expect(plain.adapter.authEnvironment()).toBe('login')
  })

  it('isolates a host reviewer before startup and refuses a resumed reviewer', async () => {
    const f = fixture({ approvalReviewer: true, mcpConfig: '{"mcpServers":{"unwanted":{}}}' })
    await f.adapter.start()
    const args = f.transport.options.args
    // --bare would drop the owner's OAuth login ("Not logged in"), so isolation is spelled out.
    expect(args).not.toContain('--bare')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args).toContain('--disable-slash-commands')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(f.adapter.capabilities.approvalRouting).toBe('isolated-reviewer')
    await expect(fixture({ approvalReviewer: true, nativeSessionId: 'old-native' }).adapter.start()).rejects.toThrow('fresh isolated')
  })

  it('launches an evaluation turn lean: no settings, skills, tools, MCP servers, grants or plan mode, Conductor hooks kept', async () => {
    const f = fixture({ profile: 'evaluation', settings: { permission: 'default', plan: true }, mcpConfig: 'browser.json', localAssistMcpConfig: 'local.json', conductorMcpConfig: 'conductor.json', permissionGrants: { rules: () => [{ rule: 'Bash(git status)', once: false }], used: vi.fn() } })
    await f.adapter.start()
    const args = f.transport.options.args
    expect(args).not.toContain('--bare')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args).toContain('--disable-slash-commands')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args.filter(arg => arg === '--mcp-config')).toHaveLength(1)
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(args).not.toContain('--settings')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual')
    for (const config of ['browser.json', 'local.json', 'conductor.json']) expect(args).not.toContain(config)
    const initialize = f.transport.sent.find(message => (message as { request?: { subtype?: string } }).request?.subtype === 'initialize') as { request: { hooks: Record<string, unknown> } }
    expect(Object.keys(initialize.request.hooks)).toEqual(expect.arrayContaining(['PreToolUse', 'PostToolUse']))
    expect(f.adapter.capabilities.approvalRouting).not.toBe('isolated-reviewer')
  })

  it('passes the browser and conductor-local configs in one --mcp-config, and neither to a reviewer', async () => {
    const both = fixture({ mcpConfig: 'browser.json', localAssistMcpConfig: 'local.json' })
    await both.adapter.start()
    const args = both.transport.options.args
    expect(args.filter(arg => arg === '--mcp-config')).toHaveLength(1)
    expect(args.slice(args.indexOf('--mcp-config') + 1, args.indexOf('--mcp-config') + 3)).toEqual(['browser.json', 'local.json'])
    const local = fixture({ localAssistMcpConfig: 'local.json' })
    await local.adapter.start()
    expect(local.transport.options.args[local.transport.options.args.indexOf('--mcp-config') + 1]).toBe('local.json')
    const reviewer = fixture({ approvalReviewer: true, localAssistMcpConfig: 'local.json' })
    await reviewer.adapter.start()
    expect(reviewer.transport.options.args).not.toContain('local.json')
  })

  it('keeps a managed Auto worker on native auto even when its controller reviews coworkers', async () => {
    const f = fixture({ reviewApprovals: true, settings: { permission: 'auto', plan: false } })
    await f.adapter.start()
    // The review opt-in used to pin the worker to manual, which made every shell command wait for
    // the owner; a worker the owner put on Auto stays on Auto.
    expect(f.transport.options.args[f.transport.options.args.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(f.adapter.capabilities.approvalRouting).toBe('stronger-review')
    await f.adapter.submit('Work', { permission: 'auto', plan: false })
    expect(f.projection().settings.permission).toBe('auto')
  })

  it('launches owner-authorized Full Auto with the native bypass capability and confirms it live', async () => {
    const f = fixture({ settings: { permission: 'auto', plan: false }, claudeFullAutoAuthorized: () => true })
    await f.adapter.start()
    const args = f.transport.options.args
    expect(args).toContain('--allow-dangerously-skip-permissions')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' } }))
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ requestedPermissionMode: 'bypassPermissions', permissionMode: 'bypassPermissions', permissionModeStatus: 'confirmed', claudeFullAutoAuthorized: true })
    const initialize = f.transport.sent.find(value => (value as { request?: { subtype?: string } }).request?.subtype === 'initialize') as { request: { hooks: Record<string, unknown> } }
    expect(Object.keys(initialize.request.hooks)).toEqual(expect.arrayContaining(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']))
    // The native bypass mode reaches nested subagents by inheritance; Conductor's tool hook
    // still sees their non-read tool calls with the same owner policy fence.
    f.transport.receive(hook('nested', 'conductor_before', 'child-tool', 'Bash', { command: 'git status' }))
    await flush()
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { request_id: 'nested', subtype: 'success' } })
  })
  it('records native child PreToolUse mode once per subagent and mode without tool arguments or execution claims', async () => {
    const executionStarted = vi.fn()
    const f = fixture({ settings: { permission: 'auto', plan: false }, claudeFullAutoAuthorized: () => true,
      permissionGrants: { rules: () => [], used: vi.fn(), executionStarted } })
    await f.adapter.start()
    const childHook = (requestId: string, toolUseId: string, mode: string, agentId?: string): Json => ({
      type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: 'conductor_before', tool_use_id: toolUseId,
        input: { hook_event_name: 'PreToolUse', session_id: 'native-session', ...(agentId ? { agent_id: agentId } : {}),
          permission_mode: mode, tool_use_id: toolUseId, tool_name: 'Bash', tool_input: { command: 'private fixture command' } } }
    })
    f.transport.receive(childHook('child-first', 'tool-one', 'bypassPermissions', 'child-one'))
    f.transport.receive(childHook('child-repeat', 'tool-two', 'bypassPermissions', 'child-one'))
    f.transport.receive(childHook('child-change', 'tool-three', 'plan', 'child-one'))
    f.transport.receive(childHook('root', 'tool-four', 'bypassPermissions'))
    await flush()
    const receipts = f.events.filter(event => event.native?.method === 'hook/PreToolUse')
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({ data: { type: 'notice', payload: { session_id: 'native-session', agent_id: 'child-one',
      tool_use_id: 'tool-one', permission_mode: 'bypassPermissions' } }, native: { method: 'hook/PreToolUse', payload: {
      session_id: 'native-session', agent_id: 'child-one', tool_use_id: 'tool-one', permission_mode: 'bypassPermissions' } } })
    expect(receipts[1]).toMatchObject({ native: { payload: { tool_use_id: 'tool-three', permission_mode: 'plan' } } })
    expect(JSON.stringify(receipts)).not.toContain('private fixture command')
    expect(executionStarted).not.toHaveBeenCalled()
  })

  it('keeps legacy Auto classifier-backed without owner policy, and allows explicit Guarded Auto under the policy', async () => {
    const legacy = fixture({ settings: { permission: 'auto', plan: false } })
    await legacy.adapter.start()
    expect(legacy.transport.options.args).not.toContain('--allow-dangerously-skip-permissions')
    expect(legacy.transport.options.args[legacy.transport.options.args.indexOf('--permission-mode') + 1]).toBe('auto')
    legacy.transport.receive({ type: 'system', subtype: 'init', permissionMode: 'auto' })
    expect(legacy.adapter.capabilities.effectiveSettings).toMatchObject({ requestedPermissionMode: 'auto', permissionMode: 'auto', permissionModeStatus: 'confirmed', claudeFullAutoAuthorized: false })

    const guarded = fixture({ settings: { permission: 'auto', claudeGuardedAuto: true, plan: false }, claudeFullAutoAuthorized: () => true })
    await guarded.adapter.start()
    expect(guarded.transport.options.args[guarded.transport.options.args.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(guarded.transport.sent.some(value => JSON.stringify(value).includes('set_permission_mode'))).toBe(false)
  })

  it('downgrades a live bypass runtime on owner policy revocation and fences tools until native acknowledgement', async () => {
    let authorized = true
    const f = fixture({ settings: { permission: 'auto', plan: false }, claudeFullAutoAuthorized: () => authorized })
    await f.adapter.start()
    f.transport.autoControlResponses = false
    authorized = false
    const refreshing = f.adapter.refreshClaudeFullAutoPolicy()
    await flush()
    expect(f.transport.sent.at(-1)).toMatchObject({ request: { subtype: 'set_permission_mode', mode: 'auto' } })
    f.transport.receive(hook('revoked-tool', 'conductor_before', 'tool-after-revoke', 'Bash', { command: 'git status' }))
    await flush()
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { request_id: 'revoked-tool', response: { hookSpecificOutput: { permissionDecision: 'deny' } } } })
    const control = f.transport.sent.slice().reverse().find(value => (value as { request?: { subtype?: string; mode?: string } }).request?.subtype === 'set_permission_mode' && (value as { request?: { mode?: string } }).request?.mode === 'auto') as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: control.request_id, response: { permissionMode: 'auto' } } })
    await expect(refreshing).resolves.toEqual({ status: 'confirmed' })
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ requestedPermissionMode: 'auto', permissionMode: 'auto', permissionModeStatus: 'confirmed', claudeFullAutoAuthorized: false })
  })

  it('reports a deferred restart for an incapable existing process and blocks a failed bypass transition exactly', async () => {
    let authorized = false
    const old = fixture({ settings: { permission: 'auto', plan: false }, claudeFullAutoAuthorized: () => authorized })
    await old.adapter.start()
    old.transport.receive({ type: 'system', subtype: 'init', permissionMode: 'auto' })
    authorized = true
    await expect(old.adapter.refreshClaudeFullAutoPolicy()).resolves.toEqual({ status: 'restart-pending' })
    expect(old.adapter.capabilities.effectiveSettings).toMatchObject({ requestedPermissionMode: 'bypassPermissions', permissionMode: 'auto', permissionModeStatus: 'restart-pending' })
    await expect(old.adapter.submit('Do work', { permission: 'auto', plan: false })).rejects.toThrow('--allow-dangerously-skip-permissions')
    expect(old.transport.sent.some(value => (value as { type?: string }).type === 'user')).toBe(false)

    const blocked = fixture({ settings: { permission: 'default', plan: false }, claudeFullAutoAuthorized: () => true })
    await blocked.adapter.start()
    blocked.transport.receive({ type: 'system', subtype: 'init', permissionMode: 'manual' })
    blocked.transport.autoControlResponses = false
    const sending = blocked.adapter.submit('Full Auto request', { permission: 'auto', plan: false })
    await flush()
    const control = blocked.transport.sent.at(-1) as { request_id: string }
    blocked.transport.receive({ type: 'control_response', response: { subtype: 'error', request_id: control.request_id, error: 'managed policy refused bypassPermissions' } })
    await expect(sending).rejects.toThrow('managed policy refused bypassPermissions')
    expect(blocked.adapter.capabilities.effectiveSettings).toMatchObject({ requestedPermissionMode: 'bypassPermissions', permissionMode: 'manual', permissionModeStatus: 'blocked', permissionModeError: 'managed policy refused bypassPermissions' })
    expect(blocked.transport.sent.some(value => (value as { type?: string }).type === 'user')).toBe(false)
  })

  it('marks an exact managed-policy startup refusal blocked before the process is disposed', async () => {
    const f = fixture({ settings: { permission: 'auto', plan: false }, claudeFullAutoAuthorized: () => true }, false)
    const starting = f.adapter.start()
    await flush()
    f.transport.autoControlResponses = false
    const initialize = f.transport.sent[0] as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: initialize.request_id, response: { models: [], current_permission_mode: 'manual' } } })
    await flush()
    const mode = f.transport.sent.at(-1) as { request_id: string; request: { subtype: string; mode: string } }
    expect(mode.request).toMatchObject({ subtype: 'set_permission_mode', mode: 'bypassPermissions' })
    f.transport.receive({ type: 'control_response', response: { subtype: 'error', request_id: mode.request_id, error: 'Managed disableBypassPermissionsMode refused bypassPermissions' } })
    await expect(starting).rejects.toThrow('Managed disableBypassPermissionsMode refused bypassPermissions')
    const failed = f.events.filter(event => event.data.type === 'session').at(-1)
    expect(failed?.data).toMatchObject({ phase: 'disconnected', capabilities: { effectiveSettings: {
      requestedPermissionMode: 'bypassPermissions', permissionMode: 'manual', permissionModeStatus: 'blocked', permissionModeError: 'Managed disableBypassPermissionsMode refused bypassPermissions'
    } } })
    expect(f.transport.sent.some(value => (value as { type?: string }).type === 'user')).toBe(false)
  })

  it('takes the saved owner Manual mode over an adapter that last submitted Auto', async () => {
    let authorized = false
    const f = fixture({ settings: { permission: 'auto', plan: false }, claudeFullAutoAuthorized: () => authorized })
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', permissionMode: 'auto' })
    authorized = true
    await expect(f.adapter.refreshClaudeFullAutoPolicy({ permission: 'default', plan: false })).resolves.toEqual({ status: 'confirmed' })
    expect(f.transport.sent.at(-1)).not.toMatchObject({ request: { mode: 'bypassPermissions' } })
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ requestedPermissionMode: 'manual', permissionMode: 'manual', permissionModeStatus: 'confirmed', claudeFullAutoAuthorized: true })
  })

  it('reports native pending, progress, and post-hook outcomes with exact identities, never calling progress at PreToolUse', async () => {
    const nativePending = vi.fn(), executionStarted = vi.fn(), executionFinished = vi.fn()
    const f = fixture({ permissionGrants: { rules: () => [], used: vi.fn(), nativePending, executionStarted, executionFinished } })
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', session_id: 'native-grant-session', permissionMode: 'manual' })
    await f.adapter.submit('Run exact tool', settings)
    const input = { command: 'echo exact' }
    f.transport.receive(permission('pending-native', 'tool-exact', 'Bash', input))
    await flush()
    expect(nativePending).toHaveBeenCalledWith({ runtimeId: 'incarnation-A', nativeSessionId: 'native-grant-session', requestId: 'pending-native', toolUseId: 'tool-exact', tool: 'Bash', input })
    f.transport.receive(hook('pre-exact', 'conductor_before', 'tool-exact', 'Bash', input))
    await flush()
    expect(executionStarted).not.toHaveBeenCalled()
    f.transport.receive({ type: 'tool_progress', tool_use_id: 'tool-exact', tool_name: 'Bash', elapsed_time_seconds: 0.01 })
    await flush()
    expect(executionStarted).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'native-grant-session', requestId: 'pending-native', toolUseId: 'tool-exact', input }), 'tool-progress')
    f.transport.receive(hook('post-exact', 'conductor_after', 'tool-exact', 'Bash', input, { exitCode: 0 }))
    await flush()
    expect(executionFinished).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'tool-exact', input }), 'succeeded')

    f.transport.receive(permission('pending-fast', 'tool-fast', 'Bash', { command: 'true' }))
    f.transport.receive(hook('pre-fast', 'conductor_before', 'tool-fast', 'Bash', { command: 'true' }))
    f.transport.receive(hook('post-fast', 'conductor_after', 'tool-fast', 'Bash', { command: 'true' }, { exitCode: 0 }))
    await flush()
    expect(executionStarted).toHaveBeenCalledTimes(1)
    expect(executionFinished).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'tool-fast' }), 'succeeded')
  })

  it('marks accepted Allow once unknown on disconnect before progress, while clearing terminal and cancelled calls', async () => {
    const executionStarted = vi.fn(), executionFinished = vi.fn()
    const f = fixture({ permissionGrants: { rules: () => [], used: vi.fn(), executionStarted, executionFinished } })
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', session_id: 'native-grant-session', permissionMode: 'manual' })
    await f.adapter.submit('Run approved tools', settings)
    const approved = async (requestId: string, toolUseId: string, command: string): Promise<void> => {
      f.transport.receive(permission(requestId, toolUseId, 'Bash', { command }))
      await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId, decision: 'allow' })
    }
    await approved('finished-request', 'finished-tool', 'echo finished')
    f.transport.receive(hook('finished-post', 'conductor_after', 'finished-tool', 'Bash', { command: 'echo finished' }, { exitCode: 0 }))
    await flush()
    await approved('cancelled-request', 'cancelled-tool', 'echo cancelled')
    f.transport.receive({ type: 'control_cancel_request', request_id: 'cancelled-request' })
    await approved('uncertain-request', 'uncertain-tool', 'echo uncertain')
    expect(executionStarted).not.toHaveBeenCalled()
    f.transport.options.onExit?.(1, null)
    expect(executionFinished.mock.calls).toEqual([
      [expect.objectContaining({ nativeSessionId: 'native-grant-session', requestId: 'finished-request', toolUseId: 'finished-tool', input: { command: 'echo finished' } }), 'succeeded'],
      [expect.objectContaining({ nativeSessionId: 'native-grant-session', requestId: 'cancelled-request', toolUseId: 'cancelled-tool', input: { command: 'echo cancelled' } }), 'cancelled'],
      [expect.objectContaining({ nativeSessionId: 'native-grant-session', requestId: 'uncertain-request', toolUseId: 'uncertain-tool', input: { command: 'echo uncertain' } }), 'unknown']
    ])
  })
  it('links an unrepresentable native grant to one approval interaction without losing the exact native request', async () => {
    const nativePending = vi.fn(() => ({ id: 'native-grant:exact' } as import('../../shared/permission-grants').PermissionGrantRequest))
    const f = fixture({ permissionGrants: { rules: () => [], used: vi.fn(), nativePending } })
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', session_id: 'native-grant-session', permissionMode: 'manual' })
    await f.adapter.submit('Run', settings)
    f.transport.receive(permission('pending-native', 'tool-exact', 'Bash', { command: 'echo exact' }))
    await flush()
    expect(f.projection().items.find(item => item.data.type === 'interaction' && item.data.interaction.id === 'pending-native')?.data).toMatchObject({ interaction: { status: 'pending', permissionGrantId: 'native-grant:exact' } })
    expect(nativePending).toHaveBeenCalledTimes(1)
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'pending-native', decision: 'allow' })
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { request_id: 'pending-native', response: { behavior: 'allow', toolUseID: 'tool-exact' } } })
  })

  it('does not replay a cached allow after the native request changes arguments', async () => {
    const f = fixture()
    await f.adapter.start()
    await f.adapter.submit('Edit', settings)
    f.transport.receive(permission('same-id', 'write', 'Write', { file_path: 'a.txt', content: 'one' }))
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'same-id', decision: 'allow' })
    f.transport.receive(permission('same-id', 'write', 'Write', { file_path: 'a.txt', content: 'two' }))
    await flush()
    expect(JSON.stringify(f.transport.sent.at(-1))).toContain('changed arguments')
    expect(JSON.stringify(f.transport.sent.at(-1))).not.toContain('"behavior":"allow"')
  })

  it('returns native PreToolUse denial even for a tool remembered as allowed by the CLI', async () => {
    const beforeTool = vi.fn(), f = fixture({ authorizeTool: async () => 'Persistent owner denial', beforeTool })
    await f.adapter.start()
    f.transport.receive(hook('fence', 'conductor_before', 'tool', 'Write', { file_path: 'a.txt', content: 'x' }))
    await flush()
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ response: expect.objectContaining({ response: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Persistent owner denial' } } }) }))
    expect(beforeTool).not.toHaveBeenCalled()
  })

  it('refuses to send a turn after a successful control reply reports a different effective permission', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.autoControlResponses = false
    const submitted = f.adapter.submit('Auto work', { ...settings, permission: 'auto' })
    await flush()
    const control = f.transport.sent.at(-1) as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: control.request_id, response: { permissionMode: 'default' } } })
    await expect(submitted).rejects.toThrow('native mode remains default')
    expect(f.projection().capabilities?.effectiveSettings).toMatchObject({ permissionMode: 'default' })
    expect(f.transport.sent.some(item => (item as { type?: string }).type === 'user')).toBe(false)
  })

  it('does not repeatedly reset a native resolved model alias or equivalent default permission', async () => {
    const f = fixture({ settings: { ...settings, model: 'haiku' } })
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001', permissionMode: 'default' })
    await f.adapter.submit('Continue', { ...settings, model: 'haiku' })
    expect(f.transport.sent.some(item => /set_model|set_permission_mode/.test(JSON.stringify(item)))).toBe(false)
  })
  it('never sends or reports an effort for a model whose native catalog offers none (Haiku)', async () => {
    const f = fixture({ settings: { ...settings, model: 'opus', effort: 'high' } }, false)
    const starting = f.adapter.start()
    await flush()
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: (f.transport.sent[0] as { request_id: string }).request_id, response: { models: [
      { value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
      { value: 'haiku', displayName: 'Haiku', supportsEffort: false }
    ] } } })
    await starting
    const flags = () => f.transport.sent.filter(item => JSON.stringify(item).includes('apply_flag_settings')).map(item => (item as { request: { settings: { effortLevel: unknown } } }).request.settings.effortLevel)
    // The effort carried over from Opus is dropped for Haiku, and the launch-time effort is cleared.
    await f.adapter.submit('Switch to the cheap model', { ...settings, model: 'haiku', effort: 'high' })
    expect(flags()).toEqual([null])
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ effort: null })
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, usage: {} })
    await flush()
    // Back on a model with a ladder, the chosen effort is sent again.
    await f.adapter.submit('Back to Opus', { ...settings, model: 'opus', effort: 'high' })
    expect(flags()).toEqual([null, 'high'])
  })
  it('connects to patch and minor releases at or above the baseline, recording the unverified gap', async () => {
    expect(claudeCompatibility(CLAUDE_COMPATIBILITY)).toEqual({ supported: true, verified: true })
    expect(claudeCompatibility('2.1.280')).toEqual({ supported: true, verified: false })
    expect(claudeCompatibility('2.2.0')).toEqual({ supported: true, verified: false })
    const f = fixture({}, true, '2.1.280')
    await f.adapter.start()
    expect(f.adapter.capabilities.runtimeVersion).toBe('2.1.280')
    expect(f.adapter.capabilities.limitations.some(limitation => limitation.includes('2.1.280') && limitation.includes('fixture-verified'))).toBe(true)
  })

  it('refuses a CLI below the baseline, a different major, and an unreadable version', async () => {
    expect(claudeCompatibility('2.1.262').supported).toBe(false)
    expect(claudeCompatibility('2.0.999').supported).toBe(false)
    expect(claudeCompatibility('3.0.0').supported).toBe(false)
    expect(claudeCompatibility('unknown').supported).toBe(false)
    // 2.1.263 was the previous baseline; since the 2026-09-21 sweep verified 2.1.278 it is below it.
    await expect(fixture({}, true, '2.1.263').adapter.start()).rejects.toThrow('below the tested 2.1.278 bridge baseline')
  })

  it('awaits initialize and keeps user configuration/native coding prompt and resume identity', async () => {
    const f = fixture({ nativeSessionId: 'native-session' }, false)
    const starting = f.adapter.start()
    await flush()
    expect(f.transport.sent).toHaveLength(1)
    await expect(f.adapter.submit('Too early', settings)).rejects.toThrow('disconnected')
    const first = f.transport.sent[0] as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: first.request_id, response: {} } })
    await starting
    expect(f.transport.options.args).toContain('--resume')
    expect(f.transport.options.args).toContain('native-session')
    expect(f.transport.options.args).toContain('--permission-prompt-tool')
    expect(f.transport.options.args).not.toContain('--system-prompt')
    expect(f.transport.options.args).not.toContain('--bare')
    expect(f.transport.options.args).not.toContain('--setting-sources')
    await f.adapter.submit('Follow up', settings)
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', session_id: 'native-session', message: { content: 'Follow up' } })
  })

  it('reads loaded settings asynchronously and emits only bounded, allowlisted diagnostics', async () => {
    const f = fixture({}, false)
    const starting = f.adapter.start()
    await flush()
    f.transport.autoControlResponses = false
    const initialize = f.transport.sent[0] as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: initialize.request_id,
      response: { current_permission_mode: 'manual' } } })
    await starting
    const getSettings = f.transport.sent.find(message => (message as { request?: { subtype?: string } }).request?.subtype === 'get_settings') as { request_id: string; request: { subtype: string } }
    expect(getSettings.request).toEqual({ subtype: 'get_settings' })
    await f.adapter.submit('A turn can start while settings are pending', settings)
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ type: 'user' }))
    const mode = JSON.stringify(f.adapter.capabilities.effectiveSettings)
    const secret = 'SECRET-DO-NOT-EMIT'
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: getSettings.request_id, response: {
      effective: { permissions: { allow: Array(10_005).fill(`Bash(${secret})`), ask: [secret], deny: [], defaultMode: 'auto', disableBypassPermissionsMode: 'disable' },
        hooks: { PreToolUse: [{ command: secret }], PostToolUse: [{ command: secret }], [secret]: [{ command: secret }] },
        env: { API_KEY: secret }, path: `C:/private/${secret}`, token: secret },
      sources: { userSettings: { permissions: { allow: [secret], defaultMode: 'default' }, hooks: { PermissionDenied: [{ command: secret }] }, path: secret },
        localSettings: { permissions: { ask: [secret], defaultMode: secret, disableBypassPermissionsMode: secret } },
        policySettings: { permissions: { deny: [secret], disableBypassPermissionsMode: 'disable' } },
        [secret]: { permissions: { ask: [secret] } } },
      applied: { token: secret }
    } } })
    await flush()
    const summaries = f.events.filter(event => event.native?.method === 'get_settings/summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.native?.payload).toEqual({ status: 'available',
      effective: { permissions: { allow: 10_000, ask: 1, deny: 0, defaultMode: 'auto', disableBypassPermissionsMode: 'disable' },
        hooks: ['PreToolUse', 'PostToolUse'] },
      sources: [{ name: 'userSettings', permissions: { allow: 1, defaultMode: 'default' }, hooks: ['PermissionDenied'] },
        { name: 'localSettings', permissions: { ask: 1 }, hooks: [] },
        { name: 'policySettings', permissions: { deny: 1, disableBypassPermissionsMode: 'disable' }, hooks: [] }] })
    expect(JSON.stringify(summaries)).not.toContain(secret)
    expect(JSON.stringify(summaries)).not.toContain('path')
    expect(JSON.stringify(f.adapter.capabilities.effectiveSettings)).toBe(mode)
    expect((f.adapter as unknown as { controls: Map<string, unknown> }).controls.size).toBe(0)
  })

  it('reports unsupported and unknown settings responses generically without changing mode', async () => {
    for (const unsupported of [true, false]) {
      const f = fixture({}, false)
      const starting = f.adapter.start()
      await flush()
      f.transport.autoControlResponses = false
      const initialize = f.transport.sent[0] as { request_id: string }
      f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: initialize.request_id,
        response: { current_permission_mode: 'manual' } } })
      await starting
      const mode = JSON.stringify(f.adapter.capabilities.effectiveSettings)
      const request = f.transport.sent.at(-1) as { request_id: string }
      f.transport.receive(unsupported
        ? { type: 'control_response', response: { subtype: 'error', error: 'unsupported SECRET-DO-NOT-EMIT', request_id: request.request_id } }
        : { type: 'control_response', response: { subtype: 'success', response: { arbitrary: 'SECRET-DO-NOT-EMIT' }, request_id: request.request_id } })
      await flush()
      const summary = f.events.filter(event => event.native?.method === 'get_settings/summary')
      expect(summary).toHaveLength(1)
      expect(summary[0]?.native?.payload).toEqual({ status: 'unavailable' })
      expect(JSON.stringify(summary)).not.toContain('SECRET-DO-NOT-EMIT')
      expect(JSON.stringify(f.adapter.capabilities.effectiveSettings)).toBe(mode)
      expect((f.adapter as unknown as { controls: Map<string, unknown> }).controls.size).toBe(0)
    }
  })

  it('times out the settings read in three seconds and retires its control request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const f = fixture({}, false)
      const starting = f.adapter.start()
      await flush()
      f.transport.autoControlResponses = false
      const initialize = f.transport.sent[0] as { request_id: string }
      f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: initialize.request_id,
        response: { current_permission_mode: 'manual' } } })
      await starting
      const mode = JSON.stringify(f.adapter.capabilities.effectiveSettings)
      const request = f.transport.sent.at(-1) as { request_id: string; request: { subtype: string } }
      expect(request.request.subtype).toBe('get_settings')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(f.events.filter(event => event.native?.method === 'get_settings/summary')).toMatchObject([
        { native: { payload: { status: 'unavailable' } } }
      ])
      expect((f.adapter as unknown as { controls: Map<string, unknown> }).controls.size).toBe(0)
      f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
        response: { effective: { env: { token: 'LATE-SECRET' } }, sources: {} } } })
      await flush()
      expect(f.events.filter(event => event.native?.method === 'get_settings/summary')).toHaveLength(1)
      expect(JSON.stringify(f.adapter.capabilities.effectiveSettings)).toBe(mode)
    } finally { vi.useRealTimers() }
  })

  it('publishes fresh capabilities before learning native identity from the first turn', async () => {
    const f = fixture()
    await f.adapter.start()
    expect(f.events.at(-1)?.data).toMatchObject({ type: 'session', phase: 'idle', capabilities: { models: [{ id: 'fixture-model' }] } })
    expect(f.projection().nativeSessionId).toBeUndefined()

    await f.adapter.submit('First prompt', settings)
    f.transport.receive({ type: 'system', subtype: 'init', session_id: 'native-after-first-turn', model: 'fixture-model', claude_code_version: '2.1.263' })

    expect(f.projection()).toMatchObject({ phase: 'running', nativeSessionId: 'native-after-first-turn' })
  })

  it('keeps native permission drift authoritative across startup and resume', async () => {
    const f = fixture({ settings: { ...settings, permission: 'auto' } })
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', model: 'fixture-model', permissionMode: 'auto' })
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ permissionMode: 'auto' })
    await f.adapter.submit('Already auto', { ...settings, permission: 'auto' })
    expect(f.transport.sent.filter(value => JSON.stringify(value).includes('set_permission_mode'))).toHaveLength(0)

    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    f.transport.receive({ type: 'system', subtype: 'init', model: 'fixture-model', permissionMode: 'manual' })
    await f.adapter.submit('Restore auto', { ...settings, permission: 'auto' })
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'auto' } }))
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ permissionMode: 'auto' })
  })

  it('reports an acknowledged native setting without replacing the configured settings', async () => {
    const f = fixture()
    await f.adapter.start()
    await f.adapter.submit('Switch mode', { ...settings, permission: 'accept-edits', effort: 'high' })
    expect(f.projection().settings).toMatchObject({ permission: 'accept-edits', effort: 'high' })
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ permissionMode: 'acceptEdits', effort: 'high' })
    expect(f.events.some(event => event.data.type === 'notice' && event.data.message.includes('acknowledged'))).toBe(true)
  })

  it('reports a rejected native setting and preserves the prior effective mode', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.autoControlResponses = false
    const pending = f.adapter.submit('Rejected mode', { ...settings, permission: 'auto' })
    await flush()
    const request = f.transport.sent.find(value => (value as { type?: string; request?: { subtype?: string } }).request?.subtype === 'set_permission_mode') as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'managed policy denied auto' } })
    await expect(pending).rejects.toThrow('managed policy denied auto')
    expect((f.adapter.capabilities.effectiveSettings as Record<string, Json>)?.permissionMode).not.toBe('auto')
    expect(f.events).toContainEqual(expect.objectContaining({ data: { type: 'error', message: 'managed policy denied auto' } }))
  })

  it('reconciles by message identity, preserves repeated chunks, and never calls input completion execution', async () => {
    const f = fixture()
    await f.adapter.start()
    await f.adapter.submit('Synthetic prompt', settings)
    let seq = 0
    const stream = (event: Json) => f.transport.receive({ type: 'stream_event', uuid: `chunk-${seq++}`, session_id: 'native-1', event })
    stream({ type: 'message_start', message: { id: 'message-1' } })
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ha' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ha' } })
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'shell-1', name: 'PowerShell', input: {} } })
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } })
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Write-Output hé"}' } })
    expect(f.projection().items.find((item) => item.nativeItemId === 'shell-1')?.data).toMatchObject({ inputDelta: '{"command":"Write-Output hé"}', status: 'preparing' })
    stream({ type: 'content_block_stop', index: 1 })
    f.transport.receive({ type: 'assistant', uuid: 'completed-message', session_id: 'native-1', message: { id: 'message-1', content: [{ type: 'text', text: 'haha' }, { type: 'tool_use', id: 'shell-1', name: 'PowerShell', input: { command: 'Write-Output hé' } }] } })
    const projection = f.projection()
    expect(projection.items.filter((item) => item.data.type === 'text')).toHaveLength(1)
    expect(projection.items.find((item) => item.data.type === 'text')?.data).toMatchObject({ text: 'haha' })
    expect(projection.items.find((item) => item.data.type === 'tool')?.data).toMatchObject({ status: 'preparing', name: 'PowerShell', input: { command: 'Write-Output hé' } })
    f.transport.receive({ type: 'tool_progress', tool_use_id: 'shell-1', tool_name: 'PowerShell', elapsed_time_seconds: 1 })
    expect(f.projection().items.find((item) => item.data.type === 'tool')?.data).toMatchObject({ status: 'running' })
  })

  it('keeps interleaved tools and nested native parents correlated; nonzero exit is failure', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive(toolUse('one', 'Bash', { command: 'node test.mjs' }))
    f.transport.receive(toolUse('two', 'Read', { file_path: '日本語 file.mjs' }, 'agent-tool'))
    f.transport.receive({ type: 'user', uuid: 'result-two', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'two', content: 'file data' }] } })
    f.transport.receive({ type: 'user', uuid: 'result-one', tool_use_result: { stdout: 'actual failure', stderr: 'stderr', exitCode: 2 }, message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'actual failure' }] } })
    expect(f.projection().items.find((item) => item.nativeItemId === 'two')).toMatchObject({ parentId: 'agent-tool', data: { name: 'Read', output: 'file data', status: 'completed' } })
    expect(f.projection().items.find((item) => item.nativeItemId === 'one')?.data).toMatchObject({ name: 'Bash', output: 'actual failure', stderr: 'stderr', exitCode: 2, status: 'failed' })
  })

  it('captures auto-approved edit only at genuine pre/post hooks and waits before acknowledging', async () => {
    let release!: () => void
    const beforeTool = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const afterTool = vi.fn(async () => undefined)
    const f = fixture({ beforeTool, afterTool })
    await f.adapter.start()
    const input = { file_path: 'panel.mjs', old_string: 'one\ntwo\n', new_string: '' }
    f.transport.receive(toolUse('edit', 'Edit', input))
    expect(beforeTool).not.toHaveBeenCalled()
    f.transport.receive(hook('pre', 'conductor_before', 'edit', 'Edit', input))
    expect(beforeTool).toHaveBeenCalledWith('edit', ['panel.mjs'])
    expect(f.transport.sent).not.toContainEqual(expect.objectContaining({ type: 'control_response' }))
    release(); await flush()
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'pre', response: {} } })
    f.transport.receive(hook('post', 'conductor_after', 'edit', 'Edit', input, {}))
    await flush()
    expect(afterTool).toHaveBeenCalledWith('edit', ['panel.mjs'], true)
    expect(f.projection().items.find((item) => item.nativeItemId === 'edit')?.data).toMatchObject({ status: 'completed' })
    expect(f.events.some((event) => event.data.type === 'interaction')).toBe(false)
  })

  it('resolves exact approvals once across views, rejects old runtime and sends real deny/abort messages', async () => {
    const beforeTool = vi.fn(async () => undefined)
    const f = fixture({ beforeTool })
    await f.adapter.start()
    const input = { file_path: 'file.txt', content: 'new' }
    f.transport.receive(permission('approval-1', 'write-1', 'Write', input))
    expect(beforeTool).not.toHaveBeenCalled()
    await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'old', requestId: 'approval-1', decision: 'allow' })).rejects.toThrow('expired')
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval-1', decision: 'deny' })
    await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval-1', decision: 'allow' })).rejects.toThrow('stale')
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'approval-1', response: { behavior: 'deny', interrupt: false, toolUseID: 'write-1' } } })
    f.transport.receive(permission('approval-2', 'write-2', 'Write', input))
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval-2', decision: 'abort' })
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'deny', interrupt: true } } })
  })

  it('uses question text keys and preserves the real input when returning multiple answers', async () => {
    const f = fixture()
    await f.adapter.start()
    const input = { questions: [{ question: 'Which systems?', header: 'Systems', options: [{ label: 'Windows' }, { label: 'Linux' }], multiSelect: true }] }
    f.transport.receive(permission('ask', 'question-tool', 'AskUserQuestion', input))
    expect(f.projection().phase).toBe('waiting_input')
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'ask', answers: { 'question:0': ['Windows', 'Linux'] } })
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'ask', response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Which systems?': ['Windows', 'Linux'] } } } } })
  })

  it('records the chosen answers on the resolved interaction so history can read them back', async () => {
    const f = fixture()
    await f.adapter.start()
    const input = { questions: [{ question: 'Which label?', header: 'Label', options: [{ label: 'Ice Berry' }, { label: 'Sun Berry' }] }] }
    f.transport.receive(permission('ask', 'question-tool', 'AskUserQuestion', input))
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'ask', answers: { 'question:0': ['Ice Berry'] } })
    const resolved = f.events.filter(event => event.data.type === 'interaction').map(event => event.data).at(-1)
    expect(resolved).toMatchObject({ interaction: { status: 'resolved', answers: { 'Which label?': 'Ice Berry' } } })
  })

  it('expires cancelled requests, interrupts through control protocol, and does not turn ACK into completion', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(permission('approval', 'tool', 'Bash', { command: 'node --version' }))
    f.transport.receive({ type: 'control_cancel_request', request_id: 'approval' })
    await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval', decision: 'allow' })).rejects.toThrow('stale')
    await f.adapter.interrupt()
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt', cancel_queued: true } })
    expect(f.projection().phase).toBe('interrupting')
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })
    expect(f.projection().phase).toBe('interrupted')
  })

  it('applies model and planning settings through acknowledged control requests and rejects unsupported controls', async () => {
    const f = fixture()
    await f.adapter.start()
    await f.adapter.submit('Plan', { ...settings, model: 'fixture-model', plan: true })
    expect(f.transport.sent.slice(-3)).toEqual([
      expect.objectContaining({ request: { subtype: 'set_model', model: 'fixture-model' } }),
      expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'plan' } }),
      expect.objectContaining({ type: 'user' })
    ])
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    await expect(f.adapter.submit('readonly', { ...settings, permission: 'read-only' })).rejects.toThrow('no Conductor read-only sandbox')
    await f.adapter.submit('effort', { ...settings, effort: 'high' })
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } }))
  })

  it('keeps unknown payloads inspectable and missing usage unknown; disconnect does not resend', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'future_provider_event', payload: { test: 'SYNTHETIC' } })
    expect(f.projection().items.some((item) => item.data.type === 'notice' && item.data.message.includes('future_provider_event'))).toBe(true)
    const sent = f.transport.sent.length
    f.transport.options.onExit?.(1, null)
    expect(f.projection().phase).toBe('disconnected')
    await expect(f.adapter.submit('Retry', settings)).rejects.toThrow('disconnected')
    expect(f.transport.sent).toHaveLength(sent)
  })

  it('decodes fragmented JSON and split Unicode all the way into an adapter projection', async () => {
    const f = fixture()
    await f.adapter.start()
    const errors: Error[] = []
    const decoder = new JsonLineDecoder((message) => f.transport.receive(message), (error) => errors.push(error))
    const frame = Buffer.from(JSON.stringify({ type: 'assistant', uuid: 'unicode-msg', message: { id: 'unicode', content: [{ type: 'text', text: 'Árvíz 日本語 😀' }] } }) + '\r\n')
    for (const byte of frame) decoder.push(Buffer.from([byte]))
    expect(errors).toEqual([])
    expect(f.projection().items.find((item) => item.nativeItemId === 'unicode:text:0')?.data).toMatchObject({ text: 'Árvíz 日本語 😀' })
  })

  it('drives an actual fake process through handshake, approval, hook and result round trips', async () => {
    const events: AdapterEvent[] = []
    const adapter = new ClaudeAdapter({ executable: process.execPath, cwd: process.cwd(), runtimeId: 'fake-process-runtime', settings, emit: (event) => events.push(event) }, {
      version: async () => CLAUDE_COMPATIBILITY, createTransport: (options) => {
        const transport = new JsonLineTransport({ ...options, args: [resolve('scripts/fixtures/claude-runtime.mjs')] })
        const send = transport.send.bind(transport)
        // This older fixture covers the turn protocol; answer the new optional read in the test host.
        transport.send = (message: Json) => {
          const request = message as { type?: string; request_id?: string; request?: { subtype?: string } }
          if (request.type === 'control_request' && request.request?.subtype === 'get_settings') {
            queueMicrotask(() => options.onMessage({ type: 'control_response', response: { subtype: 'success',
              request_id: request.request_id!, response: { effective: {}, sources: {} } } }))
          } else send(message)
        }
        return transport
      }
    })
    adapters.push(adapter)
    await adapter.start()
    await adapter.submit('SYNTHETIC_PROCESS_CONTRACT', settings)
    await vi.waitFor(() => expect(events.some((event) => event.data.type === 'interaction' && event.requestId === 'fake-approval')).toBe(true))
    await adapter.respond({ sessionId: 'session', runtimeId: 'fake-process-runtime', requestId: 'fake-approval', decision: 'allow' })
    await vi.waitFor(() => expect(events.some((event) => event.data.type === 'session' && event.data.phase === 'completed')).toBe(true))
    expect(events.some((event) => event.data.type === 'tool' && event.itemId === 'fake-shell' && event.data.output === 'SYNTHETIC OUTPUT 😀' && event.data.status === 'completed')).toBe(true)
    expect(events.some((event) => event.data.type === 'error')).toBe(false)
  })

  it('accounts runtime-cumulative estimated costs as deltas and keeps per-turn tokens authoritative', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'result', uuid: 'cost-1', subtype: 'success', total_cost_usd: 0.10, usage: { input_tokens: 10, output_tokens: 2 } })
    f.transport.receive({ type: 'result', uuid: 'cost-2', subtype: 'success', total_cost_usd: 0.15, usage: { input_tokens: 20, output_tokens: 3 } })
    f.transport.receive({ type: 'result', uuid: 'cost-3', subtype: 'success', usage: {} })
    const costs = f.events.flatMap((event) => event.data.type === 'usage' && event.data.costUsd !== undefined ? [event.data] : [])
    expect(costs).toHaveLength(2)
    expect(costs[0]).toMatchObject({ costUsd: 0.10, source: 'estimate' })
    expect(costs[1]!.costUsd).toBeCloseTo(0.05)
    expect(costs.reduce((sum, cost) => sum + cost.costUsd!, 0)).toBeCloseTo(0.15)
    expect(f.events.some((event) => event.data.type === 'usage' && event.data.source === 'provider' && event.data.inputTokens === 20 && event.data.costUsd === undefined)).toBe(true)
    const sent = f.transport.sent.length
    await expect(f.adapter.submit('/clear', settings)).rejects.toThrow('new Conductor session')
    expect(f.transport.sent).toHaveLength(sent)
  })

  it('returns discovered configuration metadata without making another runtime request', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', session_id: 'native', tools: ['Bash', 'Edit'], mcp_servers: [] })
    const sent = f.transport.sent.length
    expect(await f.adapter.discover()).toMatchObject({ connection: 'local-cli', runtimeVersion: CLAUDE_COMPATIBILITY, configuration: { tools: ['Bash', 'Edit'], mcp_servers: [] } })
    expect(f.transport.sent).toHaveLength(sent)
  })

  it.each([
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])],
    ['image/jpeg', Buffer.from([255, 216, 255, 224, 0, 16])],
    ['image/gif', Buffer.from('GIF89aSYNTHETIC')],
    ['image/webp', Buffer.from('RIFF0000WEBPSYNTHETIC')]
  ])('encodes explicitly selected %s fixture bytes into native image blocks without altering prompt text', async (mediaType, fixtureBytes) => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-image-contract-')); imageRoots.push(root)
    // Synthetic file headers test wire routing, not live-provider image interpretation.
    const bytes = fixtureBytes as Buffer
    writeFileSync(join(root, 'selected misleading extension.txt'), bytes)
    const f = fixture({ cwd: root })
    await f.adapter.start()
    await f.adapter.submit('Original user text', settings, [{ id: 'selected', kind: 'image', name: 'Selected fixture', path: 'selected misleading extension.txt' }])
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', message: { content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
      { type: 'text', text: 'Original user text' }
    ] } })
  })

  it('rejects invalid, oversized, traversing and junction image sources before any user message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-image-boundary-')); imageRoots.push(root)
    const cwd = join(root, 'workspace'); mkdirSync(cwd)
    writeFileSync(join(cwd, 'invalid.png'), 'not an image')
    writeFileSync(join(cwd, 'oversized.png'), Buffer.alloc(3 * 1024 * 1024 + 1))
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    symlinkSync(outside, join(cwd, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    const f = fixture({ cwd }); await f.adapter.start()
    const sent = f.transport.sent.length
    for (const [path, expected] of [['invalid.png', 'PNG, JPEG'], ['oversized.png', '3 MiB'], ['../outside/private.png', 'outside'], ['junction/private.png', 'junction']]) {
      await expect(f.adapter.submit('Never sent', settings, [{ id: 'image', kind: 'image', name: 'Invalid fixture', path }])).rejects.toThrow(expected)
    }
    expect(f.transport.sent).toHaveLength(sent)
  })

  it('bounds the combined encoded image message before dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-image-limit-')); imageRoots.push(root)
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
    writeFileSync(join(root, 'large.png'), bytes)
    const f = fixture({ cwd: root }); await f.adapter.start()
    const sent = f.transport.sent.length
    await expect(f.adapter.submit('Never sent', settings, [
      { id: 'one', kind: 'image', name: 'One synthetic image', path: 'large.png' },
      { id: 'two', kind: 'image', name: 'Two synthetic images', path: 'large.png' }
    ])).rejects.toThrow('4 MiB combined')
    expect(f.transport.sent).toHaveLength(sent)
  })
})

it('preserves model-specific effort capability metadata from Claude initialization', async () => {
  const f = fixture({}, false)
  const starting = f.adapter.start()
  await flush()
  const first = f.transport.sent[0] as { request_id: string }
  f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: first.request_id, response: { models: [
    { value: 'reasoner', displayName: 'Reasoner', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'plain', displayName: 'Plain', supportsEffort: false },
    { value: 'unknown', displayName: 'Unknown' }
  ] } } })
  await starting
  expect(f.adapter.capabilities.models).toEqual([
    { id: 'reasoner', label: 'Reasoner', effort: ['low', 'high'] },
    { id: 'plain', label: 'Plain', effort: [] },
    { id: 'unknown', label: 'Unknown', effort: [] }
  ])
})


describe('Claude conversation reliability', () => {
  it('reconciles late native identity and ignores late deltas and result echoes', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'late-id' } } })
    f.transport.receive({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Once' } } })
    f.transport.receive({ type: 'assistant', session_id: 'native-late', uuid: 'final-message', message: { id: 'late-id', content: [{ type: 'text', text: 'Once only' }] } })
    f.transport.receive({ type: 'stream_event', session_id: 'native-late', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' only' } } })
    f.transport.receive({ type: 'result', subtype: 'success', result: 'Once only', usage: {} })
    const texts = f.projection().items.filter(item => item.data.type === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]?.data).toMatchObject({ text: 'Once only' })
  })
  it('uses Auto/Edit/Manual and keeps permission grants scoped to this session', async () => {
    const f = fixture({ settings: { ...settings, permission: 'auto' } })
    await f.adapter.start()
    expect(f.transport.options.args).toContain('auto')
    await f.adapter.submit('Edit', { ...settings, permission: 'accept-edits' })
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }))
    const request: Json = { type: 'control_request', request_id: 'grant', request: { subtype: 'can_use_tool', tool_use_id: 'shell', tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] } }
    f.transport.receive(request)
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'grant', decision: 'allow-session' })
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'allow', updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] } } })
    const reply = f.transport.sent.at(-1)
    f.transport.receive(request)
    expect(f.transport.sent.at(-1)).toEqual(reply)
    expect(f.projection().items.filter(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending')).toHaveLength(0)
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    await f.adapter.submit('Manual', { ...settings, effort: 'high' })
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } }))
    f.transport.receive(request)
    expect(f.transport.sent.at(-1)).toEqual(reply)
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'manual' } }))
  })
  it('reports live message usage with cache inputs and authoritative turn usage', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'usage-msg', model: 'actual-runtime-model', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 } } } })
    f.transport.receive({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 12 } } })
    const live = f.projection().items.filter(item => item.data.type === 'usage' && item.data.scope === 'message')
    expect(live).toHaveLength(1)
    expect(live[0]?.data).toMatchObject({ scope: 'message', inputTokens: 35, cachedTokens: 20, cacheCreationTokens: 5, outputTokens: 12, totalTokens: 47 })
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ model: 'actual-runtime-model' })
    f.transport.receive({ type: 'result', subtype: 'success', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 15 } })
    expect(f.projection().items.some(item => item.data.type === 'usage' && item.data.scope === 'turn' && item.data.totalTokens === 50)).toBe(true)
  })
  it('normalizes reported account allowance windows and records the first level of a run separately', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    // Claude's own wire shape: fractional utilization keyed by window, epoch-second resetsAt.
    f.transport.receive({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0.24, resetsAt: 1789416000 },
      seven_day: { utilization: 0.1 },
      seven_day_overage_included: { utilization: 0.99, resetsAt: 1789416000 },
      model_scoped: { utilization: null }
    } } })
    const first = f.projection().items.find(item => item.nativeItemId === 'usage:account-rate-limits:first')
    const rolling = () => f.projection().items.find(item => item.nativeItemId === 'usage:account-rate-limits')
    // Rescaled to the same 0-100 shape Codex reports, with Claude's fixed window durations.
    expect(first?.data).toMatchObject({ type: 'usage', source: 'provider', limits: { rateLimits: {
      five_hour: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1789416000 },
      seven_day: { usedPercent: 10, windowDurationMins: 10080 },
      seven_day_overage_included: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1789416000, scope: 'model', modelSelectors: ['fable'], label: 'Fable weekly' }
    } } })
    // An unreported utilization is dropped, never recorded as zero usage.
    expect(JSON.stringify(first?.data)).not.toContain('model_scoped')

    f.transport.receive({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.62 } } } })
    // The rolling item moves; the first-observed level is retained so a share can be sourced.
    expect(rolling()?.data).toMatchObject({ limits: { rateLimits: { seven_day: { usedPercent: 62 } } } })
    expect(first?.data).toMatchObject({ limits: { rateLimits: { seven_day: { usedPercent: 10 } } } })

    // A report with nothing measurable in it is not recorded at all.
    const before = f.projection().items.length
    f.transport.receive({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: null } } } })
    expect(f.projection().items).toHaveLength(before)
  })
  it('preserves an ordinary final bracket after withholding an incomplete diagnostic prefix', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'assistant', message: { id: 'bracket', content: [{ type: 'text', text: '[' }] } })
    expect(f.projection().items.find(item => item.data.type === 'text')?.data).toMatchObject({ text: '[' })
  })
  it('keeps internal stop diagnostics out of streamed text and interrupted errors', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'stopped' } } })
    f.transport.receive({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    for (const text of ['[ede_', 'diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use']) f.transport.receive({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
    await f.adapter.interrupt()
    f.transport.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], usage: {} })
    expect(f.projection().phase).toBe('interrupted')
    expect(f.projection().items.filter(item => item.data.type === 'error')).toHaveLength(0)
    expect(f.projection().items.filter(item => item.data.type === 'text')).toEqual([])
  })
})


it('reports the model from complete assistant messages without letting child models replace it', async () => {
  const f = fixture()
  await f.adapter.start()
  f.transport.receive({ type: 'assistant', message: { id: 'main-model', model: 'claude-main', content: [] } })
  expect(f.projection().capabilities?.effectiveSettings).toMatchObject({ model: 'claude-main' })
  f.transport.receive({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'child-model', model: 'claude-child', content: [] } })
  expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ model: 'claude-main' })
})


it('matches VS Code context accounting, reserves output and compaction space, and resets after compact', async () => {
  const f = fixture()
  await f.adapter.start()
  f.transport.receive({ type: 'assistant', message: { id: 'context-message', model: 'claude-main', usage: { input_tokens: 1000, cache_read_input_tokens: 120000, cache_creation_input_tokens: 2000, output_tokens: 300 }, content: [] } })
  f.transport.receive({ type: 'result', subtype: 'success', modelUsage: { 'claude-main': { contextWindow: 200000, maxOutputTokens: 32000 } }, usage: { input_tokens: 900000, output_tokens: 9000 } })
  const latest = () => f.events.filter(event => event.itemId === 'usage:context').at(-1)?.data
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 123300, contextCapacityTokens: 155000, modelContextWindow: 200000 } })
  f.transport.receive({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'child-context', model: 'claude-child', usage: { input_tokens: 190000, output_tokens: 500 }, content: [] } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 123300 } })
  f.transport.receive({ type: 'system', subtype: 'compact_boundary' })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: null } })
  f.transport.receive({ type: 'assistant', message: { id: 'new-context', model: 'claude-main', usage: { input_tokens: 2000, output_tokens: 30 }, content: [] } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 2030, contextCapacityTokens: 155000 } })
  f.transport.receive({ type: 'assistant', message: { id: 'new-model', model: 'claude-other', usage: { input_tokens: 1000, output_tokens: 20 }, content: [] } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 1020, contextCapacityTokens: null } })
  // The 1M variants, as observed live on 2.1.278 (parity ledger R14): system/init names the
  // configured model with its suffix, the message frames name the API model without it, and
  // modelUsage is keyed by the configured name and accumulates every model the session used.
  f.transport.receive({ type: 'system', subtype: 'init', session_id: 'native-1m', model: 'claude-opus-5[1m]', claude_code_version: CLAUDE_COMPATIBILITY })
  f.transport.receive({ type: 'assistant', message: { id: 'opus-1m', model: 'claude-opus-5', usage: { input_tokens: 4, cache_read_input_tokens: 28000, output_tokens: 17 }, content: [] } })
  f.transport.receive({ type: 'result', subtype: 'success', modelUsage: { 'claude-other': { contextWindow: 200000, maxOutputTokens: 32000 }, 'claude-opus-5[1m]': { contextWindow: 1000000, maxOutputTokens: 64000 } }, usage: { input_tokens: 4, output_tokens: 17 } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 28021, contextCapacityTokens: 923000, modelContextWindow: 1000000 } })
  // A saved [1m] alias prefers the suffixed entry even when the session also used the bare model.
  await f.adapter.submit('Saved alias', { ...settings, model: 'opus[1m]' })
  f.transport.receive({ type: 'assistant', message: { id: 'opus-1m-again', model: 'claude-opus-5', usage: { input_tokens: 4, cache_read_input_tokens: 30000, output_tokens: 10 }, content: [] } })
  f.transport.receive({ type: 'result', subtype: 'success', modelUsage: { 'claude-opus-5': { contextWindow: 200000, maxOutputTokens: 32000 }, 'claude-opus-5[1m]': { contextWindow: 1000000, maxOutputTokens: 64000 } }, usage: { input_tokens: 4, output_tokens: 10 } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 30014, contextCapacityTokens: 923000, modelContextWindow: 1000000 } })
})


describe('Claude mid-turn steering (synthetic, zero inference)', () => {
  it('writes another user message immediately without resetting turn identity, pending tools, or settings', async () => {
    const f = fixture({ nativeSessionId: 'native-steering' })
    await f.adapter.start(); await f.adapter.submit('Original prompt', settings)
    f.transport.receive(toolUse('still-running', 'Read', { path: 'context.txt' }))
    const turnId = f.events.at(-1)?.turnId
    const count = f.transport.sent.length
    await f.adapter.steer('More data', { ...settings, effort: 'low' }, [{ id: 'selection', kind: 'selection', name: 'Selected lines', content: 'Exact context' }])
    expect(f.transport.sent).toHaveLength(count + 1)
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', session_id: 'native-steering', uuid: expect.any(String), message: { role: 'user', content: expect.stringContaining('More data') } })
    expect(f.transport.sent.at(-1)).toMatchObject({ message: { content: expect.stringContaining('Exact context') } })
    expect((f.transport.sent.at(-1) as { uuid: string }).uuid).not.toBe(turnId)
    expect(f.projection().phase).toBe('running')
    expect(f.adapter.capabilities.steering).toBe(true)
    f.transport.receive(toolUse('after-steer', 'Read', {}))
    expect(f.events.at(-1)?.turnId).toBe(turnId)
    expect(f.projection().items.find(item => item.nativeItemId === 'still-running')).toBeDefined()
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ effort: null })
  })

  it.each(['idle', 'completed', 'disconnected', 'disposed', 'interrupting'])('refuses a %s runtime before writing input', async state => {
    const f = fixture()
    await f.adapter.start()
    if (state !== 'idle') await f.adapter.submit('Original prompt', settings)
    if (state === 'completed') f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    if (state === 'disconnected') f.transport.options.onExit?.(1, null)
    if (state === 'disposed') f.adapter.dispose()
    if (state === 'interrupting') await f.adapter.interrupt()
    const count = f.transport.sent.length
    expect(f.adapter.capabilities.steering).toBe(false)
    await expect(f.adapter.steer('Keep my text', settings)).rejects.toThrow(SteeringUnavailableError)
    expect(f.transport.sent).toHaveLength(count)
  })

  it('uses the same image encoder for submit and steer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-steer-image-')); imageRoots.push(root)
    writeFileSync(join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))
    const f = fixture({ cwd: root })
    const attachments = [{ id: 'image', kind: 'image' as const, name: 'image.png', path: 'image.png' }]
    await f.adapter.start(); await f.adapter.submit('Same text', settings, attachments)
    const original = f.transport.sent.at(-1) as { message: Json }
    await f.adapter.steer('Same text', settings, attachments)
    expect(f.transport.sent.at(-1)).toMatchObject({ message: original.message })
  })

  it('rechecks the active turn after asynchronous image capture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-steer-image-race-')); imageRoots.push(root)
    writeFileSync(join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))
    const f = fixture({ cwd: root })
    await f.adapter.start(); await f.adapter.submit('Original prompt', settings)
    const count = f.transport.sent.length
    const steering = f.adapter.steer('Keep my image', settings, [{ id: 'image', kind: 'image', name: 'image.png', path: 'image.png' }])
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    await expect(steering).rejects.toThrow(SteeringUnavailableError)
    expect(f.transport.sent).toHaveLength(count)
  })

  it('surfaces a failed stdin write without claiming delivery or permitting automatic retry', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original prompt', settings)
    const count = f.transport.sent.length
    vi.spyOn(f.transport, 'send').mockImplementationOnce(() => { throw new Error('stdin write failed') })
    const reason: unknown = await f.adapter.steer('Keep my text', settings).catch(error => error)
    expect(reason).toBeInstanceOf(Error)
    expect(reason).not.toBeInstanceOf(SteeringUnavailableError)
    expect(f.transport.sent).toHaveLength(count)
  })
})

describe('Claude task reporting (payloads captured from a real session)', () => {
  const subagents = (f: ReturnType<typeof fixture>) =>
    f.events.filter(event => event.data.type === 'subagent').map(event => event.data as Extract<AdapterEvent['data'], { type: 'subagent' }>)

  it('does not report a foreground tool call as a subagent', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'bu8bk69bg', tool_use_id: 'toolu_A', description: 'Typecheck the renderer changes', is_backgrounded: false, task_type: 'local_bash' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'bu8bk69bg', tool_use_id: 'toolu_A', status: 'completed', output_file: '', summary: 'Typecheck the renderer changes' })
    expect(subagents(f)).toHaveLength(0)
    // The native record is retained for the inspector without entering the conversation.
    expect(f.events.some(event => event.data.type === 'notice' && event.native?.method === 'system/task_started')).toBe(true)
  })

  it('keeps a background Bash process on its tool row instead of reporting a subagent', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'b90gny9dq', tool_use_id: 'toolu_B', description: 'Run Codex on the steering implementation', is_backgrounded: true, task_type: 'local_bash' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'b90gny9dq', tool_use_id: 'toolu_B', status: 'completed', output_file: 'C:/tmp/b90gny9dq.output', summary: 'Background command "Run Codex on the steering implementation" completed (exit code 0)' })
    expect(subagents(f)).toHaveLength(0)
    const tool = f.projection().items.find(item => item.data.type === 'tool' && item.nativeItemId === 'toolu_B')
    expect(tool?.data).toMatchObject({ type: 'tool', name: 'Bash', description: 'Run Codex on the steering implementation', status: 'completed' })
  })

  it('keeps a detached background Bash tool active after its parent turn completes', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Start background work', settings)
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'background-shell', tool_use_id: 'toolu_background', description: 'Long background check', is_backgrounded: true, task_type: 'local_bash' })
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })
    expect(f.projection().phase).toBe('completed')
    expect(f.projection().items.find(item => item.nativeItemId === 'toolu_background')?.data).toMatchObject({ type: 'tool', detached: true, status: 'running' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'background-shell', tool_use_id: 'toolu_background', status: 'completed', summary: 'Long background check completed' })
    expect(f.projection().items.find(item => item.nativeItemId === 'toolu_background')?.data).toMatchObject({ type: 'tool', detached: true, status: 'completed' })
    expect(f.projection().items.some(item => item.data.type === 'subagent')).toBe(false)
  })

  it('stops every backgrounded task through the stop_task control and retires what the CLI no longer runs', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Start watch loops', settings)
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'watch-1', tool_use_id: 'toolu_w1', description: 'Watch ship status', is_backgrounded: true, task_type: 'local_bash' })
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'watch-2', tool_use_id: 'toolu_w2', description: 'Watch coworkers', is_backgrounded: true, task_type: 'local_bash' })
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'foreground', tool_use_id: 'toolu_f', description: 'Typecheck', is_backgrounded: false, task_type: 'local_bash' })
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })
    expect(f.adapter.backgroundWork()).toBe(2)
    f.transport.autoControlResponses = false
    const stopping = f.adapter.stopBackgroundWork()
    const stops = f.transport.sent.filter(item => JSON.stringify(item).includes('stop_task')) as Array<{ request_id: string; request: { task_id: string } }>
    expect(stops.map(item => item.request)).toEqual([{ subtype: 'stop_task', task_id: 'watch-1' }, { subtype: 'stop_task', task_id: 'watch-2' }])
    // The CLI stops the first and reports it; the second it no longer knows.
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: stops[0]!.request_id, response: {} } })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'watch-1', tool_use_id: 'toolu_w1', status: 'stopped', summary: 'Watch ship status was stopped' })
    f.transport.receive({ type: 'control_response', response: { subtype: 'error', request_id: stops[1]!.request_id, error: 'No task found with ID: watch-2' } })
    await expect(stopping).resolves.toBe(2)
    expect(f.adapter.backgroundWork()).toBe(0)
    expect(f.projection().items.find(item => item.nativeItemId === 'toolu_w1')?.data).toMatchObject({ type: 'tool', status: 'interrupted' })
    expect(f.events.some(event => event.data.type === 'notice' && event.data.message.includes('watch-2 could not be stopped'))).toBe(true)
  })

  it('keeps an associated detached Task tool truthful while its background agent outlives the parent', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Start background agent', settings)
    f.transport.receive(toolUse('toolu_agent', 'Task', { description: 'Investigate in background' }))
    f.transport.receive(toolUse('ordinary_unresolved', 'Read', { file_path: 'still-missing.txt' }))
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'agent-background', tool_use_id: 'toolu_agent', description: 'Investigate in background', is_backgrounded: true, task_type: 'local_agent' })
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })

    expect(f.projection().phase).toBe('completed')
    expect(f.projection().items.find(item => item.nativeItemId === 'toolu_agent')?.data).toMatchObject({ type: 'tool', name: 'Task', detached: true, status: 'running' })
    expect(f.projection().items.find(item => item.nativeItemId === 'task:agent-background')?.data).toMatchObject({ type: 'subagent', detached: true, status: 'running' })
    const unresolved = f.projection().items.find(item => item.nativeItemId === 'ordinary_unresolved')?.data
    expect(unresolved).toMatchObject({ type: 'tool', status: 'failed' })
    expect(unresolved).not.toHaveProperty('detached')

    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'agent-background', tool_use_id: 'toolu_agent', status: 'completed', summary: 'Background agent completed' })
    expect(f.projection().items.find(item => item.nativeItemId === 'toolu_agent')?.data).toMatchObject({ type: 'tool', detached: true, status: 'completed' })
    expect(f.projection().items.find(item => item.nativeItemId === 'task:agent-background')?.data).toMatchObject({ type: 'subagent', detached: true, status: 'completed' })
  })

  it('reports a real Agent task even when it is foreground and clamps a report-sized summary', async () => {
    const f = fixture()
    await f.adapter.start()
    const report = '## 1. `HAF_Blaze_Tax_Price_Sync` - includes/class-tax-price-sync.php ' + 'design notes and verified call sites '.repeat(400)
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_R', is_backgrounded: false, task_type: 'local_agent' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', tool_use_id: 'toolu_R', status: 'completed', summary: report })
    const named = subagents(f).at(-1)?.name ?? ''
    expect(named.length).toBeLessThanOrEqual(120)
    expect(named).toContain('HAF_Blaze_Tax_Price_Sync')
    expect(named).not.toContain('\n')
  })

  it('does not infer an agent from an orphan output file', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'orphan', tool_use_id: 'toolu_C', status: 'completed', output_file: 'C:/tmp/orphan.output', summary: 'Background command "Deploy" completed (exit code 0)' })
    expect(subagents(f)).toHaveLength(0)
    expect(f.events.some(event => event.native?.method === 'system/task_notification')).toBe(true)
  })

  it('keeps two concurrent background runs distinct', async () => {
    const f = fixture()
    await f.adapter.start()
    for (const [task, tool] of [['one', 'toolu_D'], ['two', 'toolu_E']] as const) {
      f.transport.receive({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tool, description: 'Run ' + task, is_backgrounded: true, task_type: 'local_agent' })
    }
    expect(new Set(subagents(f).map(agent => agent.name)).size).toBe(2)
  })

  it.each(['local_agent', 'local_workflow', 'remote_agent'])('recognizes %s as agent work from task_type', async taskType => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: taskType, tool_use_id: 'tool-' + taskType, description: taskType, task_type: taskType })
    expect(subagents(f)).toEqual([expect.objectContaining({ name: taskType, status: 'running', detached: false })])
  })

  it('attaches provider-reported child token totals to a real Agent task', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'agent-usage', tool_use_id: 'tool-agent', description: 'Research', task_type: 'local_agent' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'agent-usage', status: 'completed', total_tokens: 1234 })
    expect(f.projection().items).toContainEqual(expect.objectContaining({ parentId: 'task:agent-usage', data: expect.objectContaining({ type: 'usage', totalTokens: 1234 }) }))
  })
})

describe('Claude background work outliving the turn that started it', () => {
  it('still counts a backgrounded command after its tool call and its whole turn have returned', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Relaunch the showcase render', settings)
    f.transport.receive(toolUse('toolu_render', 'Bash', { command: 'blender -b scene.blend', run_in_background: true }))
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'render', tool_use_id: 'toolu_render', description: 'Relaunch the final showcase render', is_backgrounded: true, task_type: 'local_bash' })
    // The trap: backgrounding the command returns the tool call at once, and the turn result
    // follows immediately behind it. Neither says anything about the hours of work still to come.
    f.transport.receive({ type: 'user', uuid: 'render-result', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_render', content: 'Command running in the background' }] } })
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })
    await flush()
    expect(f.projection().phase).toBe('completed')
    expect(f.projection().items.find(item => item.nativeItemId === 'toolu_render')?.data).toMatchObject({ type: 'tool', status: 'completed' })
    expect(f.adapter.backgroundWork()).toBe(1)
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'render', tool_use_id: 'toolu_render', status: 'completed', summary: 'Background command completed (exit code 0)' })
    await flush()
    expect(f.adapter.backgroundWork()).toBe(0)
  })

  it('counts an armed watcher, and a foreground task never at all', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'watch', tool_use_id: 'toolu_monitor', description: 'render progress', is_backgrounded: true })
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'typecheck', tool_use_id: 'toolu_check', description: 'Typecheck', is_backgrounded: false, task_type: 'local_bash' })
    await flush()
    expect(f.adapter.backgroundWork()).toBe(1)
    // A watcher that expires without firing still ends its task.
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'watch', tool_use_id: 'toolu_monitor', status: 'stopped', summary: 'render progress' })
    await flush()
    expect(f.adapter.backgroundWork()).toBe(0)
  })

  it('retires a finished task before the frame announcing it reaches the host', async () => {
    // The host reads this inventory when the event arrives, so a task dropped afterwards would
    // leave the conversation waiting on work that already reported, with nothing to correct it.
    const observed: Array<{ method?: string; outstanding: number }> = []
    let adapter!: ClaudeAdapter
    const f = fixture({ emit: event => observed.push({ method: event.native?.method, outstanding: adapter.backgroundWork() }) })
    adapter = f.adapter
    await adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'render', tool_use_id: 'toolu_render', description: 'Render', is_backgrounded: true, task_type: 'local_bash' })
    await flush()
    expect(observed.filter(entry => entry.method === 'system/task_started').at(-1)?.outstanding).toBe(1)
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'render', tool_use_id: 'toolu_render', status: 'completed', summary: 'Render completed' })
    await flush()
    expect(observed.filter(entry => entry.method === 'system/task_notification').at(-1)?.outstanding).toBe(0)
  })

  it('takes the runtime\'s own background inventory as authoritative without disturbing foreground tasks', async () => {
    const f = fixture()
    await f.adapter.start()
    // A resumed conversation inherits work it never saw start; this frame is the only source.
    f.transport.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'render', task_type: 'local_bash', description: 'Relaunch the final showcase render' },
      { task_id: 'watch', description: 'final showcase render progress' }
    ] })
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'review', tool_use_id: 'toolu_review', description: 'Review the diff', task_type: 'local_agent' })
    await flush()
    expect(f.adapter.backgroundWork()).toBe(2)
    f.transport.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'render', task_type: 'local_bash', description: 'Relaunch the final showcase render' }] })
    await flush()
    expect(f.adapter.backgroundWork()).toBe(1)
    f.transport.receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    await flush()
    expect(f.adapter.backgroundWork()).toBe(0)
    // The foreground agent is tracked for its description, not as background work, so the
    // inventory frame must not have forgotten it.
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'review', tool_use_id: 'toolu_review', status: 'completed', summary: 'Agent completed (exit code 0)' })
    await flush()
    expect(f.events.filter(event => event.data.type === 'subagent').at(-1)?.data).toMatchObject({ name: 'Review the diff', status: 'completed' })
  })

  it('opens the turn the runtime starts by itself rather than streaming into an idle session', async () => {
    const f = fixture()
    await f.adapter.start()
    const phases = (): string[] => f.events.flatMap(event => event.data.type === 'session' ? [event.data.phase] : [])
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'render', status: 'completed', summary: 'Background command completed (exit code 0)' })
    await flush()
    expect(phases()).not.toContain('running')
    // Nothing of ours delivered this turn; its first frame of output is its only announcement.
    f.transport.receive({ type: 'assistant', uuid: 'wake-1', parent_tool_use_id: null, session_id: 'native', message: { id: 'native-wake-1', model: 'fixture-model', content: [{ type: 'text', text: 'Render finished at frame 1251.' }] } })
    await flush()
    expect(f.projection().phase).toBe('running')
    expect(f.adapter.capabilities.steering).toBe(true)
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })
    await flush()
    expect(f.projection().phase).toBe('completed')
    expect(f.adapter.capabilities.steering).toBe(false)
  })

  it('never opens a turn from a detached child still streaming under a finished one', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Dispatch the wave', settings)
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })
    await flush()
    expect(f.projection().phase).toBe('completed')
    f.transport.receive({ type: 'assistant', uuid: 'child-1', parent_tool_use_id: 'toolu_task', session_id: 'native', message: { id: 'native-child-1', content: [{ type: 'text', text: 'Child still reporting.' }] } })
    await flush()
    expect(f.projection().phase).toBe('completed')
    expect(f.adapter.capabilities.steering).toBe(false)
  })
})


describe('Claude visible text identity', () => {
  it('reconciles text after hidden thinking when final blocks are renumbered, including multiple identical visible blocks', async () => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Prompt', settings)
    const stream = (event: Json) => f.transport.receive({ type: 'stream_event', session_id: 'native-1', event })
    stream({ type: 'message_start', message: { id: 'thinking-message' } })
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
    for (const index of [1, 2]) {
      stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Repeated intentionally.' } })
    }
    stream({ type: 'message_stop' })
    f.transport.receive({ type: 'assistant', uuid: 'final', message: { id: 'thinking-message', content: [{ type: 'text', text: 'Repeated intentionally.' }, { type: 'text', text: 'Repeated intentionally.' }] } })
    const text = f.projection().items.filter(item => item.data.type === 'text')
    expect(text).toHaveLength(2)
    expect(text.map(item => item.nativeItemId)).toEqual(['thinking-message:text:0', 'thinking-message:text:1'])
  })
})


it('attaches actual bounded background command output to its Bash tool record', async () => {
  const base = join(tmpdir(), 'claude'); mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'conductor-adapter-output-')); imageRoots.push(root)
  const taskDirectory = join(root, 'native-output-session', 'tasks'); mkdirSync(taskDirectory, { recursive: true })
  const outputFile = join(taskDirectory, 'background-1.output'); writeFileSync(outputFile, 'Native background command completed successfully')
  const f = fixture({ nativeSessionId: 'native-output-session' }); await f.adapter.start()
  f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'background-1', tool_use_id: 'bash-1', is_backgrounded: true, task_type: 'local_bash', description: 'Run checks' })
  f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'background-1', status: 'completed', output_file: outputFile })
  await vi.waitFor(() => expect(f.projection().items.find(item => item.data.type === 'tool' && item.nativeItemId === 'bash-1')?.data).toMatchObject({ name: 'Bash', description: 'Run checks', status: 'completed', output: 'Native background command completed successfully' }))
  expect(f.projection().items.some(item => item.data.type === 'subagent')).toBe(false)
})


describe('Claude permission actions and native approval boundaries', () => {
  function request(f: ReturnType<typeof fixture>, id = 'approval') {
    const item = f.projection().items.find(item => item.data.type === 'interaction' && item.data.interaction.id === id)
    if (item?.data.type !== 'interaction') throw new Error('Missing permission request')
    return item.data.interaction
  }
  function answer(id: string, decision: string) { return { sessionId: 'session', runtimeId: 'incarnation-A', requestId: id, decision } }
  function modeAck(f: ReturnType<typeof fixture>, error?: string) {
    const sent = f.transport.sent.at(-1) as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: error ? 'error' : 'success', request_id: sent.request_id, ...(error ? { error } : { response: {} }) } })
  }
  it('shows distinct session and auto actions without inventing a reusable grant', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive(permission('approval', 'shell', 'Bash', { command: 'npm test' }))
    expect(request(f).choices).toContainEqual(expect.objectContaining({ id: 'allow-session', label: 'Allow for this session', disabled: true, description: expect.stringContaining('did not offer') }))
    expect(request(f).choices).toContainEqual(expect.objectContaining({ id: 'auto-mode', label: 'Switch to auto-mode', disabled: false }))
    await expect(f.adapter.respond(answer('approval', 'allow-session'))).rejects.toThrow('Unsupported')
    expect(request(f).status).toBe('pending')
    await f.adapter.respond(answer('approval', 'allow'))
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'allow', updatedInput: { command: 'npm test' } } } })
    expect(JSON.stringify(f.transport.sent.at(-1))).not.toContain('updatedPermissions')
  })
  it('limits native suggestions to the permitted tool and session, including provider Edit rules for Write', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive({ type: 'control_request', request_id: 'approval', request: {
      subtype: 'can_use_tool', tool_use_id: 'write', tool_name: 'Write', input: { file_path: 'report.txt', content: 'data' },
      permission_suggestions: [
        { type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Edit', ruleContent: '/report.txt' }] },
        { type: 'addRules', behavior: 'allow', destination: 'projectSettings', rules: [{ toolName: 'Bash' }] },
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        { type: 'addDirectories', directories: ['C:/'], destination: 'session' }
      ]
    } })
    expect(request(f).choices.find(choice => choice.id === 'allow-session')).toMatchObject({ disabled: false, description: expect.stringContaining('Edit(/report.txt)') })
    await f.adapter.respond(answer('approval', 'allow-session'))
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Edit', ruleContent: '/report.txt' }] }] } } })
    // If Claude still requests a matching permission, host grants must never skip it:
    // native ask rules and required-interaction tools outrank native allow rules.
    f.transport.receive(permission('required-again', 'write-again', 'Write', { file_path: 'report.txt', content: 'data' }))
    expect(request(f, 'required-again').status).toBe('pending')
    expect(f.projection().settings.permission).toBe('default')
    f.adapter.dispose()
    const fresh = fixture(); await fresh.adapter.start()
    fresh.transport.receive(permission('approval', 'write', 'Write', { file_path: 'report.txt', content: 'data' }))
    expect(request(fresh).status).toBe('pending')
    expect(JSON.stringify(fresh.transport.sent)).not.toContain('updatedPermissions')
  })
  it.each<Record<string, Json>>([
    { matched_ask_rule: { source: 'policySettings', tool_name: 'Bash' } },
    { decision_reason: 'Your organization requires approval for this tool' }
  ])('does not offer a reusable grant over a mandatory approval: %j', async boundary => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive({ type: 'control_request', request_id: 'approval', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, ...boundary,
      permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], destination: 'session' }]
    } })
    expect(request(f).choices.find(choice => choice.id === 'allow-session')).toMatchObject({ disabled: true, description: expect.stringContaining('individual approval') })
  })
  it('awaits native auto-mode confirmation, allows the selected request once, and preserves other pending requests', async () => {
    const f = fixture({ settings: { ...settings, plan: true } }); await f.adapter.start(); await f.adapter.submit('Synthetic', { ...settings, plan: true })
    f.transport.receive(permission('approval', 'one', 'Bash', { command: 'npm test' }))
    f.transport.receive(permission('second', 'two', 'Bash', { command: 'git status' }))
    f.transport.autoControlResponses = false
    const switching = f.adapter.respond(answer('approval', 'auto-mode'))
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'auto' } })
    expect(request(f).status).toBe('pending')
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ requestedPermissionMode: 'auto', permissionModeStatus: 'pending' })
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ permissionMode: 'plan' })
    await expect(f.adapter.respond(answer('approval', 'auto-mode'))).rejects.toThrow('already resolved')
    modeAck(f); await switching
    expect(f.projection()).toMatchObject({ phase: 'waiting_approval', settings: { permission: 'auto', plan: false }, capabilities: { effectiveSettings: { permissionMode: 'auto' } } })
    expect(request(f)).toMatchObject({ status: 'resolved', outcome: 'auto-mode' })
    expect(request(f, 'second').status).toBe('pending')
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { request_id: 'approval', response: { behavior: 'allow', updatedInput: { command: 'npm test' } } } })
    expect(JSON.stringify(f.transport.sent.at(-1))).not.toContain('updatedPermissions')
    await f.adapter.respond(answer('second', 'deny'))
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    f.transport.autoControlResponses = true
    await f.adapter.submit('Keep Auto', { ...settings, permission: 'auto' })
    expect(f.transport.sent.filter(value => JSON.stringify(value).includes('set_permission_mode'))).toHaveLength(1)
    f.transport.receive(permission('mandatory-in-auto', 'three', 'Bash', { command: 'npm test' }))
    expect(request(f, 'mandatory-in-auto').choices.find(choice => choice.id === 'auto-mode')).toMatchObject({ disabled: true, description: expect.stringContaining('already active') })
    expect(request(f, 'mandatory-in-auto').status).toBe('pending')
  })
  it('leaves a rejected native auto switch pending and lets the owner deny the operation', async () => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(permission('approval', 'one', 'Bash', { command: 'npm test' }))
    f.transport.autoControlResponses = false
    const switching = f.adapter.respond(answer('approval', 'auto-mode'))
    modeAck(f, 'Auto mode is disabled by managed policy')
    await expect(switching).rejects.toThrow('disabled by managed policy')
    expect(request(f).status).toBe('pending')
    expect(f.projection()).toMatchObject({ settings: { permission: 'default' }, phase: 'waiting_approval' })
    expect(f.transport.sent.filter(value => JSON.stringify(value).includes('"behavior":"allow"'))).toHaveLength(0)
    await f.adapter.respond(answer('approval', 'deny'))
    expect(request(f)).toMatchObject({ status: 'resolved', outcome: 'deny' })
  })
  it.each(['cancel', 'complete'] as const)('never answers a request that the provider %s event expired during mode switching', async ending => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(permission('approval', 'one', 'Bash', { command: 'npm test' }))
    f.transport.autoControlResponses = false
    const switching = f.adapter.respond(answer('approval', 'auto-mode'))
    const modeRequest = f.transport.sent.at(-1)
    if (ending === 'cancel') f.transport.receive({ type: 'control_cancel_request', request_id: 'approval' })
    else f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    modeAck(f); await switching
    expect(request(f).status).toBe('expired')
    expect(f.transport.sent.at(-1)).toEqual(modeRequest)
    expect(f.projection()).toMatchObject({ phase: ending === 'cancel' ? 'running' : 'completed', settings: { permission: 'auto', plan: false } })
  })
  it('keeps questions separate from permission mode actions', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive(permission('approval', 'question', 'AskUserQuestion', { questions: [{ question: 'Pick one', options: [{ label: 'One' }] }] }))
    expect(request(f).choices.map(choice => choice.id)).toEqual(['allow', 'deny', 'abort'])
  })
})


it('honors the native offered session Edit mode, keeps it across turns, and expires it for another runtime', async () => {
  const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
  f.transport.receive({ type: 'control_request', request_id: 'session-edit', request: {
    subtype: 'can_use_tool', tool_use_id: 'write', tool_name: 'Write', input: { file_path: 'proof.txt', content: 'first' },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  } })
  const interaction = f.projection().items.find(item => item.data.type === 'interaction')
  expect(interaction?.data).toMatchObject({ interaction: { choices: expect.arrayContaining([expect.objectContaining({ id: 'allow-session', disabled: false, description: expect.stringContaining('all file edits') })]) } })
  await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'session-edit', decision: 'allow-session' })
  expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }))
  expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } } })
  expect(f.projection()).toMatchObject({ settings: { permission: 'accept-edits', temporaryPermission: { runtimeId: 'incarnation-A', restore: 'default' } }, capabilities: { effectiveSettings: { permissionMode: 'acceptEdits' } } })
  f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
  await f.adapter.submit('Another turn', f.projection().settings)
  expect(f.transport.sent.filter(value => JSON.stringify(value).includes('set_permission_mode'))).toHaveLength(1)
  const resumed = fixture({ settings: f.projection().settings, runtimeId: 'incarnation-B' })
  await resumed.adapter.start()
  expect(resumed.transport.options.args[resumed.transport.options.args.indexOf('--permission-mode') + 1]).toBe('manual')
  await resumed.adapter.submit('Stale queued settings', f.projection().settings)
  expect(resumed.transport.sent.filter(value => JSON.stringify(value).includes('set_permission_mode'))).toHaveLength(0)
})

it.each([
  { tool_name: 'Bash', update: { type: 'setMode', mode: 'acceptEdits', destination: 'session' } },
  { tool_name: 'Write', update: { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' } },
  { tool_name: 'Write', update: { type: 'setMode', mode: 'bypassPermissions', destination: 'session' } }
])('does not invent a session mode grant for an unrelated tool or permanent/dangerous mode: %j', async row => {
  const f = fixture(); await f.adapter.start()
  f.transport.receive({ type: 'control_request', request_id: 'unoffered', request: { subtype: 'can_use_tool', tool_name: row.tool_name, input: {}, permission_suggestions: [row.update] } })
  await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'unoffered', decision: 'allow-session' })).rejects.toThrow('Unsupported')
})


it.each(['deny', 'abort', 'interrupt'] as const)('preserves explicit %s outcome through native failure hooks and error echoes', async action => {
  const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
  const input = { command: 'node --version' }
  f.transport.receive(permission('decision', 'shell', 'Bash', input))
  if (action === 'interrupt') await f.adapter.interrupt()
  else await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'decision', decision: action })
  f.transport.receive(hook('failure-hook', 'conductor_failed', 'shell', 'Bash', input, { exitCode: 1, stderr: 'Native request did not run' }))
  await flush()
  f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'Native request did not run', is_error: true }] } })
  expect(f.projection().items.find(item => item.data.type === 'tool' && item.nativeItemId === 'shell')?.data).toMatchObject({ status: action === 'deny' ? 'rejected' : 'interrupted' })
  f.transport.receive(toolUse('ordinary-error', 'Bash', { command: 'node missing-file.js' }))
  f.transport.receive(hook('ordinary-failure-hook', 'conductor_failed', 'ordinary-error', 'Bash', { command: 'node missing-file.js' }, { exitCode: 1 }))
  await flush()
  expect(f.projection().items.find(item => item.data.type === 'tool' && item.nativeItemId === 'ordinary-error')?.data).toMatchObject({ status: 'failed' })
})


describe('Claude native steering command lifecycle', () => {
  it('uses next priority and only reports consumption on the matching native started frame', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original', settings)
    await f.adapter.steer('Followup', settings, [], 'steering-1')
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', uuid: 'steering-1', priority: 'next' })
    expect(f.events.some(event => event.data.type === 'input_delivery')).toBe(false)
    const lifecycle = (id: string, state: string) => f.transport.receive({ type: 'command_lifecycle', uuid: id + state, command_uuid: id, state })
    lifecycle('other-input', 'started'); lifecycle('steering-1', 'queued')
    f.transport.receive(toolUse('next-tool', 'Read', { file_path: 'panel.mjs' }))
    expect(f.events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'steering-1', status: 'accepted' }])
    lifecycle('steering-1', 'started'); lifecycle('steering-1', 'started'); lifecycle('steering-1', 'cancelled')
    expect(f.events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'steering-1', status: 'accepted' }, { type: 'input_delivery', inputId: 'steering-1', status: 'delivered' }])
    expect(f.adapter.capabilities.steering).toBe(true)
  })
  it('uses the interrupt cancellation receipt, never an ambiguous cancelled lifecycle, to authorize replay', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original', settings)
    await f.adapter.steer('Pending', settings, [], 'pending-input')
    f.transport.autoControlResponses = false
    const stopping = f.adapter.interrupt()
    const request = f.transport.sent.at(-1) as { request_id: string }
    f.transport.receive({ type: 'command_lifecycle', command_uuid: 'pending-input', state: 'cancelled' })
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    expect(f.events.some(event => event.data.type === 'input_delivery')).toBe(false)
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [], cancelled: ['pending-input'] } } })
    await stopping
    expect(f.events.at(-1)?.data).toEqual({ type: 'input_delivery', inputId: 'pending-input', status: 'cancelled' })
  })
  it('does not label an ambiguous cancellation not-sent when a later input is accepted', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original', settings)
    await f.adapter.steer('First follow-up', settings, [], 'first-input')
    f.transport.receive({ type: 'command_lifecycle', command_uuid: 'first-input', state: 'queued' })
    f.transport.receive({ type: 'command_lifecycle', command_uuid: 'first-input', state: 'cancelled' })
    await f.adapter.steer('Second follow-up', settings, [], 'second-input')
    f.transport.receive({ type: 'command_lifecycle', command_uuid: 'second-input', state: 'queued' })
    expect(f.events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([
      { type: 'input_delivery', inputId: 'first-input', status: 'accepted' },
      { type: 'input_delivery', inputId: 'first-input', status: 'uncertain' },
      { type: 'input_delivery', inputId: 'second-input', status: 'accepted' }
    ])
  })
  it('marks pending input uncertain on disconnect and tracks a native next command after a result', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original', settings)
    await f.adapter.steer('Next', settings, [], 'next-input')
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    f.transport.receive({ type: 'command_lifecycle', command_uuid: 'next-input', state: 'started' })
    expect(f.adapter.capabilities.steering).toBe(true)
    await f.adapter.steer('Unconfirmed', settings, [], 'unconfirmed-input')
    f.adapter.dispose()
    expect(f.events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'next-input', status: 'delivered' }, { type: 'input_delivery', inputId: 'unconfirmed-input', status: 'uncertain' }])
  })
})

it('marks a compaction so the host restates its briefing', async () => {
  const f = fixture()
  await f.adapter.start()
  f.transport.receive({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } })
  const resets = () => f.events.filter(event => event.data.type === 'notice' && (event.data.payload as { contextReset?: boolean } | undefined)?.contextReset === true)
  expect(resets()).toHaveLength(1)
  expect(resets()[0]).toMatchObject({ native: { method: 'system/compact_boundary' } })
  // A subagent compacting its own context does not touch what the main conversation was told.
  f.transport.receive({ type: 'system', subtype: 'compact_boundary', parent_tool_use_id: 'child' })
  expect(resets()).toHaveLength(1)
})

describe('claude auto-mode classifier denials', () => {
  // Live-observed 2026-09-22 (claude 2.1.280): in Auto the CLI's classifier refuses a tool without any
  // can_use_tool request; the only trace is this tool_result, and the result frame's permission_denials.
  const DENIED = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Security Weaken]. If you have other tasks that don't depend on this action, continue working on those."

  it('keeps the tool failed and adds one notice card per denial, which the result frame then confirms', async () => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(toolUse('toolu_denied', 'Edit', { file_path: 'C:/Windows/System32/drivers/etc/hosts', old_string: 'a', new_string: 'b' }))
    f.transport.receive({ type: 'user', uuid: 'denied-result', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: DENIED }] } })
    // An ordinary failure and a repeated delivery are not denials.
    f.transport.receive(toolUse('toolu_plain', 'Bash', { command: 'node missing.js' }))
    f.transport.receive({ type: 'user', uuid: 'plain-result', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_plain', is_error: true, content: 'Error: Cannot find module' }] } })
    f.transport.receive({ type: 'user', uuid: 'denied-result-again', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: DENIED }] } })
    await flush()
    let items = f.projection().items
    expect(items.find(item => item.data.type === 'tool' && item.nativeItemId === 'toolu_denied')?.data).toMatchObject({ status: 'failed' })
    expect(items.find(item => item.data.type === 'tool' && item.nativeItemId === 'toolu_plain')?.data).toMatchObject({ status: 'failed' })
    const notices = items.filter(item => item.data.type === 'notice' && autoModeDenialOf(item.data))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.nativeItemId).toBe('auto-denial:toolu_denied')
    expect(notices[0]!.data).toMatchObject({ type: 'notice', payload: { autoModeDenial: { tool: 'Edit', reason: 'Security Weaken', toolUseId: 'toolu_denied' } } })
    // The notice names the exact call and the one rule approving it would hand this conversation.
    expect(notices[0]!.data.type === 'notice' ? notices[0]!.data.message : '').toBe("Auto mode refused Edit (Security Weaken): Edit a file (shared): C:/Windows/System32/drivers/etc/hosts. The claude CLI's own classifier decided this. Approve it once or for this session, or deny it: Conductor then hands this conversation exactly Edit(//c/Windows/System32/drivers/etc/hosts) and tells it to retry.")
    expect(autoModeDenialOf(notices[0]!.data)?.request).toMatchObject({ tool: 'Edit', class: 'shared', rule: 'Edit(//c/Windows/System32/drivers/etc/hosts)', category: 'Security Weaken' })
    expect(f.events.some(event => event.native?.method === 'tool_result/auto_mode_denial')).toBe(true)
    // Nothing was asked of the owner through the approval channel, because the CLI never asked Conductor.
    expect(items.some(item => item.data.type === 'interaction')).toBe(false)
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: {}, modelUsage: {}, permission_denials: [{ tool_name: 'Edit', tool_input: { file_path: 'C:/Windows/System32/drivers/etc/hosts' }, tool_use_id: 'toolu_denied' }] })
    await flush()
    items = f.projection().items
    expect(items.filter(item => item.nativeItemId === 'auto-denial:toolu_denied')).toHaveLength(1)
    expect(items.find(item => item.nativeItemId === 'auto-denial:toolu_denied')?.data).toMatchObject({ payload: { autoModeDenial: { tool: 'Edit', confirmed: true } } })
    expect(f.projection().phase).toBe('completed')
  })

  it('does not mistake the owner\'s own denial, delivered through the approval channel, for a classifier denial', async () => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    const input = { command: 'node --version' }
    f.transport.receive(permission('decision', 'shell', 'Bash', input))
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'decision', decision: 'deny' })
    f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'Permission for this action has been denied. Reason: the user rejected it', is_error: true }] } })
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, result: 'Stopped', usage: {}, modelUsage: {}, permission_denials: [{ tool_name: 'Bash', tool_input: input, tool_use_id: 'shell' }] })
    await flush()
    const items = f.projection().items
    expect(items.find(item => item.data.type === 'tool' && item.nativeItemId === 'shell')?.data).toMatchObject({ status: 'rejected' })
    expect(items.some(item => item.data.type === 'notice' && autoModeDenialOf(item.data))).toBe(false)
  })
})

describe('owner permission grants (src/main/permission-grants)', () => {
  const deniedHook = (requestId: string, toolId: string, name: string, input: Json, reason: string): Json =>
    ({ type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: 'conductor_denied', tool_use_id: toolId, input: { hook_event_name: 'PermissionDenied', tool_use_id: toolId, tool_name: name, tool_input: input, reason } } })

  it('registers the PermissionDenied hook and turns its record into one structured request, which the text fallback does not duplicate', async () => {
    const denied = vi.fn()
    const f = fixture({ permissionGrants: { rules: () => [], used: vi.fn(), denied } }); await f.adapter.start()
    const initialize = f.transport.sent.find(message => (message as { request?: { subtype?: string } }).request?.subtype === 'initialize') as { request: { hooks: Record<string, Json> } }
    expect(initialize.request.hooks.PermissionDenied).toEqual([{ hookCallbackIds: ['conductor_denied'], timeout: expect.any(Number) }])
    await f.adapter.submit('Synthetic', settings)
    // The haftheme case (2026-09-25), with a stand-in path: a new local script, refused for what it describes.
    const input = { file_path: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh', content: '#!/usr/bin/env bash\n' }
    f.transport.receive(toolUse('toolu_w', 'Write', input))
    f.transport.receive(deniedHook('deny-hook', 'toolu_w', 'Write', input, 'Modify Shared Resources'))
    await flush()
    expect(f.transport.sent.some(message => { const reply = message as { type?: string; response?: { request_id?: string; subtype?: string } }; return reply.type === 'control_response' && reply.response?.request_id === 'deny-hook' && reply.response.subtype === 'success' })).toBe(true)
    f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w', is_error: true, content: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Modify Shared Resources]. If you have other tasks that don\'t depend on this action, continue working on those.' }] } })
    await flush()
    const notices = f.projection().items.filter(item => autoModeDenialOf(item.data))
    expect(notices).toHaveLength(1)
    expect(autoModeDenialOf(notices[0]!.data)).toMatchObject({ tool: 'Write', reason: 'Modify Shared Resources', request: { action: 'Write a file', resource: 'C:\\Users\\owner\\site\\app\\prod\\fix-pool.sh', class: 'local', rule: 'Edit(//c/Users/owner/site/app/prod/fix-pool.sh)', category: 'Modify Shared Resources' } })
    expect(f.events.some(event => event.native?.method === 'hook/permission_denied')).toBe(true)
    // The card is a pending owner request from the moment it is shown, so a handoff can move it.
    expect(denied).toHaveBeenCalledExactlyOnceWith('auto-denial:toolu_w', expect.objectContaining({ rule: 'Edit(//c/Users/owner/site/app/prod/fix-pool.sh)', toolUseId: 'toolu_w' }))
  })

  const hookReply = (f: ReturnType<typeof fixture>, requestId: string) => (f.transport.sent.find(message => (message as { response?: { request_id?: string } }).response?.request_id === requestId) as { response?: { response?: Json } } | undefined)?.response?.response
  const outages = (f: ReturnType<typeof fixture>) => f.projection().items.filter(item => item.data.type === 'notice' && (item.data.payload as { classifierUnavailable?: unknown } | undefined)?.classifierUnavailable)

  it('shows a classifier outage as one plain notice, raises no card or request, and lets the agent retry', async () => {
    const denied = vi.fn(), refused = vi.fn()
    const f = fixture({ permissionGrants: { rules: () => [{ rule: 'Bash(npm test)', once: false }], used: vi.fn(), refused, denied } }); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    for (const id of ['toolu_o1', 'toolu_o2']) {
      f.transport.receive(toolUse(id, 'Bash', { command: 'npm test' }))
      f.transport.receive(deniedHook(`hook-${id}`, id, 'Bash', { command: 'npm test' }, 'Classifier unavailable'))
      await flush()
      f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action.' }] } })
    }
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: {}, modelUsage: {}, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_o1' }] })
    await flush()
    expect(hookReply(f, 'hook-toolu_o1')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } })
    expect(denied).not.toHaveBeenCalled()
    expect(refused).not.toHaveBeenCalled()
    expect(f.projection().items.some(item => autoModeDenialOf(item.data))).toBe(false)
    const notices = outages(f)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.data).toMatchObject({ payload: { classifierUnavailable: { tool: 'Bash', reason: 'Classifier unavailable', count: 2 } } })
    expect(notices[0]!.data.type === 'notice' ? notices[0]!.data.message : '').toMatch(/not a refusal: nothing needs approval\. The agent was told to retry the same call/)
  })

  it('says to continue once the check is back when the CLI stopped the turn, and asks for no retry', async () => {
    const denied = vi.fn()
    const f = fixture({ permissionGrants: { rules: () => [], used: vi.fn(), denied } }); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(toolUse('toolu_s', 'Bash', { command: 'npm test' }))
    f.transport.receive(deniedHook('hook-stop', 'toolu_s', 'Bash', { command: 'npm test' }, 'Auto mode unavailable — stopped after repeated responses with no safety verdict'))
    await flush()
    expect(hookReply(f, 'hook-stop')).toEqual({})
    expect(denied).not.toHaveBeenCalled()
    expect(outages(f)).toHaveLength(1)
    expect(outages(f)[0]!.data).toMatchObject({ payload: { classifierUnavailable: { stopped: true } }, message: expect.stringMatching(/stopped this turn.*Continue the conversation once the check is back/) })
  })

  it('keeps a real classifier refusal an owner card, as before', async () => {
    const denied = vi.fn()
    const f = fixture({ permissionGrants: { rules: () => [], used: vi.fn(), denied } }); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(toolUse('toolu_real', 'Bash', { command: 'npm test' }))
    f.transport.receive(deniedHook('hook-real', 'toolu_real', 'Bash', { command: 'npm test' }, 'Interfere With Workloads'))
    await flush()
    expect(hookReply(f, 'hook-real')).toEqual({})
    expect(outages(f)).toHaveLength(0)
    expect(autoModeDenialOf(f.projection().items.find(item => item.nativeItemId === 'auto-denial:toolu_real')!.data)).toMatchObject({ tool: 'Bash', reason: 'Interfere With Workloads' })
    expect(denied).toHaveBeenCalledExactlyOnceWith('auto-denial:toolu_real', expect.objectContaining({ category: 'Interfere With Workloads', toolUseId: 'toolu_real' }))
  })

  it('launches with the granted rules in --settings, hands a running CLI the current set through apply_flag_settings, and passes no --settings without grants', async () => {
    let rules = [{ rule: 'Bash(ssh -i key root@192.0.2.10 bash -s < app/prod/fix-pool.sh)', once: true }]
    const f = fixture({ permissionGrants: { rules: () => rules, used: vi.fn() } })
    await f.adapter.start()
    const args = f.transport.options.args
    expect(JSON.parse(readFileSync(args[args.indexOf('--settings') + 1]!, 'utf8'))).toEqual({ permissions: { allow: [rules[0]!.rule] } })
    // A pipeline is checked part by part natively, so each part gets its own exact rule as well.
    rules = [{ rule: "Bash(ssh -o BatchMode=yes root@192.0.2.10 'bash -s -- --check' < app/prod/fix-pool.sh 2>&1 | tail -40)", once: false }]
    await expect(f.adapter.applyPermissionRules()).resolves.toBe('applied')
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'apply_flag_settings', settings: { permissions: { allow: [rules[0]!.rule, "Bash(ssh -o BatchMode=yes root@192.0.2.10 'bash -s -- --check' < app/prod/fix-pool.sh 2>&1)", 'Bash(tail -40)'] } } } })
    rules = []
    await expect(f.adapter.applyPermissionRules()).resolves.toBe('applied')
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'apply_flag_settings', settings: { permissions: { allow: [] } } } })
    const none = fixture(); await none.adapter.start()
    expect(none.transport.options.args).not.toContain('--settings')
    const reviewer = fixture({ approvalReviewer: true, permissionGrants: { rules: () => [{ rule: 'Bash(git status)', once: false }], used: vi.fn() } }); await reviewer.adapter.start()
    expect(reviewer.transport.options.args).not.toContain('--settings')
  })

  it('exempts the conductor request tools from the classifier with exact allow rules, kept beside the grants', async () => {
    const exempt = ['mcp__conductor__request_permission', 'mcp__conductor__list_permissions']
    const settingsOf = (args: string[]) => JSON.parse(readFileSync(args[args.indexOf('--settings') + 1]!, 'utf8'))
    // With no grants at all, a tab with the conductor server still launches with the two rules.
    const bare = fixture({ conductorMcpConfig: 'conductor.json' }); await bare.adapter.start()
    expect(settingsOf(bare.transport.options.args)).toEqual({ permissions: { allow: exempt } })
    // apply_flag_settings replaces the whole layer, so a live grant change keeps them too.
    let rules = [{ rule: 'Bash(git push)', once: true }]
    const f = fixture({ conductorMcpConfig: 'conductor.json', permissionGrants: { rules: () => rules, used: vi.fn() } }); await f.adapter.start()
    expect(settingsOf(f.transport.options.args)).toEqual({ permissions: { allow: [...exempt, 'Bash(git push)'] } })
    rules = []
    await expect(f.adapter.applyPermissionRules()).resolves.toBe('applied')
    expect(f.transport.sent.at(-1)).toMatchObject({ request: { subtype: 'apply_flag_settings', settings: { permissions: { allow: exempt } } } })
    // Only exact tool names: no server-wide mcp__conductor rule, so control and send_message stay judged.
    expect(exempt.every(rule => /^mcp__conductor__[a-z_]+$/.test(rule))).toBe(true)
    // An approval reviewer or an evaluation turn has no conductor tools and gets no rules.
    for (const options of [{ approvalReviewer: true }, { profile: 'evaluation' as const }]) {
      const isolated = fixture({ ...options, conductorMcpConfig: 'conductor.json' }); await isolated.adapter.start()
      expect(isolated.transport.options.args).not.toContain('--settings')
    }
  })

  it('reports a CLI that cannot take flag settings while it runs as unsupported', async () => {
    const f = fixture({ permissionGrants: { rules: () => [], used: vi.fn() } }); await f.adapter.start()
    f.transport.autoControlResponses = false
    const applying = f.adapter.applyPermissionRules(); await flush()
    const request = f.transport.sent.at(-1) as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'apply_flag_settings is not supported in this context (onApplyFlagSettings callback not registered)' } })
    await expect(applying).resolves.toBe('unsupported')
  })

  it('spends an approve-once grant only after its exact call ran, and reports a granted call the classifier still refused', async () => {
    const command = 'ssh -i key root@192.0.2.10 bash -s < app/prod/fix-pool.sh'
    const used = vi.fn(), refused = vi.fn(), denied = vi.fn()
    const f = fixture({ permissionGrants: { rules: () => [{ rule: `Bash(${command})`, once: true }], used, refused, denied } })
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(toolUse('other', 'Bash', { command: 'git status' }))
    f.transport.receive(hook('after-other', 'conductor_after', 'other', 'Bash', { command: 'git status' }, { stdout: '', exitCode: 0 }))
    f.transport.receive(toolUse('granted', 'Bash', { command }))
    f.transport.receive(hook('before-granted', 'conductor_before', 'granted', 'Bash', { command }))
    await flush()
    expect(used).not.toHaveBeenCalled()
    f.transport.receive(hook('after-granted', 'conductor_after', 'granted', 'Bash', { command }, { stdout: 'ok', exitCode: 0 }))
    await flush()
    expect(used).toHaveBeenCalledExactlyOnceWith(`Bash(${command})`)
    f.transport.receive(toolUse('again', 'Bash', { command }))
    f.transport.receive(deniedHook('denied-again', 'again', 'Bash', { command }, '[External System Write]'))
    await flush()
    expect(refused).toHaveBeenCalledWith(`Bash(${command})`)
    // The service decides whether the grant stands (its approval turn may still be queued) before
    // it files the card, which then joins the approved request instead of asking again.
    expect(denied).toHaveBeenCalledWith('auto-denial:again',expect.objectContaining({ tool: 'Bash', rule: `Bash(${command})` }))
    expect(refused.mock.invocationCallOrder[0]).toBeLessThan(denied.mock.invocationCallOrder[0]!)
  })
})

describe('Conductor tool hook health (harness gap H16)', () => {
  afterEach(() => resetClaudeHookHealth())
  const initializeHooks = (f: ReturnType<typeof fixture>) => (f.transport.sent.find(message => (message as { request?: { subtype?: string } }).request?.subtype === 'initialize') as { request: { hooks: Record<string, Array<{ matcher?: string; timeout?: number }>> } }).request.hooks

  it('keeps read-only tools out of the PreToolUse matcher, so an unreachable hook host cannot refuse them, and holds every other tool', async () => {
    const f = fixture(); await f.adapter.start()
    const [before] = initializeHooks(f).PreToolUse!
    expect(before!.matcher).toBe(PRE_TOOL_USE_MATCHER)
    const hooked = new RegExp(PRE_TOOL_USE_MATCHER)
    for (const read of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'mcp__conductor-local__local_ask', 'mcp__conductor-local__summarize_file', 'mcp__conductor-browser__browser_snapshot', 'mcp__conductor-browser__browser_screenshot', 'mcp__conductor-browser__browser_console']) expect(hooked.test(read), read).toBe(false)
    for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Agent', 'ReadMcpResourceTool', 'Reader', 'mcp__conductor__control', 'mcp__conductor-local__run_and_summarize', 'mcp__conductor-browser__browser_click', 'mcp__conductor-browser__browser_evaluate', 'mcp__other__Read']) expect(hooked.test(tool), tool).toBe(true)
    expect(HOOK_FREE_READ_TOOLS).toHaveLength(10)
    // The after-hooks still see every call (approve-once grants are spent there), and a CLI this
    // app started waits past Conductor's own 15 s budget, so a late answer is Conductor's refusal.
    expect(initializeHooks(f).PostToolUse).toEqual([{ hookCallbackIds: ['conductor_after'], timeout: 20 }])
  })

  it('times every hook answer for app.state', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive(hook('timed', 'conductor_before', 'tool', 'Bash', { command: 'npm test' }))
    await flush()
    expect(claudeHookHealth()).toMatchObject({ unreachable: false, answered: 1, failures: 0, slow: 0, lastFailureAt: null })
  })

  it('shows calls refused for want of a hook answer as one notice per runtime, flags app.state and marks the payload for the next briefing', async () => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    for (const id of ['toolu_h1', 'toolu_h2']) {
      f.transport.receive(toolUse(id, 'Bash', { command: 'npm test' }))
      f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'PreToolUse hook did not respond before its timeout (host client may be unreachable). The tool call was not executed; other configured hooks may not have completed.' }] } })
    }
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: {}, modelUsage: {} })
    await f.adapter.submit('Again', settings)
    f.transport.receive(toolUse('toolu_h3', 'Edit', { file_path: 'a.txt' }))
    f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_h3', is_error: true, content: 'PreToolUse hook failed with an unexpected error. The tool call was not executed; other configured hooks may not have completed.' }] } })
    await flush()
    const notices = f.projection().items.filter(item => item.data.type === 'notice' && (item.data.payload as { hookUnreachable?: unknown } | undefined)?.hookUnreachable)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.data).toMatchObject({ payload: { hookUnreachable: { tool: 'Edit', count: 3 } }, message: expect.stringMatching(/unreachable.*refused Edit and 2 more calls.*Read-only tools \(Read, Glob, Grep, LS/) })
    expect(f.projection().items.some(item => autoModeDenialOf(item.data))).toBe(false)
    expect(claudeHookHealth()).toMatchObject({ unreachable: true, failures: 3, lastFailure: expect.stringMatching(/^PreToolUse hook failed/) })
    expect(claudeHookHealth(Date.now() + 11 * 60_000).unreachable).toBe(false)
  })

  it('keeps one classifier-outage notice per runtime across turns, counting the latest turn', async () => {
    const f = fixture(); await f.adapter.start()
    for (const [turn, ids] of [['one', ['toolu_c1', 'toolu_c2']], ['two', ['toolu_c3']]] as const) {
      await f.adapter.submit(turn, settings)
      for (const id of ids) {
        f.transport.receive(toolUse(id, 'Bash', { command: 'npm test' }))
        f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash.' }] } })
      }
      f.transport.receive({ type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: {}, modelUsage: {} })
      await flush()
    }
    const notices = f.projection().items.filter(item => item.data.type === 'notice' && (item.data.payload as { classifierUnavailable?: unknown } | undefined)?.classifierUnavailable)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.data).toMatchObject({ payload: { classifierUnavailable: { toolUseId: 'toolu_c3', count: 1 } } })
  })
})

// Haftheme 2026-10-01: an approval interrupted a successor's first turn 0.3 s after its message was
// sent, before the CLI had started it. No result ever closes a turn the CLI never ran, so the tab
// stayed 'interrupting' through a restart and refused every message.
describe('a turn interrupted before the CLI started it', () => {
  const sessionEvents = (f: ReturnType<typeof fixture>) => f.events.filter(event => event.data.type === 'session').map(event => event.data as { phase: string; notStarted?: boolean })
  const turnMessage = (f: ReturnType<typeof fixture>) => (f.transport.sent.find(message => (message as { type?: string }).type === 'user') as { uuid: string }).uuid
  afterEach(() => { vi.useRealTimers() })

  it('settles at once when the interrupt receipt cancels the turn\'s own message, and takes the next turn', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Successor brief', settings)
    f.transport.autoControlResponses = false
    const stopping = f.adapter.interrupt()
    const request = f.transport.sent.at(-1) as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [], cancelled: [turnMessage(f)] } } })
    await stopping
    expect(f.projection().phase).toBe('interrupted')
    expect(sessionEvents(f).at(-1)).toMatchObject({ phase: 'interrupted', notStarted: true })
    f.transport.autoControlResponses = true
    await expect(f.adapter.submit('Approved retry', settings)).resolves.toBeUndefined()
    expect(f.projection().phase).toBe('running')
  })

  it('settles a turn that showed no frame once the CLI has had time to close it, but waits for the result of one it started', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const silent = fixture()
    await silent.adapter.start(); await silent.adapter.submit('Successor brief', settings)
    await silent.adapter.interrupt()
    expect(silent.projection().phase).toBe('interrupting')
    vi.advanceTimersByTime(3_001)
    expect(silent.projection().phase).toBe('interrupted')
    expect(sessionEvents(silent).at(-1)).toMatchObject({ notStarted: true })

    const started = fixture()
    await started.adapter.start(); await started.adapter.submit('Long task', settings)
    started.transport.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'working' } } })
    await started.adapter.interrupt()
    vi.advanceTimersByTime(60_000)
    expect(started.projection().phase).toBe('interrupting')
    started.transport.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} })
    expect(started.projection().phase).toBe('interrupted')
    expect(sessionEvents(started).some(event => event.notStarted)).toBe(false)
  })

  it('re-interrupts a stopping turn on reattach and settles it when the CLI never started it, also from an older build\'s state', async () => {
    const detached = async (olderBuild: boolean) => {
      const before = fixture()
      await before.adapter.start(); await before.adapter.submit('Successor brief', settings)
      before.transport.autoControlResponses = false
      const stopping = before.adapter.interrupt()
      const request = before.transport.sent.at(-1) as { request_id: string }
      before.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [], cancelled: [] } } })
      await stopping
      Object.assign(before.transport, { detachable: true, detach: async () => ({ runtimeId: 'host-runtime', seq: 1 }) })
      const detachment = (await before.adapter.detach())!
      expect(detachment).not.toBeNull()
      // An older build kept no record of whether the turn had started.
      if (olderBuild) delete (detachment.state as { v: Record<string, unknown> }).v.turnEvidence
      // Detaching polls with real timers; the reattached turn's settle is timed with fake ones.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const after = fixture({ attach: detachment })
      await after.adapter.start()
      expect(after.transport.sent.some(message => (message as { request?: { subtype?: string } }).request?.subtype === 'interrupt')).toBe(true)
      await flush()
      vi.advanceTimersByTime(3_001)
      vi.useRealTimers()
      return after
    }
    const current = await detached(false)
    expect(current.projection().phase).toBe('interrupted')
    expect(sessionEvents(current).at(-1)).toMatchObject({ phase: 'interrupted', notStarted: true })
    const older = await detached(true)
    expect(older.projection().phase).toBe('interrupted')
    // Unknown whether it ran, so its message is not offered again; the conversation is told.
    expect(sessionEvents(older).at(-1)).not.toHaveProperty('notStarted')
    expect(older.events.some(event => event.data.type === 'notice' && /showed no sign of the interrupted turn/.test(event.data.message))).toBe(true)
  })
})
