/** SYNTHETIC Electron fixture: raw Claude CLI protocol; never contacts a provider. */
// Only fixed panel smoke operations are executable. The fixture refuses arbitrary prompts/tools.
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

if (process.env.CONDUCTOR_OFFLINE_TESTS !== '1') throw new Error('Synthetic Claude UI fixture requires CONDUCTOR_OFFLINE_TESTS=1')
const fableQuotaFixture = process.env.CONDUCTOR_TEST_CLAUDE_QUOTA === 'fable'
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
let permissionScenario
let permissionMode = process.argv[process.argv.indexOf('--permission-mode') + 1]
const sessionRules = new Set()
const steeringHeld = new Map()
const steeringTimers = new Set()

// One turn that writes where a real agent writes: a memory file under the owner's profile, a
// sibling project, a brand-new nested directory, and one ordinary in-workspace edit. Only the
// last two are the workspace's business; the snapshot layer has nothing to capture for the rest
// and must not narrate that fact once per tool call.
const outsideDirectory = process.env.CONDUCTOR_SMOKE_OUTSIDE_DIR
const outsideEdits = outsideDirectory ? [
  { path: resolve(outsideDirectory, 'memory', 'fact.md'), body: 'remembered outside the workspace\n' },
  { path: resolve(outsideDirectory, 'sibling-project', 'notes.md'), body: 'a sibling project file\n' },
  { path: resolve(outsideDirectory, 'memory', 'second.md'), body: 'a second memory write\n' },
  { path: resolve('panel.mjs'), body: null },
  { path: resolve('brand-new/nested/created.txt'), body: 'created inside a directory that did not exist\n' }
] : []
let outsideIndex = 0
const stepOutside = () => {
  const edit = outsideEdits[outsideIndex]
  if (!edit) {
    text(`**Synthetic fixture:** completed ${outsideEdits.length} writes, ${outsideEdits.length - 2} of them outside the workspace.`)
    pending = undefined; finish(); return
  }
  const input = { file_path: edit.path, old_string: '', new_string: edit.body ?? '', description: 'Synthetic out-of-workspace write' }
  declare(`outside-${outsideIndex}`, 'Edit', input)
  pending = `outside-pre-${outsideIndex}`
  hook(pending, 'conductor_before', `outside-${outsideIndex}`, 'Edit', input)
}

