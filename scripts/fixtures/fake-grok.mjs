// Offline stand-in for `grok agent --no-leader stdio` (Grok Build 1.0.41): ACP JSON-RPC 2.0 over
// newline-framed stdio, with frame shapes copied from live captures on 2026-09-24. No inference.
// The prompt text selects the scripted turn:
//   synthetic:edit        an Edit tool call with a diff that asks for permission
//   synthetic:command X   a Run Command tool call for command X that asks for permission
//   synthetic:hang        a turn that only ends through session/cancel
//   synthetic:models      announces grok-4.8 through _x.ai/models/update before replying
//   synthetic:compact     reports a finished auto compaction before replying
//   anything else         a thought and a short reply
// FAKE_GROK_UNAUTHENTICATED=1 makes session/new fail the way a signed-out CLI does.
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const efforts = (values, preferred = 'high') => values.map(value => ({ id: value, value, label: value, default: value === preferred }))
const catalog = (current = 'grok-4.7') => ({
  currentModelId: current,
  availableModels: [
    { modelId: 'grok-4.7', name: 'Grok 4.7', description: "SpaceXAI's latest frontier model", _meta: { totalContextTokens: 500000, supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: efforts(['xhigh', 'high', 'medium', 'low']) } },
    { modelId: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast', _meta: { totalContextTokens: 500000, supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: efforts(['xhigh', 'high', 'medium', 'low']) } },
    { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { totalContextTokens: 500000, supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: efforts(['high', 'medium', 'low']) } }
  ]
})
const sessions = new Map()
let outgoing = 0
const waiting = new Map()
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (method, params) => send({ method, params })
const update = (sessionId, value) => notify('session/update', { sessionId, update: value, _meta: { eventId: randomUUID() } })
const ask = (method, params) => new Promise(resolve => { const id = outgoing++; waiting.set(id, resolve); send({ id, method, params }) })
const configOptions = session => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: catalog().availableModels.map(model => ({ value: model.modelId, name: model.name })) },
  { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: session.effort, options: ['xhigh', 'high', 'medium', 'low'].map(value => ({ value, name: value })) }
]
const sessionResult = session => ({ sessionId: session.id, models: catalog(session.model), configOptions: configOptions(session), _meta: { currentWorkingDirectory: session.cwd } })

