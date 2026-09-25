import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeCapabilities, parseProbe, PROBE_SCRIPT, selectNode } from './capabilities.ts'
import { RemoteJobService, syncScript } from './service.ts'
import { buildJobCommand, JOB_WRAPPER, MarkerScanner, shQuote } from './shell.ts'
import { RemoteJobStore } from './store.ts'
import { FakeNodes, shellWords } from './test-fakes.ts'
import { sshArgs } from './transport.ts'
import type { ExecutionNode } from './types.ts'

const MAC_PROBE = [
  'hostname=jurajs-mac-mini', 'user=juraj', 'home=/Users/juraj', 'os=Darwin', 'arch=arm64', 'kernel=24.6.0', 'shell=/bin/zsh',
  'osName=macOS', 'osVersion=15.6.1', 'osBuild=24G90', 'model=Macmini9,1', 'cpu=Apple M1', 'cores=8', 'perfCores=4',
  'memBytes=17179869184', 'developerDir=/Library/Developer/CommandLineTools', 'rosetta=no', 'sleep=0', 'diskFreeKb=183500800',
  'tool.git=/usr/bin/git|git version 2.39.5 (Apple Git-154)', 'tool.node=/opt/homebrew/bin/node|v24.8.0', 'tool.npm=/opt/homebrew/bin/npm|11.6.0',
  'tool.brew=/opt/homebrew/bin/brew|Homebrew 4.6.10', 'tool.xcodebuild=/usr/bin/xcodebuild|'
].join('\n')
const LINUX_PROBE = ['hostname=box', 'os=Linux', 'arch=x86_64', 'cores=16', 'memBytes=34359738368', 'tool.git=/usr/bin/git|git version 2.43.0'].join('\n')

const probeFor: Record<string, string> = { 'jurajs-mac-mini': MAC_PROBE, 'linux-box': LINUX_PROBE }

let root: string
let fake: FakeNodes
let store: RemoteJobStore
let service: RemoteJobService
let ids = 0

const makeService = (): RemoteJobService => new RemoteJobService({
  store, transport: fake.factory(), newId: () => `rj_${++ids}`, nonce: () => 'n0nce',
  resolveCommit: async (_repo, ref) => ref === 'HEAD' ? 'a'.repeat(40) : ref.padEnd(40, '0'),
  cancelGraceMs: 50, localGraceMs: 50
})

/** Answers probes like a real node would, and hands job commands to `job`. */
const behave = (job: (spec: NonNullable<ReturnType<typeof FakeNodes.job>>, run: Parameters<FakeNodes['handler']>[1], nodeHost: string) => void, offline: string[] = []): void => {
  fake.handler = (command, run, _options, host) => {
    if (offline.includes(host)) { run.stderr('ssh: connect to host: Operation timed out\n'); run.end(255, { error: 'ssh could not complete the connection' }); return }
    if (command.includes('kv hostname')) { run.stdout(probeFor[host === 'mac-mini' ? 'jurajs-mac-mini' : 'linux-box'] ?? ''); run.end(0); return }
    const spec = FakeNodes.job(command)
    if (spec) { job(spec, run, host); return }
    run.end(0)
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'remote-jobs-'))
  fake = new FakeNodes()
  store = new RemoteJobStore(root)
  ids = 0
  service = makeService()
  service.registerNode({ id: 'mac-mini', name: 'Mac mini', ssh: { host: 'jurajs-mac-mini', user: 'juraj', identityFile: 'C:/k/conductor_mac_ed25519' } })
  service.registerNode({ id: 'linux-box', ssh: { host: 'linux-box', user: 'dev', identityFile: 'C:/k/id' } })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('shell pieces', () => {
  it('quotes so the words come back exactly, quotes and all', () => {
    const tricky = `echo "it's $HOME" && printf '%s\\n' a b`
    const line = buildJobCommand({ jobId: 'rj_1', cwd: 'conductor-node/work/x', timeoutSec: 90, command: tricky, nonce: 'abc' })
    expect(shellWords(line)).toEqual(['/bin/bash', '-c', JOB_WRAPPER, 'conductor-job', 'rj_1', 'conductor-node/work/x', '90', tricky, 'abc'])
    expect(shQuote("a'b")).toBe(`'a'\\''b'`)
  })

  it('splits wrapper markers out of stderr, even across chunks and glued to output', () => {
    const scanner = new MarkerScanner('n1')
    const first = scanner.push('warning: x\n@@conduc')
    expect(first).toEqual({ text: 'warning: x\n', events: [] })
    const second = scanner.push('tor-job:n1 started pid=42\npartial line @@conductor-job:n1 exit=3\n')
    expect(second.text).toBe('partial line ')
    expect(second.events).toEqual([{ kind: 'started', pid: 42 }, { kind: 'exit', code: 3 }])
    expect(scanner.push('@@conductor-job:other exit=0\n').events).toEqual([])
    expect(scanner.flush()).toBe('')
  })

  it('the wrapper never runs CLT shims and stops the whole process group', () => {
    expect(PROBE_SCRIPT).toContain('shim.$t')
    expect(JOB_WRAPPER).toContain('set -m')
    expect(JOB_WRAPPER).toContain('kill -TERM -"$pid"')
    expect(JOB_WRAPPER).toContain('kill -KILL -"$pid"')
    expect(JOB_WRAPPER).toContain('cat <&3')
  })

  it('ssh is keys-only, bounded and pins the host key in Conductor\'s own file', () => {
    const node = store.getNode('mac-mini')!
    const args = sshArgs({ ...node, ssh: { ...node.ssh, port: 2222 } }, 'C:/data/known_hosts')
    expect(args).toEqual(expect.arrayContaining(['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=accept-new', 'UserKnownHostsFile=C:/data/known_hosts', 'ConnectTimeout=15', '-p', '2222']))
    expect(args.at(-1)).toBe('juraj@jurajs-mac-mini')
  })

  it('the checkout script fetches the pushed ref into the node\'s own checkout and drops the ref again', () => {
    const script = syncScript({ root: 'conductor-node' }, 'conductor', 'refs/conductor/jobs/rj_1', 'a'.repeat(40))
    expect(script).toContain(`bare="$HOME/"'conductor-node/repos/conductor.git'`)
    expect(script).toContain('git checkout -q --detach --force "$commit"')
    expect(script).toContain('git --git-dir="$bare" update-ref -d "$ref"')
  })
})

