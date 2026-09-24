import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE } from './codex'
import { JsonLineTransport } from './transport'
import type { AdapterEvent, Json, SessionSettings } from '../../shared/structured-agent'

// Native acceptance for Codex Auto escalations, offline: the production adapter drives the real
// scripts/fixtures/codex-app-server.mjs process over stdio. Nothing is executed on the host and no
// provider is contacted. The in-memory protocol checks live in codex-auto-refusal.regression.test.ts.
const fixture = path.resolve('scripts/fixtures/codex-app-server.mjs')
const auto: SessionSettings = { permission: 'auto', plan: false }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean() })

function create() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'conductor-codex-escalation-'))
  const events: AdapterEvent[] = [], sent: Json[] = []
  let closed = true
  const adapter = new CodexAdapter({ executable: 'not-a-real-provider', cwd, runtimeId: 'runtime-1', settings: auto, environment: { ...process.env }, emit: event => events.push(event) }, {
    version: async () => `codex-cli ${CODEX_PROTOCOL_BASELINE}`,
    requestTimeoutMs: 3000,
    transport: options => {
      closed = false
      const transport = new JsonLineTransport({ ...options, executable: process.execPath, args: [fixture], onExit: (code, signal) => { closed = true; options.onExit?.(code, signal) } })
      return { start: () => transport.start(), send: message => { sent.push(message); transport.send(message) }, close: () => transport.close(), get connected() { return transport.connected } }
    }
  })
  cleanup.push(async () => { adapter.dispose(); await waitFor(() => closed); rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }) })
  const interactions = () => events.flatMap(event => event.data.type === 'interaction' ? [event.data.interaction] : [])
  const responses = () => sent.filter(message => (message as { id?: unknown; method?: unknown }).id === 500 && !(message as { method?: unknown }).method)
  const phase = (value: string) => events.some(event => event.data.type === 'session' && event.data.phase === value)
  const notices = () => events.flatMap(event => event.data.type === 'notice' ? [event.data.message] : [])
  const command = () => events.filter(event => event.itemId === 'command-1' && event.data.type === 'tool').at(-1)?.data
  return { adapter, events, sent, interactions, responses, phase, notices, command }
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!predicate()) { if (Date.now() > until) throw new Error('Synthetic protocol condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

describe('Codex Auto escalations through the real app-server fixture process', () => {
  it('answers the invoice incident\'s read-only port query once by itself: no decline, no card, no interrupt', async () => {
    const f = create()
    await f.adapter.submit('synthetic:escalation:outside', auto)
    await waitFor(() => f.phase('completed'))
    expect(f.responses()).toEqual([{ id: 500, result: { decision: 'accept' } }])
    expect(f.interactions()).toEqual([])
    expect(f.phase('waiting_approval')).toBe(false)
    expect(f.phase('interrupted')).toBe(false)
    expect(f.notices().some(message => /^Auto allowed .*outside the workspace sandbox without asking\.$/.test(message))).toBe(true)
    expect(f.command()).toMatchObject({ status: 'completed' })
  })

  it('keeps a system-directory escalation as an owner card with only one-action choices; the owner\'s Allow runs it once', async () => {
    const f = create()
    await f.adapter.submit('synthetic:escalation:boundary', auto)
    await waitFor(() => f.interactions().some(interaction => interaction.status === 'pending'))
    const card = f.interactions().at(-1)!
    // Held, not declined: nothing was sent back to Codex, and the owner sees why.
    expect(f.responses()).toEqual([])
    expect(f.phase('waiting_approval')).toBe(true)
    expect(f.notices().some(message => message.includes('Auto left') && message.includes('a Windows system directory'))).toBe(true)
    // Codex's lasting prefix rule and session grants are never offered on an Auto-held card.
    expect(card.choices.map(choice => choice.id)).toEqual(['accept', 'cancel'])
    expect(card.choices.every(choice => !choice.disabled)).toBe(true)
    const response = { sessionId: 's', runtimeId: 'runtime-1', requestId: card.id, decision: 'accept' }
    await f.adapter.respond(response)
    await expect(f.adapter.respond(response)).rejects.toThrow()
    await waitFor(() => f.phase('completed'))
    expect(f.responses()).toEqual([{ id: 500, result: { decision: 'accept' } }])
    expect(f.command()).toMatchObject({ status: 'completed' })
  })

  it('an owner Cancel on a held card is sent once and ends the turn without running the command', async () => {
    const f = create()
    await f.adapter.submit('synthetic:escalation:boundary', auto)
    await waitFor(() => f.interactions().some(interaction => interaction.status === 'pending'))
    await f.adapter.respond({ sessionId: 's', runtimeId: 'runtime-1', requestId: f.interactions().at(-1)!.id, decision: 'cancel' })
    await waitFor(() => f.phase('interrupted') || f.phase('completed'))
    expect(f.responses()).toEqual([{ id: 500, result: { decision: 'cancel' } }])
    expect(f.command()).toMatchObject({ status: 'rejected' })
  })

  it('a duplicate delivery keeps one card; the same id with other arguments expires it and nothing is ever answered', async () => {
    const f = create()
    await f.adapter.submit('synthetic:escalation:reissue', auto)
    await waitFor(() => f.interactions().some(interaction => interaction.status === 'pending'))
    const card = f.interactions().at(-1)!
    await new Promise(resolve => setTimeout(resolve, 150))
    // The exact duplicate at 40 ms produced neither a second card nor a response.
    expect(f.interactions().filter(interaction => interaction.status === 'pending')).toHaveLength(1)
    expect(f.responses()).toEqual([])
    await waitFor(() => f.interactions().some(interaction => interaction.id === card.id && interaction.status === 'expired'))
    await waitFor(() => f.phase('completed'))
    await expect(f.adapter.respond({ sessionId: 's', runtimeId: 'runtime-1', requestId: card.id, decision: 'accept' })).rejects.toThrow()
    // Codex was told its reissued identity is refused; no decision for either set of arguments.
    expect(f.responses()).toHaveLength(1)
    expect(f.responses()[0]).toMatchObject({ id: 500, error: { code: -32602 } })
    expect(f.command()).toMatchObject({ status: 'rejected' })
  })
})
