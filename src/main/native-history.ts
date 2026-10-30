import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { AdapterEvent, AgentEventData, Json } from '../shared/structured-agent'
import type { CliCaptureCoverage, CliCaptureReason, TranscriptToolCall } from '../shared/tool-timings'
import { TELEPORT_NOTE, TranscriptToolPairs } from './transcript-tool-pairs'
export interface NativeHistoryItem { id: string; turnId?: string; data: AgentEventData }
export function claudeHistoryPath(cwd: string, nativeId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(nativeId)) throw new Error('Invalid native conversation ID')
  const directory = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', directory, nativeId + '.jsonl')
}
export function hasClaudeHistory(cwd: string, nativeId: string): boolean { return existsSync(claudeHistoryPath(cwd, nativeId)) }
/** Most bytes of a CLI view's own rows read for its tool timings: the newest, from the handoff on. */
export const MAX_CLI_TIMING_BYTES = 16 * 1024 * 1024
/** The conversation transcript's size now: where a CLI view's own rows will start. 0 when it does
 *  not exist yet (a fresh conversation); null when it cannot be read. */
export async function claudeHistorySize(cwd: string, nativeId: string): Promise<number | null> {
  try { return (await stat(claudeHistoryPath(cwd, nativeId))).size } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null }
}

/**
 * Where a CLI view's own rows start, as persisted at the handoff: the transcript's size, its file
 * identity (device and index, where the platform reports one) and a SHA-256 of its first and of its
 * last FINGERPRINT_BYTES bytes up to that size. Hashes only, never content. A transcript is only
 * appended to, so a file that is smaller, another file, or has different bytes at either end is
 * not the file the boundary was taken from; a rewrite that leaves both ends and the size alone is
 * the one thing it cannot see.
 */
export interface ClaudeHistoryBoundary { bytes: number; id?: string; head?: string; tail?: string }
const FINGERPRINT_BYTES = 4096
const HASH = /^[0-9a-f]{64}$/

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read)
    if (!bytesRead) return null
    read += bytesRead
  }
  return buffer
}
async function windowHash(handle: FileHandle, position: number, length: number): Promise<string | null> {
  const bytes = await readExactly(handle, position, length)
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null
}
const fileId = (info: { dev: bigint; ino: bigint }): string | undefined => info.ino ? `${info.dev}:${info.ino}` : undefined

/** The boundary of the transcript as it is now; null when it cannot be read (a lost boundary). */
export async function claudeHistoryBoundary(cwd: string, nativeId: string): Promise<ClaudeHistoryBoundary | null> {
  let handle: FileHandle
  try { handle = await open(claudeHistoryPath(cwd, nativeId), 'r') } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { bytes: 0 } : null }
  try {
    const info = await handle.stat({ bigint: true }), bytes = Number(info.size)
    if (!Number.isSafeInteger(bytes)) return null
    if (!bytes) return { bytes: 0 }
    const window = Math.min(bytes, FINGERPRINT_BYTES)
    const head = await windowHash(handle, 0, window), tail = await windowHash(handle, bytes - window, window)
    if (!head || !tail) return null
    const id = fileId(info)
    return { bytes, ...(id ? { id } : {}), head, tail }
  } catch { return null } finally { await handle.close().catch(() => undefined) }
}
/** A persisted boundary that is well formed, or null. */
function parseBoundary(value: unknown): ClaudeHistoryBoundary | null {
  const boundary = value as Partial<ClaudeHistoryBoundary> | null
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary) || !Number.isSafeInteger(boundary.bytes) || boundary.bytes! < 0) return null
  if (boundary.id !== undefined && (typeof boundary.id !== 'string' || boundary.id.length > 80)) return null
  if (boundary.bytes === 0) return { bytes: 0 }
  if (typeof boundary.head !== 'string' || typeof boundary.tail !== 'string' || !HASH.test(boundary.head) || !HASH.test(boundary.tail)) return null
  return { bytes: boundary.bytes!, ...(boundary.id ? { id: boundary.id } : {}), head: boundary.head, tail: boundary.tail }
}

