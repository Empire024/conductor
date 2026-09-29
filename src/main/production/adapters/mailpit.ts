import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CapturedMailAdapter, CapturedMailConfig, CapturedMessage } from '../../../shared/production'

/**
 * Captured-mail adapter (docs/production-agent.md M6): reads what a sandbox sent, never sends.
 *
 * - `mailpit`: the Mailpit HTTP API at `location` (`GET /api/v1/messages`, `/api/v1/message/{ID}`,
 *   `/api/v1/message/{ID}/headers`), newest first, bounded to MAX_MESSAGES.
 * - `maildir`: RFC 5322 files under `location/new` and `location/cur` (and the directory itself),
 *   parsed for headers, a text/plain and a text/html part.
 *
 * Messages are returned oldest first; `since` keeps those received at or after that instant.
 */

export const MAX_MESSAGES = 200
export const MAX_MESSAGE_BYTES = 1024 * 1024
const MAIL_TIMEOUT_MS = 15_000

export interface CapturedMailOptions {
  fetch?: typeof fetch
  limit?: number
  timeoutMs?: number
}

export function createCapturedMailAdapter(config: CapturedMailConfig, options: CapturedMailOptions = {}): CapturedMailAdapter {
  return config.kind === 'maildir' ? createMaildirAdapter(config.location, options) : createMailpitAdapter(config.location, options)
}

export function createMailpitAdapter(location: string, options: CapturedMailOptions = {}): CapturedMailAdapter {
  let base: URL
  try { base = new URL(location.replace(/\/+$/, '') + '/') } catch { throw new Error(`Mailpit location ${location} is not a URL`) }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`Mailpit location ${location} must be http(s)`)
  const doFetch = options.fetch ?? fetch
  const limit = Math.min(options.limit ?? MAX_MESSAGES, MAX_MESSAGES)
  const get = async (path: string): Promise<unknown> => {
    const url = new URL(path, base)
    const response = await doFetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? MAIL_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Mailpit ${url.pathname}: HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_MESSAGE_BYTES * 4) throw new Error(`Mailpit ${url.pathname}: response over the size limit`)
    return JSON.parse(buffer.toString('utf8'))
  }
  return {
    async list(since) {
      const summary = await get(`api/v1/messages?limit=${limit}&start=0`) as { messages?: Array<Record<string, unknown>> }
      const sinceMs = since ? Date.parse(since) : null
      const picked = (summary.messages ?? []).filter(item => sinceMs === null || Date.parse(String(item.Created ?? '')) >= sinceMs).slice(0, limit)
      const messages: CapturedMessage[] = []
      for (const item of picked) {
        const id = String(item.ID ?? '')
        if (!id) continue
        const [full, headers] = await Promise.all([
          get(`api/v1/message/${encodeURIComponent(id)}`) as Promise<Record<string, unknown>>,
          (get(`api/v1/message/${encodeURIComponent(id)}/headers`) as Promise<Record<string, unknown>>).catch(() => ({})),
        ])
        messages.push({
          id,
          from: address(full.From ?? item.From),
          to: addresses(full.To ?? item.To),
          subject: String(full.Subject ?? item.Subject ?? ''),
          receivedAt: new Date(String(item.Created ?? full.Date ?? Date.now())).toISOString(),
          text: bound(String(full.Text ?? '')),
          html: full.HTML ? bound(String(full.HTML)) : null,
          headers: flattenHeaders(headers),
        })
      }
      return messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    },
  }
}

