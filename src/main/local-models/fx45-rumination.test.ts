import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAdapter, setLocalEndpointOverride } from '../providers/local.ts'
import { DEFAULT_SANDBOX } from './config.ts'
import * as paths from './paths.ts'
import { LOCAL_DOLPHIN_X1_8B as MODEL } from '../../shared/local-models.ts'
import { emptyProjection, projectAgentEvent, replayAgentEvents } from '../../shared/structured-agent-reducer.ts'
import type { AgentEvent, SessionProjection } from '../../shared/structured-agent.ts'

const loop = 'Wait, let me reconsider this circular draft. '.repeat(80)
const prior = 'I will inspect the project file.'
const answer = 'The file says the answer is blue.'
const frame = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
const prose = (text: string) => frame({ content: text }, 'stop')
const tool = frame({ content: prior, tool_calls: [{ index: 0, id: 'read', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } }] }, 'tool_calls')
const text = (p: SessionProjection) => p.items.flatMap(i => i.data.type === 'text' && i.data.role === 'assistant' && i.data.text ? [i.data.text] : [])
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); setLocalEndpointOverride(null); vi.restoreAllMocks() })

// Real adapter -> LocalAgentSession -> HTTP/SSE client -> provider events -> timeline reducer.
// The server forces the production rumination detector, not a mocked helper verdict.
it.each(['recover', 'twice', 'bare', 'reasoning', 'repair'] as const)('FX45 withdraws a discarded completion end to end: %s', async scenario => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-fx45-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'note.txt'), 'blue')
  writeFileSync(join(root, 'config', 'api-key'), 'k'.repeat(64))
  writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ version: 1, llamaServer: 'unused', llamaVersion: 'fixture', models: { [MODEL]: { id: MODEL, label: MODEL, repo: 'fixture/model', revision: 'a'.repeat(40), file: 'unused.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'b'.repeat(64), port: 12000, contextTokens: 32768, gpuLayers: 1, extraArgs: [] } }, sandbox: DEFAULT_SANDBOX }))
  vi.spyOn(paths, 'layout').mockReturnValue(paths.layoutFor(root))
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const rounds = scenario === 'bare' ? [prose(loop), prose(answer)]
    : scenario === 'twice' ? [tool, prose(loop), prose(loop)]
      : scenario === 'reasoning' ? [tool, frame({ content: 'Discard this draft. ', reasoning_content: loop }), prose(answer)]
        : scenario === 'repair' ? [tool, frame({}, 'stop'), frame({ reasoning_content: loop }), prose(answer)]
          : [tool, prose(loop), prose(answer)]
  const server = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end((rounds[requests.length - 1] ?? prose('Unexpected extra request')) + 'data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })
  setLocalEndpointOverride(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  const events: AgentEvent[] = [], beforeWithdraw: string[][] = []
  let projection = emptyProjection('fx45')
  const settings = { model: MODEL, permission: 'read-only' as const, plan: false }
  const adapter = new LocalAdapter({ executable: '', cwd: root, runtimeId: 'fx45-runtime', settings, emit: event => {
    if (event.data.type === 'text' && event.data.role === 'assistant' && event.data.mode === 'snapshot' && !event.data.text) beforeWithdraw.push(text(projection))
    const full: AgentEvent = { schemaVersion: 1, id: String(events.length + 1), sequence: events.length + 1, sessionId: 'fx45', runtimeId: 'fx45-runtime', provider: 'local', projectId: 'p', workspaceId: 'w', cwd: root, timestamp: new Date().toISOString(), ...event }
    events.push(full)
    projection = projectAgentEvent(projection, full)
  } })
  cleanup.push(() => adapter.dispose())
  await adapter.submit(scenario === 'bare' ? 'Why is the sky blue?' : 'Read note.txt and tell me what it says.', settings)
  await vi.waitFor(() => expect(['completed', 'failed']).toContain(projection.phase), { timeout: 10000 })
  expect(requests, JSON.stringify(events.filter(e => e.data.type === 'notice').map(e => e.data))).toHaveLength(rounds.length)
  expect(beforeWithdraw).toHaveLength(scenario === 'twice' ? 2 : 1)
  if (scenario === 'recover' || scenario === 'twice') expect(beforeWithdraw[0]?.join('')).toContain(loop)
  const expected = scenario === 'bare' ? [answer] : [prior, answer]
  if (scenario === 'twice') {
    expect(text(projection)[0]).toBe(prior)
    expect(text(projection).join('')).toContain('Two replies in a row')
    expect(text(projection).join('')).not.toContain(loop)
  } else {
    expect(text(projection)).toEqual(expected)
    expect(text(replayAgentEvents('fx45', events))).toEqual(expected)
  }
  if (scenario === 'recover') {
    // Replay the same real adapter stream without the new withdrawal event: the old
    // projection retains the 3k draft next to the good answer (VR9f's failure).
    const old = events.filter(e => !(e.data.type === 'text' && e.data.role === 'assistant' && e.data.mode === 'snapshot' && e.data.text === ''))
      .map((e, index) => ({ ...e, sequence: index + 1 }))
    expect(text(replayAgentEvents('fx45', old)).join('')).toContain(loop)
    expect(text(projection).join('')).not.toContain(loop)
    if (process.env.FX45_PROJECTION_PATH) writeFileSync(process.env.FX45_PROJECTION_PATH, JSON.stringify(projection, null, 2))
  }
  expect(events.some(e => e.data.type === 'notice' && /reasoning in circles/.test(e.data.message))).toBe(true)
  expect(requests.at(-1)!.messages.some(m => m.content.includes(loop))).toBe(false)
  if (scenario === 'twice') {
    expect(events.some(e => e.data.type === 'notice' && /two replies reasoning in circles/.test(e.data.message))).toBe(true)
    // A later owner message gets a fresh turn; no discarded draft comes back.
    rounds.push(prose('A fresh answer.'))
    await adapter.submit('Say hello.', settings)
    await vi.waitFor(() => expect(text(projection).at(-1)).toBe('A fresh answer.'))
    expect(text(projection).join('')).not.toContain(loop)
  }
})
