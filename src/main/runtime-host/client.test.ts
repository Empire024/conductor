import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuntimeHostClient } from './client'
import { runtimeHostPipe } from './protocol'

/** A runtime host stand-in in its own process, so it keeps answering while this thread is blocked
 *  (the real host is a separate process too). It answers every request at once, except attaches
 *  of a runtime named silent-* (never) and late-* (after 800 ms), and reports each request it
 *  read on stdout. */
const FAKE_HOST = `
const { createServer } = require('node:net')
const [pipe, secret] = process.argv.slice(2)
createServer(socket => {
  let pending = ''
  const reply = (id, value) => socket.write(JSON.stringify({ op: 'result', id, ok: true, value }) + '\\n')
  socket.on('data', chunk => {
    pending += chunk
    let end
    while ((end = pending.indexOf('\\n')) >= 0) {
      const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
      process.stdout.write(JSON.stringify({ op: request.op, runtimeId: request.runtimeId }) + '\\n')
      if (request.op === 'hello') { if (request.secret === secret) reply(request.id, { pid: process.pid, features: [] }); continue }
      if (request.op === 'attach' && request.runtimeId.startsWith('silent-')) continue
      const value = request.op === 'attach' ? { lastSeq: 3, replayed: 0, missing: 0, alive: true } : undefined
      if (request.op === 'attach' && request.runtimeId.startsWith('late-')) setTimeout(() => reply(request.id, value), 800)
      else if (request.id !== undefined) reply(request.id, value)
    }
  })
  socket.on('error', () => {})
}).listen(pipe, () => process.stdout.write(JSON.stringify({ op: 'listening' }) + '\\n'))
`

/** What a stalled main thread does: nothing else runs until it returns. */
const block = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* stalled */ } }
const listener = { frame: () => {}, exit: () => {} }

describe('runtime host client under a stalled event loop (FX33)', () => {
  let root: string, pipe: string, secret: string, host: ChildProcess, seen: Array<{ op: string; runtimeId?: string }>
  const clients: RuntimeHostClient[] = []
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'conductor-host-client-'))
    const script = join(root, 'fake-host.cjs')
    writeFileSync(script, FAKE_HOST)
    pipe = runtimeHostPipe(join(root, randomUUID()))
    secret = randomBytes(16).toString('hex')
    seen = []
    host = spawn(process.execPath, [script, pipe, secret], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    let buffer = ''
    await new Promise<void>(resolve => host.stdout!.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const entry = JSON.parse(buffer.slice(0, end)) as { op: string; runtimeId?: string }
        buffer = buffer.slice(end + 1)
        if (entry.op === 'listening') resolve(); else seen.push(entry)
      }
    }))
  })
  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose()
    host.kill()
    rmSync(root, { recursive: true, force: true })
  })
  const connect = async (): Promise<RuntimeHostClient> => { const client = await RuntimeHostClient.connect(pipe, secret); clients.push(client); return client }

  it('takes an answer the host sent while this thread was blocked, although the timer fired late', async () => {
    const client = await connect()
    const attached = client.attach('kept-1', 0, listener, 300)
    // The request leaves, the host answers at once, and this thread does not look for 2 s: when
    // it runs again the expired timer comes before the pipe is read.
    block(2000)
    await expect(attached).resolves.toMatchObject({ alive: true })
  })

  it('times attaches queued behind a write in flight from when they leave, not from when they were queued', async () => {
    const client = await connect()
    // Seven reattaches in one go, then a stall: on 2026-09-25 they reached the host 71 s after
    // they were queued and every one timed out with its answer unread.
    const attaches = Array.from({ length: 7 }, (_, index) => client.attach(`kept-${index}`, index, listener, 300))
    block(2000)
    const results = await Promise.allSettled(attaches)
    expect(results.map(result => result.status)).toEqual(Array(7).fill('fulfilled'))
  })

  it('still gives up on a host that never answers, and then never closes that runtime itself', async () => {
    const client = await connect()
    await expect(client.attach('silent-1', 4, listener, 200)).rejects.toThrow('Runtime host did not answer attach')
    client.close('silent-1')
    await client.list()
    expect(seen.filter(entry => entry.runtimeId === 'silent-1').map(entry => entry.op)).toEqual(['attach'])
  })

  it('lets go of a runtime the host attached after this process stopped waiting, instead of closing it', async () => {
    const client = await connect()
    await expect(client.attach('late-1', 9, listener, 200)).rejects.toThrow('Runtime host did not answer attach')
    client.close('late-1')
    await new Promise(resolve => setTimeout(resolve, 1200))
    await client.list()
    expect(seen.filter(entry => entry.runtimeId === 'late-1').map(entry => entry.op)).toEqual(['attach', 'detach'])
  })
})
