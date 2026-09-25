import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callNodeMethod, withNodes, type NodeCaller } from './control.ts'
import { RemoteJobService } from './service.ts'
import { RemoteJobStore } from './store.ts'
import { FakeNodes } from './test-fakes.ts'

let root: string
let fake: FakeNodes
let service: RemoteJobService
const agent: NodeCaller = { projectId: 'p1', projectPath: 'C:/Claude/conductor', agentSessionId: 'agent_a', owner: false, refusal: null }
const owner: NodeCaller = { ...agent, agentSessionId: 'owner', owner: true }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'remote-jobs-control-'))
  fake = new FakeNodes()
  fake.handler = (command, run) => {
    if (command.includes('kv hostname')) { run.stdout('os=Darwin\narch=arm64\ntool.git=/usr/bin/git|git version 2\ndeveloperDir=/Library/Developer/CommandLineTools\n'); run.end(0); return }
    if (FakeNodes.job(command)) { run.mark('started pid=3'); run.stdout('ok\n'); run.mark('exit=0'); run.end(0); return }
    run.end(0)
  }
  service = new RemoteJobService({ store: new RemoteJobStore(root), transport: fake.factory(), resolveCommit: async () => 'b'.repeat(40) })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('nodes.* control', () => {
  it('only the owner registers or removes a node, with the Conductor key by default', async () => {
    await expect(callNodeMethod(service, agent, 'nodes.register', { id: 'mac-mini', host: 'jurajs-mac-mini', user: 'juraj' })).rejects.toThrow(/owner/)
    const node = await callNodeMethod(service, owner, 'nodes.register', { id: 'mac-mini', host: 'jurajs-mac-mini', user: 'juraj' }) as { ssh: { identityFile: string } }
    expect(node.ssh.identityFile).toMatch(/conductor_mac_ed25519$/)
    await expect(callNodeMethod(service, agent, 'nodes.remove', { nodeId: 'mac-mini' })).rejects.toThrow(/owner/)
  })

  it('runs a macOS job for a writable coworker and keeps other projects\' jobs out of sight', async () => {
    await callNodeMethod(service, owner, 'nodes.register', { id: 'mac-mini', host: 'jurajs-mac-mini', user: 'juraj' })
    const job = await callNodeMethod(service, agent, 'nodes.run', { command: 'sw_vers', requires: ['macos'], checkout: true, cwd: 'scripts' }) as { id: string; cwd: string; checkout: { commit: string } }
    expect(job.cwd).toBe('conductor-node/work/conductor/scripts')
    expect(await callNodeMethod(service, agent, 'nodes.job', { jobId: job.id, waitSeconds: 2 })).toMatchObject({ status: 'succeeded', stdoutTail: 'ok\n' })
    expect(await callNodeMethod(service, agent, 'nodes.log', { jobId: job.id })).toMatchObject({ text: 'ok\n' })
    const listed = await callNodeMethod(service, agent, 'nodes.jobs', {}) as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('stdoutTail')
    const stranger = { ...agent, projectId: 'p2', agentSessionId: 'agent_b' }
    expect(await callNodeMethod(service, stranger, 'nodes.jobs', {})).toEqual([])
    await expect(callNodeMethod(service, stranger, 'nodes.job', { jobId: job.id })).rejects.toThrow(/No remote job with that id in this project/)
  })

  it('refuses callers that may not act, and checkouts of projects not on this machine', async () => {
    await callNodeMethod(service, owner, 'nodes.register', { id: 'mac-mini', host: 'jurajs-mac-mini', user: 'juraj' })
    const local = { ...agent, refusal: 'A sandboxed local conversation cannot run commands on another machine' }
    await expect(callNodeMethod(service, local, 'nodes.run', { command: 'id', nodeId: 'mac-mini' })).rejects.toThrow(/sandboxed local/)
    await expect(callNodeMethod(service, local, 'nodes.probe', {})).rejects.toThrow(/sandboxed local/)
    expect(await callNodeMethod(service, local, 'nodes.list', {})).toHaveLength(1)
    await expect(callNodeMethod(service, { ...agent, projectPath: null }, 'nodes.run', { command: 'id', nodeId: 'mac-mini', checkout: true })).rejects.toThrow(/on this machine/)
    await expect(callNodeMethod(service, agent, 'nodes.run', { command: 'id', nodeId: 'mac-mini', checkout: { commit: 'HEAD; rm -rf /' } })).rejects.toThrow(/checkout.commit/)
    await expect(callNodeMethod(service, agent, 'nodes.run', { command: 'id', host: 'x' })).rejects.toThrow(/host is not an argument/)
  })

  it('only the starter, the owner or a wizard cancels a job', async () => {
    await callNodeMethod(service, owner, 'nodes.register', { id: 'mac-mini', host: 'jurajs-mac-mini', user: 'juraj' })
    fake.handler = (command, run) => {
      if (command.includes('kv hostname')) { run.stdout('os=Darwin\narch=arm64\n'); run.end(0); return }
      if (FakeNodes.job(command)) { run.mark('started pid=3'); run.onStdinClosed(() => { run.mark('reason=cancelled'); run.mark('exit=143'); run.end(143) }); return }
      run.end(0)
    }
    const job = await callNodeMethod(service, agent, 'nodes.run', { command: 'sleep 100', nodeId: 'mac-mini' }) as { id: string }
    await expect(callNodeMethod(service, { ...agent, agentSessionId: 'agent_c' }, 'nodes.cancel', { jobId: job.id })).rejects.toThrow(/Only the owner/)
    await callNodeMethod(service, agent, 'nodes.cancel', { jobId: job.id, reason: 'done' })
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'cancelled', cancelReason: 'done' })
  })

  it('machines.list shows a node as its own machine, or as the node facet of its Conductor peer', async () => {
    await callNodeMethod(service, owner, 'nodes.register', { id: 'mac-mini', host: 'jurajs-mac-mini', user: 'juraj', name: 'Mac mini' })
    await callNodeMethod(service, owner, 'nodes.register', { id: 'box', host: 'box', user: 'u', peerMachineId: 'machine_box' })
    const machines = [{ id: 'local', kind: 'local' }, { id: 'machine_box', kind: 'peer' }]
    const merged = withNodes(machines, service.listNodes())
    expect(merged).toHaveLength(3)
    expect(merged[1]).toMatchObject({ id: 'machine_box', kind: 'peer', node: { nodeId: 'box' } })
    expect(merged[2]).toMatchObject({ id: 'node:mac-mini', name: 'Mac mini', kind: 'node', runsThisProject: false, node: { nodeId: 'mac-mini', workspaceRoot: '~/conductor-node' } })
  })
})
