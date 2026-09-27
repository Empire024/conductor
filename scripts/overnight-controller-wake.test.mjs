import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, wake } from './overnight-controller-wake.mjs'
import { createControlClient } from './overseer/control-client.mjs'

const start = Date.parse('2026-09-27T21:00:00Z')
const args = (at = '2026-09-27T22:00:00Z', deadline = '2026-09-27T22:05:00Z') =>
  ['--at', at, '--deadline', deadline, '--agent', 'agent-a', '--project', 'project-a', '--workspace', 'workspace-a', '--prompt-file', 'unused', '--state-file', 'unused']

async function fixture(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-wake-'))
  let now = start, calls = [], reads = 0, idle = 700
  const config = { ...parseArgs(args(), start), stateFile: join(dir, 'state.json') }
  const agent = { agentSessionId: config.agent, projectId: config.project, workspaceId: config.workspace,
    tabId: 'tab-a', wizard: true, phase: 'completed', backgroundTasks: 0 }
  const status = { ...agent, pending: [], waitingPrompts: 0, activeTool: null, recovery: { superseded: null } }
  const deps = {
    now: () => now, sleep: async ms => { now += ms }, idleSeconds: async () => idle,
    readPrompt: async () => 'SECRET PROMPT', readCredential: async () => ({ ok: true, credential: { token: 'SECRET TOKEN' } }),
    clientFromCredential: () => ({ call: async (method, payload) => {
      calls.push(method)
      if (method === 'agents.list') return [{ ...agent, ...overrides.agent }]
      if (method === 'agents.status') { reads++; return { ...status, ...overrides.status } }
      if (method === 'agents.steer') { if (overrides.steerError) throw overrides.steerError; return { delivery: 'started' } }
      throw new Error('unexpected method')
    } })
  }
  return { dir, config, deps, calls, get now() { return now }, set now(value) { now = value }, get reads() { return reads }, set idle(value) { idle = value }, state: () => readFile(config.stateFile, 'utf8'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('strict dates, horizon and deadline', () => {
  assert.throws(() => parseArgs(args('2026-09-27T20:59:59Z'), start), /future/)
  assert.throws(() => parseArgs(args('2026-09-28T21:00:01Z', '2026-09-28T21:01:00Z'), start), /24 hours/)
  assert.throws(() => parseArgs(args('2026-09-27T22:00:00Z', '2026-09-27T22:00:00Z'), start), /deadline/)
  assert.throws(() => parseArgs(args('2026-09-27T22:00:00'), start), /ISO/)
})

test('waits until due, checks read-only state and sends one wake', async () => {
  const f = await fixture()
  try {
    assert.equal(await wake(f.config, f.deps), 'sent')
    assert.deepEqual(f.calls, ['agents.list', 'agents.status', 'agents.steer'])
    assert.ok(f.now >= f.config.at && f.now < f.config.deadline)
    const state = await f.state()
    assert.match(state, /"phase":"sent"/)
    assert.doesNotMatch(state, /SECRET/)
    await assert.rejects(wake(f.config, f.deps), /Existing wake state/)
    assert.equal(f.calls.filter(x => x === 'agents.steer').length, 1)
  } finally { await f.cleanup() }
})

for (const [name, change] of [
  ['not wizard', { agent: { wizard: false } }],
  ['superseded', { status: { recovery: { superseded: { by: 'agent-b' } } } }],
  ['running', { status: { phase: 'running' } }],
  ['background task', { status: { backgroundTasks: 1 } }],
  ['pending request', { status: { pending: [{ requestId: 'r' }] } }],
  ['queued prompt', { status: { waitingPrompts: 1 } }]
]) test(`refuses ${name}`, async () => {
  const f = await fixture(change)
  try { assert.equal(await wake(f.config, f.deps), 'refused'); assert.ok(!f.calls.includes('agents.steer')) }
  finally { await f.cleanup() }
})

test('owner activity or unknown idle never reaches app before deadline', async () => {
  const f = await fixture()
  try { f.idle = null; assert.equal(await wake(f.config, f.deps), 'expired'); assert.deepEqual(f.calls, []) }
  finally { await f.cleanup() }
})

test('599 seconds idle still defers the wake', async () => {
  const f = await fixture()
  try { f.idle = 599; assert.equal(await wake(f.config, f.deps), 'expired'); assert.deepEqual(f.calls, []) }
  finally { await f.cleanup() }
})

test('a read completing at the deadline cannot trigger a later status or steer', async () => {
  const f = await fixture()
  const original = f.deps.clientFromCredential
  f.deps.clientFromCredential = (...parameters) => {
    const control = original(...parameters)
    return { call: async (...args) => {
      const result = await control.call(...args)
      if (args[0] === 'agents.list') f.now = f.config.deadline
      return result
    } }
  }
  try { assert.equal(await wake(f.config, f.deps), 'expired'); assert.deepEqual(f.calls, ['agents.list']) }
  finally { await f.cleanup() }
})

test('unreachable reads retry at most once per minute and stop at deadline', async () => {
  const f = await fixture()
  f.deps.readCredential = async () => ({ ok: false })
  try { assert.equal(await wake(f.config, f.deps), 'expired'); assert.deepEqual(f.calls, []); assert.ok(f.now <= f.config.deadline) }
  finally { await f.cleanup() }
})

test('mutation timeout is ambiguous, persisted intent prevents restart retry', async () => {
  const f = await fixture({ steerError: Object.assign(new Error('transport timeout'), { code: 'timeout' }) })
  try {
    assert.equal(await wake(f.config, f.deps), 'ambiguous')
    assert.deepEqual(f.calls, ['agents.list', 'agents.status', 'agents.steer'])
    assert.match(await f.state(), /"phase":"sent-intent"/)
    assert.doesNotMatch(await f.state(), /SECRET/)
    await assert.rejects(wake(f.config, f.deps), /Existing wake state/)
  } finally { await f.cleanup() }
})

for (const stalledMethod of ['agents.list', 'agents.steer']) test(`actual client: stalled ${stalledMethod} response body ends by deadline`, async () => {
  const f = await fixture()
  const started = Date.now()
  f.config.at = started - 1
  f.config.deadline = started + 90
  f.deps.now = Date.now
  f.deps.clientFromCredential = (_credential, options) => createControlClient({
    endpoint: 'http://127.0.0.1:1/control', token: 'SECRET TOKEN', timeoutMs: options.timeoutMs,
    fetchImpl: async (_url, init) => {
      const { method } = JSON.parse(init.body)
      f.calls.push(method)
      if (method === stalledMethod) return { ok: true, status: 200, text: () => new Promise(() => {}) }
      const result = method === 'agents.list' ? [{ agentSessionId: f.config.agent, projectId: f.config.project,
        workspaceId: f.config.workspace, tabId: 'tab-a', wizard: true, phase: 'completed', backgroundTasks: 0 }]
        : { agentSessionId: f.config.agent, projectId: f.config.project, workspaceId: f.config.workspace,
          tabId: 'tab-a', wizard: true, phase: 'completed', backgroundTasks: 0,
          pending: [], waitingPrompts: 0, activeTool: null, recovery: { superseded: null } }
      return { ok: true, status: 200, text: async () => JSON.stringify({ result }) }
    }
  })
  try {
    assert.equal(await wake(f.config, f.deps), stalledMethod === 'agents.list' ? 'expired' : 'ambiguous')
    assert.ok(Date.now() - started < 220, 'whole response must settle promptly after 90 ms deadline')
    assert.equal(f.calls.filter(x => x === 'agents.steer').length, stalledMethod === 'agents.list' ? 0 : 1)
    assert.doesNotMatch(await f.state(), /SECRET/)
    if (stalledMethod === 'agents.steer') assert.match(await f.state(), /"phase":"sent-intent"/)
  } finally { await f.cleanup() }
})

for (const operation of ['idle', 'credential', 'prompt']) test(`stalled ${operation} read ends by deadline without steer`, async () => {
  const f = await fixture()
  const started = Date.now()
  f.config.at = started - 1
  f.config.deadline = started + 70
  f.deps.now = Date.now
  const never = () => new Promise(() => {})
  if (operation === 'idle') f.deps.idleSeconds = never
  if (operation === 'credential') f.deps.readCredential = never
  if (operation === 'prompt') f.deps.readPrompt = never
  try {
    assert.equal(await wake(f.config, f.deps), 'expired')
    assert.ok(Date.now() - started < 200)
    assert.ok(!f.calls.includes('agents.steer'))
    assert.doesNotMatch(await f.state(), /SECRET/)
  } finally { await f.cleanup() }
})

test('exclusive lease refuses a second instance', async () => {
  const f = await fixture()
  let release
  f.deps.sleep = () => new Promise(resolve => { release = () => { f.now = f.config.at; resolve() } })
  try {
    const first = wake(f.config, f.deps)
    while (!release) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(wake(f.config, f.deps), /EEXIST/)
    release()
    assert.equal(await first, 'sent')
  } finally { await f.cleanup() }
})
