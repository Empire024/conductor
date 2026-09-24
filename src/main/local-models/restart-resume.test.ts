import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentSession, LocalTurnSuspension } from './agent'
import { StagnationDetector } from './progress'
import { DEFAULT_LOCAL_AGENT_POLICY } from './agent-policy'

/** A local turn paused for a Conductor restart and resumed by the next process
 *  (docs/runtime-host.md, "Local model turns"): no round lost or repeated, no tool call replayed. */

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()) })

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'local-resume-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'notes.txt'), 'first line\n')
  return root
}

type Reply = Record<string, unknown> | 'hold'
/** A stand-in llama.cpp endpoint. 'hold' keeps the request open until the client goes away, the
 *  way a long generation is still streaming when the restart comes. */
async function endpoint(reply: (index: number, body: any) => Reply): Promise<{ url: string; requests: any[]; held: () => number }> {
  const requests: any[] = []
  let held = 0
  const open: ServerResponse[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const message = reply(requests.length, parsed)
      requests.push(parsed)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (message === 'hold') { held++; open.push(response); response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half an ans' }, finish_reason: null }] })}\n\n`); return }
      response.end(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => { open.forEach(response => response.destroy()); server.close() })
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, held: () => held }
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] })

function store(): { load(): unknown; save(value: unknown): Promise<void>; value(): any } {
  let saved: unknown
  return { load: () => structuredClone(saved), save: async value => { saved = structuredClone(value) }, value: () => saved }
}

const options = (url: string, root: string, checkpoint: ReturnType<typeof store>, extra: Record<string, unknown> = {}) => ({
  endpoint: url, apiKey: 'k'.repeat(64), model: 'local/test', workspace: root, sandbox: null, readOnly: true, timeoutSec: 5, contextTokens: 32768,
  taskId: 'conversation-1', checkpoint, ...extra
})

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let tick = 0; tick < 200 && !condition(); tick++) await new Promise(done => setTimeout(done, 10))
  if (!condition()) throw new Error('condition never held')
}

