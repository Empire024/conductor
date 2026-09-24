import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuntimeHostClient, type RuntimeListener } from './client'
import { RuntimeHost } from './host'
import { runtimeHostPipe, type FrameStream } from './protocol'

/** A fake runtime: echoes each stdin line as {echo}, counts with {tick} on request, exits on {quit}. */
const FAKE = `
const readline = require('node:readline')
process.stdout.write(JSON.stringify({ ready: true }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.quit) process.exit(message.quit)
  if (message.ticks) { let n = 0; const timer = setInterval(() => { process.stdout.write(JSON.stringify({ tick: ++n }) + '\\n'); if (n === message.ticks) { clearInterval(timer); if (message.thenExit) process.exit(0) } }, message.every ?? 5); return }
  if (message.stderr) { process.stderr.write(message.stderr); return }
  process.stdout.write(JSON.stringify({ echo: message }) + '\\n')
})`

interface Recorded { seq: number; stream: FrameStream; data: string }
const recorder = (): RuntimeListener & { frames: Recorded[]; exits: Array<{ seq: number; code: number | null }>; next(predicate: (frame: Recorded) => boolean): Promise<Recorded>; exited(): Promise<void> } => {
  const frames: Recorded[] = [], exits: Array<{ seq: number; code: number | null }> = []
  const waiters: Array<() => void> = []
  const wake = (): void => { for (const waiter of waiters.splice(0)) waiter() }
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 50) })
    }
  }
  return {
    frames, exits,
    frame(seq, stream, data) { frames.push({ seq, stream, data }); wake() },
    exit(seq, code) { exits.push({ seq, code }); wake() },
    async next(predicate) { await until(() => frames.some(predicate)); return frames.find(predicate)! },
    async exited() { await until(() => exits.length > 0) }
  }
}