for await (const line of input) {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const kind = message.request.subtype
    if (kind === 'initialize') {
      // Delayed metadata response exercises pressing Send during initialization.
      await new Promise(resolve => setTimeout(resolve, 800))
      initialized = true
      const models = fableQuotaFixture
        ? [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', supportsEffort: true, supportedEffortLevels: ['high'], defaultEffort: 'high' }]
        : [{ value: 'synthetic-claude', displayName: 'Synthetic Claude fixture', supportsEffort: true, supportedEffortLevels: ['low', 'high'], defaultEffort: 'high' }]
      success(message.request_id, { models, commands: [{ name: 'fixture', description: 'Synthetic discovery only' }] })
      if (fableQuotaFixture) {
        const resetsAt = Math.floor(Date.now() / 1000) + 86_400
        // Native identity/effective model evidence, still outside any user/model turn.
        emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1', effort: 'high', permissionMode: 'default', claude_code_version: '2.1.263' })
        emit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
          five_hour: { utilization: 0.24, resetsAt },
          seven_day: { utilization: 0.95, resetsAt },
          seven_day_overage_included: { utilization: 0.99, resetsAt }
        } } })
      }
    } else if (kind === 'interrupt') {
      if (pending) send({ type: 'control_cancel_request', request_id: pending })
      const cancelled = [...steeringHeld.keys()]
      steeringHeld.clear(); for (const timer of steeringTimers) clearTimeout(timer); steeringTimers.clear()
      pending = undefined; success(message.request_id, { cancelled, still_queued: [] }); emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use', usage: {} })
    } else if (kind === 'set_permission_mode') {
      if (permissionScenario === 'REJECT' && message.request.mode === 'auto') send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Synthetic managed policy disables auto-mode' } })
      else { permissionMode = message.request.mode; success(message.request_id) }
    } else if (kind === 'set_model' || kind === 'apply_flag_settings') success(message.request_id)
    else send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported synthetic control' } })
  } else if (message.type === 'user') {
    if (!initialized) throw new Error('User message before initialization')
    const blocks = message.message.content
    const prompt = Array.isArray(blocks) ? blocks.filter(item => item.type === 'text').map(item => item.text).join('') : blocks
    if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE && typeof prompt === 'string') writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
    if (typeof prompt === 'string' && prompt.startsWith('SYNTHETIC IMAGES')) {
      const images = blocks.filter(item => item.type === 'image')
      if (!images.length || images.some(item => item.source.type !== 'base64' || item.source.media_type !== 'image/png' || Buffer.from(item.source.data, 'base64').subarray(0,8).toString('hex') !== '89504e470d0a1a0a')) throw new Error('Synthetic image bytes did not reach Claude')
      emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: '2.1.263' })
      text('Synthetic native images received: ' + images.length); finish(); continue
    }
    if (typeof prompt !== 'string' || !prompt.startsWith('SYNTHETIC ')) throw new Error('Fixture accepts explicitly synthetic prompts only')
    if (prompt.startsWith('SYNTHETIC STEERING ')) {
      const scenario = prompt.split(/\s+/)[2]
      if (message.priority === 'next') {
        steeringHeld.set(message.uuid, prompt)
        emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' })
        if (scenario === 'NEXT') {
          const timer = setTimeout(() => {
            steeringTimers.delete(timer)
            if (!steeringHeld.delete(message.uuid)) return
            result('steering-tool', 'Synthetic tool boundary reached')
            emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'started' })
            text('Synthetic steering consumed while the original turn continues.')
          }, 1800)
          steeringTimers.add(timer)
        }
      } else {
        emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: '2.1.263' })
        if (scenario === 'WAIT') { declare('steering-tool', 'Read', { file_path: 'synthetic.txt' }); text('Synthetic tool remains active.') }
        else { text('Synthetic expedited input received.'); finish() }
      }
      continue
    }
    if (prompt.startsWith('SYNTHETIC STEER DATA')) { emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' }); emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'started' }); text('Synthetic steering input received during the active turn.'); continue }
    turn++
    if (prompt.startsWith('SYNTHETIC PERMISSION ')) {
      permissionScenario = /^SYNTHETIC PERMISSION (SCOPED|REPEAT|AUTO|REJECT|ONCE|DENY|REQUIRED|SESSION_EDIT|REPEAT_EDIT)\b/.exec(prompt)?.[1]
      if (!permissionScenario) throw new Error('Unknown synthetic permission scenario')
      emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: '2.1.263', permissionMode })
      const command = permissionScenario === 'SCOPED' || permissionScenario === 'REPEAT' ? 'echo conductor-session-scope' : 'echo conductor-' + permissionScenario.toLowerCase()
      const editPermission = ['SESSION_EDIT', 'REPEAT_EDIT'].includes(permissionScenario)
      const toolName = editPermission ? 'Write' : 'Bash'
      const toolInput = editPermission ? { file_path: 'synthetic-permission.txt', content: 'proof' } : { command }
      declare(`permission-tool-${turn}`, toolName, toolInput)
      if (permissionScenario === 'REPEAT_EDIT' && permissionMode === 'acceptEdits') {
        result(`permission-tool-${turn}`, 'SYNTHETIC native Edit-mode session grant covered repeat; no file was changed.')
        text('SYNTHETIC native session Edit mode reused.'); finish(); continue
      }
      if (permissionScenario === 'REPEAT' && sessionRules.has(command)) {
        result(`permission-tool-${turn}`, 'SYNTHETIC native session rule covered repeat; no command was executed.')
        text('SYNTHETIC native session grant reused.'); finish(); continue
      }
      pending = `permission-${turn}`
      send({ type: 'control_request', request_id: pending, request: {
        subtype: 'can_use_tool', tool_use_id: `permission-tool-${turn}`, tool_name: toolName, input: toolInput,
        ...(permissionScenario === 'REQUIRED' ? { matched_ask_rule: { source: 'policySettings', tool_name: 'Bash' }, decision_reason: 'Synthetic policy requires approval' } : {}),
        permission_suggestions: editPermission ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] : [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: command }] }]
      } })
      continue
    }
    if (prompt.startsWith('SYNTHETIC STEER START')) { emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: '2.1.263' }); continue }
    emit({ type: 'system', subtype: 'init', claude_code_version: '2.1.263', tools: ['Edit', 'Bash'], mcp_servers: [], permissionMode: 'default' })
    if (prompt.startsWith('SYNTHETIC QUESTION')) {
      emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', effort: 'high', claude_code_version: '2.1.263' })
      const answerText = 'I have one question before continuing.'
      text(answerText)
      pending = 'question-' + turn
      send({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: pending, input: { questions: [{ header: 'Appearance', question: 'Which theme should this workspace use?', multiSelect: false, options: [{ label: 'Night', description: 'A quiet, dark workspace.' }, { label: 'Day', description: 'A bright workspace for daytime.' }] }] } } })
      continue
    }
    if (prompt.startsWith('SYNTHETIC OUTSIDE')) {
      if (!outsideEdits.length) throw new Error('Synthetic out-of-workspace scenario requires CONDUCTOR_SMOKE_OUTSIDE_DIR')
      text('**Synthetic Claude activity:** writing a memory file, a sibling project file and one file in this workspace.')
      outsideIndex = 0
      stepOutside()
      continue
    }
    if (prompt.startsWith('SYNTHETIC BASH BACKGROUND')) {
      const taskId = `background-bash-${turn}`
      const toolId = `background-bash-tool-${turn}`
      emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: '2.1.263' })
      declare(toolId, 'Bash', { command: 'node --version', description: 'Synthetic background Bash process' })
      emit({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolId, description: 'Synthetic background Bash process', is_backgrounded: true, task_type: 'local_bash', status: 'running' })
      emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolId, status: 'completed', summary: 'Synthetic background Bash process completed (exit code 0)' })
      result(toolId, 'Synthetic background Bash process completed.')
      text('Synthetic background Bash process stayed on its Bash activity row.')
      finish()
      continue
    }
    if (prompt.startsWith('SYNTHETIC BACKGROUND')) {
      // A turn that hands its work to a backgrounded task and then reports its own result while
      // that child is still going, which is what Claude does whenever an agent dispatches work.
      const taskId = `background-task-${++turn}`
      emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: '2.1.263' })
      declare(`task-tool-${turn}`, 'Task', { description: 'Synthetic background worker' })
      emit({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `task-tool-${turn}`, description: 'Synthetic background worker', is_backgrounded: true, task_type: 'local_agent', status: 'running' })
      text('Handing this to a background worker; holding here until it reports.')
      finish()
      // The child reports back long after the parent turn ended. The wait is what the caller
      // observes the conversation in: still working, with no turn of its own in flight.
      const timer = setTimeout(() => {
        steeringTimers.delete(timer)
        emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: `task-tool-${turn}`, status: 'completed', summary: 'Synthetic background worker completed (exit code 0)' })
      }, Number(process.env.CONDUCTOR_SMOKE_BACKGROUND_MS ?? 6000))
      steeringTimers.add(timer)
      continue
    }
    if (prompt.startsWith('SYNTHETIC FILELINKS')) {
      // The caller supplies the exact Markdown to answer with between <<< and >>>, so this fixture
      // never has to know which link shapes a smoke test exercises, and Conductor's own appended
      // prompt sections are not echoed back into the reply.
      const body = /<<<([\s\S]*?)>>>/.exec(prompt)?.[1]?.trim()
      if (!body) throw new Error('Synthetic file-link scenario requires the reply Markdown between <<< and >>>')
      text(body)
      finish(); continue
    }
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
    if (id === `permission-${turn}`) {
      for (const update of response.updatedPermissions ?? []) {
        if (update.type === 'setMode' && update.mode === 'acceptEdits' && update.destination === 'session' && ['SESSION_EDIT', 'REPEAT_EDIT'].includes(permissionScenario)) { permissionMode = 'acceptEdits'; continue }
        if (update.type !== 'addRules' || update.behavior !== 'allow' || update.destination !== 'session') throw new Error('Synthetic session grant escaped its scope')
        for (const rule of update.rules) {
          if (rule.toolName !== 'Bash' || rule.ruleContent !== 'echo conductor-session-scope') throw new Error('Synthetic grant was broader than the offered action')
          sessionRules.add(rule.ruleContent)
        }
      }
      result(`permission-tool-${turn}`, `SYNTHETIC ${response.behavior}; no command was executed.`, response.behavior !== 'allow')
      text(`SYNTHETIC permission result: ${response.behavior}; native mode: ${permissionMode}.`)
      pending = undefined; permissionScenario = undefined; finish(); continue
    }
    if (id === 'question-' + turn) {
      if (response.updatedInput.answers['Which theme should this workspace use?'] !== 'Night') throw new Error('Synthetic question answer changed')
      result(pending, 'Answer received')
      const summary = 'Night was selected.'
      text(summary)
      emit({ type: 'result', subtype: 'success', is_error: false, result: summary, usage: { input_tokens: 100, output_tokens: 20 } })
      pending = undefined
      continue
    }
    if (id === `outside-pre-${outsideIndex}`) {
      const edit = outsideEdits[outsideIndex]
      mkdirSync(dirname(edit.path), { recursive: true })
      writeFileSync(edit.path, edit.body ?? readFileSync(edit.path, 'utf8').replace(oldDeclarations, ''))
      pending = `outside-post-${outsideIndex}`
      hook(pending, 'conductor_after', `outside-${outsideIndex}`, 'Edit', { file_path: edit.path }, { filePath: edit.path })
    } else if (id === `outside-post-${outsideIndex}`) {
      result(`outside-${outsideIndex}`, `Synthetic fixture wrote ${outsideEdits[outsideIndex].path}.`)
      outsideIndex++
      stepOutside()
    } else if (id === `pre-${turn}`) {
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
