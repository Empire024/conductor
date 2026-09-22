import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AdapterEvent, Json, SessionSettings } from '../../shared/structured-agent'
import { StructuredActivity } from '../../renderer/src/panes/StructuredAgentRenderers'
import type { AdapterOptions } from './adapter'
import type { TransportOptions } from './transport'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE } from './codex'
import { ApprovalReviews, type ReviewAction } from '../approval-review'

// Bounded adapter ownership: agent_mucykb2d_xjxx7ve. See docs/approval-auto-refusal-repro.md.
// No process, shell command, network, model, credential or application window is used.
// The original six expected failures were promoted to ordinary assertions after the
// existing lead released the adapter slice. The original failing JSON remains evidence.
const cleanup: CodexAdapter[] = []
afterEach(() => cleanup.splice(0).forEach(adapter => adapter.dispose()))
const threadId = 'auto-refusal-thread', turnId = 'auto-refusal-turn', nativeRequestId = 900
const requestId = 'number:900'
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json

function fixture(permission: SessionSettings['permission'] = 'auto', extra: Partial<AdapterOptions> = {}) {
  const settings: SessionSettings = { permission, plan: false }
  const events: AdapterEvent[] = [], sent: Json[] = []
  let wire!: TransportOptions, connected = false, uncertainSend = false
  const inject = (message: unknown) => wire.onMessage(asJson(message))
  const adapter = new CodexAdapter({ executable: 'never-launched', cwd: process.cwd(), runtimeId: 'auto-runtime', settings, ...extra, emit: event => events.push(event) }, {
    version: async () => `codex-cli ${CODEX_PROTOCOL_BASELINE}`,
    transport: options => {
      wire = options
      return {
        start: () => { connected = true }, close: () => { connected = false }, get connected() { return connected },
        send: message => {
          sent.push(asJson(message))
          const packet = message as { id?: number; method?: string }
          if (!packet.method) {
            if (uncertainSend) throw new Error('Synthetic response delivery is ambiguous')
            return
          }
          const result = packet.method === 'initialize' ? { userAgent: 'synthetic-auto-refusal' }
            : ['thread/start', 'thread/resume'].includes(packet.method) ? {
              thread: { id: threadId, status: { type: 'idle' }, turns: [] }, model: 'synthetic-model', reasoningEffort: 'low',
              modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, instructionSources: []
            }
              : packet.method === 'model/list' ? { data: [] }
                : packet.method === 'turn/start' ? { turn: { id: turnId, status: 'inProgress', items: [] } } : undefined
          if (result) queueMicrotask(() => inject({ id: packet.id, result }))
        }
      }
    }
  })
  cleanup.push(adapter)
  const request = (kind: 'commandExecution' | 'fileChange' | 'permissions' = 'commandExecution', command = 'Write-Output synthetic') => {
    inject({ id: nativeRequestId, method: `item/${kind}/requestApproval`, params: {
      threadId, turnId, itemId: 'auto-item', reason: 'Synthetic policy escalation', cwd: process.cwd(),
      ...(kind === 'commandExecution' ? { command, availableDecisions: ['accept', 'decline', 'cancel'] }
        : kind === 'permissions' ? { permissions: { network: { enabled: true } } } : {})
    } })
  }
  const responses = () => sent.filter(packet => (packet as { id?: number; method?: string }).id === nativeRequestId && !(packet as { method?: string }).method)
  const pending = () => events.flatMap(event => event.data.type === 'interaction' && event.data.interaction.status === 'pending' ? [event.data.interaction] : [])
  const answer = (decision = 'accept', runtimeId = 'auto-runtime') => adapter.respond({ sessionId: 'synthetic-session', runtimeId, requestId, decision })
  return { adapter, events, sent, request, responses, pending, answer,
    start: () => adapter.submit('Synthetic approval lifecycle only', settings),
    disconnect: () => { connected = false; wire.onExit?.(1, null) },
    makeDeliveryUncertain: () => { uncertainSend = true }
  }
}

