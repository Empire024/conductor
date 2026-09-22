import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../shared/models'
import type { AdapterEvent, InteractionResponse, Json, SessionSettings } from '../shared/structured-agent'
import { ApprovalReviewGate } from './approval-review-gate'
import type { ReviewAction, ReviewResult } from './approval-review'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'approval-gate-')); roots.push(cwd)
  const spec: AgentSpec = { id: 'worker', projectId: 'project', sessionId: 'workspace', provider: 'claude', cwd, title: 'Worker' }
  const persisted = new Map<string, string>(), publications: AdapterEvent[] = [], responses: InteractionResponse[] = []
  let settings: SessionSettings = { permission: 'auto', plan: false, model: 'haiku' }
  let decide: (action: ReviewAction, digest: string) => Promise<ReviewResult> = async (_action, digest) => ({ digest, decision: 'allow', rationale: 'Exact authorized workspace write', reviewerId: 'reviewer', model: 'claude-opus-test', turnId: 'turn' })
  const persistence = { getSetting: (key: string) => persisted.get(key) ?? null, setSetting: (key: string, value: string) => { persisted.set(key, value) } }
  const make = () => new ApprovalReviewGate(persistence, () => settings, (_id, _runtime, event) => { publications.push(event) }, async response => {
    const record = await gate.reserve(response, true)
    responses.push(response)
    if (record) gate.finish(record, true)
  })
  let gate = make()
  const run = vi.fn((_spec: AgentSpec, action: ReviewAction, digest: string) => decide(action, digest))
  const route = () => { gate.routing = { enabled: () => true, supportsExactExecution: () => true, authorization: () => ({ id: 'owner-task', text: 'Owner: write panel.txt in this project. No deployment or installs.' }), run } }
  route()
  const request = (id = 'request', args: Json = { file_path: 'panel.txt', content: 'hello' }, tool = 'Write', extra: Record<string, Json> = {}): AdapterEvent => ({ itemId: 'tool-' + id, requestId: id,
    data: { type: 'interaction', interaction: { id, kind: 'approval', status: 'pending', title: 'Allow ' + tool + '?', input: args, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-session', label: 'Session' }, { id: 'deny', label: 'Deny' }] } },
    native: { method: 'can_use_tool', payload: { subtype: 'can_use_tool', tool_name: tool, input: args, ...extra } } })
  const last = () => { const data = publications.at(-1)?.data; if (data?.type !== 'interaction') throw new Error('No interaction'); return data.interaction }
  const waitPhase = async (phase: string) => { await vi.waitFor(() => expect(last().review?.phase).toBe(phase)) }
  return { spec, cwd, persistence, publications, responses, run, request, last, waitPhase, get gate() { return gate }, setSettings(value: SessionSettings) { settings = value }, setDecision(value: typeof decide) { decide = value }, restart() { gate = make(); route() } }
}

describe('host approval response gate (synthetic reviewers, no inference)', () => {
  it('blocks production native writes without a trusted executor contract, before spending a reviewer turn', async () => {
    const f = fixture()
    delete f.gate.routing!.supportsExactExecution
    f.gate.intercept(f.spec, 'runtime', f.request())
    await f.waitPhase('blocked')
    expect(f.last().review?.rationale).toContain('cannot enforce reviewed file preconditions')
    expect(f.run).not.toHaveBeenCalled()
    expect(f.responses).toHaveLength(0)
  })

  it('refuses an automatic response whose live action binding was lost on reconnect, but never the owner', async () => {
    const f = fixture()
    await expect(f.gate.reserve({ sessionId: 'worker', runtimeId: 'lost-runtime', requestId: 'missing', decision: 'allow' }, true, true)).rejects.toThrow('no live action binding')
    await expect(f.gate.reserve({ sessionId: 'worker', runtimeId: 'lost-runtime', requestId: 'missing', decision: 'allow' }, false, true)).resolves.toBeUndefined()
  })
  it("keeps the owner's choices open during the review and sends one exact workspace Write response", async () => {
    const f = fixture()
    let release!: (result: ReviewResult) => void, digest = ''
    f.setDecision(async (_action, actual) => { digest = actual; return new Promise(resolve => { release = resolve }) })
    const visible = f.gate.intercept(f.spec, 'runtime', f.request())
    expect(visible.data).toMatchObject({ type: 'interaction', interaction: { review: { phase: 'reviewing' }, title: 'Pending stronger-model review' } })
    if (visible.data.type === 'interaction') expect(visible.data.interaction.choices.every(choice => !choice.disabled)).toBe(true)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
    release({ digest, decision: 'allow', rationale: 'Authorized file', reviewerId: 'reviewer', model: 'claude-opus-test', turnId: 'turn' })
    await vi.waitFor(() => expect(f.responses).toHaveLength(1))
    f.gate.intercept(f.spec, 'runtime', f.request())
    await tick()
    expect(f.responses).toHaveLength(1)
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.run.mock.calls[0]![1]).toMatchObject({ tool: 'Write', arguments: { file_path: 'panel.txt', content: 'hello' }, machineId: 'local', ownerEvidence: expect.stringContaining('No deployment') })
  })
  it('journals an owner answer given after escalation and persists that denial across runtime/worker/tool routes', async () => {
    const f = fixture()
    f.setDecision(async (_action, digest) => ({ digest, decision: 'escalate', rationale: 'Needs owner permission', reviewerId: 'reviewer', model: 'claude-opus-test', turnId: 'turn' }))
    f.gate.intercept(f.spec, 'runtime', f.request())
    await f.waitPhase('owner')
    expect(f.last().title).toBe('Owner decision: Allow Write?')
    expect(f.last().choices.every(choice => !choice.disabled)).toBe(true)
    const record = await f.gate.reserve({ sessionId: 'worker', runtimeId: 'runtime', requestId: 'request', decision: 'deny' }, false)
    expect(record?.denied).toBe(true)
    f.restart()
    expect(await f.gate.guardTool({ ...f.spec, id: 'replacement' }, 'Bash', { command: 'overwrite panel.txt' })).toContain('durable approval denial')
    expect(await f.gate.guardTool({ ...f.spec, id: 'replacement' }, 'Edit', { file_path: 'panel.txt' })).toContain('durable approval denial')
    expect(await f.gate.guardTool(f.spec, 'Read', { file_path: 'panel.txt' })).toBeUndefined()
  })
  it('invalidates a review when another writer changes target contents before the answer', async () => {
    const f = fixture()
    writeFileSync(join(f.cwd, 'panel.txt'), 'before')
    f.setDecision(async (_action, digest) => { writeFileSync(join(f.cwd, 'panel.txt'), 'concurrent edit'); return { digest, decision: 'allow', rationale: 'Allowed', reviewerId: 'reviewer', model: 'claude-opus-test', turnId: 'turn' } })
    f.gate.intercept(f.spec, 'runtime', f.request())
    await f.waitPhase('paused')
    expect(f.responses).toHaveLength(0)
    expect(f.last().review?.rationale).toContain('changed')
  })
  it('blocks unsupported native requests from automatic approval without running a reviewer, leaving them to the owner', async () => {
    const f = fixture()
    f.gate.intercept({ ...f.spec, provider: 'codex' }, 'runtime', f.request('command', { command: 'outside write' }, 'Bash'))
    await f.waitPhase('blocked')
    expect(f.last().review?.rationale).toContain('no implemented exact-action')
    expect(f.run).not.toHaveBeenCalled()
    expect(f.last().title).toBe('Allow Bash?')
    expect(f.last().choices.every(choice => !choice.disabled)).toBe(true)
  })
  it('never replaces mandatory native approval with a reviewer allow', async () => {
    const f = fixture()
    f.gate.intercept(f.spec, 'runtime', f.request('mandatory', { file_path: 'panel.txt', content: 'x' }, 'Write', { matched_ask_rule: { behavior: 'ask' } }))
    await f.waitPhase('blocked')
    expect(f.responses).toHaveLength(0)
    expect(f.last().review?.rationale).toContain('native owner boundary')
  })
  it('preserves an outage as paused, leaves the decision with the owner and never falls back to another model', async () => {
    const f = fixture()
    f.setDecision(async () => { throw new Error('Reviewer budget exhausted') })
    f.gate.intercept(f.spec, 'runtime', f.request())
    await f.waitPhase('paused')
    expect(f.responses).toHaveLength(0)
    expect(f.last().choices.every(choice => !choice.disabled)).toBe(true)
    f.restart()
    f.gate.intercept(f.spec, 'runtime', f.request())
    await f.waitPhase('paused')
    expect(f.run).toHaveBeenCalledOnce()
  })
  it('lets the owner answer during a review or after it stalled, and never uses the late reviewer result', async () => {
    const f = fixture()
    let release!: (result: ReviewResult) => void, digest = ''
    f.setDecision(async (_action, actual) => { digest = actual; return new Promise(resolve => { release = resolve }) })
    f.gate.intercept(f.spec, 'runtime', f.request())
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
    const record = await f.gate.reserve({ sessionId: 'worker', runtimeId: 'runtime', requestId: 'request', decision: 'allow-session' }, false)
    expect(record?.phase).toBe('responding')
    f.gate.finish(record!, true)
    release({ digest, decision: 'deny', rationale: 'Late and unused', reviewerId: 'reviewer', model: 'claude-opus-test', turnId: 'turn' })
    await tick(); await tick()
    expect(f.responses).toHaveLength(0)
    expect(f.gate.journal.hasDenials('project')).toBe(false)
    expect(f.gate.journal.get('project', record!.id)?.phase).toBe('responded')
    // A review that could not even bind an action still leaves a normal approval for the owner.
    f.gate.routing!.authorization = () => { throw new Error('Remote, detached or cross-project review authority is unsupported') }
    f.gate.intercept(f.spec, 'runtime', f.request('second'))
    await f.waitPhase('paused')
    expect(f.last().title).toBe('Allow Write?')
    expect(f.last().review?.rationale).toContain('cross-project')
    expect(f.last().choices.every(choice => !choice.disabled)).toBe(true)
    await expect(f.gate.reserve({ sessionId: 'worker', runtimeId: 'runtime', requestId: 'second', decision: 'allow' }, false)).resolves.toBeUndefined()
  })
  it('does not review a plan-mode mutation or a protected settings path', async () => {
    const f = fixture()
    f.setSettings({ permission: 'default', plan: true })
    f.gate.intercept(f.spec, 'runtime', f.request())
    await f.waitPhase('blocked')
    expect(f.run).not.toHaveBeenCalled()
    f.setSettings({ permission: 'auto', plan: false })
    f.gate.intercept(f.spec, 'runtime', f.request('config', { file_path: 'AGENTS.md', content: 'override' }))
    await f.waitPhase('paused')
    expect(f.last().review?.rationale).toContain('Protected configuration')
    expect(f.run).not.toHaveBeenCalled()
  })
})
