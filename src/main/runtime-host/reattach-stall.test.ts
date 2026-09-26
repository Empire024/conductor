import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConductorDatabase } from '../database'
import { ClaudeAdapter, CLAUDE_COMPATIBILITY } from '../providers/claude'
import { JsonLineTransport, setRuntimeHost } from '../providers/transport'
import type { AdapterOptions } from '../providers/adapter'
import { StructuredSessions } from '../structured-sessions'
import type { AgentSpec } from '../../shared/models'
import type { SessionSettings } from '../../shared/structured-agent'
import { RuntimeHostClient } from './client'
import type { HostLock } from './protocol'

/** A Claude CLI stand-in: each message is one native turn that streams thirty words, 60 ms apart,
 *  and answers "ack:<message>". */
const FAKE_CLAUDE = `
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'stall-native', parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let chain = Promise.resolve()
const turn = async text => {
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID(), words = [...Array.from({ length: 30 }, (_, i) => 'w' + i + ' '), 'ack:' + text]
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const word of words) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } }); await wait(60) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words.join('') }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const content = message.message.content
  const text = Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : String(content)
  chain = chain.then(() => turn(text.trim()))
})`

const settings: SessionSettings = { permission: 'auto', plan: false }
const until = async (check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
/** What the relaunched app's main thread did for 71 s on 2026-09-25: nothing else ran. */
const block = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* stalled */ } }

describe('reattaching kept turns when the new app stalls at startup (FX33)', () => {
  let root: string, fake: string, host: ChildProcess, lock: HostLock
  beforeAll(async () => {
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
    vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
    root = mkdtempSync(join(tmpdir(), 'conductor-reattach-stall-'))
    fake = join(root, 'fake-claude.cjs')
    writeFileSync(fake, FAKE_CLAUDE)
    // The real host, bundled the way the app ships it and run as its own process, so it keeps
    // answering while this thread is blocked.
    const bundle = join(root, 'runtime-host.js')
    buildSync({ entryPoints: [join(__dirname, 'host-main.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning' })
    host = spawn(process.execPath, [bundle, '--user-data', root], { stdio: 'ignore', windowsHide: true, env: { ...process.env, CONDUCTOR_RUNTIME_HOST_IDLE_MS: '120000' } })
    const lockPath = join(root, 'runtime-host', 'host.json')
    await until(() => existsSync(lockPath), 'the runtime host to listen')
    lock = JSON.parse(readFileSync(lockPath, 'utf8')) as HostLock
  })
  afterAll(async () => {
    setRuntimeHost(null)
    try { const client = await RuntimeHostClient.connect(lock.pipe, lock.secret); await client.stopAll(); await client.shutdown().catch(() => undefined); client.dispose() } catch { host.kill() }
    await new Promise(resolve => setTimeout(resolve, 500))
    vi.unstubAllEnvs()
    for (let attempt = 0; ; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break } catch (error) { if (attempt > 40) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
  })

  const factory = (_provider: unknown, options: AdapterOptions) => new ClaudeAdapter(options, {
    version: async () => CLAUDE_COMPATIBILITY,
    createTransport: transport => new JsonLineTransport({ ...transport, executable: process.execPath, args: [fake, ...transport.args], environment: { ...process.env } })
  })
  const app = async (databasePath: string) => {
    const database = new ConductorDatabase(databasePath)
    const client = await RuntimeHostClient.connect(lock.pipe, lock.secret)
    setRuntimeHost(client)
    const sessions = new StructuredSessions(database, () => process.execPath, vi.fn(), factory)
    return { database, sessions, client, close: () => { sessions.dispose(); client.dispose(); database.close() } }
  }
  const assistantText = (database: ConductorDatabase, id: string): string =>
    database.structured.snapshot(id)!.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => (item.data as { text: string }).text).join('\n')

  it('keeps every runtime attached through a 30 s block right after reattaching, and delivers the next message to each', async () => {
    const workspace = join(root, 'workspace'); mkdirSync(workspace)
    const databasePath = join(root, 'conductor.db')
    const first = await app(databasePath)
    const project = first.database.upsertProject(workspace, 'Stall project')
    const sessionId = first.database.listSessions(project.id)[0]!.id
    const specs: AgentSpec[] = ['wizard', 'coworker-a', 'coworker-b'].map(name => ({ id: `stall-${name}`, projectId: project.id, sessionId, provider: 'claude', title: name, cwd: workspace }))
    for (const spec of specs) { first.sessions.ensure(spec); await first.sessions.submit(spec.id, `start ${spec.id}`, settings) }
    for (const spec of specs) await until(() => assistantText(first.database, spec.id).includes('w2 '), `${spec.id} to be under way`)
    const runtimeIds = specs.map(spec => first.database.structured.snapshot(spec.id)!.runtimeId)

    // The restart keeps all three turns running in the host.
    expect((await first.sessions.detachForRestart()).sort()).toEqual(specs.map(spec => spec.id).sort())
    const kept = (await first.client.list()).filter(entry => entry.alive && entry.detached).map(entry => entry.runtimeId)
    expect(kept).toHaveLength(3)
    first.close()

    const second = await app(databasePath)
    for (const spec of specs) await second.sessions.reattach(spec.id)
    // Every attach has been written; the new app's main thread now stalls for 30 s, twice as
    // long as the old 15 s request timeout.
    block(30_000)

    for (const spec of specs) await until(() => second.database.structured.snapshot(spec.id)!.phase === 'completed', `${spec.id} to finish its kept turn`, 20_000)
    for (const spec of specs) {
      const state = second.database.structured.snapshot(spec.id)!
      expect(state.items.some(item => item.data.type === 'error')).toBe(false)
      expect(assistantText(second.database, spec.id)).toContain(`ack:start ${spec.id}`)
    }
    const listed = await second.client.list()
    for (const runtimeId of kept) expect(listed.find(entry => entry.runtimeId === runtimeId)).toMatchObject({ alive: true, attached: true })

    // A message sent to each afterwards reaches the same kept process.
    for (const spec of specs) await second.sessions.submit(spec.id, `after ${spec.id}`, settings)
    for (const spec of specs) await until(() => assistantText(second.database, spec.id).includes(`ack:after ${spec.id}`) && second.database.structured.snapshot(spec.id)!.phase === 'completed', `${spec.id} to answer after the stall`, 20_000)
    specs.forEach((spec, index) => expect(second.database.structured.snapshot(spec.id)!.runtimeId).toBe(runtimeIds[index]))
    second.close()
  }, 120_000)
})
