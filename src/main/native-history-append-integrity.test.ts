import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync, writeSync, type BigIntStats } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_CLI_TIMING_BYTES, captureClaudeCliToolCalls, claudeHistoryBoundary, claudeHistoryPath, type CaptureFs } from './native-history'

/**
 * captureClaudeCliToolCalls when rows are APPENDED while it runs (docs/perf-evidence/
 * t3code-cli-append-integrity.md). The earlier stability work kept a snapshot of an appended file
 * after comparing only the two ends of the window; a same-length rewrite strictly inside the window
 * after it was read, with the ends unchanged, was kept as a snapshot of rows the file no longer
 * holds. The whole window, at most MAX_CLI_TIMING_BYTES, is now re-read once and compared before a
 * snapshot is kept. A rewrite made before or while the window is read is not separable from the
 * append by the file's times; the last test documents that limit.
 * Real files in a temp directory with wrapped async handles; a mutation lands at a chosen read of
 * the (sequential, so deterministic) capture. No CLI, model, Electron or timer.
 */
const T0 = Date.parse('2026-10-30T10:00:00.000Z')
const stamp = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()
const NATIVE = 'native-conversation'
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const callRows = (tag: string, at: number, ms: number, options: { sessionId?: string; remoteSourced?: boolean } = {}) => [
  JSON.stringify({ type: 'assistant', uuid: 'a-' + tag, sessionId: options.sessionId ?? NATIVE, ...(options.remoteSourced ? { remoteSourced: true } : {}), timestamp: stamp(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + tag, name: 'Bash', input: { command: 'npm test' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'r-' + tag, sessionId: options.sessionId ?? NATIVE, ...(options.remoteSourced ? { remoteSourced: true } : {}), timestamp: stamp(at + ms), sourceToolAssistantUUID: 'a-' + tag, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + tag, content: 'ok', is_error: false }] } })
]
const call = (tag: string, at: number, ms: number, options?: Parameters<typeof callRows>[3]) => callRows(tag, at, ms, options).join('\n') + '\n'
const filler = (bytes: number) => { const line = JSON.stringify({ type: 'summary', sessionId: NATIVE, summary: 'f'.repeat(900) }) + '\n'; return line.repeat(Math.ceil(bytes / line.length)) }
/** Three calls with other rows between them, so the middle call's rows lie more than a fingerprint window from both ends of the window. */
const spread = () => call('first', 60_000, 1_000) + filler(12_000) + call('middle', 70_000, 2_000) + filler(12_000) + call('last', 80_000, 500)

async function transcript(cli: string) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-append-integrity-')); roots.push(root)
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'profile'))
  const cwd = join(root, 'workspace')
  const path = claudeHistoryPath(cwd, NATIVE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, call('chat', 0, 2_000) + filler(9_000))
  const boundary = (await claudeHistoryBoundary(cwd, NATIVE))!
  appendFileSync(path, cli)
  return { cwd, path, boundary, handoff: { claudeBoundary: boundary } }
}

