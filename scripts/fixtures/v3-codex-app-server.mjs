// SYNTHETIC OFFLINE FIXTURE. No provider executable, network, credentials, or inference.
// Copy of scripts/fixtures/codex-app-server.mjs (handshake, --version, model/list, etc.) plus one
// added scenario, 'synthetic:numbered-stream', for V3 verify S1/S2 (this is a private test-tmp
// fixture copy, not an edit of the checked-in script).
import readline from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

if (process.env.CONDUCTOR_TEST_PROVIDER_START_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_PROVIDER_START_CAPTURE, `${process.pid}\n`)
if (process.argv.includes('--version')) { console.log('codex-cli 0.155.1'); process.exit(0) }

let initialized = false
let acknowledged = false
let currentTurn
let turnNumber = 0
let approval
const materializedPath = join(process.cwd(), '.synthetic-codex-materialized')
let materialized = existsSync(materializedPath)
const threadId = 'synthetic-thread-1'
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params })
const itemEvent = (method, item) => notify(method, { threadId, turnId: currentTurn, item })
const patch = '@@ -1,5 +1,3 @@\n export function updatePanel(el, pinned) {\n-  var wasOpen = el.classList.contains(\'is-open\');\n-  var wasPinned = pinned;\n   el.classList.add(\'is-loading\');\n }\n'
const changes = [{ path: 'panel.mjs', kind: { type: 'update', move_path: null }, diff: patch }]
const command = (id, status = 'inProgress', output = null, exitCode = null) => ({ type: 'commandExecution', id, command: 'pwsh.exe -NoProfile -Command "Write-Output café"', cwd: process.cwd(), source: 'agent', status, aggregatedOutput: output, exitCode, durationMs: exitCode === null ? null : 4, commandActions: [], pluginId: null, scriptPath: null, processId: null })
const finish = (status = 'completed') => notify('turn/completed', { threadId, turn: { id: currentTurn, items: [], status, error: status === 'failed' ? { message: 'synthetic failure' } : null } })
const usageRouting = process.env.CONDUCTOR_TEST_USAGE_ROUTING === '1'
const defaults = () => ({ thread: { id: threadId, status: { type: 'idle' }, turns: [], cwd: process.cwd() }, model: usageRouting ? 'gpt-6-astra' : 'synthetic-model', reasoningEffort: usageRouting ? 'xhigh' : 'low', modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, instructionSources: [] })

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (!message.method) {
    if (!approval || message.id !== approval.id) { process.exitCode = 9; return }
    if (message.error && approval.reissue) {
      approval = undefined
      itemEvent('item/completed', command('command-1', 'declined', '', null))
      itemEvent('item/completed', { type: 'agentMessage', id: 'reissue-refused', text: 'Synthetic: the client refused the reissued request: ' + message.error.message, phase: null, memoryCitation: null, delivery: null, questions: null })
      finish()
      return
    }
    const pending = approval
    approval = undefined
    notify('serverRequest/resolved', { threadId, requestId: message.id })
    if (pending.question) {
      itemEvent('item/completed', { type: 'agentMessage', id: 'question-answer', text: JSON.stringify(message.result), phase: null, memoryCitation: null, delivery: null, questions: null })
      finish()
      return
    }
    if (pending.mcp) {
      const allowed = message.result?.action === 'accept'
      itemEvent('item/completed', { type: 'mcpToolCall', id: 'mcp-1', server: 'conductor-browser', tool: 'browser_snapshot', arguments: {}, status: allowed ? 'completed' : 'failed', result: allowed ? { content: [{ type: 'text', text: 'synthetic snapshot' }], structuredContent: null } : null, error: allowed ? null : { message: 'user rejected MCP tool call' }, durationMs: 3 })
      itemEvent('item/completed', { type: 'agentMessage', id: 'mcp-answer', text: JSON.stringify(message.result), phase: null, memoryCitation: null, delivery: null, questions: null })
      finish()
      return
    }
    const accepted = ['accept', 'acceptForSession'].includes(message.result?.decision)
    if (accepted && pending.edit) {
      const path = join(process.cwd(), 'panel.mjs')
      writeFileSync(path, readFileSync(path, 'utf8').replace("  var wasOpen = el.classList.contains('is-open');\n  var wasPinned = pinned;\n", ''))
    }
    if (pending.edit) itemEvent('item/completed', { type: 'fileChange', id: 'edit-1', changes, status: accepted ? 'completed' : 'declined' })
    else itemEvent('item/completed', command('command-1', accepted ? 'completed' : 'declined', accepted ? 'ran once\n' : '', accepted ? 0 : null))
    finish(message.result?.decision === 'cancel' ? 'interrupted' : 'completed')
    return
  }
  if (message.method === 'initialize') {
    if (initialized) throw new Error('duplicate initialization')
    setTimeout(() => {
      initialized = true
      send({ id: message.id, result: { userAgent: 'codex/0.155.1 synthetic', codexHome: '/synthetic/not-read', platformFamily: 'windows', platformOs: 'windows' } })
    }, 12)
    return
  }
  if (message.method === 'initialized') {
    if (!initialized) throw new Error('initialized before initialize response')
    acknowledged = true
    return
  }
  if (!initialized || !acknowledged) throw new Error('request before initialization handshake completed')
  if (message.method === 'thread/name/set') { materialized = true }
  if (message.method === 'thread/read') { send({ id: message.id, result: { thread: defaults().thread } }); return }
  if (message.method === 'config/read') { send({ id: message.id, result: { config: { approval_policy: null, mcp_servers: {} }, layers: [] } }); return }
  if (message.method === 'thread/start' || message.method === 'thread/resume') { send({ id: message.id, result: defaults() }); return }
  if (message.method === 'model/list') {
    const models = [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: true, defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh', description: 'Synthetic' }] }]
    send({ id: message.id, result: { data: models, nextCursor: null } })
    return
  }
  if (message.method === 'account/rateLimits/read') { send({ id: message.id, result: { ordinaryUsageAllowed: true, rateLimits: null, rateLimitsByLimitId: {}, rateLimitResetCredits: null, accountId: 'synthetic-account', rateLimitUpsell: null } }); return }
  if (message.method === 'thread/goal/get') { send({ id: message.id, result: { goal: null } }); return }
  if (message.method === 'thread/fork') { send({ id: message.id, result: { ...defaults(), thread: { ...defaults().thread, id: 'synthetic-fork-1' } } }); return }
  if (['thread/unsubscribe', 'thread/name/set', 'thread/archive', 'thread/unarchive'].includes(message.method)) { send({ id: message.id, result: {} }); return }
  if (message.method === 'skills/list') { send({ id: message.id, result: { data: [{ cwd: process.cwd(), skills: [], errors: [] }] } }); return }
  if (message.method === 'mcpServerStatus/list') { send({ id: message.id, result: { data: [], nextCursor: null } }); return }
  if (message.method === 'plugin/list') { send({ id: message.id, result: { marketplaces: [] } }); return }
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId: currentTurn } })
    itemEvent('item/completed', { type: 'userMessage', id: 'steer-' + message.id, clientId: message.params.clientUserMessageId, content: message.params.input })
    return
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} })
    if (approval) { notify('serverRequest/resolved', { threadId, requestId: approval.id }); approval = undefined }
    setTimeout(() => finish('interrupted'), 15)
    return
  }
  if (message.method !== 'turn/start') { send({ id: message.id, error: { code: -32601, message: 'unsupported synthetic request' } }); return }
  currentTurn = `synthetic-turn-${++turnNumber}`
  const promptText = message.params.input[0].text
  const scenario = promptText.startsWith('synthetic:') ? promptText.split(/\r?\n/, 1)[0] : promptText
  notify('turn/started', { threadId, turn: { id: currentTurn, status: 'inProgress', items: [], error: null } })
  send({ id: message.id, result: { turn: { id: currentTurn, status: 'inProgress', items: [], error: null } } })
  if (scenario === 'synthetic:numbered-stream') {
    const words = Array.from({ length: Number(process.env.V3_STREAM_WORDS ?? 120) }, (_, i) => 'w' + String(i + 1).padStart(3, '0') + ' ')
    const delayMs = Number(process.env.V3_STREAM_DELAY_MS ?? 250)
    itemEvent('item/started', { type: 'agentMessage', id: 'stream-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null })
    let index = 0
    const stream = () => {
      notify('item/agentMessage/delta', { threadId, turnId: currentTurn, itemId: 'stream-1', delta: words[index] })
      index++
      if (index < words.length) setTimeout(stream, delayMs)
      else { itemEvent('item/completed', { type: 'agentMessage', id: 'stream-1', text: words.join(''), phase: null, memoryCitation: null, delivery: null, questions: null }); finish() }
    }
    stream()
    return
  }
  itemEvent('item/completed', { type: 'agentMessage', id: 'message-1', text: 'café again again', phase: null, memoryCitation: null, delivery: null, questions: null })
  finish()
})
