import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync, writeSync, type BigIntStats } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { captureClaudeCliToolCalls, claudeHistoryBoundary, claudeHistoryPath, type CaptureFs, type ClaudeHistoryBoundary } from './native-history'

/**
 * captureClaudeCliToolCalls against a transcript that changes WHILE it is being read
 * (docs/perf-evidence/t3code-cli-read-stability.md). An open handle does not lock a file: another
 * process can truncate or rewrite the same inode at any moment. Real files in a temp directory, with
 * async handles wrapped so that a write, a truncation or a short read lands at a chosen read or stat
 * of the capture, which is sequential and so deterministic. No CLI, model, Electron or timer.
 */
const T0 = Date.parse('2026-10-30T10:00:00.000Z')
const stamp = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()
const SECRET = 'SECRET-ROW-TEXT-4711'
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const NATIVE = 'native-conversation'
const callRows = (tag: string, at: number, ms: number, options: { sessionId?: string; command?: string; remoteSourced?: boolean } = {}) => [
  JSON.stringify({ type: 'assistant', uuid: 'a-' + tag, sessionId: options.sessionId ?? NATIVE, ...(options.remoteSourced ? { remoteSourced: true } : {}), timestamp: stamp(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + tag, name: 'Bash', input: { command: options.command ?? 'npm test' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'r-' + tag, sessionId: options.sessionId ?? NATIVE, ...(options.remoteSourced ? { remoteSourced: true } : {}), timestamp: stamp(at + ms), sourceToolAssistantUUID: 'a-' + tag, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + tag, content: 'ok', is_error: false }] } })
]
const call = (tag: string, at: number, ms: number, options?: Parameters<typeof callRows>[3]) => callRows(tag, at, ms, options).join('\n') + '\n'
const filler = (bytes: number) => { const line = JSON.stringify({ type: 'summary', sessionId: NATIVE, summary: 'f'.repeat(900) }) + '\n'; return line.repeat(Math.ceil(bytes / line.length)) }

/** A transcript holding the handoff's rows (longer than a fingerprint window, so its two ends differ), its boundary, and the CLI's own rows appended after. */
async function transcript(cli: string) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-read-stability-')); roots.push(root)
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'profile'))
  const cwd = join(root, 'workspace')
  const path = claudeHistoryPath(cwd, NATIVE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, call('chat', 0, 2_000, { command: 'echo ' + SECRET }) + filler(9_000))
  const boundary = (await claudeHistoryBoundary(cwd, NATIVE))!
  expect(boundary.bytes).toBe(statSync(path).size)
  appendFileSync(path, cli)
  return { cwd, path, boundary, handoff: { claudeBoundary: boundary as ClaudeHistoryBoundary } }
}