describe('runtime host', () => {
  let directory: string, fake: string, host: RuntimeHost, pipe: string, secret: string
  const clients: RuntimeHostClient[] = []
  const connect = async (): Promise<RuntimeHostClient> => { const client = await RuntimeHostClient.connect(pipe, secret); clients.push(client); return client }
  const spawnFake = (client: RuntimeHostClient, runtimeId: string, listener: RuntimeListener): Promise<{ pid: number | null }> =>
    client.spawn({ runtimeId, executable: process.execPath, args: [fake], cwd: directory, meta: { agentSessionId: 'agent-1', provider: 'claude' } }, listener)

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'runtime-host-'))
    fake = join(directory, 'fake-runtime.cjs')
    writeFileSync(fake, FAKE)
    pipe = runtimeHostPipe(join(directory, randomUUID()))
    secret = randomBytes(16).toString('hex')
    host = new RuntimeHost({ pipe, secret, bufferFrames: 40 })
    await host.listen()
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose()
    await host.close()
    await new Promise(resolve => setTimeout(resolve, 200))
    rmSync(directory, { recursive: true, force: true })
  })

  it('refuses a client without the secret', async () => {
    await expect(RuntimeHostClient.connect(pipe, 'wrong', 1000)).rejects.toThrow()
  })

  it('moves whole lines both ways with monotonic sequence numbers', async () => {
    const client = await connect(), listener = recorder()
    const { pid } = await spawnFake(client, 'rt-1', listener)
    expect(pid).toBeGreaterThan(0)
    await listener.next(frame => frame.data.includes('ready'))
    client.send('rt-1', JSON.stringify({ hello: 'wörld' }))
    client.send('rt-1', JSON.stringify({ stderr: 'diagnostic' }))
    const echo = await listener.next(frame => frame.data.includes('echo'))
    expect(JSON.parse(echo.data)).toEqual({ echo: { hello: 'wörld' } })
    await listener.next(frame => frame.stream === 'stderr')
    expect(listener.frames.map(frame => frame.seq)).toEqual(listener.frames.map((_, index) => index + 1))
    client.send('rt-1', JSON.stringify({ quit: 3 }))
    await listener.exited()
    expect(listener.exits[0]).toEqual({ seq: listener.frames.length + 1, code: 3 })
  })

  it('keeps a detached runtime running and replays what it said while nobody listened', async () => {
    const first = await connect(), before = recorder()
    await spawnFake(first, 'rt-2', before)
    await before.next(frame => frame.data.includes('ready'))
    const handled = before.frames.at(-1)!.seq
    await first.detach('rt-2', handled, { title: 'Wizard' })
    // The app is gone: the runtime keeps talking to nobody.
    first.dispose()
    const listing = await connect()
    const [info] = await listing.list()
    expect(info).toMatchObject({ runtimeId: 'rt-2', alive: true, detached: true, attached: false, meta: { agentSessionId: 'agent-1', title: 'Wizard' } })
    listing.dispose()

    const second = await connect(), after = recorder()
    const attached = await second.attach('rt-2', handled, after)
    expect(attached).toMatchObject({ replayed: 0, missing: 0, alive: true })
    second.send('rt-2', JSON.stringify({ ticks: 5 }))
    await after.next(frame => frame.data === JSON.stringify({ tick: 5 }))
    const seqs = after.frames.map(frame => frame.seq)
    expect(seqs[0]).toBe(handled + 1)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('buffers frames produced between detach and reattach, in order, without duplicates', async () => {
    const first = await connect(), before = recorder()
    await spawnFake(first, 'rt-3', before)
    await before.next(frame => frame.data.includes('ready'))
    first.send('rt-3', JSON.stringify({ ticks: 10, every: 20 }))
    const midTurn = await before.next(frame => frame.data === JSON.stringify({ tick: 2 }))
    await first.detach('rt-3', midTurn.seq)
    first.dispose()
    await new Promise(resolve => setTimeout(resolve, 400))

    const second = await connect(), after = recorder()
    await second.attach('rt-3', midTurn.seq, after)
    await after.next(frame => frame.data === JSON.stringify({ tick: 10 }))
    const ticks = [...before.frames.filter(frame => frame.seq <= midTurn.seq), ...after.frames].filter(frame => frame.data.includes('tick')).map(frame => JSON.parse(frame.data).tick)
    expect(ticks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(after.frames[0]!.seq).toBe(midTurn.seq + 1)
  })

  it('replays an exit that happened while detached, then forgets the runtime once acknowledged', async () => {
    const first = await connect(), before = recorder()
    await spawnFake(first, 'rt-4', before)
    await before.next(frame => frame.data.includes('ready'))
    first.send('rt-4', JSON.stringify({ ticks: 3, thenExit: true }))
    await first.detach('rt-4', before.frames.at(-1)!.seq)
    first.dispose()
    await new Promise(resolve => setTimeout(resolve, 400))
    const second = await connect(), after = recorder()
    const attached = await second.attach('rt-4', 1, after)
    expect(attached.alive).toBe(false)
    await after.exited()
    expect(after.frames.filter(frame => frame.data.includes('tick'))).toHaveLength(3)
    second.ack('rt-4', after.exits[0]!.seq)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await second.list()).toEqual([])
  })

  it('reports frames it had to drop when the buffer overflowed', async () => {
    const first = await connect(), before = recorder()
    await spawnFake(first, 'rt-5', before)
    await before.next(frame => frame.data.includes('ready'))
    const handled = before.frames.at(-1)!.seq
    first.send('rt-5', JSON.stringify({ ticks: 60, every: 1 }))
    await first.detach('rt-5', handled)
    first.dispose()
    const second = await connect()
    const deadline = Date.now() + 10_000
    while ((await second.list())[0]!.lastSeq < handled + 60 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    const after = recorder()
    const attached = await second.attach('rt-5', handled, after)
    expect(attached.missing).toBe(20)
    expect(after.frames).toHaveLength(40)
    expect((await second.list())[0]!.lostFrames).toBe(20)
  })

  it('closes the runtimes of a client that goes away without detaching', async () => {
    const first = await connect(), listener = recorder()
    await spawnFake(first, 'rt-6', listener)
    await listener.next(frame => frame.data.includes('ready'))
    first.dispose()
    const second = await connect()
    const deadline = Date.now() + 10_000
    while ((await second.list()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(await second.list()).toEqual([])
  })

  it('refuses a second owner while the first is attached, and closes on request', async () => {
    const first = await connect(), listener = recorder()
    await spawnFake(first, 'rt-7', listener)
    const second = await connect()
    await expect(second.attach('rt-7', 0, recorder())).rejects.toThrow(/another client/)
    first.close('rt-7')
    await listener.exited()
  })

  it('exits by itself once nothing is alive and nobody is connected', async () => {
    let idled = false
    const idlePipe = runtimeHostPipe(join(directory, randomUUID()))
    const idleHost = new RuntimeHost({ pipe: idlePipe, secret, idleMs: 200, onIdle: () => { idled = true } })
    await idleHost.listen()
    const client = await RuntimeHostClient.connect(idlePipe, secret)
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(idled).toBe(false)
    client.dispose()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(idled).toBe(true)
  })
})
