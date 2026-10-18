import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { MARKER_PREFIX, shQuote } from './shell.ts'

/**
 * Files a job leaves in its working directory, brought back to this machine: test reports,
 * screenshots, traces. The node packs them with tar over the same ssh transport; this side
 * unpacks them itself, so nothing on the node decides where a file lands here.
 *
 * Confinement, twice over. On the node, every requested path is resolved with `pwd -P` and must
 * stay under the job's working directory; a requested path that is itself a symbolic link is
 * skipped, and tar stores links inside a folder as links, never following them. Here, only regular
 * files and folders are written, every entry name is normalized and refused if it is absolute,
 * names a drive or climbs with "..", and the resolved target must stay inside the destination.
 */

export const ARTIFACT_CAP_BYTES = 512 * 1024 * 1024
export const MAX_ARTIFACT_PATHS = 20

export interface ArtifactFetch {
  at: string
  /** Where the files landed on this machine. */
  dir: string
  patterns: string[]
  files: number
  bytes: number
  /** Matches left out: symbolic links, paths outside the working directory, unsafe entry names. */
  skipped: string[]
  /** Patterns that matched nothing. */
  missing: string[]
  error: string | null
}

/** A path or glob relative to the job's working directory; refuses anything that could leave it. */
export function checkArtifactPattern(value: unknown): string {
  if (typeof value !== 'string') throw new Error('artifact paths are strings')
  const pattern = value.trim().replace(/\/+$/, '')
  if (!pattern || pattern.length > 300 || /[\0\r\n]/.test(pattern)) throw new Error('artifact paths are 1-300 characters on one line')
  if (pattern.includes('\\')) throw new Error(`artifact path ${pattern}: use forward slashes`)
  if (pattern.startsWith('/') || pattern.startsWith('~') || /^[A-Za-z]:/.test(pattern)) throw new Error(`artifact path ${pattern} must be relative to the job's working directory`)
  if (pattern.split('/').includes('..')) throw new Error(`artifact path ${pattern} may not contain ..`)
  return pattern
}

export function checkArtifactPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ARTIFACT_PATHS) throw new Error(`artifacts is a list of 1 to ${MAX_ARTIFACT_PATHS} paths or globs relative to the job's working directory`)
  return [...new Set(value.map(checkArtifactPattern))]
}

/**
 * Packs the matches of each pattern (bash globs, no **) under the working directory as a gzip'd
 * tar on stdout, after reporting on stderr what was missing, skipped and how large the rest is.
 * Refuses (`too-large`) before sending anything when the total is over the cap.
 */
export const FETCH_SCRIPT = String.raw`cwd=$1; cap=$2; tag="@@conductor-job:$3"; shift 3
mark() { printf '%s %s\n' "$tag" "$1" >&2; }
if [ -f "$HOME/.conductor-node/env.sh" ]; then . "$HOME/.conductor-node/env.sh" >/dev/null 2>&1; fi
case "$cwd" in "" | "~") cwd=$HOME ;; "~/"*) cwd="$HOME/$(printf '%s' "$cwd" | sed 's|^~/||')" ;; /*) ;; *) cwd="$HOME/$cwd" ;; esac
cd "$cwd" 2>/dev/null || { mark error=cwd; exit 3; }
base=$(pwd -P)
shopt -s nullglob
n=0
for pat in "$@"; do
  found=0
  IFS=
  for m in $pat; do
    m=$\{m%/}
    if [ -L "$m" ]; then found=1; mark "skipped $m"; continue; fi
    [ -e "$m" ] || continue
    found=1
    case "$m" in */*) d=$\{m%/*} ;; *) d=. ;; esac
    real=$(cd "$d" 2>/dev/null && pwd -P) || { mark "skipped $m"; continue; }
    case "$real/" in "$base/"*) ;; *) mark "skipped $m"; continue ;; esac
    rel=$\{real#"$base"}; rel=$\{rel#/}
    files[n]="./$\{rel:+$rel/}$\{m##*/}"; n=$((n + 1))
  done
  unset IFS
  [ "$found" = 1 ] || mark "missing $pat"
done
if [ "$n" = 0 ]; then mark none; exit 0; fi
kb=$(du -sk "$\{files[@]}" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')
bytes=$((kb * 1024))
if [ "$bytes" -gt "$cap" ]; then mark "too-large bytes=$bytes"; exit 4; fi
mark "packing files=$n bytes=$bytes"
COPYFILE_DISABLE=1 tar -czf - "$\{files[@]}"
code=$?
mark "tar=$code"
exit "$code"`.replaceAll('$\\{', '${')

