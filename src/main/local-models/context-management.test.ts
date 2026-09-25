import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentSession, type LocalTelemetryEntry } from './agent.ts'
import { normaliseContract } from './completion.ts'
import { requestBudget } from './context-budget.ts'
import type { DockerSandbox, SandboxResult } from './sandbox.ts'
import type { ToolSpec } from './client.ts'

/** The loop under real request shapes: a stand-in llama.cpp endpoint whose reply is decided per
 *  request from what the loop sent, so each test scripts a model's behaviour rather than fixed
 *  frames. Every request is recorded with its message roles and content. */
interface Sent { messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>; tools?: ToolSpec[]; max_tokens: number }
type Script = (sent: Sent, index: number) => { frames: string[] } | { status: number; body: string }

const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })
const usageFrame = (prompt: number, completion: number): string => JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })
const call = (id: string, name: string, args: Record<string, unknown>): string => frame({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
const answer = (text: string): string => frame({ content: text }, 'stop')

function stub(script: Script): Promise<{ endpoint: string; server: Server; sent: Sent[] }> {
  const sent: Sent[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Sent
      const reply = script(parsed, sent.length)
      sent.push(parsed)
      response.on('error', () => { /* the client may close early on purpose */ })
      if ('status' in reply) { response.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const item of reply.frames) response.write(`data: ${item}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({ endpoint: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, server, sent })
  }))
}

const KEY = 'k'.repeat(64)
const lastUser = (sent: Sent): string => [...sent.messages].reverse().find(message => message.role === 'user')?.content ?? ''
const allUser = (sent: Sent): string => sent.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')

describe('context management in the local agent loop', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-ctx-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const value = 1\n', 'utf8')
    for (let n = 0; n < 12; n++) writeFileSync(join(root, `big-${n}.txt`), Array.from({ length: 200 }, (_v, i) => `FILE${n} line ${i + 1} ${'payload '.repeat(18)}`).join('\n') + '\n', 'utf8')
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    return root
  }

  it('grows across rounds, warns, compacts before the window is exceeded, keeps the task state, and keeps raw output for the timeline', async () => {
    const contextTokens = 14000
    const reads = 7
    const server = await stub((sent, index) => index < reads
      ? { frames: [call(`r${index}`, 'read_file', { path: `big-${index}.txt` }), usageFrame(Math.min(contextTokens, 3000 + index * 5000), 40)] }
      : { frames: [answer('Read them all; the value is 1.'), usageFrame(9000, 20)] })
    cleanup.push(() => server.server.close())
    const root = workspace()
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: root, sandbox: null, readOnly: true, timeoutSec: 30, contextTokens })
    const notices: string[] = []
    const telemetry: LocalTelemetryEntry[] = []
    const raw: string[] = []
    const outcome = await session.run('Task: read every big file, then report the value in src/a.ts. Constraint: touch nothing.', { notice: message => notices.push(message), telemetry: entry => telemetry.push(entry), toolEnd: tool => raw.push(tool.output) })

    expect(outcome.stopReason).toBe('completed')
    expect(server.sent).toHaveLength(reads + 1)
    // 1 and 2: the estimate rose round by round and crossed the warning band.
    const requests = telemetry.filter((entry): entry is Extract<LocalTelemetryEntry, { kind: 'request' }> => entry.kind === 'request')
    expect(requests[1]!.promptTokens).toBeGreaterThan(requests[0]!.promptTokens)
    // Request telemetry is measured after compaction; the compaction entry records the band that triggered it.
    // The bands are crossed fast with reads this size: either the warning spoke or compaction did.
    expect(notices.some(message => /Context is at about \d+%|Context compacted/.test(message))).toBe(true)
    // 3 and 8: compaction happened before any request could exceed the window, and every request
    // actually sent fit the window with the reserve counted.
    const compactions = telemetry.filter((entry): entry is Extract<LocalTelemetryEntry, { kind: 'compaction' }> => entry.kind === 'compaction')
    expect(compactions.length).toBeGreaterThanOrEqual(1)
    expect(compactions[0]!.afterTokens).toBeLessThan(compactions[0]!.beforeTokens)
    expect(['compact', 'aggressive', 'overflow']).toContain(compactions[0]!.level)
    for (const sent of server.sent) expect(requestBudget(sent.messages as never, sent.tools ?? [], contextTokens, sent.max_tokens).totalTokens).toBeLessThanOrEqual(contextTokens)
    // 4: the task and its constraint survive in the rendered state the model reads.
    const afterCompaction = server.sent.slice(-1)[0]!
    // Adjacent user turns are merged for the chat template, so the state may share the owner's message.
    const state = afterCompaction.messages.find(message => message.role === 'user' && message.content.includes('[Task state'))
    expect(state).toBeDefined()
    expect(state!.content).toContain('read every big file')
    expect(state!.content).toContain('touch nothing')
    expect(afterCompaction.messages[1]!.content).toContain('Task: read every big file')
    // 5: old verbose reads are out of the active prompt; at most two groups remain.
    expect(afterCompaction.messages.filter(message => message.role === 'tool').length).toBeLessThanOrEqual(2)
    expect(afterCompaction.messages.filter(message => message.role === 'tool' && message.content.includes('FILE0 line 1 ')).length).toBe(0)
    // 6: the timeline got every raw result in full while the prompt got the shaped form.
    expect(raw).toHaveLength(reads)
    expect(raw[0]).toContain('FILE0 line 200')
    expect(raw[0]!.length).toBeGreaterThan(30_000)
    const promptCopy = server.sent[1]!.messages.find(message => message.role === 'tool')!
    expect(promptCopy.content.length).toBeLessThan(raw[0]!.length)
    expect(outcome.report.excludedOutputChars).toBeGreaterThan(0)
    // 7: the report carries the reserve and the window separately.
    expect(outcome.report.context).toMatchObject({ windowTokens: contextTokens, reserveTokens: 2560, capacityTokens: contextTokens - 2560, estimated: false })
    expect(outcome.report.compactions).toBe(compactions.length)
    expect(outcome.report.recoveredTokens).toBeGreaterThan(0)
    // 14: the same conversation carries on after compaction; the earlier instruction is not lost.
    const second = await session.run('Now say done.', {})
    expect(second.stopReason).toBe('completed')
    const last = server.sent.at(-1)!
    expect(last.messages[0]!.role).toBe('system')
    expect(allUser(last)).toContain('Now say done.')
    expect(session.state()?.discoveries.join(' ')).toContain('Earlier instruction')
  })

  it('warns at the soft round, presses to finish, and stops at the hard limit rather than looping forever', async () => {
    const server = await stub((sent, index) => ({ frames: [call(`r${index}`, 'read_file', { path: `big-${index % 12}.txt`, offset: 1 + index, limit: 3 })] }))
    cleanup.push(() => server.server.close())
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768, policy: { task:{maxRounds:5}, rounds: { softWarningAt: 2, strongWarningAt: 3, finishAt: 4, hardLimit: 5 } } })
    const notices: string[] = []
    const outcome = await session.run('Keep reading.', { notice: message => notices.push(message) })
    expect(outcome.stopReason).toBe('round_limit')
    expect(outcome.report).toMatchObject({ rounds: 5, hardLimit: 5 })
    expect(server.sent).toHaveLength(5)
    // 9: each stage spoke once, in order, before the stop.
    expect(lastUser(server.sent[2]!)).toContain('You have used 2 of 5 tool rounds')
    expect(lastUser(server.sent[3]!)).toContain('2 tool rounds remain. Focus')
    expect(lastUser(server.sent[4]!)).toContain('Finish phase')
    expect(allUser(server.sent[1]!)).not.toContain('[Conductor]')
    expect(outcome.text).toContain('cumulative limit')
    // 10: the reserve tightens for the finish phase.
    expect(server.sent[4]!.max_tokens).toBe(1536)
    expect(server.sent[0]!.max_tokens).toBe(2560)
  })

  it('notices the same failing action repeated, corrects the model once, then ends the run with a report', async () => {
    const server = await stub((sent, index) => ({ frames: [call(`r${index}`, 'read_file', { path: 'missing.txt' })] }))
    cleanup.push(() => server.server.close())
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    const notices: string[] = []
    const outcome = await session.run('Open the file.', { notice: message => notices.push(message) })
    expect(outcome.stopReason).toBe('stagnation')
    expect(outcome.report.loopWarnings).toBe(1)
    expect(outcome.report.rounds).toBe(6)
    expect(lastUser(server.sent[3]!)).toContain('repeating an unsuccessful action (read_file, 3 times')
    expect(notices.some(message => message.startsWith('Stopped: The read_file approach'))).toBe(true)
  })

  it('does not raise a loop warning while the model makes distinct progress', async () => {
    const server = await stub((sent, index) => index < 8
      ? { frames: [call(`e${index}`, 'edit_file', { path: 'src/a.ts', old_text: `value = ${index + 1}`, new_text: `value = ${index + 2}` })] }
      : { frames: [answer('Incremented eight times.')] })
    cleanup.push(() => server.server.close())
    const root = workspace()
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: root, sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768 })
    const outcome = await session.run('Increment the value eight times, one edit at a time.', {})
    expect(outcome.stopReason).toBe('completed')
    expect(outcome.report.loopWarnings).toBe(0)
    expect(outcome.report.filesChanged).toEqual(['src/a.ts'])
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('value = 9')
    expect(server.sent.every(sent => !allUser(sent).includes('repeating'))).toBe(true)
  })

  it('runs the acceptance command itself under a contract and asks the model to finalize once it passes inside the allowed paths', async () => {
    const root = workspace()
    const runs: string[] = []
    const runAcceptance = async (command: string): Promise<SandboxResult & { where: 'sandbox' | 'host-copy' }> => { runs.push(command); const ok = readFileSync(join(root, 'src', 'a.ts'), 'utf8').includes('value = 2'); return { exitCode: ok ? 0 : 1, stdout: ok ? 'ok 1 - value\n# pass 1' : 'not ok 1 - value\n  expected 2, got 1\n# fail 1', stderr: '', truncated: false, timedOut: false, durationMs: 5, where: 'sandbox' } }
    const sandbox = { exec: runAcceptance, runAcceptance } as unknown as DockerSandbox
    const server = await stub((sent, index) => {
      if (index === 0) return { frames: [call('e0', 'edit_file', { path: 'src/a.ts', old_text: 'value = 1', new_text: 'value = 3' })] }
      if (index === 1) return { frames: [call('e1', 'edit_file', { path: 'src/a.ts', old_text: 'value = 3', new_text: 'value = 2' })] }
      return { frames: [answer('Changed src/a.ts so the value is 2; the acceptance passed.')] }
    })
    cleanup.push(() => server.server.close())
    const contract = normaliseContract({ allowedPaths: ['src/a.ts'], acceptance: { command: 'node --test tests/a.test.mjs' } })
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: root, sandbox, readOnly: false, timeoutSec: 30, contextTokens: 32768, contract, control: async () => ({}) })
    const notices: string[] = []
    const outcome = await session.run('Make tests/a.test.mjs pass by changing src/a.ts only.', { notice: message => notices.push(message) })
    // The runtime ran the acceptance after each edit; the model never had to.
    expect(runs).toEqual(['node --test tests/a.test.mjs', 'node --test tests/a.test.mjs'])
    expect(lastUser(server.sent[1]!)).toContain('Acceptance FAILED (exit 1)')
    expect(lastUser(server.sent[1]!)).toContain('expected 2, got 1')
    // 13: once it passed with only allowed paths changed, the model was told to stop.
    expect(lastUser(server.sent[2]!)).toContain('The task is complete: acceptance passed')
    expect(outcome.stopReason).toBe('completed')
    expect(outcome.report.detail).toContain('Finished: acceptance passed')
    expect(outcome.report.acceptance).toEqual({ command: 'node --test tests/a.test.mjs', passed: true, exitCode: 0, where: 'sandbox' })
    expect(outcome.report.filesChanged).toEqual(['src/a.ts'])
    // The bounded task got the coding tool set only.
    expect(server.sent[0]!.tools!.map(tool => tool.function.name)).toEqual(['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'apply_edits', 'run_command'])
    expect(server.sent[0]!.messages[0]!.content).toContain('bounded coding task')
    expect(session.state()?.constraints.join(' ')).toContain('Only these paths may be changed: src/a.ts')
  })

  it('runs acceptance through the sandbox host-copy fallback, not exec, so a Windows node_modules native-module failure never masks a real pass', async () => {
    // exec() stands in for what a bound Windows node_modules does to vitest/tsc in the sandbox
    // (S25): it fails before a single test runs. runAcceptance() is where DockerSandbox falls
    // back to an isolated host copy instead. If agent.ts called exec() directly, this would fail.
    const root = workspace()
    const exec = async (): Promise<SandboxResult> => ({ exitCode: 1, stdout: '', stderr: "Cannot find module '@rollup/rollup-linux-x64-gnu'", truncated: false, timedOut: false, durationMs: 5 })
    const runAcceptance = async (command: string): Promise<SandboxResult & { where: 'sandbox' | 'host-copy' }> => ({ exitCode: 0, stdout: `ran ${command} in a host copy\nok 1 - value\n# pass 1`, stderr: '', truncated: false, timedOut: false, durationMs: 5, where: 'host-copy' })
    const sandbox = { exec, runAcceptance } as unknown as DockerSandbox
    const server = await stub((_sent, index) => index === 0
      ? { frames: [call('e0', 'edit_file', { path: 'src/a.ts', old_text: 'value = 1', new_text: 'value = 2' })] }
      : { frames: [answer('Changed src/a.ts so the value is 2; the acceptance passed.')] })
    cleanup.push(() => server.server.close())
    const contract = normaliseContract({ allowedPaths: ['src/a.ts'], acceptance: { command: 'npx vitest run tests/a.test.mjs' } })
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: root, sandbox, readOnly: false, timeoutSec: 30, contextTokens: 32768, contract, control: async () => ({}) })
    const outcome = await session.run('Make tests/a.test.mjs pass by changing src/a.ts only.', {})
    expect(outcome.report.acceptance).toMatchObject({ passed: true, exitCode: 0, where: 'host-copy' })
  })

  it('refuses a final message that claims edits and passing tests without a single tool call', async () => {
    const server = await stub(() => ({ frames: [answer('All 5 exact replacements done via edit_file (verified each with read_file). Tests passing.')] }))
    cleanup.push(() => server.server.close())
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: workspace(), sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768 })
    const outcome = await session.run('Apply the five edits listed below.', {})
    expect(outcome.stopReason).toBe('unverified_claim')
    expect(outcome.report.unverified).toMatch(/no write, edit or apply_edits tool call ran/)
    expect(outcome.report.filesChanged).toEqual([])
    expect(outcome.text).toContain('Could not complete the task')
    expect(outcome.text).not.toContain('All 5 exact replacements')
  })

  it('cuts off a reply that reasons in circles, keeps the monologue out of the history, and lets the model act', async () => {
    const monologue = Array.from({ length: 300 }, (_v, i) => frame({ content: `Wait, actually the index ${i} is off. Hmm, let me rethink this. ` }))
    const server = await stub((sent, index) => index === 0 ? { frames: monologue } : { frames: [answer('Acted: the value is 1.')] })
    cleanup.push(() => server.server.close())
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    const notices: string[] = []
    const outcome = await session.run('What is the value?', { notice: message => notices.push(message) })
    expect(outcome).toMatchObject({ stopReason: 'completed', text: 'Acted: the value is 1.' })
    expect(notices.some(message => message.includes('reasoning in circles'))).toBe(true)
    const stored = server.sent[1]!.messages.find(message => message.role === 'assistant')!
    expect(stored.content.startsWith('[Reasoning cut short by Conductor.]')).toBe(true)
    expect(stored.content.length).toBeLessThan(400)
    expect(lastUser(server.sent[1]!)).toContain('Act now')
  })

  it('compacts aggressively and retries once when the server itself says the request no longer fits', async () => {
    const overflow = JSON.stringify({ error: { type: 'exceed_context_size', message: 'the request exceeds the available context size' } })
    let turn = 0
    const server = await stub((sent, index) => {
      // First turn: three reads, then an answer. Second turn: two refusals, then an answer.
      if (turn === 0) return index < 3 ? { frames: [call(`r${index}`, 'read_file', { path: `big-${index}.txt` })] } : { frames: [answer('First turn done.')] }
      return index < 6 ? { status: 400, body: overflow } : { frames: [answer('Second turn done.')] }
    })
    cleanup.push(() => server.server.close())
    const session = new LocalAgentSession({ endpoint: server.endpoint, apiKey: KEY, model: 'local/ornith1.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    expect((await session.run('Read three files.', {})).stopReason).toBe('completed')
    turn = 1
    const notices: string[] = []
    const outcome = await session.run('Continue.', { notice: message => notices.push(message) })
    expect(outcome.stopReason).toBe('completed')
    expect(notices.some(message => message.includes('compacting aggressively'))).toBe(true)
    expect(server.sent).toHaveLength(7)
    const retried = server.sent[6]!
    expect(retried.messages.some(message => message.role === 'user' && message.content.includes('[Task state'))).toBe(true)
    expect(retried.messages.filter(message => message.role === 'tool').length).toBeLessThanOrEqual(1)
    expect(outcome.report.compactions).toBe(1)
  })
})
