#!/usr/bin/env node
// Zero-turn probe of the installed Grok CLI's ACP `session/set_config_option` wire shape.
// Spawns `grok agent --no-leader stdio`, initializes, opens one session in a temp directory and
// sends value-shape variants for `model` and `reasoning_effort`. It never sends `session/prompt`,
// so no model turn runs and nothing is billed. Output is sanitized (session ids, paths, catalog).
//   node scripts/probe-grok-config.mjs [path-to-grok]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const executable = process.argv[2] ?? 'grok'
const cwd = mkdtempSync(path.join(tmpdir(), 'conductor-grok-probe-'))
const child = spawn(executable, ['agent', '--no-leader', 'stdio'], { cwd, env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buffer = '', nextId = 0, sessionId
const waiting = new Map()
const sanitize = value => JSON.parse(JSON.stringify(value ?? null, (key, entry) => {
  if (typeof entry === 'string' && sessionId && entry === sessionId) return '<session>'
  if (typeof entry === 'string' && entry.toLowerCase().includes(cwd.toLowerCase())) return '<cwd>'
  if (/token|authorization|apikey|secret/i.test(key) && typeof entry === 'string') return '<redacted>'
  return entry
}))
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && message.method === undefined && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
    else if (message.id !== undefined && message.method) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'probe does not implement client methods' } })}\n`)
  }
})
child.stderr.resume()
const request = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  const id = ++nextId
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
  waiting.set(id, message => { clearTimeout(timer); resolve(message) })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
/** Only what matters for the shape question: current values and the offered choices. */
const summarizeOptions = options => Array.isArray(options) ? options.map(option => ({ id: option.id, type: option.type, category: option.category, currentValue: option.currentValue, options: Array.isArray(option.options) ? option.options.map(choice => choice.value ?? choice.id ?? choice) : option.options })) : options
const outcome = message => message.error ? { error: sanitize(message.error) } : { result: sanitize({ ...message.result, configOptions: summarizeOptions(message.result?.configOptions) }) }

try {
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'conductor-probe', title: 'Conductor probe', version: '1' } })
  if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(sanitize(initialized.error))}`)
  console.log(JSON.stringify({ step: 'initialize', protocolVersion: initialized.result.protocolVersion, agentInfo: initialized.result.agentInfo ?? null }))
  const created = await request('session/new', { cwd, mcpServers: [] }, 120_000)
  if (created.error) throw new Error(`session/new failed: ${JSON.stringify(sanitize(created.error))}`)
  sessionId = created.result.sessionId
  const options = created.result.configOptions ?? []
  console.log(JSON.stringify({ step: 'session/new', configOptions: summarizeOptions(sanitize(options)) }))
  const current = id => { const option = options.find(entry => entry.id === id); return option?.currentValue }
  const choices = id => (options.find(entry => entry.id === id)?.options ?? []).map(choice => choice.value).filter(value => typeof value === 'string')
  const model = choices('model').find(value => value !== current('model')) ?? current('model')
  const effort = choices('reasoning_effort').find(value => value !== current('reasoning_effort')) ?? 'medium'
  const variants = value => [
    ['plain string', value],
    ['{value}', { value }],
    ['{type:"select",value}', { type: 'select', value }],
    ['{valueId}', { valueId: value }]
  ]
  for (const [configId, target] of [['model', model], ['reasoning_effort', effort]]) {
    for (const [label, value] of variants(target)) {
      const answer = await request('session/set_config_option', { sessionId, configId, value })
      console.log(JSON.stringify({ step: 'session/set_config_option', configId, shape: label, sent: value, ...outcome(answer) }))
    }
  }
  // The exact owner failures (high -> medium effort, Grok Fast) and invalid choices, plain-string shape.
  for (const [configId, value] of [['reasoning_effort', 'medium'], ['model', 'grok-4.7-build-fast'], ['model', 'grok-9'], ['reasoning_effort', 'turbo']]) {
    const answer = await request('session/set_config_option', { sessionId, configId, value })
    console.log(JSON.stringify({ step: 'session/set_config_option', configId, shape: 'plain string', sent: value, ...outcome(answer) }))
  }
  // Put the session back the way Grok opened it (it is a throwaway session in a temp directory).
  for (const configId of ['model', 'reasoning_effort']) if (current(configId)) await request('session/set_config_option', { sessionId, configId, value: current(configId) })
} catch (error) {
  console.log(JSON.stringify({ step: 'probe-failed', message: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill()
  setTimeout(() => { try { rmSync(cwd, { recursive: true, force: true }) } catch { /* Grok may still hold it */ } process.exit() }, 500)
}