describe('node records', () => {
  it('parses an M1 probe into facts and capabilities', () => {
    const facts = parseProbe(MAC_PROBE)
    expect(facts).toMatchObject({ platform: 'darwin', arch: 'arm64', osVersion: '15.6.1', model: 'Macmini9,1', cores: 8, performanceCores: 4, ramGb: 16, diskFreeGb: 175, rosetta: false, sleepMinutes: '0', developerDir: '/Library/Developer/CommandLineTools' })
    expect(nodeCapabilities({ facts, labels: ['electron-build'] })).toEqual(['apple-silicon', 'arm64', 'brew', 'electron-build', 'git', 'macos', 'node', 'node@24', 'npm', 'xcode-clt'])
  })

  it('reports Command Line Tools shims instead of pretending git is there', () => {
    const facts = parseProbe('os=Darwin\narch=arm64\nshim.git=/usr/bin/git\nshim.python3=/usr/bin/python3')
    expect(facts.shims).toEqual(['git', 'python3'])
    expect(nodeCapabilities({ facts, labels: [] })).not.toContain('git')
  })

  it('a probe marks the node online with its facts; a failed one marks it offline with the reason', async () => {
    behave(() => undefined, ['linux-box'])
    const mac = await service.probeNode('mac-mini')
    expect(mac).toMatchObject({ status: 'online', lastError: null, capabilities: expect.arrayContaining(['macos', 'apple-silicon']) })
    expect(mac.lastSeenAt).toBeTruthy()
    const linux = await service.probeNode('linux-box')
    expect(linux.status).toBe('offline')
    expect(linux.lastError).toContain('Operation timed out')
    // Records persist: a new store over the same folder sees the probe.
    expect(new RemoteJobStore(root).getNode('mac-mini')?.facts?.model).toBe('Macmini9,1')
  })

  it('refuses unsafe registrations', () => {
    expect(() => service.registerNode({ id: 'Mac Mini', ssh: { host: 'h', user: 'u', identityFile: 'k' } })).toThrow(/lower-case/)
    expect(() => service.registerNode({ id: 'm', ssh: { host: 'h; rm -rf /', user: 'u', identityFile: 'k' } })).toThrow(/host/)
    expect(() => service.registerNode({ id: 'm', ssh: { host: 'h', user: 'u', identityFile: 'k' }, root: '../etc' })).toThrow(/root/)
  })

  it('selectNode says per node why nothing qualifies', () => {
    const offline = { ...store.getNode('mac-mini')!, facts: parseProbe(MAC_PROBE), status: 'offline' as const, lastError: 'timeout' }
    const linux: ExecutionNode = { ...store.getNode('linux-box')!, facts: parseProbe(LINUX_PROBE), status: 'online' }
    expect(() => selectNode([
      { node: offline, capabilities: nodeCapabilities(offline), runningJobs: 0 },
      { node: linux, capabilities: nodeCapabilities(linux), runningJobs: 0 }
    ], ['mac'])).toThrow('No online node with macos. mac-mini is offline (timeout); linux-box lacks macos.')
  })
})