interface CliWindow { tools: TranscriptToolCall[]; unmatched: number; orphans: number; dropped: number; bytesRead: number; bytesSkipped: number; truncated: boolean }
/** The rows after `fromByte` of an open transcript of `size` bytes: at most the newest `maxBytes`. */
async function readCliWindow(handle: FileHandle, size: number, nativeId: string, fromByte: number, options: { maxBytes?: number; known?: Iterable<string> }): Promise<CliWindow> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? MAX_CLI_TIMING_BYTES))
  const start = Math.max(fromByte, size - maxBytes), length = size - start
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, start + read)
    if (!bytesRead) break
    read += bytesRead
  }
  let bytes = buffer.subarray(0, read)
  const truncated = start > fromByte
  // A window that starts mid-file starts mid-row: that partial row goes, cut at a newline byte.
  if (truncated) { const newline = bytes.indexOf(0x0a); bytes = bytes.subarray(newline < 0 ? bytes.length : newline + 1) }
  const rows: any[] = []
  let teleported = -1
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object' || row.sessionId !== undefined && row.sessionId !== nativeId || row.remoteSourced === true) continue
    const content = row.message?.content
    const first = typeof content === 'string' ? content : Array.isArray(content) && typeof content[0]?.text === 'string' ? content[0].text : ''
    if (row.type === 'user' && TELEPORT_NOTE.test(first)) teleported = rows.length
    rows.push(row)
  }
  const known = new Set(options.known ?? [])
  const pairs = new TranscriptToolPairs()
  for (const row of rows.slice(teleported + 1)) pairs.add(row)
  const paired = pairs.calls()
  return { tools: paired.tools.filter(call => !known.has(call.toolUseId)), unmatched: paired.unmatched, orphans: paired.orphans, dropped: paired.dropped, bytesRead: read, bytesSkipped: start - fromByte, truncated }
}

/**
 * The tool calls a raw Claude CLI-view tab made: only rows its CLI appended to the conversation's
 * transcript after `fromByte` (the size at the handoff, claudeHistorySize), at most the newest
 * `maxBytes` of them, read asynchronously; never the whole file. Rows of another session, rows the
 * CLI marks as copied from elsewhere (remoteSourced) and rows before a teleport's note (a cloud
 * session's own rows, on its clock) are left out, as are calls the handoff already knew. Pairing is
 * by exact tool_use_id (transcript-tool-pairs.ts). A file that shrank since is not read at all.
 * It trusts `fromByte`; captureClaudeCliToolCalls is the read that verifies a persisted boundary.
 */
export async function readClaudeCliToolCalls(cwd: string, nativeId: string, fromByte: number, options: { maxBytes?: number; known?: Iterable<string> } = {}): Promise<{ tools: TranscriptToolCall[]; unmatched: number; bytesRead: number; truncated: boolean; shrank: boolean }> {
  const none = { tools: [], unmatched: 0, bytesRead: 0, truncated: false, shrank: false }
  if (!Number.isSafeInteger(fromByte) || fromByte < 0) return none
  let handle: FileHandle
  try { handle = await open(claudeHistoryPath(cwd, nativeId), 'r') } catch { return none }
  try {
    const size = (await handle.stat()).size
    if (size < fromByte) return { ...none, shrank: true }
    const window = await readCliWindow(handle, size, nativeId, fromByte, options)
    return { tools: window.tools, unmatched: window.unmatched, bytesRead: window.bytesRead, truncated: window.truncated, shrank: false }
  } finally { await handle.close() }
}

/**
 * The same read, but of a handoff's persisted boundary, verified against the file on one open
 * handle (so nothing can change between the check and the read), with an explicit account of what
 * was and was not read. A missing, malformed or size-only (legacy) boundary, or a file that is
 * gone, shorter, another file or different at either end, imports nothing and says why: rows
 * cannot then be told from the ones before the handoff, and no bounded continuation can find the
 * boundary again. A window that did not reach back to the boundary is `partial`, never `complete`.
 */