describe('local turn paused for a restart', () => {
  it('pauses mid-generation and resumes in a new process with the same rounds and nothing re-run', async () => {
    const root = workspace(), checkpoint = store()
    const server = await endpoint(index => index === 0 ? call('call-read', 'read_file', { path: 'notes.txt' }) : index === 1 ? 'hold' : { content: 'The note says first line.' })
    const first = new LocalAgentSession(options(server.url, root, checkpoint))
    const controller = new AbortController()
    const running = first.run('What does notes.txt say?', {}, controller.signal)
    await waitFor(() => server.held() === 1)
    controller.abort(new LocalTurnSuspension('pause-1'))
    const paused = await running
    expect(paused).toMatchObject({ stopReason: 'interrupted', suspended: 'pause-1' })
    expect(checkpoint.value()).toMatchObject({ suspended: { id: 'pause-1', ledger: { round: 1 } }, state: { execution: { lifecycle: 'running', budgets: { rounds: 1 } } } })

    // The next process: a fresh session over the same checkpoint.
    const second = new LocalAgentSession(options(server.url, root, checkpoint))
    expect(second.pausePoint()).toMatchObject({ id: 'pause-1', round: 1 })
    await expect(second.resume('some-other-pause', {})).rejects.toThrow(/nothing was replayed/)
    const resumed = await second.resume('pause-1', {})
    expect(resumed).toMatchObject({ stopReason: 'completed', text: 'The note says first line.' })
    expect(resumed.suspended).toBeUndefined()

    // The held request is sent once more, unchanged; the finished read is not.
    expect(server.requests).toHaveLength(3)
    expect(server.requests[2].messages).toEqual(server.requests[1].messages)
    const last = server.requests[2].messages
    expect(last.filter((message: any) => message.role === 'user' && message.content === 'What does notes.txt say?')).toHaveLength(1)
    expect(last.filter((message: any) => message.role === 'tool' && message.tool_call_id === 'call-read')).toHaveLength(1)
    expect(checkpoint.value().state.execution).toMatchObject({ lifecycle: 'completed', budgets: { rounds: 1 } })
    expect(resumed.report.rounds).toBe(1)
    // A pause point is used once.
    expect(second.pausePoint()).toBeUndefined()
    expect(checkpoint.value().suspended).toBeUndefined()
  })

  it('reports a tool call the pause cut short and never runs it again', async () => {
    const root = workspace(), checkpoint = store()
    const server = await endpoint(index => index === 0 ? call('call-write', 'write_file', { path: 'out.txt', content: 'written\n' }) : { content: 'The write was interrupted; nothing was written.' })
    const controller = new AbortController()
    let reached = false
    // The artifact hook runs before the write lands; the restart arrives while it is running.
    const beforeTool = async (): Promise<void> => { reached = true; await new Promise<void>(done => controller.signal.addEventListener('abort', () => done())) }
    const first = new LocalAgentSession(options(server.url, root, checkpoint, { readOnly: false, beforeTool }))
    const running = first.run('Write out.txt.', {}, controller.signal)
    await waitFor(() => reached)
    controller.abort(new LocalTurnSuspension('pause-2'))
    expect(await running).toMatchObject({ suspended: 'pause-2' })
    const saved = checkpoint.value()
    expect(saved.state.execution.pending).toBeUndefined()
    expect(saved.state.execution.executed.map((entry: any) => entry.id)).toEqual(['call-write'])

    const second = new LocalAgentSession(options(server.url, root, checkpoint, { readOnly: false }))
    const resumed = await second.resume('pause-2', {})
    expect(resumed.stopReason).toBe('completed')
    expect(existsSync(join(root, 'out.txt'))).toBe(false)
    expect(server.requests).toHaveLength(2)
    const result = server.requests[1].messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call-write')
    expect(result.content).toMatch(/Interrupted: Conductor restarted while this write_file call was running/)
    expect(result.content).toMatch(/will not be run again/)
    expect(checkpoint.value().state.execution.budgets.rounds).toBe(1)
  })

  it('an ordinary stop is not a pause, and a new message discards a pause point nobody resumed', async () => {
    const root = workspace(), checkpoint = store()
    const server = await endpoint(index => index === 0 ? 'hold' : { content: 'Fresh answer.' })
    const controller = new AbortController()
    const running = new LocalAgentSession(options(server.url, root, checkpoint)).run('Summarise.', {}, controller.signal)
    await waitFor(() => server.held() === 1)
    controller.abort()
    const stopped = await running
    expect(stopped.stopReason).toBe('interrupted')
    expect(stopped.suspended).toBeUndefined()
    expect(checkpoint.value().suspended).toBeUndefined()

    const pausedServer = await endpoint(index => index === 0 ? 'hold' : { content: 'Fresh answer.' })
    const pauseStore = store(), pausing = new AbortController()
    const pausedRun = new LocalAgentSession(options(pausedServer.url, root, pauseStore)).run('Summarise.', {}, pausing.signal)
    await waitFor(() => pausedServer.held() === 1)
    pausing.abort(new LocalTurnSuspension('pause-3'))
    await pausedRun
    const reopened = new LocalAgentSession(options(pausedServer.url, root, pauseStore))
    expect(reopened.pausePoint()?.id).toBe('pause-3')
    // The restart did not keep it (no reattach): the owner's next message starts a turn instead.
    expect(await reopened.run('Go on.', {})).toMatchObject({ stopReason: 'completed' })
    expect(reopened.pausePoint()).toBeUndefined()
    await expect(reopened.resume('pause-3', {})).rejects.toThrow(/nothing was replayed/)
  })

  it('a stagnation count survives the pause', () => {
    const policy = DEFAULT_LOCAL_AGENT_POLICY.stagnation
    const detector = new StagnationDetector(policy)
    const failing = { name: 'read_file', arguments: { path: 'missing.txt' }, output: 'error: ENOENT', failed: true }
    for (let n = 0; n < policy.repeatWarnAt - 1; n++) detector.observe(failing)
    const restored = StagnationDetector.restore(policy, JSON.parse(JSON.stringify(detector.snapshot())))
    expect(restored.observe(failing).action).toBe(detector.observe(failing).action)
    expect(restored.snapshot()).toEqual(detector.snapshot())
  })
})
