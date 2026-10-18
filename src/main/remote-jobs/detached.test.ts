import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RemoteJobService, utf8Boundary } from './service.ts'
import { buildFollowCommand, buildLaunchCommand, DETACHED_FOLLOW, DETACHED_LAUNCHER, DETACHED_SUPERVISOR, FrameReader } from './shell.ts'
import { RemoteJobStore } from './store.ts'
import { FakeDetachedNode, FakeNodes, shellWords, tarGz } from './test-fakes.ts'
import type { RemoteJob } from './types.ts'

let root: string
let fake: FakeNodes
let node: FakeDetachedNode
let ids = 0

const makeService = (extra: Partial<ConstructorParameters<typeof RemoteJobService>[0]> = {}): RemoteJobService => new RemoteJobService({
  store: new RemoteJobStore(root), transport: fake.factory(), newId: () => `rj_${++ids}`, nonce: () => `n${ids}x${Math.random().toString(36).slice(2, 6)}`,
  resolveCommit: async () => 'a'.repeat(40), cancelGraceMs: 50, localGraceMs: 50, reconnectMinMs: 5, reconnectMaxMs: 20, logPollMs: 5, ...extra
})

const tick = (ms = 10): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error('condition not met'); await tick(2) }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'remote-jobs-detached-'))
  ids = 0
  fake = new FakeNodes()
  node = new FakeDetachedNode()
  fake.handler = (command, run) => {
    if (node.handle(command, run)) return
    if (command.includes('kv hostname')) { run.stdout('os=Darwin\narch=arm64\n'); run.end(0); return }
    run.end(0)
  }
  makeService().registerNode({ id: 'mac-mini', ssh: { host: 'jurajs-mac-mini', user: 'juraj', identityFile: 'k' } })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('detached shell pieces', () => {
  it('the launcher hands the supervisor to nohup in its own process group and leaves state for followers', () => {
    const line = buildLaunchCommand({ jobId: 'rj_1', cwd: 'work/x', timeoutSec: 90, command: 'npm test', nonce: 'abc' })
    expect(shellWords(line)).toEqual(['/bin/bash', '-c', DETACHED_LAUNCHER, 'conductor-launch', 'rj_1', 'work/x', '90', 'npm test', 'abc', DETACHED_SUPERVISOR])
    expect(DETACHED_LAUNCHER).toContain('set -m\nnohup /bin/bash -c "$supervisor"')
    expect(DETACHED_LAUNCHER).toContain('</dev/null >/dev/null 2>"$state/supervisor.log" &')
    expect(DETACHED_LAUNCHER).toContain('pwd -P >"$state/cwd"')
    expect(DETACHED_SUPERVISOR).toContain(`trap '' HUP PIPE`)
    expect(DETACHED_SUPERVISOR).toContain('kill -TERM -"$pid"')
    expect(DETACHED_SUPERVISOR).toContain('if [ -e "$state/cancel" ]; then reason=cancelled')
    // The exit file appears whole, after the output is complete.
    expect(DETACHED_SUPERVISOR).toContain('mv "$state/exit.tmp" "$state/exit"')
    // No JavaScript interpolation leaked into the bash.
    for (const script of [DETACHED_LAUNCHER, DETACHED_SUPERVISOR, DETACHED_FOLLOW]) expect(script).not.toMatch(/undefined|\[object/)
  })

  it('follow commands carry offsets and the cancel flag; a bad job id is refused', () => {
    const words = shellWords(buildFollowCommand({ jobId: 'rj_9', stdoutOffset: 1200, stderrOffset: 7, maxSeconds: 300, nonce: 'n', cancel: true }))
    expect(words.slice(3)).toEqual(['conductor-follow', 'rj_9', '1200', '7', '300', 'n', '1'])
    expect(DETACHED_FOLLOW).toContain('tail -c +$((out + 1)) "$s/stdout" | head -c "$lo"')
    expect(() => buildFollowCommand({ jobId: 'x; rm -rf ~', stdoutOffset: 0, stderrOffset: 0, maxSeconds: 1, nonce: 'n', cancel: false })).toThrow(/job id/)
  })

  it('frames come back out of any chunking, binary and multi-byte output included', () => {
    const tag = '@@conductor-job:z1 '
    const out = Buffer.from('héllo\n')
    const err = Buffer.from([0xff, 0x00, 0x0a])
    const stream = Buffer.concat([
      Buffer.from('motd noise\n'),
      Buffer.from(`${tag}frame out=${out.length} err=${err.length} pid=42 alive=1 exit=- reason=-\n`), out, err,
      Buffer.from(`${tag}frame out=0 err=0 pid=42 alive=0 exit=3 reason=timeout\n`),
      Buffer.from(`${tag}gone\n`)
    ])
    const reader = new FrameReader('z1')
    const events = [...stream].flatMap(byte => reader.push(Buffer.from([byte])))
    expect(events).toEqual([
      { kind: 'frame', stdout: out, stderr: err, pid: 42, alive: true, exit: null, reason: null },
      { kind: 'frame', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 42, alive: false, exit: 3, reason: 'timeout' },
      { kind: 'gone' }
    ])
  })

  it('utf8Boundary never splits a character', () => {
    const text = Buffer.from('a€b😀')
    expect(utf8Boundary(text.subarray(0, 2))).toBe(1)
    expect(utf8Boundary(text.subarray(0, 4))).toBe(4)
    expect(utf8Boundary(text.subarray(0, 7))).toBe(5)
    expect(utf8Boundary(text)).toBe(text.length)
  })
})

describe('detached jobs', () => {
  it('launch once, stream output, survive a dropped connection, end with the exit code and clear the node', async () => {
    const service = makeService()
    const job = await service.submit({ command: 'npx playwright test', nodeId: 'mac-mini', detached: true, timeoutSec: 3600 })
    expect(job.detached).toBe(true)
    await until(() => node.openSessions === 1)
    expect(service.getJob(job.id)).toMatchObject({ status: 'running', remotePid: 100 })
    node.output(job.id, 'stdout', 'Running 412 tests\n')
    node.output(job.id, 'stderr', 'warn\n')
    await until(() => service.readLog(job.id, 'stdout').text.includes('412'))
    // The network drops (this machine slept): the job runs on, and the follower comes back.
    node.dropConnections()
    node.output(job.id, 'stdout', '  ok 1 login\n')
    await until(() => node.openSessions === 1)
    node.output(job.id, 'stdout', '412 passed\n')
    node.exit(job.id, 0)
    const done = await service.wait(job.id, 2000)
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, detail: null, stdoutBytes: 42, stderrBytes: 5 })
    expect(readFileSync(join(root, 'jobs', job.id, 'stdout.log'), 'utf8')).toBe('Running 412 tests\n  ok 1 login\n412 passed\n')
    expect(node.launches).toEqual([job.id])
    // The reconnect asked only for what was not here yet.
    expect(node.follows.map(follow => follow.stdoutOffset)).toEqual([0, 18])
    expect(node.cleaned).toEqual([job.id])
  })

  it('a Conductor restart leaves it running on the node; the next start reattaches from the bytes it has', async () => {
    const first = makeService()
    const job = await first.submit({ command: 'npm run test:e2e', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    node.output(job.id, 'stdout', 'part one\n')
    await until(() => first.readLog(job.id, 'stdout').size === 9)
    await first.shutdown(500)
    expect(node.openSessions).toBe(0)
    expect(node.cancels).toEqual([])
    expect(first.getJob(job.id)).toMatchObject({ status: 'running', stdoutBytes: 9 })
    // While Conductor is down the job keeps writing.
    node.output(job.id, 'stdout', 'part two\n')
    const second = makeService({ isAlive: () => false })
    const recovered = await second.recover()
    expect(recovered).toEqual([expect.objectContaining({ id: job.id, status: 'running', runnerPid: process.pid })])
    await until(() => node.openSessions === 1)
    expect(node.follows.at(-1)).toMatchObject({ stdoutOffset: 9 })
    node.exit(job.id, 1)
    expect(await second.wait(job.id, 2000)).toMatchObject({ status: 'failed', exitCode: 1, detail: 'Exited with code 1.' })
    expect(readFileSync(join(root, 'jobs', job.id, 'stdout.log'), 'utf8')).toBe('part one\npart two\n')
  })

  it('cancel reconnects with the cancel flag and the node stops the group', async () => {
    const service = makeService()
    const job = await service.submit({ command: 'sleep 999', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    await service.cancel(job.id, 'owner changed their mind')
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'cancelled', cancelReason: 'owner changed their mind', exitCode: 143 })
    expect(node.cancels).toEqual([job.id])
    expect(node.follows.at(-1)).toMatchObject({ cancel: true })
  })

  it('another process can cancel it: the node takes the cancel and the runner records the end', async () => {
    const runner = makeService()
    const job = await runner.submit({ command: 'sleep 999', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    const other = makeService({ isAlive: () => true })
    store(job.id, { runnerPid: 999_999 })
    await other.cancel(job.id, 'from the script')
    expect(node.cancels).toEqual([job.id])
    expect(await runner.wait(job.id, 2000)).toMatchObject({ status: 'cancelled', cancelReason: 'cancelled on the node' })
  })

  it('a cancel asked for while the node is unreachable survives a restart and is delivered on reattach', async () => {
    const first = makeService()
    const job = await first.submit({ command: 'sleep 999', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    node.unreachable = true
    node.dropConnections()
    await first.cancel(job.id, 'stop it')
    await tick(30)
    await first.shutdown(500)
    expect(first.getJob(job.id)).toMatchObject({ status: 'running', cancelReason: 'stop it' })
    expect(first.getJob(job.id).cancelRequestedAt).toBeTruthy()
    expect(node.cancels).toEqual([])
    node.unreachable = false
    const second = makeService({ isAlive: () => false })
    await second.recover()
    expect(await second.wait(job.id, 2000)).toMatchObject({ status: 'cancelled', cancelReason: 'stop it' })
    expect(node.cancels).toEqual([job.id])
  })

  it('keeps trying while the node sleeps, and is lost only long past its deadline', async () => {
    const service = makeService({ detachedGraceMs: 40 })
    const job = await service.submit({ command: 'x', nodeId: 'mac-mini', detached: true, timeoutSec: 1 })
    await until(() => node.openSessions === 1)
    node.unreachable = true
    node.dropConnections()
    await tick(30)
    expect(service.getJob(job.id).status).toBe('running')
    expect(service.getNode('mac-mini').status).toBe('offline')
    const done = await service.wait(job.id, 3000)
    expect(done.status).toBe('lost')
    expect(done.detail).toMatch(/No contact with mac-mini/)
  })

  it('a node that came back without the job (rebooted, state gone) makes it lost, never hung', async () => {
    const service = makeService()
    const first = await service.submit({ command: 'x', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    node.die(first.id)
    expect(await service.wait(first.id, 2000)).toMatchObject({ status: 'lost', detail: expect.stringMatching(/before it reported an exit code/) })
    const second = await service.submit({ command: 'y', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    node.dropConnections()
    node.jobs.delete(second.id)
    expect(await service.wait(second.id, 2000)).toMatchObject({ status: 'lost', detail: expect.stringMatching(/no record of it/) })
  })

  it('the node\'s deadline ends it as timed out; a missing working directory fails at launch', async () => {
    const service = makeService()
    const job = await service.submit({ command: 'sleep 999', nodeId: 'mac-mini', detached: true, timeoutSec: 5 })
    await until(() => node.openSessions === 1)
    expect(node.jobs.get(job.id)?.timeoutSec).toBe(5)
    node.exit(job.id, 143, 'timeout')
    expect(await service.wait(job.id, 2000)).toMatchObject({ status: 'timed-out', exitCode: 143 })
    const lost = await service.submit({ command: 'ls', nodeId: 'mac-mini', detached: true, cwd: 'nowhere' })
    expect(await service.wait(lost.id, 2000)).toMatchObject({ status: 'failed', detail: 'The working directory nowhere does not exist on mac-mini.' })
  })

  it('a node that cannot be reached at launch fails the job and asks it to stop anything half-started', async () => {
    const service = makeService()
    node.unreachable = true
    const job = await service.submit({ command: 'x', nodeId: 'mac-mini', detached: true })
    const done = await service.wait(job.id, 2000)
    expect(done.status).toBe('failed')
    expect(done.detail).toMatch(/Could not start it on mac-mini/)
    expect(fake.calls.filter(call => shellWords(call.command)[3] === 'conductor-cancel')).toHaveLength(1)
  })
})

describe('following a log by offset', () => {
  it('returns new bytes from an offset, waits for more, and says when it is done', async () => {
    const service = makeService()
    const job = await service.submit({ command: 'x', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    const empty = await service.readLogFrom(job.id, 'stdout', 0, 1024, 20)
    expect(empty).toMatchObject({ text: '', offset: 0, nextOffset: 0, done: false })
    const waiting = service.readLogFrom(job.id, 'stdout', 0, 1024, 2000)
    node.output(job.id, 'stdout', 'line 1\n')
    expect(await waiting).toMatchObject({ text: 'line 1\n', nextOffset: 7, done: false })
    // A character split across reads waits for its other half.
    node.output(job.id, 'stdout', Buffer.from('€').subarray(0, 1))
    await until(() => service.readLog(job.id, 'stdout').size === 8)
    expect(await service.readLogFrom(job.id, 'stdout', 7, 1024)).toMatchObject({ text: '', nextOffset: 7 })
    node.output(job.id, 'stdout', Buffer.concat([Buffer.from('€').subarray(1), Buffer.from(' end\n')]))
    node.exit(job.id, 0)
    await service.wait(job.id, 2000)
    expect(await service.readLogFrom(job.id, 'stdout', 7, 4)).toMatchObject({ text: '€ ', nextOffset: 11, done: false })
    expect(await service.readLogFrom(job.id, 'stdout', 11, 1024, 5000)).toMatchObject({ text: 'end\n', nextOffset: 15, size: 15, done: true })
    await expect(service.readLogFrom(job.id, 'stdout', 99)).rejects.toThrow(/past the end/)
  })
})

describe('artifacts', () => {
  it('are fetched into the job\'s folder when it ends, with counts and bytes, and only regular files inside it', async () => {
    const service = makeService()
    node.fetch = patterns => ({
      marks: ['missing coverage', 'skipped playwright-report/link', 'packing files=2 bytes=4096'],
      archive: tarGz([
        { name: './playwright-report', type: '5' },
        { name: './playwright-report/index.html', content: '<html>report</html>' },
        { name: `./test-results/${'deep/'.repeat(25)}trace.zip`, content: 'zip' },
        { name: './test-results/escape', type: '2', linkname: '/etc/passwd' },
        { name: '../outside.txt', content: 'no' },
        { name: '/abs.txt', content: 'no' }
      ]),
      ...(patterns.length ? {} : {})
    })
    const artifactsRoot = join(root, 'project', '.conductor-scratch', 'remote-artifacts')
    const job = await service.submit({ command: 'npx playwright test', nodeId: 'mac-mini', detached: true, cwd: 'conductor-node/work/haf-stuff', artifacts: ['playwright-report', 'test-results/', 'coverage'], artifactsRoot })
    expect(job.artifacts).toEqual(['playwright-report', 'test-results', 'coverage'])
    await until(() => node.openSessions === 1)
    node.exit(job.id, 1)
    const done = await service.wait(job.id, 2000) as RemoteJob
    const dir = join(artifactsRoot, job.id)
    expect(done.status).toBe('failed')
    expect(done.artifactFetch).toMatchObject({ dir, files: 2, bytes: 22, missing: ['coverage'], error: null })
    expect(done.artifactFetch!.skipped).toEqual([
      'playwright-report/link (symbolic link or outside the working directory)',
      './test-results/escape (symbolic link)', '../outside.txt (unsafe name)', '/abs.txt (unsafe name)'
    ])
    expect(readFileSync(join(dir, 'playwright-report', 'index.html'), 'utf8')).toBe('<html>report</html>')
    expect(readFileSync(join(dir, 'test-results', ...'deep/'.repeat(25).split('/').filter(Boolean), 'trace.zip'), 'utf8')).toBe('zip')
    expect(existsSync(join(root, 'project', '.conductor-scratch', 'remote-artifacts', 'outside.txt'))).toBe(false)
    expect(node.fetches).toEqual([{ cwd: 'conductor-node/work/haf-stuff', cap: 512 * 1024 * 1024, patterns: ['playwright-report', 'test-results', 'coverage'] }])
    // Fetched before the node's state is cleared.
    expect(node.cleaned).toEqual([job.id])
  })

  it('an attached job fetches them too; a refusal for size is reported and fails nothing', async () => {
    fake.handler = (command, run) => {
      if (node.handle(command, run)) return
      const spec = FakeNodes.job(command)
      if (spec) { run.mark('started pid=1'); run.mark('exit=0'); run.end(0); return }
      run.end(0)
    }
    node.fetch = () => ({ marks: ['too-large bytes=999999999999'], code: 4 })
    const service = makeService()
    const job = await service.submit({ command: 'make', nodeId: 'mac-mini', artifacts: ['out'], artifactsRoot: join(root, 'a') })
    const done = await service.wait(job.id, 2000)
    expect(done.status).toBe('succeeded')
    expect(done.artifactFetch).toMatchObject({ files: 0, error: expect.stringMatching(/over the 536870912-byte cap/) })
  })

  it('nodes.fetch brings back more on demand, and the local cap stops an archive that grows past it', async () => {
    const service = makeService({ artifactCapBytes: 1000 })
    const job = await service.submit({ command: 'x', nodeId: 'mac-mini', detached: true })
    await until(() => node.openSessions === 1)
    node.fetch = () => ({ marks: ['packing files=1 bytes=4'], archive: tarGz([{ name: './notes.txt', content: 'hi' }]) })
    const small = await service.fetchArtifacts(job.id, ['notes.txt'], join(root, 'f1'))
    expect(small).toMatchObject({ files: 1, bytes: 2, error: null })
    expect(readFileSync(join(root, 'f1', 'notes.txt'), 'utf8')).toBe('hi')
    node.fetch = () => ({ marks: ['packing files=1 bytes=4'], archive: tarGz([{ name: './big.bin', content: Buffer.alloc(5000, 7) }]) })
    const big = await service.fetchArtifacts(job.id, ['big.bin'], join(root, 'f2'))
    expect(big.error).toMatch(/larger than 1000 bytes/)
    node.fetch = () => ({ marks: ['error=cwd'], code: 3 })
    expect((await service.fetchArtifacts(job.id, ['x'], join(root, 'f3'))).error).toMatch(/working directory .* is gone/)
    await expect(service.fetchArtifacts(job.id, ['../etc'], join(root, 'f4'))).rejects.toThrow(/may not contain \.\./)
    node.exit(job.id, 0)
    await service.wait(job.id, 2000)
  })

  it('refuses artifact paths that could leave the working directory', async () => {
    const service = makeService()
    for (const bad of ['/etc/passwd', '~/secrets', 'a/../../b', 'C:/x', 'a\\b', '']) {
      await expect(service.submit({ command: 'x', nodeId: 'mac-mini', artifacts: [bad], artifactsRoot: root })).rejects.toThrow(/artifact/)
    }
    await expect(service.submit({ command: 'x', nodeId: 'mac-mini', artifacts: ['ok'] })).rejects.toThrow(/folder on this machine/)
  })
})

function store(id: string, patch: Partial<RemoteJob>): void {
  const records = new RemoteJobStore(root)
  records.saveJob({ ...records.getJob(id)!, ...patch })
}