export async function captureClaudeCliToolCalls(cwd: string, nativeId: string, handoff: { claudeBoundary?: unknown; claudeBytes?: unknown }, options: { maxBytes?: number; known?: Iterable<string> } = {}): Promise<{ tools: TranscriptToolCall[]; coverage: CliCaptureCoverage }> {
  const coverage = (status: CliCaptureCoverage['status'], reason: CliCaptureReason, extra: Partial<CliCaptureCoverage> = {}): { tools: TranscriptToolCall[]; coverage: CliCaptureCoverage } =>
    ({ tools: [], coverage: { status, reason, boundaryBytes: null, fileBytes: null, bytesRead: 0, bytesSkipped: 0, unmatchedCalls: 0, unpairedResults: 0, droppedCalls: 0, ...extra } })
  if (handoff.claudeBoundary === undefined) return coverage('unavailable', handoff.claudeBytes === undefined ? 'boundary-missing' : typeof handoff.claudeBytes === 'number' && Number.isSafeInteger(handoff.claudeBytes) && handoff.claudeBytes >= 0 ? 'boundary-unverified' : 'boundary-malformed', typeof handoff.claudeBytes === 'number' && Number.isSafeInteger(handoff.claudeBytes) ? { boundaryBytes: handoff.claudeBytes } : {})
  const boundary = parseBoundary(handoff.claudeBoundary)
  if (!boundary) return coverage('unavailable', 'boundary-malformed')
  let handle: FileHandle
  try { handle = await open(claudeHistoryPath(cwd, nativeId), 'r') } catch (error) {
    // A conversation whose CLI view wrote nothing has no transcript, and had none at the handoff.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return boundary.bytes === 0 ? coverage('complete', 'no-transcript', { boundaryBytes: 0, fileBytes: 0 }) : coverage('unavailable', 'file-missing', { boundaryBytes: boundary.bytes })
    return coverage('unavailable', 'file-unreadable', { boundaryBytes: boundary.bytes })
  }
  try {
    const info = await handle.stat({ bigint: true }), size = Number(info.size)
    const known = { boundaryBytes: boundary.bytes, fileBytes: size }
    if (!Number.isSafeInteger(size)) return coverage('unavailable', 'file-unreadable', { boundaryBytes: boundary.bytes })
    if (size < boundary.bytes) return coverage('unavailable', 'file-shrank', known)
    const id = fileId(info)
    if (boundary.id && id && boundary.id !== id) return coverage('unavailable', 'file-replaced', known)
    if (boundary.bytes > 0) {
      const window = Math.min(boundary.bytes, FINGERPRINT_BYTES)
      if (await windowHash(handle, 0, window) !== boundary.head || await windowHash(handle, boundary.bytes - window, window) !== boundary.tail) return coverage('unavailable', 'file-changed', known)
    }
    const read = await readCliWindow(handle, size, nativeId, boundary.bytes, options)
    const reason: CliCaptureReason = read.truncated ? 'window-truncated' : read.dropped ? 'call-limit' : 'complete'
    return { tools: read.tools, coverage: { status: reason === 'complete' ? 'complete' : 'partial', reason, ...known, bytesRead: read.bytesRead, bytesSkipped: read.bytesSkipped, unmatchedCalls: read.unmatched, unpairedResults: read.orphans, droppedCalls: read.dropped } }
  } catch { return coverage('unavailable', 'file-unreadable', { boundaryBytes: boundary.bytes }) } finally { await handle.close().catch(() => undefined) }
}
export async function readClaudeHistory(cwd: string, nativeId: string): Promise<NativeHistoryItem[]> {
  const path = claudeHistoryPath(cwd, nativeId)
  if (!existsSync(path)) return []
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const items = new Map<string, NativeHistoryItem>(), tools = new Map<string, { name: string; input: Json }>()
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) continue
      let row: { type?: string; uuid?: string; sessionId?: string; isSidechain?: boolean; message?: { id?: string; role?: string; content?: string | Array<Record<string, unknown>> } }
      try { row = JSON.parse(line) } catch { continue }
      if (row.isSidechain || row.sessionId && row.sessionId !== nativeId || !['user', 'assistant'].includes(row.type ?? '') || !row.message) continue
      const messageId = row.uuid ?? row.message.id
      if (!messageId) continue
      const content = typeof row.message.content === 'string' ? [{ type: 'text', text: row.message.content }] : row.message.content ?? []
      content.forEach((block, index) => {
        const id = messageId + ':' + index
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) items.set(id, { id, data: { type: 'text', role: row.type === 'user' ? 'user' : 'assistant', mode: 'snapshot', text: block.text } })
        else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const tool = { name: typeof block.name === 'string' ? block.name : 'Tool', input: block.input as Json }
          tools.set(block.id, tool)
          items.set(block.id, { id: block.id, data: { type: 'tool', ...tool, status: 'interrupted' } })
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const tool = tools.get(block.tool_use_id) ?? { name: 'Tool', input: undefined }
          const output = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : ''
          items.set(block.tool_use_id, { id: block.tool_use_id, data: { type: 'tool', ...tool, status: block.is_error ? 'failed' : 'completed', output } })
        }
      })
      while (items.size > 2000) items.delete(items.keys().next().value!)
      while (tools.size > 2000) tools.delete(tools.keys().next().value!)
    }
  } finally { lines.close(); stream.destroy() }
  return [...items.values()]
}
/** Grok keeps each session in `~/.grok/sessions/<encoded cwd>/<session id>/`; the group name is
 *  an encoding of the working directory, so the session is found by its own directory name. */
