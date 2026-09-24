import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpec } from '../shared/models'
import { AgentControlServer } from './agent-control-server'
import { CONTROL_METHOD_CLASSES, controlMethodClass } from './control-method-classes'

const servers: AgentControlServer[] = []
afterEach(() => { servers.splice(0).forEach(server => server.close()) })

const spec: AgentSpec = {
  id: 'caller', projectId: 'project', sessionId: 'workspace', provider: 'codex', title: 'Caller', cwd: 'C:\\project'
}

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(call: (method: string) => Promise<unknown>) {
  const control = {
    authorize: vi.fn(() => spec),
    ownerScope: vi.fn(() => ({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: 'owner', owner: true })),
    call: vi.fn((_scope: unknown, method: string) => call(method))
  }
  const server = new AgentControlServer(control as never, false)
  servers.push(server)
  await server.start()
  const briefing = server.briefing(spec)
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)![1]!
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)![1]!
  const request = (method: string): Promise<Response> => fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args: {} })
  })
  return { control, request }
}

describe('agent-control request concurrency', () => {
  it('lets a read complete while a mutation from the same session is in flight', async () => {
    const mutation = deferred()
    const started = deferred()
    const f = await fixture(async method => {
      if (method === 'tabs.open') { started.resolve(); await mutation.promise; return { opened: true } }
      return { 'tools.list': '()' }
    })

    const opening = f.request('tabs.open')
    await started.promise
    const listed = await f.request('tools.list')
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ result: { 'tools.list': '()' } })
    mutation.resolve()
    expect((await opening).status).toBe(200)
  })

  it('serializes two mutations from one session instead of rejecting the second', async () => {
    const first = deferred()
    const firstStarted = deferred()
    const calls: string[] = []
    const f = await fixture(async method => {
      calls.push(method)
      if (method === 'tabs.open') { firstStarted.resolve(); await first.promise }
      return method
    })

    const opening = f.request('tabs.open')
    await firstStarted.promise
    const closing = f.request('tabs.close')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toEqual(['tabs.open'])
    first.resolve()
    expect((await opening).status).toBe(200)
    expect((await closing).status).toBe(200)
    expect(calls).toEqual(['tabs.open', 'tabs.close'])
  })

  it('caps one session at eight concurrent requests', async () => {
    const release = deferred()
    const allStarted = deferred()
    let started = 0
    const f = await fixture(async () => {
      started += 1
      if (started === 8) allStarted.resolve()
      await release.promise
      return null
    })

    const requests = Array.from({ length: 8 }, () => f.request('agents.status'))
    await allStarted.promise
    const refused = await f.request('agents.status')
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'This session already has 8 control requests in progress' })
    release.resolve()
    expect((await Promise.all(requests)).every(response => response.status === 200)).toBe(true)
  })
})

describe('control method classes', () => {
  it('classifies every method advertised by tools.list and keeps mutations out of the read lane', async () => {
    const advertised = [
      'tools.list', 'app.state', 'projects.list', 'machines.list', 'models.list', 'tabs.list', 'tabs.open', 'tabs.focus', 'tabs.rename', 'tabs.split', 'tabs.detach', 'tabs.close',
      'agents.list', 'agents.snapshot', 'agents.history', 'agents.artifact', 'agents.status', 'agents.compact', 'agents.configure', 'agents.grant', 'agents.submit', 'agents.steer', 'agents.interrupt', 'agents.resume', 'agents.fork', 'agents.release', 'agents.handoff',
      'files.list', 'files.read', 'files.write', 'files.open', 'tasks.list', 'tasks.update', 'memory.recall', 'memory.remember', 'memory.forget',
      'orchestration.snapshot', 'orchestration.tasks.create', 'orchestration.tasks.update', 'orchestration.routines.save', 'workspace.rename',
      'app.update', 'app.update.status', 'app.update.authorize', 'git.status', 'git.ship', 'git.ship.status', 'local.servers', 'local.stop', 'usage.limits',
      'router.start', 'router.dispatch', 'jobs.create', 'jobs.list', 'jobs.status', 'jobs.events', 'jobs.pause', 'jobs.resume', 'jobs.cancel', 'jobs.report',
      'schedules.list', 'schedules.get', 'schedules.create', 'schedules.update', 'schedules.pause', 'schedules.resume', 'schedules.runNow', 'schedules.delete', 'schedules.scripts.save', 'schedules.scripts.delete',
      'projects.open', 'app.update.check', 'app.update.download', 'app.update.install', 'app.restart', 'app.restart.request', 'app.quit.confirm'
    ]
    const f = await fixture(async method => method === 'tools.list'
      ? Object.fromEntries(advertised.map(name => [name, 'signature']))
      : null)
    const response = await f.request('tools.list')
    expect(response.status).toBe(200)
    expect(advertised.every(method => controlMethodClass(method) !== undefined)).toBe(true)
    expect([...CONTROL_METHOD_CLASSES].every(entry => advertised.includes(entry.slice(entry.indexOf(':') + 1)))).toBe(true)
    expect(controlMethodClass('tabs.open')).toBe('mutation')
    expect(controlMethodClass('jobs.pause')).toBe('mutation')
    expect(controlMethodClass('agents.history')).toBe('read')
    expect(controlMethodClass('git.ship.status')).toBe('read')
  })
})