export function buildFetchCommand(input: { cwd: string; capBytes: number; nonce: string; patterns: string[] }): string {
  const args = [input.cwd, String(Math.floor(input.capBytes)), input.nonce, ...input.patterns.map(checkArtifactPattern)]
  return `/bin/bash -c ${shQuote(FETCH_SCRIPT)} conductor-fetch ${args.map(shQuote).join(' ')}`
}

export type FetchMark =
  | { kind: 'missing'; pattern: string }
  | { kind: 'skipped'; path: string }
  | { kind: 'too-large'; bytes: number }
  | { kind: 'none' }
  | { kind: 'packing'; files: number; bytes: number }
  | { kind: 'tar'; code: number }
  | { kind: 'error'; error: string }

export function parseFetchMarks(stderr: string, nonce: string): { marks: FetchMark[]; other: string } {
  const tag = `${MARKER_PREFIX}${nonce} `
  const marks: FetchMark[] = []
  const other: string[] = []
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith(tag)) { if (line.trim()) other.push(line); continue }
    const body = line.slice(tag.length)
    let match: RegExpExecArray | null
    if ((match = /^missing (.*)$/.exec(body))) marks.push({ kind: 'missing', pattern: match[1]! })
    else if ((match = /^skipped (.*)$/.exec(body))) marks.push({ kind: 'skipped', path: match[1]! })
    else if ((match = /^too-large bytes=(\d+)$/.exec(body))) marks.push({ kind: 'too-large', bytes: Number(match[1]) })
    else if (body === 'none') marks.push({ kind: 'none' })
    else if ((match = /^packing files=(\d+) bytes=(\d+)$/.exec(body))) marks.push({ kind: 'packing', files: Number(match[1]), bytes: Number(match[2]) })
    else if ((match = /^tar=(\d+)$/.exec(body))) marks.push({ kind: 'tar', code: Number(match[1]) })
    else if ((match = /^error=([\w-]+)$/.exec(body))) marks.push({ kind: 'error', error: match[1]! })
  }
  return { marks, other: other.join('\n') }
}

