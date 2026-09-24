/** SYNTHETIC Claude Code control-protocol fixture for the capability sweep. Never contacts a
 *  provider. It answers `initialize` with the model catalog the installed Claude Code 2.1.281
 *  advertised to this account on 2026-09-24 (captured by scripts/probe-capability-sweep.mjs,
 *  field names and values verbatim) plus one deliberately under-described model, and it answers
 *  a handful of explicitly synthetic prompts with the usage, context-window and compaction frames
 *  the production adapter reads. Nothing here executes tools or writes files. */
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

if (process.argv.includes('--version')) { console.log('2.1.281 (Claude Code)'); process.exit(0) }
if (process.env.CONDUCTOR_OFFLINE_TESTS !== '1') throw new Error('Synthetic capability fixture requires CONDUCTOR_OFFLINE_TESTS=1')

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Verbatim shape of the 2026-09-24 initialize answer (descriptions shortened, no account data). */
export const CLAUDE_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
  // Not advertised by the real CLI: a model entry with nothing but an id, the shape a future
  // release could add, so the sweep can show what Conductor does with unknown metadata.
  { value: 'swarm-unknown-model' }
]
/** Context windows the [1m] variants and the others reach, as the real result frames report them
 *  in `modelUsage`; a value here is a fixture figure, not a measurement. */
const WINDOWS = { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000, maxOutputTokens: 64_000 }, 'claude-fable-5-1': { contextWindow: 1_000_000, maxOutputTokens: 64_000 }, 'claude-sonnet-5': { contextWindow: 1_000_000, maxOutputTokens: 64_000 }, 'claude-haiku-4-5-20251001': { contextWindow: 200_000, maxOutputTokens: 64_000 } }

const input = readline.createInterface({ input: process.stdin })
const nativeSessionId = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : 'swarm-claude-native-1'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const success = (id, response = {}) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
const emit = message => send({ uuid: randomUUID(), session_id: nativeSessionId, parent_tool_use_id: null, ...message })
let model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'default'
let effort = process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : 'xhigh'
let permissionMode = process.argv.includes('--permission-mode') ? process.argv[process.argv.indexOf('--permission-mode') + 1] : 'default'
let contextUsed = 0
const resolved = () => CLAUDE_MODELS.find(entry => entry.value === model)?.resolvedModel ?? model
/** The API names the model without the [1m] suffix on message frames (observed live: system/init
 *  said `claude-opus-5[1m]`, the assistant message said `claude-opus-5`), while `modelUsage` in
 *  the result is keyed by the configured name. Reproducing that is what makes the sweep show the
 *  missing context window on the 1M Opus default (repair R14 in the parity ledger). */
const apiModel = () => resolved().replace(/\[1m\]$/, '')

const reply = (text, inputTokens, outputTokens) => {
  const messageId = randomUUID()
  // First API call of the turn: its input is the whole context at that moment, which is what the
  // adapter reads as context used (input + cache read + cache write + output).
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId, model: apiModel(), usage: { input_tokens: 4, cache_read_input_tokens: inputTokens - 4, cache_creation_input_tokens: 0, output_tokens: 0 } } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: outputTokens } } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id: messageId, model: apiModel(), content: [{ type: 'text', text }], usage: { input_tokens: 4, cache_read_input_tokens: inputTokens - 4, cache_creation_input_tokens: 0, output_tokens: outputTokens } } })
  const window = WINDOWS[resolved()]
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 4, cache_read_input_tokens: inputTokens - 4, cache_creation_input_tokens: 0, output_tokens: outputTokens }, modelUsage: window ? { [resolved()]: { inputTokens: 4, outputTokens, cacheReadInputTokens: inputTokens - 4, cacheCreationInputTokens: 0, contextWindow: window.contextWindow, maxOutputTokens: window.maxOutputTokens, costUSD: 0.01 } } : {} })
}

for await (const line of input) {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const kind = message.request.subtype
    if (kind === 'initialize') {
      // `swarm_launch_args` is the fixture's own addition (the real CLI reports no such field): the
      // arguments Conductor launched it with, so the sweep can prove no --effort was sent (R7).
      success(message.request_id, { commands: [], agents: [], output_style: 'default', models: CLAUDE_MODELS, account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }, current_permission_mode: permissionMode, hooks_applied: true, fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required', session_state: 'idle', swarm_launch_args: process.argv.slice(2) })
      const resetsAt = Math.floor(Date.now() / 1000) + 3600
      emit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.16, resetsAt }, seven_day: { utilization: 0.12, resetsAt: resetsAt + 86_400 }, seven_day_fable: { utilization: 0.19, resetsAt: resetsAt + 86_400 } } } })
    } else if (kind === 'set_model') { model = message.request.model ?? 'default'; success(message.request_id) }
    else if (kind === 'apply_flag_settings') { effort = message.request.settings?.effortLevel ?? effort; success(message.request_id) }
    else if (kind === 'set_permission_mode') { permissionMode = message.request.mode; success(message.request_id) }
    else if (kind === 'interrupt') { success(message.request_id, { cancelled: [], still_queued: [] }); emit({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }) }
    else send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported synthetic control' } })
    continue
  }
  if (message.type !== 'user') throw new Error('Unexpected fixture frame')
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(item => item.type === 'text').map(item => item.text).join('') : blocks
  if (typeof prompt !== 'string' || !prompt.startsWith('SYNTHETIC ')) throw new Error('Fixture accepts explicitly synthetic prompts only')
  const scenario = prompt.split(/\r?\n/, 1)[0]
  // As observed live on 2.1.278: system/init names the configured model (with its [1m] suffix),
  // the permission mode, tools, MCP servers and protocol capabilities, but not the effort level.
  emit({ type: 'system', subtype: 'init', session_id: nativeSessionId, model: resolved(), permissionMode, claude_code_version: '2.1.278', tools: ['Read', 'Edit', 'Bash', 'Agent', 'WebSearch', 'WebFetch'], mcp_servers: [], capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] })
  if (scenario === 'SYNTHETIC COMPACT') {
    // Compaction: the boundary arrives before the turn's own first call, whose input is the
    // compacted context; the adapter must clear the old figure and show the smaller one.
    emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: contextUsed } })
    contextUsed = 12_000
    reply('Compacted.', contextUsed, 3)
    continue
  }
  const explicit = /^SYNTHETIC CONTEXT (\d+)/.exec(scenario)
  contextUsed = explicit ? Number(explicit[1]) : contextUsed + 18_900
  reply('OK', contextUsed, 1)
}