interface Hooks {
  /** For a boundary of bytes > 0 and a window over 8 KiB: reads 0 and 1 are the boundary's ends, 2 the window, then on a growth 3 and 4 the boundary again, 5 and 6 the window's ends, 7.. its middle. */
  beforeRead?(n: number, position: number, length: number): void
  afterRead?(n: number, position: number, length: number): void
  /** Runs after the nth fstat of the handle (0 first, 1 after the fingerprints, 2 after the window, 3 after the re-check) and may replace what it reports. */
  afterStat?(n: number, info: BigIntStats): BigIntStats | void
}
function instrumented(hooks: Hooks = {}) {
  const requested: Array<{ position: number; length: number }> = []
  let opened = 0
  const fs: CaptureFs = {
    open: async path => {
      opened++
      const real = await open(path, 'r')
      let reads = 0, stats = 0
      return {
        stat: (async (options?: { bigint?: boolean }) => { const info = await real.stat({ bigint: true, ...options }) as BigIntStats; return hooks.afterStat?.(stats++, info) ?? info }) as FileHandle['stat'],
        read: (async (buffer: Buffer, offset: number, length: number, position: number) => {
          const n = reads++
          requested.push({ position, length })
          hooks.beforeRead?.(n, position, length)
          const result = await real.read(buffer, offset, length, position)
          hooks.afterRead?.(n, position, length)
          return result
        }) as FileHandle['read'],
        close: () => real.close()
      }
    },
    stat: path => stat(path, { bigint: true })
  }
  return { fs, requested, get opened() { return opened } }
}
const touch = (path: string) => utimesSync(path, new Date(), new Date(Date.now() + 60_000))
/** Replaces `from` by `to` (the same length) wherever it first occurs in the file, in place, and moves the modification time. */
function rewrite(path: string, from: string, to: string) {
  expect(to.length).toBe(from.length)
  const at = readFileSync(path).indexOf(from)
  expect(at).toBeGreaterThan(-1)
  const fd = openSync(path, 'r+'); try { writeSync(fd, to, at) } finally { closeSync(fd) }
  touch(path)
  return at
}
const ids = (tools: Array<{ toolUseId: string }>) => tools.map(tool => tool.toolUseId).sort()
const late = () => call('late', 200_000, 100)