/** An entry name from the archive as a safe relative path, or null when it must not be written. */
export function safeEntryPath(name: string): string | null {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null
  const parts = name.split('/').filter(part => part && part !== '.')
  if (!parts.length || parts.some(part => part === '..' || part.includes(':') || /[<>"|?*\x00-\x1f]/.test(part))) return null
  return parts.join('/')
}

const BLOCK = 512

const field = (header: Buffer, start: number, length: number): string => {
  const slice = header.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? length : end).toString('utf8')
}

const octal = (header: Buffer, start: number, length: number): number | null => {
  const text = field(header, start, length).trim()
  if (!text) return 0
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null
}

/** pax extended header records: "<len> <key>=<value>\n". */
const paxRecords = (data: Buffer): Record<string, string> => {
  const records: Record<string, string> = {}
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space < 0) break
    const length = Number(data.subarray(at, space).toString('ascii'))
    if (!Number.isInteger(length) || length <= 0) break
    const record = data.subarray(space + 1, at + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }
  return records
}

/**
 * An incremental ustar/pax reader that writes only regular files and folders inside `dir`.
 * Fed decompressed bytes in any chunking; stops (`error`) when the content passes `capBytes`.
 */
export class TarExtractor {
  files = 0
  bytes = 0
  readonly skipped: string[] = []
  error: string | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private entry: { remaining: number; padding: number; fd: number | null; kind: 'file' | 'skip' | 'pax' | 'longname'; data: Buffer[] } | null = null
  private pending: { path?: string; size?: number } = {}
  private ended = false
  private readonly root: string
  private readonly capBytes: number

  constructor(dir: string, capBytes: number) {
    this.root = resolve(dir)
    this.capBytes = capBytes
    mkdirSync(this.root, { recursive: true })
  }

  get done(): boolean { return this.ended || this.error !== null }

  push(chunk: Buffer): void {
    if (this.done) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    try { this.drain() } catch (error) { this.fail(error instanceof Error ? error.message : String(error)) }
  }

  /** Closes any half-written file; reports a truncated archive. */
  finish(): void {
    if (this.entry?.fd != null) { closeSync(this.entry.fd); this.entry.fd = null }
    if (!this.ended && !this.error && (this.entry || this.buffer.length)) this.error = 'the archive ended early'
  }

  private fail(message: string): void {
    if (this.entry?.fd != null) { closeSync(this.entry.fd); this.entry.fd = null }
    this.error = message
  }

  private target(name: string): string | null {
    const safe = safeEntryPath(name)
    if (!safe) return null
    const path = resolve(this.root, safe)
    const inside = relative(this.root, path)
    if (!inside || inside.startsWith('..') || inside.includes(`..${sep}`) || resolve(path) !== path) return null
    return path
  }

  private drain(): void {
    for (;;) {
      if (this.done) return
      if (this.entry) {
        const entry = this.entry
        if (entry.remaining > 0) {
          if (!this.buffer.length) return
          const take = Math.min(entry.remaining, this.buffer.length)
          const piece = this.buffer.subarray(0, take)
          if (entry.kind === 'file') {
            this.bytes += take
            if (this.bytes > this.capBytes) { this.fail(`the artifacts are larger than ${this.capBytes} bytes`); return }
            if (entry.fd != null) writeSync(entry.fd, piece)
          } else if (entry.kind === 'pax' || entry.kind === 'longname') entry.data.push(Buffer.from(piece))
          entry.remaining -= take
          this.buffer = this.buffer.subarray(take)
          continue
        }
        if (this.buffer.length < entry.padding) return
        this.buffer = this.buffer.subarray(entry.padding)
        if (entry.fd != null) { closeSync(entry.fd); this.files++ }
        if (entry.kind === 'pax') {
          const records = paxRecords(Buffer.concat(entry.data))
          if (records.path !== undefined) this.pending.path = records.path
          if (records.size !== undefined && /^\d+$/.test(records.size)) this.pending.size = Number(records.size)
        } else if (entry.kind === 'longname') this.pending.path = Buffer.concat(entry.data).toString('utf8').replace(/\0+$/, '')
        this.entry = null
        continue
      }
      if (this.buffer.length < BLOCK) return
      const header = this.buffer.subarray(0, BLOCK)
      this.buffer = this.buffer.subarray(BLOCK)
      if (header.every(byte => byte === 0)) { this.ended = true; return }
      const type = String.fromCharCode(header[156]!)
      const headerSize = octal(header, 124, 12)
      if (headerSize === null) throw new Error('the archive has an entry size this reader does not understand')
      const prefix = field(header, 257, 6).startsWith('ustar') ? field(header, 345, 155) : ''
      const name = this.pending.path ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
      const size = this.pending.size ?? headerSize
      const padding = (BLOCK - (size % BLOCK)) % BLOCK
      if (type === 'x' || type === 'L') {
        this.entry = { remaining: size, padding, fd: null, kind: type === 'x' ? 'pax' : 'longname', data: [] }
        continue
      }
      this.pending = {}
      if (type === 'g') { this.entry = { remaining: size, padding, fd: null, kind: 'skip', data: [] }; continue }
      const path = type === '0' || type === '\0' || type === '7' || type === '5' ? this.target(name) : null
      if (!path) {
        this.skipped.push(`${name}${type === '2' ? ' (symbolic link)' : type === '1' ? ' (hard link)' : type === '0' || type === '\0' || type === '5' ? ' (unsafe name)' : ''}`)
        this.entry = { remaining: size, padding, fd: null, kind: 'skip', data: [] }
        continue
      }
      if (type === '5') { mkdirSync(path, { recursive: true }); this.entry = { remaining: size, padding, fd: null, kind: 'skip', data: [] }; continue }
      let fd: number | null = null
      try {
        mkdirSync(join(path, '..'), { recursive: true })
        fd = openSync(path, 'w')
      } catch (error) {
        // A name this file system cannot hold (CON, a file where a folder is): leave that one out.
        this.skipped.push(`${name} (${(error as NodeJS.ErrnoException).code ?? 'not writable'})`)
      }
      this.entry = { remaining: size, padding, fd, kind: fd === null ? 'skip' : 'file', data: [] }
    }
  }
}