export function createMaildirAdapter(location: string, options: CapturedMailOptions = {}): CapturedMailAdapter {
  const limit = Math.min(options.limit ?? MAX_MESSAGES, MAX_MESSAGES)
  return {
    async list(since) {
      const files: Array<{ path: string; mtime: number }> = []
      for (const directory of [join(location, 'new'), join(location, 'cur'), location]) {
        if (!existsSync(directory) || !statSync(directory).isDirectory()) continue
        for (const name of readdirSync(directory)) {
          const path = join(directory, name)
          const stat = statSync(path)
          if (stat.isFile() && stat.size <= MAX_MESSAGE_BYTES) files.push({ path, mtime: stat.mtimeMs })
        }
      }
      const sinceMs = since ? Date.parse(since) : null
      const messages = files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(file => {
        const parsed = parseRfc822(readFileSync(file.path, 'utf8'))
        const date = Date.parse(parsed.headers['date'] ?? '')
        return { ...parsed, id: file.path.split(/[\\/]/).pop()!, receivedAt: new Date(Number.isFinite(date) ? date : file.mtime).toISOString() }
      })
      return messages.filter(message => sinceMs === null || Date.parse(message.receivedAt) >= sinceMs).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    },
  }
}

/** Parses a raw message: unfolded headers (lower-case keys), and the text and html parts of a (nested) multipart body. */
export function parseRfc822(raw: string): Omit<CapturedMessage, 'id' | 'receivedAt'> {
  const { headers, body } = splitHeaders(raw)
  const parts = collectParts(headers, body)
  return {
    from: headers['from'] ?? '',
    to: (headers['to'] ?? '').split(',').map(entry => entry.trim()).filter(Boolean),
    subject: decodeWords(headers['subject'] ?? ''),
    text: bound(parts.text ?? (parts.html ? parts.html.replace(/<[^>]+>/g, ' ') : '')),
    html: parts.html ? bound(parts.html) : null,
    headers,
  }
}

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const normalised = raw.replace(/\r\n/g, '\n')
  const end = normalised.indexOf('\n\n')
  const head = end >= 0 ? normalised.slice(0, end) : normalised
  const body = end >= 0 ? normalised.slice(end + 2) : ''
  const headers: Record<string, string> = {}
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value
  }
  return { headers, body }
}

function collectParts(headers: Record<string, string>, body: string, depth = 0): { text: string | null; html: string | null } {
  const type = (headers['content-type'] ?? 'text/plain').toLowerCase()
  const boundary = /boundary="?([^";]+)"?/i.exec(headers['content-type'] ?? '')?.[1]
  if (type.startsWith('multipart/') && boundary && depth < 4) {
    const found: { text: string | null; html: string | null } = { text: null, html: null }
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break
      const part = splitHeaders(chunk.replace(/^\n/, ''))
      const inner = collectParts(part.headers, part.body, depth + 1)
      found.text ??= inner.text
      found.html ??= inner.html
    }
    return found
  }
  const decoded = decodeBody(body, headers['content-transfer-encoding'] ?? '')
  return type.startsWith('text/html') ? { text: null, html: decoded } : { text: decoded, html: null }
}

function decodeBody(body: string, encoding: string): string {
  const kind = encoding.toLowerCase()
  if (kind === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (kind === 'quoted-printable') {
    const bytes = body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return Buffer.from(bytes, 'latin1').toString('utf8')
  }
  return body
}

/** RFC 2047 encoded words in a header (`=?UTF-8?B?...?=`, `=?UTF-8?Q?...?=`). */
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, _charset: string, kind: string, data: string) => kind.toLowerCase() === 'b'
    ? Buffer.from(data, 'base64').toString('utf8')
    : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8'))
}

function address(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '')
  const entry = value as { Name?: string; Address?: string }
  return entry.Name ? `${entry.Name} <${entry.Address ?? ''}>` : entry.Address ?? ''
}

function addresses(value: unknown): string[] {
  return Array.isArray(value) ? value.map(address).filter(Boolean) : []
}

function flattenHeaders(value: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value ?? {})) headers[key.toLowerCase()] = Array.isArray(entry) ? entry.map(String).join(', ') : String(entry)
  return headers
}

const bound = (text: string): string => text.length > MAX_MESSAGE_BYTES ? text.slice(0, MAX_MESSAGE_BYTES) : text