describe('Claude CLI-view capture of a transcript that grows while it is read', () => {
  it('keeps no snapshot of a window whose middle was rewritten after it was read as rows were appended, the ends unchanged', async () => {
    const t = await transcript(spread())
    const size = statSync(t.path).size
    const window = size - t.boundary.bytes
    expect(window).toBeGreaterThan(8192 + 2 * 4096)
    // The middle call's result time, 2.000 s after its call, becomes 59.000 s: same length, far from both ends of the window.
    const at = readFileSync(t.path).indexOf(stamp(72_000))
    expect(at - t.boundary.bytes).toBeGreaterThan(4096)
    expect(size - at).toBeGreaterThan(4096)
    const io = instrumented({ afterRead: n => { if (n === 2) { rewrite(t.path, stamp(72_000), stamp(129_000)); appendFileSync(t.path, late()) } } })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(tools).toEqual([])
    expect(coverage).toMatchObject({ status: 'unavailable', reason: 'file-changed', boundaryBytes: t.boundary.bytes })
    expect(coverage.bytesRead).toBe(0)
  })

  it('keeps no snapshot when the rewritten timestamp is a call\'s use time, or the result time of the first or last call', async () => {
    for (const where of [
      { name: 'use time of the middle call', from: stamp(70_000), to: stamp(71_000) },
      { name: 'result time of the first call', from: stamp(61_000), to: stamp(99_000) },
      { name: 'result time of the last call', from: stamp(80_500), to: stamp(95_500) }
    ]) {
      const t = await transcript(spread())
      const io = instrumented({ afterRead: n => { if (n === 2) { rewrite(t.path, where.from, where.to); appendFileSync(t.path, late()) } } })
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
      expect({ name: where.name, tools, status: coverage.status, reason: coverage.reason }).toEqual({ name: where.name, tools: [], status: 'unavailable', reason: 'file-changed' })
    }
  })

  it('keeps the exact calls of a genuine unchanged append as a partial snapshot, equal to what a quiet capture returned', async () => {
    const t = await transcript(spread())
    const quiet = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented().fs)
    expect(ids(quiet.tools)).toEqual(['toolu_first', 'toolu_last', 'toolu_middle'])
    expect(quiet.coverage).toMatchObject({ status: 'complete', reason: 'complete' })
    const snapshot = statSync(t.path).size
    const appended = late()
    const grown = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented({ afterRead: n => { if (n === 2) appendFileSync(t.path, appended) } }).fs)
    expect(grown.tools).toEqual(quiet.tools)
    expect(grown.coverage).toEqual({ status: 'partial', reason: 'file-changed', boundaryBytes: t.boundary.bytes, fileBytes: snapshot + appended.length, bytesRead: snapshot - t.boundary.bytes, bytesSkipped: 0, unmatchedCalls: 0, unpairedResults: 0, droppedCalls: 0 })
    // The appended rows were counted as unread, not consumed.
    const next = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, { known: quiet.tools.map(tool => tool.toolUseId) }, instrumented().fs)
    expect(ids(next.tools)).toEqual(['toolu_late'])
    expect(next.coverage).toMatchObject({ status: 'complete', reason: 'complete' })
  })

  it('keeps the same exact calls when the append lands in several pieces before the check and the window is only a few bytes over a fingerprint window', async () => {
    const t = await transcript(call('first', 60_000, 1_000) + filler(4_300))
    const quiet = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented().fs)
    const grown = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented({ afterRead: n => { if (n === 2) { appendFileSync(t.path, late()); appendFileSync(t.path, late().replace(/late/g, 'later')) } } }).fs)
    expect(grown.tools).toEqual(quiet.tools)
    expect(grown.coverage).toMatchObject({ status: 'partial', reason: 'file-changed' })
  })

  describe('a mutation while the window is being re-verified', () => {
    const mutations: Array<{ name: string; after: number; run(t: { path: string; boundary: { bytes: number } }): void; reason: string }> = [
      { name: 'more rows appended', after: 4, run: t => appendFileSync(t.path, late().replace(/late/g, 'later')), reason: 'file-changed' },
      { name: 'more rows appended after the middle was compared', after: 7, run: t => appendFileSync(t.path, late().replace(/late/g, 'later')), reason: 'file-changed' },
      { name: 'a compared region rewritten in place', after: 7, run: t => rewrite(t.path, stamp(72_000), stamp(129_000)), reason: 'file-changed' },
      { name: 'the file truncated into the window', after: 5, run: t => truncateSync(t.path, t.boundary.bytes + 100), reason: 'file-shrank' }
    ]
    for (const mutation of mutations) {
      it(`${mutation.name} is unavailable, in one pass`, async () => {
        const t = await transcript(spread())
        const window = statSync(t.path).size - t.boundary.bytes
        const io = instrumented({ afterRead: n => { if (n === 2) appendFileSync(t.path, late()); if (n === mutation.after) mutation.run(t) } })
        const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
        expect(tools).toEqual([])
        expect(coverage).toMatchObject({ status: 'unavailable', reason: mutation.reason })
        // No retry: one open, and the reads are the first pass's plus one verification pass, never a second.
        expect(io.opened).toBe(1)
        expect(io.requested.length).toBeLessThanOrEqual(3 + 4 + 1)
        expect(io.requested.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(2 * (2 * 4096 + window))
      })
    }
  })

  it('accounts for every byte it reads: the window once, the same window once more in pieces of at most 64 KiB, and four fingerprint windows', async () => {
    const t = await transcript(call('first', 60_000, 1_000) + filler(200_000) + call('last', 80_000, 500))
    const size = statSync(t.path).size, window = size - t.boundary.bytes
    const io = instrumented({ afterRead: n => { if (n === 2) appendFileSync(t.path, late()) } })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(ids(tools)).toEqual(['toolu_first', 'toolu_last'])
    expect(coverage).toMatchObject({ status: 'partial', reason: 'file-changed', bytesRead: window })
    const [first, second, windowRead, ...verification] = io.requested
    expect([first!.length, second!.length, windowRead!.length]).toEqual([4096, 4096, window])
    expect(verification.slice(0, 4).map(read => read.length)).toEqual([4096, 4096, 4096, 4096])
    const middle = verification.slice(4)
    expect(middle.length).toBeGreaterThan(2)
    expect(Math.max(...middle.map(read => read.length))).toBeLessThanOrEqual(64 * 1024)
    expect(verification.reduce((sum, read) => sum + read.length, 0)).toBe(2 * 4096 + window)
    // Every verified byte is inside the window; the boundary's prefix is only touched at its two fingerprinted ends.
    expect(middle.every(read => read.position >= t.boundary.bytes && read.position + read.length <= size)).toBe(true)
    expect(io.requested.length).toBe(3 + 4 + middle.length)
  })

  it('never reads more than MAX_CLI_TIMING_BYTES of rows however large a window is asked for, nor does it re-read an unchanged window', async () => {
    const t = await transcript(call('first', 60_000, 1_000) + filler(MAX_CLI_TIMING_BYTES + 1024 * 1024) + call('last', 80_000, 500))
    const io = instrumented()
    const { coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, { maxBytes: 2 ** 40 }, io.fs)
    expect(coverage).toMatchObject({ status: 'partial', reason: 'window-truncated', bytesRead: MAX_CLI_TIMING_BYTES })
    expect(Math.max(...io.requested.map(read => read.length))).toBe(MAX_CLI_TIMING_BYTES)
    expect(io.requested.reduce((sum, read) => sum + read.length, 0)).toBe(2 * 4096 + MAX_CLI_TIMING_BYTES)
  })

  it('rejects a same-size rewrite of a row inside the window while it is read, without growth, with both ends unchanged', async () => {
    for (const when of ['during the window read', 'before the window read']) {
      const t = await transcript(spread())
      const run = () => rewrite(t.path, stamp(72_000), stamp(129_000))
      const io = instrumented(when === 'during the window read' ? { afterRead: n => { if (n === 2) run() } } : { beforeRead: n => { if (n === 2) run() } })
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
      expect({ when, tools, status: coverage.status, reason: coverage.reason }).toEqual({ when, tools: [], status: 'unavailable', reason: 'file-changed' })
    }
  })

  it('keeps provenance, calendar and dedup exact in a kept snapshot: other sessions, copied rows and known calls stay out, exact times stay', async () => {
    const t = await transcript(call('known', 10_000, 100) + call('foreign', 20_000, 100, { sessionId: 'another-conversation' }) + call('copied', 30_000, 100, { remoteSourced: true }) + call('mine', 40_000, 7_000) + filler(9_000))
    const grown = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, { known: ['toolu_known'] }, instrumented({ afterRead: n => { if (n === 2) appendFileSync(t.path, late()) } }).fs)
    expect(ids(grown.tools)).toEqual(['toolu_mine'])
    expect(grown.tools[0]).toMatchObject({ usedAt: stamp(40_000), resultAt: stamp(47_000) })
    expect(grown.coverage).toMatchObject({ status: 'partial', reason: 'file-changed' })
  })

  it('does not look at a legacy size-only or malformed boundary at all', async () => {
    const t = await transcript(spread())
    for (const handoff of [{ claudeBytes: t.boundary.bytes }, { claudeBoundary: { bytes: t.boundary.bytes } }]) {
      const io = instrumented()
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, handoff, {}, io.fs)
      expect({ tools, status: coverage.status, opened: io.opened }).toEqual({ tools: [], status: 'unavailable', opened: 0 })
    }
  })

  it('documents the limit under growth: a rewrite made before the window is read is read, because the append moves the times too', async () => {
    const t = await transcript(spread())
    const io = instrumented({ beforeRead: n => { if (n === 2) { rewrite(t.path, stamp(72_000), stamp(129_000)); appendFileSync(t.path, late()) } } })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(coverage).toMatchObject({ status: 'partial', reason: 'file-changed' })
    expect(tools.find(tool => tool.toolUseId === 'toolu_middle')).toMatchObject({ resultAt: stamp(129_000) })
  })

  it('documents the one limit left without growth: a rewrite that keeps size, identity and both times is not seen', async () => {
    const t = await transcript(spread())
    let original: BigIntStats | undefined
    // Before the window is read the row is rewritten, and the file reports the times it had: a clock too coarse to tell two writes apart.
    const io = instrumented({
      beforeRead: n => { if (n === 2) rewrite(t.path, stamp(72_000), stamp(129_000)) },
      afterStat: (n, info) => { if (n === 0) original = info; if (n === 2) return { ...info, mtimeNs: original!.mtimeNs, ctimeNs: original!.ctimeNs } as BigIntStats }
    })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(coverage).toMatchObject({ status: 'complete', reason: 'complete' })
    expect(tools.find(tool => tool.toolUseId === 'toolu_middle')).toMatchObject({ resultAt: stamp(129_000) })
  })
})