export function grokHistoryDirectory(nativeId: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(nativeId)) throw new Error('Invalid native conversation ID')
  const root = join(process.env.GROK_HOME || join(homedir(), '.grok'), 'sessions')
  let groups: string[]
  try { groups = readdirSync(root) } catch { return undefined }
  for (const group of groups.slice(0, 4096)) {
    const directory = join(root, group, nativeId)
    if (existsSync(join(directory, 'updates.jsonl')) || existsSync(join(directory, 'summary.json'))) return directory
  }
  return undefined
}
export function hasGrokHistory(nativeId: string): boolean { return Boolean(grokHistoryDirectory(nativeId)) }
/** Messages and tool calls from Grok's own ACP update log, for a conversation continued in its TUI. */
export async function readGrokHistory(nativeId: string): Promise<NativeHistoryItem[]> {
  const directory = grokHistoryDirectory(nativeId)
  const path = directory && join(directory, 'updates.jsonl')
  if (!path || !existsSync(path)) return []
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const items = new Map<string, NativeHistoryItem>()
  let message: { id: string; role: 'user' | 'assistant'; text: string } | undefined, sequence = 0
  const flush = (): void => {
    if (message?.text.trim()) items.set(message.id, { id: message.id, data: { type: 'text', role: message.role, mode: 'snapshot', text: message.text } })
    message = undefined
  }
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) continue
      let row: Record<string, unknown>
      try { row = JSON.parse(line) } catch { continue }
      // A line is one ACP session update, bare or still in its notification envelope.
      const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : row
      const update = (params.update && typeof params.update === 'object' ? params.update : params) as Record<string, unknown>
      const kind = update.sessionUpdate
      sequence++
      if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
        const role = kind === 'user_message_chunk' ? 'user' : 'assistant'
        const content = update.content as { type?: string; text?: string } | undefined
        if (message && message.role !== role) flush()
        message ??= { id: `${role}:${sequence}`, role, text: '' }
        if (content?.type === 'text' && typeof content.text === 'string') message.text += content.text
      } else if ((kind === 'tool_call' || kind === 'tool_call_update') && typeof update.toolCallId === 'string') {
        flush()
        const previous = items.get(update.toolCallId)?.data
        const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : previous?.type === 'tool' ? previous.status : 'interrupted'
        const output = Array.isArray(update.content) ? update.content.flatMap((entry: { type?: string; content?: { text?: unknown } }) => entry?.type === 'content' && typeof entry.content?.text === 'string' ? [entry.content.text] : []).join('\n') : ''
        items.set(update.toolCallId, { id: update.toolCallId, data: { type: 'tool',
          name: previous?.type === 'tool' ? previous.name : typeof update.title === 'string' ? update.title : 'Tool',
          ...(update.rawInput !== undefined ? { input: update.rawInput as Json } : previous?.type === 'tool' && previous.input !== undefined ? { input: previous.input } : {}),
          status, ...(output ? { output } : previous?.type === 'tool' && previous.output ? { output: previous.output } : {}) } })
      }
      while (items.size > 2000) items.delete(items.keys().next().value!)
    }
    flush()
  } finally { lines.close(); stream.destroy() }
  return [...items.values()]
}
export function historyEvent(item: NativeHistoryItem, handoff: string): AdapterEvent {
  return { itemId: 'cli:' + handoff + ':' + item.id, turnId: item.turnId, data: item.data, native: { method: 'cli/history', payload: { itemId: item.id } } }
}
