import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_EVIDENCE_TEXT_BYTES, type EvidenceKind, type EvidenceRef, type EvidenceSink } from '../../shared/production'
import { maskSecrets, sanitizeDiagnostic } from '../structured-store'

/**
 * The only way a check writes evidence (docs/production-agent.md section 4.6). Everything textual is
 * redacted before it touches the disk: `maskSecrets` (bearer tokens, API keys, password assignments),
 * `Authorization`/`Cookie`/`Set-Cookie` header lines, every synthetic marker of the run, and the
 * result is bounded to MAX_EVIDENCE_TEXT_BYTES. JSON goes through `sanitizeDiagnostic` (secret-named
 * keys) and the same text redaction on every string. Binary evidence (screenshots) is written as
 * given: the browser masks password and card fields before it captures.
 *
 * Files land in `<artifactsDir>/evidence/`, and `<artifactsDir>/evidence.json` indexes every ref.
 */

export const SYNTHETIC_PLACEHOLDER = '[SYNTHETIC]'
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i
const SECRET_HEADER_LINE = /^([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)[ \t]*:).*$/gim

export interface EvidenceSinkOptions {
  now?: () => Date
  maxTextBytes?: number
}

export interface ProductionEvidenceSink extends EvidenceSink {
  /** Every ref written so far, in order. */
  list(): EvidenceRef[]
  readonly dir: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Masks secrets, secret header lines and the run's synthetic markers (case-insensitive) in one string. */
export function redactEvidenceText(text: string, markers: Iterable<string>): string {
  let result = maskSecrets(text).replace(SECRET_HEADER_LINE, '$1 [REDACTED]')
  const list = [...new Set([...markers].filter(marker => marker.length >= 6))].sort((a, b) => b.length - a.length)
  if (list.length) result = result.replace(new RegExp(list.map(escapeRegExp).join('|'), 'gi'), SYNTHETIC_PLACEHOLDER)
  return result
}

/** Drops credential headers from a captured header map (request excerpts keep the rest). */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SECRET_HEADERS.test(name) ? '[REDACTED]' : value]))
}

function redactValue(value: unknown, markers: readonly string[]): unknown {
  if (typeof value === 'string') return redactEvidenceText(value, markers)
  if (Array.isArray(value)) return value.map(item => redactValue(item, markers))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_HEADERS.test(key) ? '[REDACTED]' : redactValue(item, markers)]))
  }
  return value
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a character, noting the cut. */
export function boundText(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return text
  const note = `\n[truncated: ${bytes} bytes, kept the first ${maxBytes}]\n`
  let cut = Buffer.from(text).subarray(0, Math.max(0, maxBytes - Buffer.byteLength(note))).toString('utf8')
  if (cut.endsWith('�')) cut = cut.slice(0, -1)
  return cut + note
}

export function createEvidenceSink(dir: string, markers: Iterable<string> | (() => Iterable<string>), options: EvidenceSinkOptions = {}): ProductionEvidenceSink {
  const now = options.now ?? (() => new Date())
  const maxTextBytes = options.maxTextBytes ?? MAX_EVIDENCE_TEXT_BYTES
  const currentMarkers = (): string[] => [...(typeof markers === 'function' ? markers() : markers)]
  const refs: EvidenceRef[] = []
  let writes = Promise.resolve()

  const store = (kind: EvidenceKind, description: string, bytes: Uint8Array, ext: string, redacted: boolean): Promise<EvidenceRef> => {
    const task = writes.then(async () => {
      const index = refs.length + 1
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const safeExt = ext.replace(/^\./, '').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'txt'
      const path = `evidence/${String(index).padStart(4, '0')}-${kind}.${safeExt}`
      await mkdir(join(dir, 'evidence'), { recursive: true })
      await writeAtomic(join(dir, path), bytes)
      const ref: EvidenceRef = {
        id: `ev-${String(index).padStart(4, '0')}-${sha256.slice(0, 8)}`,
        kind,
        path,
        sha256,
        description: boundText(redactEvidenceText(description, currentMarkers()), 500),
        capturedAt: now().toISOString(),
        redacted,
      }
      refs.push(ref)
      await writeAtomic(join(dir, 'evidence.json'), Buffer.from(JSON.stringify(refs, null, 2)))
      return ref
    })
    writes = task.then(() => undefined, () => undefined)
    return task
  }

  return {
    dir,
    list: () => [...refs],
    writeText(kind, description, text, ext = 'txt') {
      const redactedText = redactEvidenceText(text, currentMarkers())
      const bounded = boundText(redactedText, maxTextBytes)
      return store(kind, description, Buffer.from(bounded), ext, bounded !== text)
    },
    writeJson(kind, description, value) {
      const cleaned = redactValue(sanitizeDiagnostic(value), currentMarkers())
      let text = JSON.stringify(cleaned, null, 2) ?? 'null'
      if (Buffer.byteLength(text) > maxTextBytes) {
        // A cut JSON document would not parse; keep a parseable wrapper with the head of the text.
        text = JSON.stringify({ truncated: true, bytes: Buffer.byteLength(text), head: boundText(text, Math.floor(maxTextBytes / 2)) })
      }
      return store(kind, description, Buffer.from(text), 'json', text !== JSON.stringify(value, null, 2))
    },
    writeBinary(kind, description, bytes, ext) {
      return store(kind, description, bytes, ext, false)
    },
  }
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, path)
}