interface Hooks {
  /** Runs before the nth read of the capture's handle. For a boundary of bytes > 0: 0 = head hash, 1 = tail hash, 2 = the window. */
  beforeRead?(n: number, position: number, length: number): void
  afterRead?(n: number, position: number, length: number): void
  /** The most bytes the nth read may return (0 = the file ends there); the file itself is untouched. */
  serve?(n: number, position: number, length: number): number
  /** Runs after the nth fstat of the handle (0 = first, 1 = after the fingerprints, 2 = after the window read, 3 = after an append was seen) and may replace what it reports. */
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
          const cap = hooks.serve?.(n, position, length) ?? length
          const result = cap <= 0 ? { bytesRead: 0, buffer } : await real.read(buffer, offset, Math.min(length, cap), position)
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
/** Pushes the modification time well away from the original, so a same-size rewrite is distinguishable on a coarse-clock file system. */
const touch = (path: string) => utimesSync(path, new Date(), new Date(Date.now() + 60_000))
/** Same length, different bytes, at `position`: a rewrite in place that no size check can see. */
function rewriteInPlace(path: string, position: number, bytes: string) {
  const fd = openSync(path, 'r+'); try { writeSync(fd, bytes, position) } finally { closeSync(fd) }
  touch(path)
}
const ids = (tools: Array<{ toolUseId: string }>) => tools.map(tool => tool.toolUseId).sort()

describe('Claude CLI-view capture stays true when the transcript changes while it is read', () => {
  const own = () => call('cli', 60_000, 1_250, { command: 'git status' })

  it('control: an unchanged transcript is complete, exact, bounded by the boundary and says nothing of the rows\' text', async () => {
    const t = await transcript(own() + call('other', 70_000, 500, { sessionId: 'another-conversation' }) + call('copied', 71_000, 500, { remoteSourced: true }))
    const io = instrumented()
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(ids(tools)).toEqual(['toolu_cli'])
    expect(tools[0]).toMatchObject({ usedAt: stamp(60_000), resultAt: stamp(61_250) })
    const size = statSync(t.path).size
    expect(coverage).toEqual({ status: 'complete', reason: 'complete', boundaryBytes: t.boundary.bytes, fileBytes: size, bytesRead: size - t.boundary.bytes, bytesSkipped: 0, unmatchedCalls: 0, unpairedResults: 0, droppedCalls: 0 })
    expect(JSON.stringify(coverage)).not.toContain(SECRET)
    expect(JSON.stringify(t.boundary)).not.toContain(SECRET)
    // Only the two fingerprint windows and the appended rows were read: the handoff's prefix is not.
    expect(io.requested.reduce((sum, read) => sum + read.length, 0)).toBe(2 * 4096 + (size - t.boundary.bytes))
  })

  it('a read served in short pieces that still reach the end is the whole read, not a short one', async () => {
    const t = await transcript(own())
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented({ serve: (n, _p, length) => n >= 2 ? Math.min(length, 7) : length }).fs)
    expect(ids(tools)).toEqual(['toolu_cli'])
    expect(coverage).toMatchObject({ status: 'complete', reason: 'complete' })
  })

  it('imports nothing when the file is truncated after the boundary was verified and before its rows are read', async () => {
    const t = await transcript(own())
    // The file ends 40 bytes into the CLI's rows: the window read comes back short of the size it was told.
    const io = instrumented({ beforeRead: n => { if (n === 2) truncateSync(t.path, t.boundary.bytes + 40) } })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(tools).toEqual([])
    expect(coverage).toMatchObject({ status: 'unavailable', reason: 'file-shrank', boundaryBytes: t.boundary.bytes, fileBytes: t.boundary.bytes + 40, unmatchedCalls: 0, unpairedResults: 0 })
  })

  it('imports nothing when the file ends before the size it was told, even though nothing wrote to it', async () => {
    const t = await transcript(own())
    const io = instrumented({ serve: (n, _p, length) => n === 2 ? Math.floor(length / 2) : n > 2 ? 0 : length })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(tools).toEqual([])
    expect(coverage).toMatchObject({ status: 'unavailable', reason: 'file-shrank' })
  })

  it('imports nothing when the file is truncated and then rewritten to the same size after verification', async () => {
    const t = await transcript(own())
    const forged = call('cli', 60_000, 99_000, { command: 'git status' })
    expect(forged.length).toBe(own().length)
    // Truncated back to the boundary and refilled with different rows of exactly the original length.
    const io = instrumented({ beforeRead: n => { if (n === 2) { truncateSync(t.path, t.boundary.bytes); appendFileSync(t.path, forged); touch(t.path) } } })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(tools).toEqual([])
    expect(coverage).toMatchObject({ status: 'unavailable', reason: 'file-changed', fileBytes: statSync(t.path).size })
  })

  it('imports nothing when the file is rewritten in place while the window is being read', async () => {
    const t = await transcript(own())
    const io = instrumented({ afterRead: n => { if (n === 2) rewriteInPlace(t.path, t.boundary.bytes + 10, 'X'.repeat(30)) } })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(tools).toEqual([])
    expect(coverage).toMatchObject({ status: 'unavailable', reason: 'file-changed' })
  })

  it('imports nothing when the file changes while the boundary\'s fingerprints are being read', async () => {
    for (const mutate of [
      { name: 'appended', run: (t: { path: string }) => appendFileSync(t.path, call('late', 80_000, 100)), reason: 'file-changed' },
      { name: 'rewritten', run: (t: { path: string; boundary: ClaudeHistoryBoundary }) => rewriteInPlace(t.path, t.boundary.bytes + 5, 'Y'.repeat(20)), reason: 'file-changed' },
      { name: 'truncated into the boundary', run: (t: { path: string; boundary: ClaudeHistoryBoundary }) => truncateSync(t.path, t.boundary.bytes - 100), reason: 'file-shrank' }
    ]) {
      const t = await transcript(own())
      // After the tail hash has been read (read 1), so the hashes themselves still match what was persisted.
      const io = instrumented({ afterRead: n => { if (n === 1) mutate.run(t) } })
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
      expect({ name: mutate.name, tools, status: coverage.status, reason: coverage.reason }).toEqual({ name: mutate.name, tools: [], status: 'unavailable', reason: mutate.reason })
    }
  })

  it('reports a file truncated inside the boundary between its stat and its fingerprint reads as shrunk', async () => {
    const t = await transcript(own())
    const io = instrumented({ beforeRead: n => { if (n === 1) truncateSync(t.path, 1000) } })
    const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
    expect(tools).toEqual([])
    expect(coverage).toMatchObject({ status: 'unavailable', reason: 'file-shrank', fileBytes: 1000 })
  })

  it('imports nothing when the handle reports another file, or the path is renamed over or deleted during the read', async () => {
    const swapped = await transcript(own())
    const other = await captureClaudeCliToolCalls(swapped.cwd, NATIVE, swapped.handoff, {}, instrumented({ afterStat: (n, info) => n === 2 ? { ...info, ino: info.ino + 1n } as BigIntStats : undefined }).fs)
    expect(other.tools).toEqual([])
    expect(other.coverage).toMatchObject({ status: 'unavailable', reason: 'file-replaced' })

    const renamed = await transcript(own())
    const replacement = join(dirname(renamed.path), 'replacement.jsonl')
    writeFileSync(replacement, readFileSync(renamed.path))
    const over = await captureClaudeCliToolCalls(renamed.cwd, NATIVE, renamed.handoff, {}, instrumented({ afterRead: n => { if (n === 2) renameSync(replacement, renamed.path) } }).fs)
    expect(over.tools).toEqual([])
    expect(over.coverage).toMatchObject({ status: 'unavailable', reason: 'file-replaced' })

    const deleted = await transcript(own())
    const gone = await captureClaudeCliToolCalls(deleted.cwd, NATIVE, deleted.handoff, {}, instrumented({ afterRead: n => { if (n === 2) rmSync(deleted.path) } }).fs)
    expect(gone.tools).toEqual([])
    expect(gone.coverage).toMatchObject({ status: 'unavailable', reason: 'file-replaced' })
  })

  describe('rows appended while the capture runs: an explicit bounded snapshot, never a silent whole capture', () => {
    it('keeps the calls up to the size first seen, says partial, shows the unread appended bytes, and drops nothing for the next return', async () => {
      const t = await transcript(own())
      const snapshot = statSync(t.path).size
      const late = call('late', 80_000, 100)
      const io = instrumented({ afterRead: n => { if (n === 2) appendFileSync(t.path, late) } })
      const first = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
      expect(ids(first.tools)).toEqual(['toolu_cli'])
      expect(first.coverage).toEqual({ status: 'partial', reason: 'file-changed', boundaryBytes: t.boundary.bytes, fileBytes: snapshot + late.length, bytesRead: snapshot - t.boundary.bytes, bytesSkipped: 0, unmatchedCalls: 0, unpairedResults: 0, droppedCalls: 0 })
      // The appended rows were counted as unread, not consumed: the same boundary reads them whole next time, once.
      const next = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, { known: first.tools.map(tool => tool.toolUseId) }, instrumented().fs)
      expect(ids(next.tools)).toEqual(['toolu_late'])
      expect(next.coverage).toMatchObject({ status: 'complete', reason: 'complete', fileBytes: snapshot + late.length })
    })

    it('imports nothing when the append also rewrote an end of the window, or of the boundary prefix', async () => {
      for (const where of ['window-start', 'window-end', 'boundary-head', 'boundary-tail'] as const) {
        const t = await transcript(own())
        const position = { 'window-start': t.boundary.bytes + 2, 'window-end': statSync(t.path).size - 12, 'boundary-head': 3, 'boundary-tail': t.boundary.bytes - 5 }[where]
        const io = instrumented({ afterRead: n => { if (n === 2) { rewriteInPlace(t.path, position, 'Z'.repeat(4)); appendFileSync(t.path, call('late', 80_000, 100)) } } })
        const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
        expect({ where, tools, status: coverage.status, reason: coverage.reason }).toEqual({ where, tools: [], status: 'unavailable', reason: 'file-changed' })
      }
    })

    it('imports nothing when the file is truncated after the append was seen', async () => {
      const t = await transcript(own())
      // Read 2 is the window, 3 to 6 the re-check of the four ends; the file is cut after the last of them.
      const io = instrumented({ afterRead: n => { if (n === 2) appendFileSync(t.path, call('late', 80_000, 100)); if (n === 6) truncateSync(t.path, t.boundary.bytes + 20) } })
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, io.fs)
      expect(tools).toEqual([])
      expect(coverage).toMatchObject({ status: 'unavailable', reason: 'file-shrank' })
    })
  })

  describe('a last row its writer had not finished', () => {
    it('is not dropped under complete: the read is partial, the cut-off bytes are unread, and nothing is timed from it', async () => {
      const [use, result] = callRows('cli', 60_000, 1_250, { command: 'git status' })
      const cut = result!.slice(0, 120)
      const t = await transcript(use + '\n' + cut)
      const size = statSync(t.path).size
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented().fs)
      expect(tools).toEqual([])
      expect(coverage).toEqual({ status: 'partial', reason: 'file-changed', boundaryBytes: t.boundary.bytes, fileBytes: size, bytesRead: size - t.boundary.bytes - cut.length, bytesSkipped: 0, unmatchedCalls: 1, unpairedResults: 0, droppedCalls: 0 })
    })

    it('is used when it is a whole row that merely lacks its newline', async () => {
      const [use, result] = callRows('cli', 60_000, 1_250, { command: 'git status' })
      const t = await transcript(use + '\n' + result)
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented().fs)
      expect(ids(tools)).toEqual(['toolu_cli'])
      expect(coverage).toMatchObject({ status: 'complete', reason: 'complete', bytesRead: statSync(t.path).size - t.boundary.bytes })
    })

    it('does not turn skipped, malformed or foreign rows into durations: a newline-terminated bad row is skipped as it always was', async () => {
      const [use] = callRows('cli', 60_000, 1_250, { command: 'git status' })
      const [foreignUse, foreignResult] = callRows('foreign', 61_000, 3_000, { sessionId: 'another-conversation' })
      const t = await transcript(use + '\n' + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_cli" BROKEN\n' + foreignUse + '\n' + foreignResult + '\n')
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, {}, instrumented().fs)
      expect(tools).toEqual([])
      expect(coverage).toMatchObject({ status: 'complete', reason: 'complete', unmatchedCalls: 1, unpairedResults: 0 })
    })
  })

  it('stays bounded: a window smaller than the appended rows reads at most maxBytes of them, partial, and never the prefix', async () => {
    const t = await transcript(own() + filler(20_000))
    const size = statSync(t.path).size
    const io = instrumented()
    const { coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, t.handoff, { maxBytes: 5_000 }, io.fs)
    expect(coverage).toMatchObject({ status: 'partial', reason: 'window-truncated', fileBytes: size, bytesRead: 5_000, bytesSkipped: size - t.boundary.bytes - 5_000 })
    expect(Math.max(...io.requested.map(read => read.length))).toBe(5_000)
    expect(io.requested.reduce((sum, read) => sum + read.length, 0)).toBe(2 * 4096 + 5_000)
  })

  it('opens nothing for a legacy size-only, malformed or missing boundary', async () => {
    const t = await transcript(own())
    for (const handoff of [{ claudeBytes: t.boundary.bytes }, { claudeBytes: -1 }, {}, { claudeBoundary: { bytes: t.boundary.bytes } }, { claudeBoundary: null }]) {
      const io = instrumented()
      const { tools, coverage } = await captureClaudeCliToolCalls(t.cwd, NATIVE, handoff, {}, io.fs)
      expect({ tools, status: coverage.status, opened: io.opened }).toEqual({ tools: [], status: 'unavailable', opened: 0 })
    }
  })
})
