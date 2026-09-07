// SYNTHETIC OFFLINE FIXTURE. No provider executable, network, credentials, or inference.
// Raw JSONL messages mirror the generated codex-cli 0.153.4 App Server protocol.
import readline from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0) }

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
const defaults = () => ({ thread: { id: threadId, status: { type: 'idle' }, turns: [], cwd: process.cwd() }, model: 'synthetic-model', reasoningEffort: 'low', modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, instructionSources: [] })

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (!message.method) {
    if (!approval || message.id !== approval.id) { process.exitCode = 9; return }
    const pending = approval
    approval = undefined
    notify('serverRequest/resolved', { threadId, requestId: message.id })
    if (pending.question) {
      itemEvent('item/completed', { type: 'agentMessage', id: 'question-answer', text: JSON.stringify(message.result), phase: null, memoryCitation: null, delivery: null, questions: null })
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
    if (pending.ui && accepted) {
      const started = Date.now()
      const running = { ...command('test-1'), command: 'node --test panel.test.mjs' }
      itemEvent('item/started', running)
      let output = ''
      let exitCode = 0
      try { output = execFileSync(process.execPath, ['--test', 'panel.test.mjs'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 5000 }) }
      catch (error) { output = String(error.stdout ?? '') + String(error.stderr ?? ''); exitCode = typeof error.status === 'number' ? error.status : 1 }
      notify('item/commandExecution/outputDelta', { threadId, turnId: currentTurn, itemId: 'test-1', delta: output })
      itemEvent('item/completed', { ...running, status: exitCode ? 'failed' : 'completed', aggregatedOutput: output, exitCode, durationMs: Date.now() - started })
      itemEvent('item/completed', { type: 'agentMessage', id: 'ui-result', text: '**Synthetic fixture:** removed two declarations from `panel.mjs`. The actual local Node test ' + (exitCode ? 'failed' : 'passed') + '.\n\n```js\nconst label = "<img src=x onerror=alert(1)>";\n```', phase: null, memoryCitation: null, delivery: null, questions: null })
      notify('thread/status/changed', { threadId, status: { type: 'idle' } })
      notify('thread/tokenUsage/updated', { threadId, turnId: currentTurn, tokenUsage: { total: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 600 }, modelContextWindow: 128000 } })
      notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1789344000 }, secondary: null } })
      finish(exitCode ? 'failed' : 'completed')
      return
    }
    finish(message.result?.decision === 'cancel' ? 'interrupted' : 'completed')
    return
  }
  if (message.method === 'initialize') {
    if (initialized) throw new Error('duplicate initialization')
    setTimeout(() => {
      initialized = true
      send({ id: message.id, result: { userAgent: 'codex/0.153.4 synthetic', codexHome: '/synthetic/not-read', platformFamily: 'windows', platformOs: 'windows' } })
    }, 12)
    return
  }
  if (message.method === 'initialized') {
    if (!initialized) throw new Error('initialized before initialize response')
    acknowledged = true
    return
  }
  if (!initialized || !acknowledged) throw new Error('request before initialization handshake completed')
  if (message.method === 'thread/name/set') { materialized = true; if (process.env.CONDUCTOR_TEST_EMPTY_HISTORY === '1') writeFileSync(materializedPath, 'Synthetic empty history metadata') }
  if (message.method === 'thread/read' && !materialized && process.env.CONDUCTOR_TEST_EMPTY_HISTORY === '1') { send({ id: message.id, error: { code: -32603, message: 'list_turns is not supported yet' } }); return }
  if (message.method === 'thread/read') { send({ id: message.id, result: { thread: defaults().thread } }); return }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: defaults() })
    return
  }
  if (message.method === 'model/list') {
    send({ id: message.id, result: { data: [{ id: 'synthetic-model-id', model: 'synthetic-model', displayName: 'Synthetic model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Synthetic' }] }, ...(process.env.CONDUCTOR_TEST_MODEL_CATALOG === '1' ? [{ id: 'plain', model: 'plain-model', displayName: 'No effort model', isDefault: false, defaultReasoningEffort: 'none', supportedReasoningEfforts: [] }] : [])], nextCursor: null } })
    return
  }
  if (message.method === 'thread/goal/get') { send({ id: message.id, result: { goal: null } }); return }
  if (message.method === 'thread/fork') { send({ id: message.id, result: { ...defaults(), thread: { ...defaults().thread, id: 'synthetic-fork-1' } } }); return }
  if (['thread/unsubscribe', 'thread/name/set', 'thread/archive', 'thread/unarchive'].includes(message.method)) { send({ id: message.id, result: {} }); return }
  if (message.method === 'skills/list') { send({ id: message.id, result: { data: [{ cwd: process.cwd(), skills: [], errors: [] }] } }); return }
  if (message.method === 'mcpServerStatus/list') { send({ id: message.id, result: { data: [], nextCursor: null } }); return }
  if (message.method === 'plugin/list') { send({ id: message.id, result: { marketplaces: [] } }); return }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} })
    if (approval) { notify('serverRequest/resolved', { threadId, requestId: approval.id }); approval = undefined }
    setTimeout(() => finish('interrupted'), 15)
    return
  }
  if (message.method !== 'turn/start') { send({ id: message.id, error: { code: -32601, message: 'unsupported synthetic request' } }); return }
  currentTurn = `synthetic-turn-${++turnNumber}`
  const scenario = message.params.input[0].text
  notify('turn/started', { threadId, turn: { id: currentTurn, status: 'inProgress', items: [], error: null } })
  send({ id: message.id, result: { turn: { id: currentTurn, status: 'inProgress', items: [], error: null } } })
  if (scenario === 'synthetic:activity-groups') {
    itemEvent('item/completed', { type: 'agentMessage', id: 'activity-intro', text: 'I will inspect the files and preserve useful results.', phase: null, memoryCitation: null, delivery: null, questions: null })
    for (let index = 1; index <= 8; index++) {
      itemEvent('item/completed', command(`activity-command-${index}`, 'completed', `EXACT OUTPUT ${index}`, 0))
      itemEvent('item/completed', { type: 'subAgentActivity', id: `activity-status-${index}`, kind: 'started', agentThreadId: 'activity-child', agentPath: '/root/reviewer' })
    }
    itemEvent('item/completed', { type: 'subAgentActivity', id: 'activity-self', kind: 'started', agentThreadId: threadId, agentPath: '/root' })
    itemEvent('item/completed', command('activity-failure', 'failed', 'An actionable command failure remains visible.', 2))
    itemEvent('item/completed', { type: 'agentMessage', id: 'activity-result', text: 'Inspection is complete. The failed check needs attention.', phase: null, memoryCitation: null, delivery: null, questions: null })
    finish()
    return
  }
  if (scenario === 'synthetic:context') {
    for (const totalTokens of [140000, 190000, 24000]) notify('thread/tokenUsage/updated', { threadId, turnId: currentTurn, tokenUsage: {
      total: { inputTokens: 9000000, outputTokens: 4000, totalTokens: 9004000, cachedInputTokens: 8000000, reasoningOutputTokens: 1000 },
      last: { inputTokens: totalTokens - 42, outputTokens: 42, totalTokens, cachedInputTokens: 20000, reasoningOutputTokens: 20 }, modelContextWindow: 200000
    } })
    finish()
    return
  }
  if (scenario === 'synthetic:telemetry') {
    const telemetry = (inputTokens, outputTokens, reasoningOutputTokens) => notify('thread/tokenUsage/updated', { threadId, turnId: currentTurn, tokenUsage: { total: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens: 400, reasoningOutputTokens }, modelContextWindow: 200000 } })
    const agents = (first, second) => itemEvent('item/completed', { type: 'collabAgentToolCall', id: 'telemetry-parent', tool: 'spawnAgent', status: 'completed', senderThreadId: threadId, receiverThreadIds: ['telemetry-research', 'telemetry-tests'], prompt: 'Synthetic telemetry validation only. No agents are actually launched.', model: null, reasoningEffort: null, agentsStates: { 'telemetry-research': { status: first, message: null }, 'telemetry-tests': { status: second, message: null } } })
    const paragraph = index => `Synthetic telemetry paragraph ${index}. This raw protocol fixture validates scrolling and accounting without model inference.`
    const message = (id, title) => itemEvent('item/completed', { type: 'agentMessage', id, text: `**${title}**\n\n` + Array.from({ length: 22 }, (_, index) => paragraph(index + 1)).join('\n\n'), phase: null, memoryCitation: null, delivery: null, questions: null })
    const waitForFile = (file, next) => {
      const started = Date.now()
      const poll = () => {
        if (existsSync(join(process.cwd(), file))) next()
        else if (Date.now() - started < 30000) setTimeout(poll, 20)
        else { process.stderr.write('Synthetic telemetry barrier timed out.\n'); finish('failed') }
      }
      poll()
    }
    agents('running', 'running')
    telemetry(1000, 20, 10)
    notify('thread/tokenUsage/updated', { threadId: 'telemetry-research', turnId: 'telemetry-child-turn', tokenUsage: { total: { inputTokens: 9000, outputTokens: 500, totalTokens: 9500, cachedInputTokens: 0, reasoningOutputTokens: 300 }, modelContextWindow: 200000 } })
    notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1789416000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1789941600 } } })
    message('telemetry-first', 'Synthetic telemetry started')
    waitForFile('.synthetic-telemetry-next', () => {
      agents('completed', 'running')
      telemetry(1000, 100, 60)
      message('telemetry-next', 'Synthetic telemetry updated')
      waitForFile('.synthetic-telemetry-finish', () => {
        agents('completed', 'errored')
        telemetry(1500, 200, 100)
        message('telemetry-final', 'Synthetic telemetry complete')
        finish()
      })
    })
    return
  }
  if (scenario.startsWith('synthetic:backlog')) {
    itemEvent('item/completed', { type: 'agentMessage', id: 'backlog-result', text: 'SYNTHETIC backlog fixture. [Open alpha](alpha.ts)\n\n' + 'long_unbroken_text_'.repeat(180) + '\n\n' + String.fromCharCode(96).repeat(3) + 'text\n' + 'wide code '.repeat(180) + '\n' + String.fromCharCode(96).repeat(3), phase: null, memoryCitation: null, delivery: null, questions: null })
    return // Deliberately wait for an explicit interrupt; no live provider runs.
  }
  if (scenario === 'synthetic:large') {
    let index = 0
    let barrierStarted
    const batch = () => {
      // Synthetic UI-only synchronization, outside the provider protocol. The test
      // selects committed text before releasing another 1,700 activity rows.
      if (index === 500 && !existsSync(join(process.cwd(), '.synthetic-large-continue'))) {
        barrierStarted ??= Date.now()
        if (Date.now() - barrierStarted > 10_000) {
          process.stderr.write('Synthetic UI selection barrier expired after 10 seconds.\n')
          finish('failed')
        } else setTimeout(batch, 20)
        return
      }
      const until = Math.min(index + 50, 2200)
      while (index < until) {
        index++
        if (index === 1800) {
          itemEvent('item/started', { type: 'collabAgentToolCall', id: 'synthetic-parent', tool: 'spawnAgent', status: 'inProgress', senderThreadId: threadId, receiverThreadIds: ['synthetic-child'], prompt: 'Synthetic nested activity only; no runtime or tools launched.', model: null, reasoningEffort: null, agentsStates: { 'synthetic-child': { status: 'running', message: null } } })
          notify('item/completed', { threadId: 'synthetic-child', turnId: 'synthetic-child-turn', item: { type: 'agentMessage', id: 'synthetic-child-text', text: '**Synthetic nested agent:** renderer relationship fixture; no model or tool execution.', phase: null, memoryCitation: null, delivery: null, questions: null } })
          itemEvent('item/completed', { type: 'collabAgentToolCall', id: 'synthetic-parent', tool: 'spawnAgent', status: 'completed', senderThreadId: threadId, receiverThreadIds: ['synthetic-child'], prompt: 'Synthetic nested activity only; no runtime or tools launched.', model: null, reasoningEffort: null, agentsStates: { 'synthetic-child': { status: 'completed', message: 'Synthetic fixture complete' } } })
        }
        itemEvent('item/completed', { type: 'agentMessage', id: `synthetic-large-${index}`, text: `**Synthetic activity ${index}:** This deterministic history checks bounded rendering and readable Markdown with Unicode café 🧪. It performs no commands, filesystem edits, network requests, or model inference.`, phase: null, memoryCitation: null, delivery: null, questions: null })
      }
      if (index < 2200) setTimeout(batch, 5)
      else finish()
    }
    batch()
    return
  }
  if (scenario.startsWith('SYNTHETIC B')) {
    itemEvent('item/completed', { type: 'agentMessage', id: 'ui-context', text: 'Synthetic fixture continuation: wasOpen and wasPinned were removed; the local Node test passed.', phase: null, memoryCitation: null, delivery: null, questions: null })
    finish()
    return
  }
  if (scenario === 'synthetic:disconnect') { process.exit(7); return }
  if (scenario === 'synthetic:question') {
    approval = { id: 501, question: true }
    send({ id: 501, method: 'item/tool/requestUserInput', params: { threadId, turnId: currentTurn, itemId: 'question-1', questions: [{ id: 'flavor', header: 'Flavor', question: 'Choose a synthetic option', isOther: false, isSecret: false, options: [{ label: 'Vanilla', description: 'Option one' }, { label: 'Café', description: 'Option two' }] }], isBlocking: true, autoResolutionMs: null } })
    return
  }
  if (scenario.startsWith('synthetic:approval') || scenario.startsWith('SYNTHETIC A')) {
    const ui = scenario.startsWith('SYNTHETIC A')
    const edit = scenario.endsWith(':edit') || ui
    itemEvent('item/started', edit ? { type: 'fileChange', id: 'edit-1', changes, status: 'inProgress' } : command('command-1'))
    approval = { id: 500, edit, ui }
    send({ id: 500, method: edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId, turnId: currentTurn, itemId: edit ? 'edit-1' : 'command-1', reason: 'Synthetic harmless operation', command: edit ? null : 'Write-Output café', cwd: process.cwd(), kind: 'command', environmentId: null, startedAtMs: Date.now(), availableDecisions: ['accept', 'decline', 'cancel'] } })
    return
  }
  itemEvent('item/started', { type: 'agentMessage', id: 'message-1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null })
  // Split the UTF-8 bytes inside the emoji as well as the JSON frame; repeated text is legitimate.
  const first = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId: currentTurn, itemId: 'message-1', delta: 'café 🧪 ' } }) + '\n')
  const split = first.indexOf(Buffer.from('🧪')) + 2
  process.stdout.write(first.subarray(0, split))
  setTimeout(() => {
    process.stdout.write(first.subarray(split))
    notify('item/agentMessage/delta', { threadId, turnId: currentTurn, itemId: 'message-1', delta: 'again ' })
    notify('item/agentMessage/delta', { threadId, turnId: currentTurn, itemId: 'message-1', delta: 'again ' })
    itemEvent('item/completed', { type: 'agentMessage', id: 'message-1', text: 'café 🧪 again again ', phase: null, memoryCitation: null, delivery: null, questions: null })
    itemEvent('item/started', command('command-1'))
    itemEvent('item/started', command('command-2'))
    notify('item/commandExecution/outputDelta', { threadId, turnId: currentTurn, itemId: 'command-1', delta: 'one\n' })
    notify('item/commandExecution/outputDelta', { threadId, turnId: currentTurn, itemId: 'command-2', delta: 'two\n' })
    notify('item/commandExecution/outputDelta', { threadId, turnId: currentTurn, itemId: 'command-1', delta: 'one\n' })
    itemEvent('item/completed', command('command-1', 'completed', 'one\none\n', 0))
    notify('item/commandExecution/outputDelta', { threadId, turnId: currentTurn, itemId: 'command-1', delta: 'late chunk must not duplicate final output\n' })
    itemEvent('item/completed', command('command-2', 'failed', 'two\n', 2))
    itemEvent('item/started', { type: 'fileChange', id: 'edit-1', changes, status: 'inProgress' })
    itemEvent('item/completed', { type: 'fileChange', id: 'edit-1', changes, status: 'completed' })
    notify('turn/diff/updated', { threadId, turnId: currentTurn, diff: patch })
    notify('turn/plan/updated', { threadId, turnId: currentTurn, explanation: 'Synthetic plan', plan: [{ step: 'Do the fixture', status: 'completed' }] })
    notify('thread/tokenUsage/updated', { threadId, turnId: currentTurn, tokenUsage: { total: { inputTokens: 8, outputTokens: 3, cachedInputTokens: 2 }, modelContextWindow: null } })
    notify('synthetic/futureEvent', { threadId, turnId: currentTurn, payload: { inspectable: true } })
    process.stderr.write('synthetic stderr stays separate\n')
    finish()
  }, 8)
})
