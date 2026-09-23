import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export const FILE_PAGE_BYTES = 16 * 1024
const LINE_PAGE_BYTES = 64 * 1024
const SCAN_LIMIT = 256 * 1024 * 1024

export interface LocalFileEvidence {
  source: { path: string; sizeBytes: number; mtimeMs: number; sha256?: string; stable: boolean }
  coordinates: { byteStart: number; byteEnd: number; endExclusive: true; firstLine?: number; lastLine?: number }
  mode: string
  encoding?: string
  bom?: string
  lineEndings?: { lf: number; crlf: number; loneCr: number }
  rawSample: string
  escapedSample: string
  hexSample: string
  truncated: boolean
}

/** Streaming scan retains only the requested window, including when a single line is huge. */
export async function boundedFile(path: string, options: { mode?: string; offset?: number; limit?: number; byteOffset?: number; byteLimit?: number; signal?: AbortSignal; evidence?: (value: LocalFileEvidence) => void } = {}): Promise<string> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('Not a regular file')
    const mode = options.mode ?? 'lines'
    if (mode === 'bytes') {
      const start = options.byteOffset ?? 0, count = Math.min(options.byteLimit ?? 4096, FILE_PAGE_BYTES)
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1) throw new Error('byte_offset must be nonnegative and byte_limit positive')
      const bytes = Buffer.alloc(count)
      const read = await file.read(bytes, 0, count, start)
      const sample = bytes.subarray(0, read.bytesRead)
      const after = await file.stat()
      options.evidence?.({ source: { path, sizeBytes: before.size, mtimeMs: before.mtimeMs, stable: before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs }, coordinates: { byteStart: start, byteEnd: start + sample.length, endExclusive: true }, mode, rawSample: sample.subarray(0, 512).toString('utf8'), escapedSample: JSON.stringify(sample.subarray(0, 512).toString('utf8')), hexSample: sample.subarray(0, 512).toString('hex'), truncated: start > 0 || start + sample.length < before.size })
      return `[read_file: mode=bytes; size_bytes=${before.size}; byte_range=${start}-${start + sample.length}; end_exclusive=true; truncated=${start > 0 || start + sample.length < before.size}; next_byte_offset=${start + sample.length}]\n${JSON.stringify({ raw: sample.toString('utf8'), escaped: JSON.stringify(sample.toString('utf8')), hex: sample.toString('hex') })}`
    }
    if (!['lines', 'inspect'].includes(mode)) throw new Error('mode must be lines, inspect or bytes')
    const offset = options.offset ?? 1, limit = options.limit ?? 200
    if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('offset must be a positive 1-based line number; negative offsets are not supported')
    const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true })
    let validUtf8 = true, position = 0, line = 1, lf = 0, crlf = 0, cr = 0, previous = -1, totalSelected = 0
    let firstByte = -1, lastByte = -1, selectedLastLine = 0
    const selected: Buffer[] = [], sample: Buffer[] = []
    const chunk = Buffer.alloc(64 * 1024)
    while (position < Math.min(before.size, SCAN_LIMIT)) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, SCAN_LIMIT - position), position)
      if (!bytesRead) break
      const bytes = chunk.subarray(0, bytesRead)
      hash.update(bytes)
      if (position < 512) sample.push(Buffer.from(bytes.subarray(0, 512 - position)))
      if (validUtf8) try { decoder.decode(bytes, { stream: true }) } catch { validUtf8 = false }
      let segment = -1
      for (let i = 0; i < bytesRead; i++) {
        const b = bytes[i]!
        if (line >= offset && line < offset + limit && totalSelected < LINE_PAGE_BYTES) {
          if (segment < 0) segment = i
          if (firstByte < 0) firstByte = position + i
          totalSelected++; lastByte = position + i + 1; selectedLastLine = line
        } else if (segment >= 0) { selected.push(Buffer.from(bytes.subarray(segment, i))); segment = -1 }
        if (b === 10) { lf++; if (previous === 13) crlf++; line++ }
        if (b === 13) cr++
        previous = b
      }
      if (segment >= 0) selected.push(Buffer.from(bytes.subarray(segment)))
      position += bytesRead
    }
    if (validUtf8) try { decoder.decode() } catch { validUtf8 = false }
    const after = await file.stat(), stable = before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    const complete = position === before.size
    const totalLines = position === 0 ? 0 : line - (previous === 10 ? 1 : 0)
    const head = Buffer.concat(sample), bom = head.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 'UTF-8' : head.subarray(0, 2).equals(Buffer.from([255, 254])) ? 'UTF-16LE' : head.subarray(0, 2).equals(Buffer.from([254, 255])) ? 'UTF-16BE' : 'none'
    const sha256 = complete && stable ? hash.digest('hex') : undefined
    if (firstByte < 0) { firstByte = position; lastByte = position }
    const identity = `path=${JSON.stringify(path)}; size_bytes=${before.size}; sha256=${sha256 ?? 'unavailable (scan incomplete or file changed)'}; stable=${stable}; scanned_bytes=${position}`
    const evidenceSample = mode === 'inspect' ? head : Buffer.concat(selected).subarray(0, 512)
    options.evidence?.({ source: { path, sizeBytes: before.size, mtimeMs: before.mtimeMs, sha256, stable }, coordinates: { byteStart: mode === 'inspect' ? 0 : firstByte, byteEnd: mode === 'inspect' ? head.length : lastByte, endExclusive: true, firstLine: mode === 'lines' && selectedLastLine > 0 ? offset : undefined, lastLine: mode === 'lines' ? selectedLastLine : undefined }, mode, encoding: validUtf8 ? 'UTF-8' : 'unknown/invalid UTF-8', bom, lineEndings: { lf: lf - crlf, crlf, loneCr: cr - crlf }, rawSample: evidenceSample.toString('utf8'), escapedSample: JSON.stringify(evidenceSample.toString('utf8')), hexSample: evidenceSample.toString('hex'), truncated: !complete || (mode === 'inspect' ? head.length < before.size : firstByte > 0 || lastByte < before.size) })
    if (mode === 'inspect') return `[read_file: mode=inspect; ${identity}]\n${JSON.stringify({ encoding: validUtf8 ? 'valid UTF-8' : 'not valid UTF-8; use bytes mode', bom, line_endings: { lf: lf - crlf, crlf, lone_cr: cr - crlf }, total_lines: complete ? totalLines : null, line_numbering: 'LF-delimited', sample_byte_range: [0, head.length], raw: head.toString('utf8'), escaped: JSON.stringify(head.toString('utf8')), hex: head.toString('hex'), coverage: complete ? 'complete' : 'scan capped at 256 MiB; use bytes mode' })}`
    const first = selectedLastLine ? offset : 0, last = selectedLastLine
    const truncated = !complete || (totalLines > 0 && (first !== 1 || last !== totalLines || totalSelected === LINE_PAGE_BYTES))
    return `[read_file: total_lines=${complete ? totalLines : 'unknown'}; returned_lines=${first}-${last}; truncated=${truncated}; next range: offset=${totalSelected === LINE_PAGE_BYTES ? last : last + 1}; ${identity}; byte_range=${firstByte}-${lastByte}; end_exclusive=true;${totalSelected === LINE_PAGE_BYTES ? ` byte cap reached: continue mode=bytes byte_offset=${lastByte};` : ''}]\n${Buffer.concat(selected).toString('utf8').replace(last === offset + limit - 1 ? /\n$/ : /$^/, '') || (totalLines ? '(no lines in requested range)' : '(empty file)')}`
  } finally { await file.close() }
}

export function staleEvidence(content: string): string {
  return `current_sha256=${createHash('sha256').update(content).digest('hex')}; current excerpt (first 1200 characters)=${JSON.stringify(content.slice(0, 1200))}. Read the current range or search a shorter anchor, then retry with a unique current old_text.`
}