describe('Auto refusal incident: native approval lifecycle', () => {
  it.each(['commandExecution', 'fileChange', 'permissions'] as const)('Auto retains %s approval with actionable choices and no native decline', async kind => {
    const f = fixture(); await f.start(); f.request(kind)
    expect({ pending: f.pending(), responses: f.responses(), last: f.events.at(-1)?.data }).toMatchObject({
      pending: [{ id: requestId, status: 'pending', choices: expect.arrayContaining([{ id: 'decline', label: 'Deny' }]) }],
      responses: [], last: { type: 'session', phase: 'waiting_approval' }
    })
  })

  it('explicit owner approval can answer the action after Auto refuses to decide', async () => {
    const f = fixture(); await f.start(); f.request()
    const outcome = await f.answer().then(() => 'accepted', error => (error as Error).message)
    expect({ outcome, responses: f.responses() }).toEqual({ outcome: 'accepted', responses: [{ id: nativeRequestId, result: { decision: 'accept' } }] })
  })

  it('renders the retained Auto request with attention styling and enabled Allow/Deny controls', async () => {
    const f = fixture(); await f.start(); f.request()
    const renderLatest = () => {
      const event = f.events.filter(event => event.data.type === 'interaction').at(-1)!
      const item = { id: 'visible-auto-request', runtimeId: 'auto-runtime', sequence: 1, timestamp: '2026-09-22T17:00:00Z', data: event.data }
      return renderToStaticMarkup(createElement(StructuredActivity, { item, sessionId: 'synthetic-session', cwd: process.cwd(), expanded: true, interactive: true,
        onExpand: () => undefined, onOpenFile: () => undefined, onDiff: () => undefined, onRespond: async (_item, decision) => { await f.answer(decision) } }))
    }
    const html = renderLatest()
    expect(html).toContain('sa-interaction needs-attention')
    expect(html).toContain('<button type="button">Allow once</button>')
    expect(html).toContain('<button type="button">Deny</button>')
    expect(html).toContain('Write-Output synthetic')
    await f.answer()
    expect(renderLatest()).not.toContain('>Allow once</button>')
    expect(renderLatest()).not.toContain('sa-interaction needs-attention')
  })

  it('an isolated reviewer in Auto retains its blocked native request; original-worker handoff is separate', async () => {
    const f = fixture('auto', { approvalReviewer: true }); await f.start(); f.request()
    expect({ pending: f.pending().length, responses: f.responses() }).toEqual({ pending: 1, responses: [] })
  })

  it('changed arguments under a reused native request ID invalidate the old owner choice', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request()
    f.request('commandExecution', 'Write-Output changed-scope')
    const outcome = await f.answer().then(() => 'accepted', () => 'refused')
    expect({ outcome, accepts: f.responses().filter(packet => (packet as { result?: { decision?: string } }).result?.decision === 'accept') })
      .toEqual({ outcome: 'refused', accepts: [] })
  })

  it('an exact repeated native request produces only one card and one owner response', async () => {
    const f = fixture(); await f.start(); f.request(); f.request()
    expect(f.pending()).toHaveLength(1)
    expect(f.responses()).toEqual([])
    await f.answer()
    await expect(f.answer()).rejects.toThrow('already answered')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
  })

  it('a changed identity stays invalid even if the provider sends the original arguments again', async () => {
    const f = fixture(); await f.start(); f.request(); f.request('commandExecution', 'Write-Output changed'); f.request()
    await expect(f.answer()).rejects.toThrow('expired')
    expect(f.responses().some(packet => (packet as { result?: { decision?: string } }).result?.decision === 'accept')).toBe(false)
    expect(f.events.some(event => event.data.type === 'interaction' && event.data.interaction.status === 'expired' && /arguments changed/.test(event.data.interaction.outcome ?? ''))).toBe(true)
  })

  it('Auto exposes only a native turn permission grant and sends the genuine permission response', async () => {
    const f = fixture(); await f.start(); f.request('permissions')
    expect(f.pending()[0]?.choices.map(choice => choice.id)).toEqual(['accept', 'decline'])
    await expect(f.answer('acceptForSession')).rejects.toThrow('not offered')
    await f.answer()
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { permissions: { network: { enabled: true } }, scope: 'turn' } }])
  })

  it('Edit exposes the exact native request and sends one owner response despite two views', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request()
    expect(f.pending()[0]).toMatchObject({ id: requestId, input: { command: 'Write-Output synthetic', cwd: process.cwd(), threadId, turnId } })
    expect(f.responses()).toEqual([])
    await expect(f.answer('accept', 'stale-runtime')).rejects.toThrow('stale runtime')
    await expect(f.answer('acceptForSession')).rejects.toThrow('not offered')
    await f.answer()
    await expect(f.answer()).rejects.toThrow('already answered')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
  })

  it('the existing host review opt-in preserves an Auto native request without answering it', async () => {
    const f = fixture('auto', { reviewApprovals: true }); await f.start(); f.request()
    expect(f.pending()).toHaveLength(1)
    expect(f.responses()).toEqual([])
    expect(f.events.at(-1)?.data).toMatchObject({ type: 'session', phase: 'waiting_approval' })
  })

  it('an actual owner denial sends decline once and cannot be replaced by a second answer', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request()
    await f.answer('decline')
    await expect(f.answer()).rejects.toThrow('already answered')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'decline' } }])
    expect(f.events.some(event => event.data.type === 'interaction' && event.data.interaction.outcome === 'decline')).toBe(true)
  })

  it('the separate journal keeps human denial durable across reconstruction and changed worker arguments', async () => {
    const store = new Map<string, string>()
    const persistence = { getSetting: (key: string) => store.get(key) ?? null, setSetting: (key: string, value: string) => { store.set(key, value) } }
    const journal = new ApprovalReviews(persistence)
    const action: ReviewAction = { projectId: 'synthetic-project', machineId: 'synthetic-device', workerId: 'worker', runtimeId: 'runtime', requestId: 'request',
      tool: 'synthetic-operation', arguments: { value: 1 }, paths: ['synthetic-target'], boundary: 'native-owner', reason: 'Native owner answer required',
      sideEffects: [], ownerEvidence: 'Synthetic owner task', authorizationId: 'owner-task', native: {} }
    const record = await journal.review(action, async digest => ({ digest, decision: 'escalate', rationale: 'Owner required', reviewerId: 'separate-reviewer', model: 'synthetic-reviewer', turnId: 'review-turn' }), () => undefined)
    expect(record.phase).toBe('owner')
    journal.reserve(action, 'deny')
    const recovered = new ApprovalReviews(persistence)
    expect(recovered.denied({ ...action, workerId: 'replacement', arguments: { value: 2 } })).toBe(true)
    expect(() => recovered.reserve(action, 'allow')).toThrow()
  })

  it('reconnect never replays input or a stale response; recovery of the pending card remains unsupported', async () => {
    const first = fixture('accept-edits'); await first.start(); first.request(); first.disconnect()
    await expect(first.answer()).rejects.toThrow('stale runtime')
    expect(first.responses()).toEqual([])
    expect(first.events.some(event => event.data.type === 'interaction' && event.data.interaction.status === 'expired')).toBe(true)
    const resumed = fixture('accept-edits', { nativeSessionId: threadId, runtimeId: 'replacement-runtime' })
    await resumed.adapter.start()
    await expect(resumed.answer('accept', 'replacement-runtime')).rejects.toThrow('expired')
    expect(resumed.sent.some(packet => (packet as { method?: string }).method === 'turn/start')).toBe(false)
    expect(resumed.responses()).toEqual([])
  })

  it('ambiguous native response delivery is explicit and never retried as a second execution', async () => {
    const f = fixture('accept-edits'); await f.start(); f.request(); f.makeDeliveryUncertain()
    await expect(f.answer()).rejects.toThrow('delivery is ambiguous')
    await expect(f.answer()).rejects.toThrow('stale runtime')
    expect(f.responses()).toEqual([{ id: nativeRequestId, result: { decision: 'accept' } }])
    expect(f.events.some(event => event.data.type === 'interaction' && event.data.interaction.outcome === 'Delivery uncertain after disconnect')).toBe(true)
    expect(f.events.at(-1)?.data).toMatchObject({ type: 'session', phase: 'disconnected', message: expect.stringContaining('uncertain') })
  })
})