async function prompt(session, text) {
  const id = session.id
  update(id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about it.' } })
  if (text.includes('synthetic:models')) notify('_x.ai/models/update', { ...catalog(session.model), availableModels: [...catalog().availableModels, { modelId: 'grok-4.8', name: 'Grok 4.8', _meta: { totalContextTokens: 1000000, reasoningEfforts: efforts(['high', 'low']) } }] })
  if (text.includes('synthetic:compact')) notify('_x.ai/session_notification', { sessionId: id, update: { sessionUpdate: 'auto_compact_completed' } })
  if (text.includes('synthetic:hang')) {
    await new Promise(resolve => { session.cancel = resolve })
    return 'cancelled'
  }
  const tool = text.includes('synthetic:edit') ? {
    toolCallId: `call-${randomUUID()}-0`, name: 'search_replace', label: 'Edit', kind: 'edit', title: `Edit \`${session.cwd}\\notes.txt\``,
    rawInput: { variant: 'SearchReplace', file_path: `${session.cwd}\\notes.txt`, old_string: 'one', new_string: 'one\ntwo' },
    content: [{ type: 'diff', path: `${session.cwd}\\notes.txt`, oldText: 'one', newText: 'one\ntwo' }], locations: [{ path: `${session.cwd}\\notes.txt` }]
  } : /synthetic:command (.+)/.test(text) ? (() => {
    const command = /synthetic:command (.+)/.exec(text)[1].trim()
    return { toolCallId: `call-${randomUUID()}-0`, name: 'run_terminal_command', label: 'Run Command', kind: 'execute', title: `Execute \`${command}\``, rawInput: { variant: 'Bash', command }, content: [], locations: [] }
  })() : undefined
  if (tool) {
    const meta = { 'x.ai/tool': { version: 1, name: tool.name, kind: tool.kind, namespace: 'grok_build', label: tool.label, read_only: false } }
    update(id, { sessionUpdate: 'tool_call', toolCallId: tool.toolCallId, title: tool.name, rawInput: tool.rawInput, _meta: meta })
    update(id, { sessionUpdate: 'tool_call_update', toolCallId: tool.toolCallId, kind: tool.kind, title: tool.title, content: tool.content, locations: tool.locations, rawInput: tool.rawInput, _meta: meta })
    const options = tool.kind === 'edit'
      ? [{ optionId: 'allow-edits-session', name: 'Yes, allow all edits during this session', kind: 'allow_always' }, { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }, { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' }]
      : [{ optionId: 'allow-always', name: 'Yes, and don\'t ask again for this command', kind: 'allow_always' }, { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }, { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' }]
    const answer = await ask('session/request_permission', { sessionId: id, toolCall: { toolCallId: tool.toolCallId, kind: tool.kind, title: tool.title, rawInput: tool.rawInput, _meta: meta }, options })
    const outcome = answer.result?.outcome
    if (outcome?.outcome === 'cancelled') return 'cancelled'
    const allowed = outcome?.outcome === 'selected' && String(outcome.optionId).startsWith('allow')
    update(id, allowed
      ? { sessionUpdate: 'tool_call_update', toolCallId: tool.toolCallId, status: 'completed', content: tool.kind === 'edit' ? tool.content : [{ type: 'content', content: { type: 'text', text: 'done\r\n' } }], rawOutput: tool.kind === 'edit' ? { type: 'SearchReplace' } : { type: 'Bash', exit_code: 0, command: tool.rawInput.command } }
      : { sessionUpdate: 'tool_call_update', toolCallId: tool.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user rejected this tool call.' } }] })
  }
  for (const chunk of ['Synthetic ', 'Grok ', 'reply.']) update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
  return 'end_turn'
}

createInterface({ input: process.stdin }).on('line', async line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id !== undefined && !message.method) { waiting.get(message.id)?.(message); waiting.delete(message.id); return }
  const { id, method, params = {} } = message
  const reply = result => send({ id, result })
  const fail = (code, text, data) => send({ id, error: { code, message: text, ...(data === undefined ? {} : { data }) } })
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {} }, auth: {} }, authMethods: [{ id: 'cached_token', name: 'cached_token' }, { id: 'grok.com', name: 'Grok' }], _meta: { agentVersion: '1.0.41', modelState: catalog() } })
    case 'session/new': {
      notify('_x.ai/session/setup', { method: 'session/new', phase: 'auth', sessionId: null })
      if (process.env.FAKE_GROK_UNAUTHENTICATED === '1') return fail(-32000, 'Authentication required', 'no auth method id provided')
      const session = { id: randomUUID(), cwd: params.cwd, model: 'grok-4.7', effort: 'high', autoMode: params._meta?.autoMode === true, mcpServers: params.mcpServers ?? [] }
      sessions.set(session.id, session)
      notify('_x.ai/session/setup', { method: 'session/new', phase: 'persistence_init', sessionId: session.id })
      return reply(sessionResult(session))
    }
    case 'session/resume': case 'session/load': {
      if (String(params.sessionId).startsWith('missing')) return fail(-32603, 'Path not found.', { detail: 'The system cannot find the path specified. (os error 3)', code: 'FS_NOT_FOUND' })
      const session = sessions.get(params.sessionId) ?? { id: params.sessionId, cwd: params.cwd, model: 'grok-4.7', effort: 'high' }
      session.autoMode = params._meta?.autoMode === true
      session.mcpServers = params.mcpServers ?? []
      sessions.set(session.id, session)
      return reply(sessionResult(session))
    }
    case 'session/set_mode':
      return reply({})
    case 'session/set_config_option': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(-32602, 'Invalid params', 'unknown session')
      // Grok 1.0.41 takes the value id as a plain string; an object such as `{ value }` fails
      // deserialization before the option is looked at (zero-turn probe, docs/autopilot-evidence/g8-grok-config.md).
      if (typeof params.value !== 'string') return fail(-32602, 'Invalid params', 'data did not match any variant of untagged enum SessionConfigOptionValue at line 1 column 111')
      const option = configOptions(session).find(entry => entry.id === params.configId)
      if (!option) return fail(-32602, 'Invalid params', 'unknown config option')
      if (!option.options.some(choice => choice.value === params.value)) return fail(-32602, 'Invalid params', params.configId === 'model' ? 'unknown model id' : `unknown ${params.configId} value`)
      if (params.configId === 'model') session.model = params.value
      else session.effort = params.value
      return reply({ configOptions: configOptions(session) })
    }
    case 'session/prompt': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(-32602, 'Invalid params', 'unknown session')
      const text = (params.prompt ?? []).map(block => block.text ?? '').join('\n')
      session.lastPrompt = text
      const stopReason = await prompt(session, text)
      notify('_x.ai/session_notification', { sessionId: session.id, update: { sessionUpdate: 'turn_completed', stop_reason: stopReason } })
      return reply({ stopReason, _meta: { sessionId: session.id, modelId: session.model, totalTokens: 19457, usage: { inputTokens: 19421, outputTokens: 27, totalTokens: 19448, cachedReadTokens: 1792, reasoningTokens: 26, costUsdTicks: 123474400 } } })
    }
    case 'session/cancel': {
      const session = sessions.get(params.sessionId)
      session?.cancel?.()
      return
    }
    case '_conductor/fixture/state':
      return reply(Object.fromEntries([...sessions].map(([key, session]) => [key, { model: session.model, effort: session.effort, autoMode: session.autoMode, mcpServers: session.mcpServers, lastPrompt: session.lastPrompt }])))
    default:
      if (id !== undefined) fail(-32601, `Method not found: ${method}`)
  }
})
