/** SYNTHETIC Electron fixture: raw Claude CLI protocol; never contacts a provider. */
// Only fixed panel smoke operations are executable. The fixture refuses arbitrary prompts/tools.
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

if (process.env.CONDUCTOR_OFFLINE_TESTS !== '1') throw new Error('Synthetic Claude UI fixture requires CONDUCTOR_OFFLINE_TESTS=1')
const input = readline.createInterface({ input: process.stdin })
const nativeSessionId = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : 'synthetic-claude-native-1'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const success = (id, response = {}) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
const emit = (message) => send({ uuid: randomUUID(), session_id: nativeSessionId, parent_tool_use_id: null, ...message })
const hook = (id, callback, tool, name, args, response) => send({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: callback, tool_use_id: tool, input: { tool_use_id: tool, tool_name: name, tool_input: args, ...(response ? { tool_response: response } : {}) } } })
const result = (tool, output, isError = false, details) => emit({ type: 'user', ...(details ? { tool_use_result: details } : {}), message: { content: [{ type: 'tool_result', tool_use_id: tool, content: output, is_error: isError }] } })
const declare = (tool, name, args) => emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: tool, name, input: args }] } })
const text = (content) => {
  const messageId = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id: messageId, content: [{ type: 'text', text: content }] } })
}
const finish = (failed = false) => emit({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, usage: {} })
const oldDeclarations = "  var wasOpen = el.classList.contains('is-open');\n  var wasPinned = pinned;\n"
const editInput = { file_path: 'panel.mjs', old_string: oldDeclarations, new_string: '', description: 'Remove the two unused declarations (synthetic fixture)' }
let initialized = false
let turn = 0
let pending
let testResult

for await (const line of input) {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const kind = message.request.subtype
    if (kind === 'initialize') {
      initialized = true
      success(message.request_id, { models: [{ value: 'synthetic-claude', displayName: 'Synthetic Claude fixture' }], commands: [{ name: 'fixture', description: 'Synthetic discovery only' }] })
    } else if (kind === 'interrupt') {
      if (pending) send({ type: 'control_cancel_request', request_id: pending })
      pending = undefined; success(message.request_id); finish()
    } else if (kind === 'set_model' || kind === 'set_permission_mode') success(message.request_id)
    else send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported synthetic control' } })
  } else if (message.type === 'user') {
    if (!initialized) throw new Error('User message before initialization')
    const prompt = message.message.content
    if (typeof prompt !== 'string' || !prompt.startsWith('SYNTHETIC ')) throw new Error('Fixture accepts explicitly synthetic prompts only')
    turn++
    emit({ type: 'system', subtype: 'init', claude_code_version: '2.1.263', tools: ['Edit', 'Bash'], mcp_servers: [], permissionMode: 'default' })
    if (prompt.startsWith('SYNTHETIC B')) {
      text('**Synthetic fixture continuation:** `wasOpen` and `wasPinned` were removed; the local Node test passed. This is offline fixture behavior, not live-provider context evidence.')
      finish(); continue
    }
    text('**Synthetic Claude activity:** review the pending edit to `panel.mjs`. The fixture will run the local Node test after approval.')
    declare(`edit-${turn}`, 'Edit', editInput)
    pending = `pre-${turn}`
    hook(pending, 'conductor_before', `edit-${turn}`, 'Edit', editInput)
  } else if (message.type === 'control_response') {
    const { request_id: id, response } = message.response
    if (id !== pending) throw new Error('Response does not match the outstanding synthetic request')
    if (id === `pre-${turn}`) {
      pending = `approval-${turn}`
      send({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_use_id: `edit-${turn}`, tool_name: 'Edit', input: editInput, title: 'Allow synthetic two-line edit?' } })
    } else if (id === `approval-${turn}`) {
      if (response.behavior !== 'allow') {
        result(`edit-${turn}`, 'Synthetic edit denied; no file bytes changed.', true)
        text('Synthetic fixture: the edit was denied and the file remains unchanged.')
        pending = undefined; finish(); continue
      }
      if (response.updatedInput.file_path !== 'panel.mjs' || response.toolUseID !== `edit-${turn}`) throw new Error('Unexpected synthetic permission response')
      const path = resolve('panel.mjs'), before = readFileSync(path, 'utf8')
      if (!before.includes(oldDeclarations)) throw new Error('Synthetic panel baseline is missing its exact two declarations')
      writeFileSync(path, before.replace(oldDeclarations, ''))
      pending = `post-${turn}`
      hook(pending, 'conductor_after', `edit-${turn}`, 'Edit', editInput, { filePath: path })
    } else if (id === `post-${turn}`) {
      result(`edit-${turn}`, 'Synthetic fixture applied exactly two deletions to panel.mjs.')
      declare(`test-${turn}`, 'Bash', { command: 'node --test panel.test.mjs', description: 'Run the dependency-free panel test (synthetic fixture)' })
      emit({ type: 'tool_progress', tool_use_id: `test-${turn}`, tool_name: 'Bash', elapsed_time_seconds: 0 })
      let stdout = '', stderr = '', exitCode = 0
      try { stdout = execFileSync(process.execPath, ['--test', 'panel.test.mjs'], { encoding: 'utf8', cwd: process.cwd(), windowsHide: true, timeout: 5000 }) }
      catch (error) { stdout = String(error.stdout ?? ''); stderr = String(error.stderr ?? ''); exitCode = typeof error.status === 'number' ? error.status : 1 }
      testResult = { stdout, stderr, exitCode }
      pending = `test-post-${turn}`
      hook(pending, exitCode ? 'conductor_failed' : 'conductor_after', `test-${turn}`, 'Bash', { command: 'node --test panel.test.mjs' }, testResult)
    } else if (id === `test-post-${turn}`) {
      result(`test-${turn}`, testResult.stdout, testResult.exitCode !== 0, testResult)
      text(`**Synthetic fixture:** removed two declarations from \`panel.mjs\`. The actual local Node test ${testResult.exitCode ? 'failed' : 'passed'}.`)
      pending = undefined; finish(testResult.exitCode !== 0)
    }
  }
}
