/** SYNTHETIC protocol fixture. No provider, inference, tools, filesystem writes or credentials. */
import readline from 'node:readline'
const input = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const success = (id, response = {}) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
let initialized = false
let toolAllowed = false
for await (const line of input) {
  const message = JSON.parse(line)
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    if (!message.request.hooks.PreToolUse[0].hookCallbackIds.includes('conductor_before')) throw new Error('Missing pre hook')
    initialized = true
    success(message.request_id, { models: [{ value: 'fixture-only', displayName: 'Synthetic model' }] })
  } else if (message.type === 'user') {
    if (!initialized) throw new Error('User input arrived before initialization')
    send({ type: 'system', subtype: 'init', session_id: 'fixture-native', claude_code_version: '2.1.263' })
    send({ type: 'assistant', uuid: 'declaration', session_id: 'fixture-native', message: { id: 'fake-msg', content: [{ type: 'tool_use', id: 'fake-shell', name: 'PowerShell', input: { command: 'SYNTHETIC_ONLY', description: 'Verify the fake process contract' } }] } })
    send({ type: 'control_request', request_id: 'fake-pre', request: { subtype: 'hook_callback', callback_id: 'conductor_before', tool_use_id: 'fake-shell', input: { tool_use_id: 'fake-shell', tool_name: 'PowerShell', tool_input: { command: 'SYNTHETIC_ONLY' } } } })
  } else if (message.type === 'control_response') {
    const { request_id: id, response } = message.response
    if (id === 'fake-pre') send({ type: 'control_request', request_id: 'fake-approval', request: { subtype: 'can_use_tool', tool_name: 'PowerShell', tool_use_id: 'fake-shell', input: { command: 'SYNTHETIC_ONLY' } } })
    else if (id === 'fake-approval') {
      if (response.behavior !== 'allow' || response.updatedInput.command !== 'SYNTHETIC_ONLY' || response.toolUseID !== 'fake-shell') throw new Error('Incorrect permission answer')
      toolAllowed = true
      send({ type: 'tool_progress', tool_use_id: 'fake-shell', tool_name: 'PowerShell', elapsed_time_seconds: 0.01 })
      send({ type: 'control_request', request_id: 'fake-post', request: { subtype: 'hook_callback', callback_id: 'conductor_after', tool_use_id: 'fake-shell', input: { tool_name: 'PowerShell', tool_input: { command: 'SYNTHETIC_ONLY' }, tool_response: { stdout: 'SYNTHETIC OUTPUT 😀', stderr: '', exitCode: 0 } } } })
    } else if (id === 'fake-post') {
      if (!toolAllowed) throw new Error('Post hook before approval')
      const line = Buffer.from(JSON.stringify({ type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'fake-shell', content: 'SYNTHETIC OUTPUT 😀' }] } }) + '\n')
      for (const byte of line) process.stdout.write(Buffer.from([byte]))
      send({ type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-native', usage: { input_tokens: 0, output_tokens: 0 } })
    }
  } else throw new Error('Unexpected fixture protocol frame')
}
