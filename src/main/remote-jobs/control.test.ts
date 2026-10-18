import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callNodeMethod, withNodes, type NodeCaller } from './control.ts'
import { RemoteJobService } from './service.ts'
import { RemoteJobStore } from './store.ts'
import { FakeDetachedNode, FakeNodes, tarGz } from './test-fakes.ts'

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

  it('a detached run with artifacts lands them in the caller\'s project; nodes.log follows it by offset', async () => {
    const node = new FakeDetachedNode()
    fake.handler = (command, run) => {
      if (node.handle(command, run)) return
      if (command.includes('kv hostname')) { run.stdout('os=Darwin\narch=arm64\n'); run.end(0); return }
      run.end(0)
    }
    node.fetch = () => ({ marks: ['packing files=1 bytes=4'], archive: tarGz([{ name: './playwright-report/index.html', content: 'ok' }]) })
    await callNodeMethod(service, owner, 'nodes.register', { id: 'mac-mini', host: 'jurajs-mac-mini', user: 'juraj' })
    const project = { ...agent, projectPath: join(root, 'haf-stuff') }
    await expect(callNodeMethod(service, project, 'nodes.run', { command: 'x', nodeId: 'mac-mini', detached: 'yes' })).rejects.toThrow(/detached is true or false/)
    await expect(callNodeMethod(service, { ...project, projectPath: null }, 'nodes.run', { command: 'x', nodeId: 'mac-mini', artifacts: ['a'] })).rejects.toThrow(/on this machine/)
    const job = await callNodeMethod(service, project, 'nodes.run', { command: 'npx playwright test', nodeId: 'mac-mini', detached: true, artifacts: ['playwright-report'] }) as { id: string; artifactsDir: string; detached: boolean }
    expect(job).toMatchObject({ detached: true, artifactsDir: join(root, 'haf-stuff', '.conductor-scratch', 'remote-artifacts', job.id) })
    await expect(callNodeMethod(service, project, 'nodes.log', { jobId: job.id, waitSeconds: 5 })).rejects.toThrow(/needs an offset/)
    await expect(callNodeMethod(service, project, 'nodes.log', { jobId: job.id, offset: 0, waitSeconds: 51 })).rejects.toThrow(/waitSeconds must be/)
    const waiting = callNodeMethod(service, project, 'nodes.log', { jobId: job.id, offset: 0, waitSeconds: 5 })
    await new Promise(resolve => setTimeout(resolve, 20))
    node.output(job.id, 'stdout', 'Running 3 tests\n')
    expect(await waiting).toMatchObject({ text: 'Running 3 tests\n', nextOffset: 16, done: false })
    node.exit(job.id, 0)
    expect(await callNodeMethod(service, project, 'nodes.job', { jobId: job.id, waitSeconds: 2 })).toMatchObject({ status: 'succeeded', artifactFetch: { files: 1, error: null } })
    expect(await callNodeMethod(service, project, 'nodes.log', { jobId: job.id, offset: 16 })).toMatchObject({ text: '', done: true })
    expect(readFileSync(join(job.artifactsDir, 'playwright-report', 'index.html'), 'utf8')).toBe('ok')
    // On demand, by the same rules as nodes.run; another project's job reads as missing.
    const fetched = await callNodeMethod(service, project, 'nodes.fetch', { jobId: job.id, path: 'playwright-report' }) as { dir: string; files: number }
    expect(fetched).toMatchObject({ dir: job.artifactsDir, files: 1 })
    await expect(callNodeMethod(service, { ...project, refusal: 'read-only' }, 'nodes.fetch', { jobId: job.id, path: 'x' })).rejects.toThrow(/read-only/)
    await expect(callNodeMethod(service, { ...project, projectId: 'p2' }, 'nodes.fetch', { jobId: job.id, path: 'x' })).rejects.toThrow(/No remote job with that id/)
    await expect(callNodeMethod(service, project, 'nodes.fetch', { jobId: job.id, path: '../../etc' })).rejects.toThrow(/may not contain/)
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