describe('remote jobs', () => {
  const succeed = (output = 'built\n'): Parameters<typeof behave>[0] => (_spec, run) => {
    run.mark('started pid=4242')
    run.stdout(output)
    run.stderr('npm warn something\n')
    run.mark('exit=0')
    run.end(0)
  }

  it('routes "requires macOS" to the Mac, captures both streams and persists logs', async () => {
    behave(succeed())
    const job = await service.submit({ command: 'uname -a', requires: ['macos'], cwd: '~', timeoutSec: 60 })
    expect(job.nodeId).toBe('mac-mini')
    const done = await service.wait(job.id, 2000)
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, remotePid: 4242, stdoutTail: 'built\n', stderrTail: 'npm warn something\n', detail: null })
    expect(readFileSync(join(root, 'jobs', job.id, 'stdout.log'), 'utf8')).toBe('built\n')
    expect(readFileSync(join(root, 'jobs', job.id, 'stderr.log'), 'utf8')).not.toContain('@@conductor-job')
    expect(JSON.parse(readFileSync(join(root, 'jobs', job.id, 'job.json'), 'utf8')).status).toBe('succeeded')
    const call = fake.calls.find(entry => FakeNodes.job(entry.command))!
    expect(call).toMatchObject({ nodeId: 'mac-mini', holdStdin: true })
    expect(FakeNodes.job(call.command)).toMatchObject({ cwd: '~', timeoutSec: 60, command: 'uname -a' })
    expect(service.readLog(job.id, 'stdout').text).toBe('built\n')
  })

  it('refuses "requires macOS" when the Mac is unreachable instead of running it elsewhere', async () => {
    behave(succeed(), ['mac-mini'])
    await expect(service.submit({ command: 'true', requires: ['macos'] })).rejects.toThrow(/No online node with macos/)
    expect(service.listJobs()).toEqual([])
  })

  it('a non-zero exit is a failure with its code', async () => {
    behave((_spec, run) => { run.mark('started pid=1'); run.stderr('boom\n'); run.mark('exit=2'); run.end(2) })
    const job = await service.submit({ command: 'false', nodeId: 'mac-mini' })
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'failed', exitCode: 2, detail: 'Exited with code 2.' })
  })

  it('the node\'s own deadline ends a job as timed out', async () => {
    behave((_spec, run) => { run.mark('started pid=1'); run.mark('reason=timeout'); run.mark('exit=143'); run.end(143) })
    const job = await service.submit({ command: 'sleep 999', nodeId: 'mac-mini', timeoutSec: 1 })
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'timed-out', exitCode: 143 })
  })

  it('cancel closes the held stdin and the node stops the job group', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    behave((_spec, run) => {
      run.mark('started pid=7')
      run.onStdinClosed(() => { run.mark('reason=cancelled'); run.mark('exit=143'); run.end(143) })
      started()
    })
    const job = await service.submit({ command: 'npm test', nodeId: 'mac-mini' })
    await running
    await service.cancel(job.id, 'owner changed their mind')
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'cancelled', cancelReason: 'owner changed their mind' })
  })

  it('a cancel the node never answers drops the connection and sends a stop by pid file', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    behave((_spec, run) => { run.mark('started pid=7'); started() })
    const job = await service.submit({ command: 'hang', nodeId: 'mac-mini' })
    await running
    await service.cancel(job.id)
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'cancelled' })
    expect(fake.calls.some(call => call.command.includes('.conductor-node/jobs/rj_1') && call.command.includes('kill -TERM'))).toBe(true)
  })

  it('a connection that dies mid-run is lost, not failed, and the node is marked offline', async () => {
    behave((_spec, run) => { run.mark('started pid=9'); run.stdout('half'); run.end(255, { error: 'ssh could not complete the connection' }) })
    await service.probeNode('mac-mini')
    const job = await service.submit({ command: 'npm run build', nodeId: 'mac-mini' })
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'lost', stdoutTail: 'half' })
    expect(service.getNode('mac-mini').status).toBe('offline')
  })

  it('a node that cannot be reached at all fails the job before it starts', async () => {
    const job = await (async () => { behave(succeed()); await service.probeNode('mac-mini'); return undefined })()
    void job
    behave(succeed(), ['mac-mini'])
    const failed = await service.submit({ command: 'true', nodeId: 'mac-mini' })
    const done = await service.wait(failed.id, 2000)
    expect(done.status).toBe('failed')
    expect(done.detail).toMatch(/Could not start it on mac-mini/)
  })

  it('a missing working directory is named', async () => {
    behave((_spec, run) => { run.mark('error=cwd'); run.mark('exit=125'); run.end(125) })
    const job = await service.submit({ command: 'ls', nodeId: 'mac-mini', cwd: 'nowhere' })
    expect((await service.wait(job.id, 2000)).detail).toBe('The working directory nowhere does not exist on mac-mini.')
  })

  it('a checkout job pushes the commit to the node and checks it out before running there', async () => {
    behave(succeed())
    const job = await service.submit({ command: 'npm ci && npm test', requires: ['macos'], checkout: { localRepoPath: 'C:/Claude/conductor', commit: 'HEAD' }, cwd: 'packages/app' })
    expect(job.cwd).toBe('conductor-node/work/conductor/packages/app')
    expect(job.checkout).toEqual({ repo: 'conductor', commit: 'a'.repeat(40), localRepoPath: 'C:/Claude/conductor' })
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'succeeded' })
    expect(fake.pushes).toEqual([expect.objectContaining({ nodeId: 'mac-mini', commit: 'a'.repeat(40), remotePath: 'conductor-node/repos/conductor.git', ref: 'refs/conductor/jobs/rj_1' })])
    const order = fake.calls.map(call => call.command.includes('git init --bare') ? 'init' : call.command.includes('git fetch') ? 'sync' : FakeNodes.job(call.command) ? 'job' : 'other')
    expect(order.filter(step => step !== 'other')).toEqual(['init', 'sync', 'job'])
  })

  it('a failed push fails the job without running it', async () => {
    behave(succeed())
    fake.pushError = new Error('git push to mac-mini failed (128): Permission denied (publickey)')
    const job = await service.submit({ command: 'npm test', nodeId: 'mac-mini', checkout: { localRepoPath: 'C:/Claude/conductor' } })
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'failed', detail: expect.stringContaining('Permission denied') })
    expect(fake.calls.some(call => FakeNodes.job(call.command))).toBe(false)
  })

  it('jobs on one checkout run one at a time; the node limit queues the rest', async () => {
    const finishers: Array<() => void> = []
    behave((_spec, run) => { run.mark('started pid=1'); finishers.push(() => { run.mark('exit=0'); run.end(0) }) })
    const checkout = { localRepoPath: 'C:/Claude/conductor' }
    const first = await service.submit({ command: 'a', nodeId: 'mac-mini', checkout })
    const second = await service.submit({ command: 'b', nodeId: 'mac-mini', checkout })
    const third = await service.submit({ command: 'c', nodeId: 'mac-mini' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.getJob(first.id).status).toBe('running')
    expect(service.getJob(second.id).status).toBe('queued')
    expect(service.getJob(third.id).status).toBe('running')
    expect(service.getNode('mac-mini').currentJobs.sort()).toEqual([first.id, second.id, third.id].sort())
    finishers.shift()!()
    await service.wait(first.id, 2000)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.getJob(second.id).status).toBe('running')
    while (finishers.length) finishers.shift()!()
    await service.idle()
    expect(service.listJobs().map(job => job.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
  })

  it('after a restart, jobs the old process ran are lost and their node is told to stop them', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    behave((_spec, run) => { run.mark('started pid=5'); started() })
    const job = await service.submit({ command: 'long', nodeId: 'mac-mini' })
    await running
    const restarted = makeService()
    const recovered = await new RemoteJobService({ store: new RemoteJobStore(root), transport: fake.factory() }).recover()
    void restarted
    expect(recovered).toEqual([expect.objectContaining({ id: job.id, status: 'lost' })])
    expect(fake.calls.at(-1)!.command).toContain(`.conductor-node/jobs/${job.id}`)
  })

  it('validates what a job asks for', async () => {
    await expect(service.submit({ command: ' ', nodeId: 'mac-mini' })).rejects.toThrow(/command/)
    await expect(service.submit({ command: 'x', nodeId: 'mac-mini', timeoutSec: 0 })).rejects.toThrow(/timeoutSec/)
    await expect(service.submit({ command: 'x', nodeId: 'nope' })).rejects.toThrow(/No node "nope"/)
    await expect(service.submit({ command: 'x', nodeId: 'mac-mini', cwd: '../..', checkout: { localRepoPath: 'C:/r' } })).rejects.toThrow(/cwd/)
  })
})
