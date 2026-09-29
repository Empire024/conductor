import { createHash, createHmac } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialRef, NetworkPolicy, StorageAdapter, StorageConfig, StorageObject } from '../../../shared/production'
import { NetworkGate, isPrivateHost } from '../netpolicy'

/**
 * Storage adapters for C16 Storage exposure (docs/production-agent.md module M4): an inventory of
 * what the store holds, and anonymous probes that ask the store the question a stranger would ask.
 *
 * - Every probe is anonymous: a GET with no cookie, no Authorization header and `redirect: 'manual'`.
 *   A 3xx is reported as it is and is not publicly readable. The only signed request is the S3
 *   inventory (ListObjectsV2), which is the owner's own view of the bucket.
 * - A probe returns a status and whether the body is a directory or bucket listing, never content:
 *   a body is read (at most 64 KiB) only for a directory key, to recognise a listing, and dropped.
 * - Private and loopback hosts are refused unless the policy allows them (a `local` environment),
 *   and requests to one host are spaced at `1000 / requestsPerSecondPerOrigin` ms.
 * - Write probes (`storage-probe-write`) do not exist here; C16 declares write access unobservable.
 *
 * Keys are relative to the store's root with forward slashes; a key ending in `/` (or the empty key,
 * the root) is a directory, which is what the listing probe asks about. Anything the adapter cannot
 * do throws a StorageAdapterError with a message that names the fix; the check reports it as the
 * reason it could not conclude.
 */

export const MAX_LISTING_BYTES = 64 * 1024
export const MAX_INVENTORY_BODY_BYTES = 4 * 1024 * 1024
export const PROBE_TIMEOUT_MS = 15_000
export const MAX_INVENTORY_OBJECTS = 5000
const MAX_WALK_DEPTH = 16
const MAX_LIST_PAGES = 20
const MAX_LISTING_NAMES = 200
const MAX_SIGNED_TTL_SECONDS = 604_800

/** Where an inventory entry came from, so a reader knows which entries were seen and which were guessed. */
export type StorageEntrySource = 'disk' | 'list-objects' | 'known-private-location' | 'uploads-listing' | 'rest-media' | 'command'
export interface StorageEntry extends StorageObject { source: StorageEntrySource }

export interface StorageAdapterOptions {
  policy: NetworkPolicy
  resolveCredential?: (ref: CredentialRef) => string | null
  fetch?: typeof fetch
  now?: () => Date
  runCommand?: (command: string, signal?: AbortSignal) => Promise<string>
  /** Waits out a signed link's lifetime; injectable so tests need not sleep. */
  sleep?: (ms: number) => Promise<void>
}

export class StorageAdapterError extends Error {
  constructor(message: string) { super(message); this.name = 'StorageAdapterError' }
}

export function createStorageAdapter(config: StorageConfig, options: StorageAdapterOptions): StorageAdapter {
  const http = createHttp(options)
  switch (config.kind) {
    case 'local-dir': return localDirAdapter(config, http)
    case 'wordpress-uploads': return wordpressAdapter(config, http)
    case 's3': return s3Adapter(config, options, http)
    case 'custom-command': return commandAdapter(config, options, http)
    default: {
      const fail = async (): Promise<never> => { throw new StorageAdapterError(`storage kind ${String((config as { kind: unknown }).kind)} is not supported: use s3, wordpress-uploads, local-dir or custom-command`) }
      return { inventory: fail, probeAnonymous: fail }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Keys and URLs
// ---------------------------------------------------------------------------------------------

export const isDirectoryKey = (key: string): boolean => key === '' || key.endsWith('/')

/** True when the key lies under one of the prefixes the owner declared intentionally public. */
export function isPublicKey(key: string, publicPrefixes: readonly string[]): boolean {
  const normalized = key.replace(/^\/+/, '')
  return publicPrefixes.some(prefix => {
    const wanted = prefix.replace(/^\/+/, '')
    return wanted !== '' && normalized.startsWith(wanted)
  })
}

/** RFC 3986 unreserved characters stay, everything else is %XX (the encoding SigV4 signs); `/` stays when asked. */
export function uriEncode(text: string, keepSlash = false): string {
  let out = ''
  for (const byte of Buffer.from(text, 'utf8')) {
    const char = String.fromCharCode(byte)
    out += /[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === '/') ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

const withSlash = (url: string): string => url.endsWith('/') ? url : `${url}/`

/** The URL of a key under a base URL; the empty key is the base itself. */
export function keyUrl(base: string, key: string): string {
  return withSlash(base) + key.replace(/^\/+/, '').split('/').map(segment => uriEncode(segment)).join('/')
}

const httpUrl = (text: string | null | undefined): string | null => text && /^https?:\/\//i.test(text) ? text : null

function normalizePrefix(prefix: string | null): string {
  const normalized = (prefix ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.split('/').some(segment => segment === '..')) throw new StorageAdapterError(`inventory prefix ${prefix} leaves the storage root`)
  return normalized
}

const bound = (limit: number): number => Math.max(0, Math.min(MAX_INVENTORY_OBJECTS, Math.floor(Number.isFinite(limit) ? limit : 0)))

// ---------------------------------------------------------------------------------------------
// Anonymous HTTP
// ---------------------------------------------------------------------------------------------

interface Http {
  /** Anonymous GET; the body is read only to recognise a listing, and only when `detectListing`. */
  probe(url: string, detectListing: boolean): Promise<{ status: number; listing: boolean }>
  /** GET returning a bounded body, for inventory sources (the site's public REST API, a listing, the signed S3 list). */
  read(url: string, maxBytes: number, headers?: Record<string, string>): Promise<{ status: number; body: string }>
}

const LISTING = [
  /<ListBucketResult[\s>]/i,
  /<title>\s*(Index of|Directory listing for)\b/i,
  /<h1>\s*(Index of|Directory listing for)\b/i,
  /\[To Parent Directory\]/i,
]

/** An Apache/nginx/IIS/Python autoindex page or an S3 ListBucketResult. */
export const looksLikeListing = (body: string): boolean => LISTING.some(pattern => pattern.test(body))

const isSuccess = (status: number | null): boolean => status !== null && status >= 200 && status < 300

function createHttp(options: StorageAdapterOptions): Http {
  const doFetch = options.fetch ?? fetch
  const gate = new NetworkGate(options.policy)
  const nextSlot = new Map<string, number>()

  const admit = async (url: string): Promise<URL> => {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new StorageAdapterError(`not a URL: ${url}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new StorageAdapterError(`${parsed.protocol} URLs are not probed; storage probes use http(s)`)
    if (parsed.username || parsed.password) throw new StorageAdapterError(`refused: ${parsed.host} URL carries credentials, and storage probes are anonymous`)
    if (!options.policy.allowPrivateAddresses && (isPrivateHost(parsed.hostname) || await gate.refusesHost(parsed.hostname))) {
      throw new StorageAdapterError(`private address ${parsed.hostname} refused for a ${options.policy.environmentKind} environment`)
    }
    const rate = options.policy.requestsPerSecondPerOrigin
    if (rate > 0) {
      const now = Date.now()
      const start = Math.max(now, nextSlot.get(parsed.host) ?? now)
      nextSlot.set(parsed.host, start + 1000 / rate)
      if (start > now) await new Promise(done => setTimeout(done, start - now))
    }
    return parsed
  }

  const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
    const parsed = await admit(url)
    try {
      return await doFetch(parsed.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { accept: '*/*', ...headers }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`GET ${parsed.origin}${parsed.pathname} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async probe(url, detectListing) {
      const response = await get(url)
      if (isSuccess(response.status) && detectListing) return { status: response.status, listing: looksLikeListing(await readBounded(response, MAX_LISTING_BYTES)) }
      await response.body?.cancel().catch(() => undefined)
      return { status: response.status, listing: false }
    },
    async read(url, maxBytes, headers) {
      const response = await get(url, headers)
      return { status: response.status, body: await readBounded(response, maxBytes) }
    },
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8')
}

/** Network failures of an optional inventory source are ignored; a policy refusal is not. */
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read() } catch (error) {
    if (error instanceof StorageAdapterError) throw error
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// local-dir
// ---------------------------------------------------------------------------------------------

function requireBase(config: StorageConfig): string {
  const base = httpUrl(config.publicBaseUrl)
  if (!base) throw new StorageAdapterError(`${config.kind} storage at ${config.location} needs publicBaseUrl (the URL it is served under) before it can be probed`)
  return base
}

function localDirAdapter(config: StorageConfig, http: Http): StorageAdapter {
  return {
    async inventory(prefix, limit) {
      const entries = await walkDirectory(config.location, normalizePrefix(prefix), bound(limit))
      return entries.map(entry => ({ ...entry, public: isPublicKey(entry.key, config.publicPrefixes) }))
    },
    async probeAnonymous(key) {
      return http.probe(keyUrl(requireBase(config), key), isDirectoryKey(key))
    },
  }
}

/** Breadth first, names sorted, dotfiles and symlinks skipped; directories are entries too (`dir/`). */
async function walkDirectory(location: string, prefix: string, limit: number): Promise<StorageEntry[]> {
  const root = await stat(location).catch(() => null)
  if (!root?.isDirectory()) throw new StorageAdapterError(`local-dir storage location ${location} is not a readable directory`)
  const entries: StorageEntry[] = []
  const queue: Array<{ relative: string; depth: number }> = [{ relative: prefix.replace(/\/+$/, ''), depth: 0 }]
  while (queue.length && entries.length < limit) {
    const { relative, depth } = queue.shift()!
    const items = await readdir(relative ? join(location, ...relative.split('/')) : location, { withFileTypes: true }).catch(() => null)
    if (!items) continue
    items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const item of items) {
      if (entries.length >= limit) break
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue
      const key = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) {
        entries.push({ key: `${key}/`, bytes: 0, public: false, lastModified: null, source: 'disk' })
        if (depth + 1 < MAX_WALK_DEPTH) queue.push({ relative: key, depth: depth + 1 })
      } else if (item.isFile()) {
        const info = await stat(join(location, ...key.split('/'))).catch(() => null)
        entries.push({ key, bytes: info?.size ?? 0, public: false, lastModified: info ? info.mtime.toISOString() : null, source: 'disk' })
      }
    }
  }
  return entries
}

// ---------------------------------------------------------------------------------------------
// wordpress-uploads
// ---------------------------------------------------------------------------------------------

/**
 * Where WordPress and its commerce, form and backup plugins keep private files under uploads/.
 * Wildcard locations (`backup-*`, any root `*.sql`/`*.zip`, export CSVs) cannot be enumerated
 * anonymously: the common names stand in, and a served uploads listing adds the real ones.
 */
export const WORDPRESS_PRIVATE_KEYS: readonly string[] = [
  'woocommerce_uploads/', 'wc-logs/', 'wpforms/', 'gravity_forms/', 'updraft/', 'ai1wm-backups/', 'backups/', 'edd/', 'wp-migrate-db/',
  'backup.sql', 'database.sql', 'db.sql', 'dump.sql', 'backup.zip', 'site-backup.zip',
  'orders.csv', 'customers.csv', 'users.csv', 'export.csv',
]

const UPLOADS_PATH = 'wp-content/uploads/'

function wordpressAdapter(config: StorageConfig, http: Http): StorageAdapter {
  const locate = (): { base: string; site: string | null } => {
    const site = httpUrl(config.location)
    const base = httpUrl(config.publicBaseUrl) ?? (site ? new URL(UPLOADS_PATH, withSlash(site)).href : null)
    if (!base) throw new StorageAdapterError(`wordpress-uploads storage needs the site URL as location or a publicBaseUrl (got ${config.location})`)
    const root = site ? withSlash(site) : withSlash(base).endsWith(`/${UPLOADS_PATH}`) ? withSlash(base).slice(0, -UPLOADS_PATH.length) : null
    return { base: withSlash(base), site: root }
  }
  return {
    async inventory(prefix, limit) {
      const { base, site } = locate()
      const wanted = normalizePrefix(prefix)
      const max = bound(limit)
      const found = new Map<string, StorageEntry>()
      const add = (key: string, entry: Omit<StorageEntry, 'key' | 'public'> & { public?: boolean }): void => {
        if (found.size >= max || found.has(key) || !key.startsWith(wanted)) return
        found.set(key, { key, public: entry.public ?? isPublicKey(key, config.publicPrefixes), bytes: entry.bytes, lastModified: entry.lastModified, source: entry.source })
      }
      for (const key of WORDPRESS_PRIVATE_KEYS) add(key, { bytes: 0, lastModified: null, source: 'known-private-location' })

      const listing = await optional(() => http.read(base, MAX_LISTING_BYTES))
      if (listing && isSuccess(listing.status) && looksLikeListing(listing.body)) {
        for (const name of listingNames(listing.body)) add(name, { bytes: 0, lastModified: null, source: 'uploads-listing' })
      }

      if (site) {
        const media = await optional(() => http.read(`${site}wp-json/wp/v2/media?per_page=100`, MAX_INVENTORY_BODY_BYTES))
        if (media && isSuccess(media.status)) {
          let items: unknown = null
          try { items = JSON.parse(media.body) } catch { items = null }
          for (const item of Array.isArray(items) ? items.slice(0, 100) : []) {
            const record = item as { source_url?: unknown; media_details?: { filesize?: unknown }; modified_gmt?: unknown }
            if (typeof record?.source_url !== 'string' || !record.source_url.startsWith(base)) continue
            let key: string
            try { key = decodeURIComponent(record.source_url.slice(base.length).split(/[?#]/)[0]!) } catch { continue }
            const modified = typeof record.modified_gmt === 'string' ? new Date(`${record.modified_gmt}Z`) : null
            add(key, {
              public: true, bytes: Number(record.media_details?.filesize) || 0, source: 'rest-media',
              lastModified: modified && !Number.isNaN(modified.getTime()) ? modified.toISOString() : null,
            })
          }
        }
      }
      return [...found.values()]
    },
    async probeAnonymous(key) {
      return http.probe(keyUrl(locate().base, key), isDirectoryKey(key))
    },
  }
}

/** Entry names (one segment, `name/` for directories) linked from an autoindex page. */
export function listingNames(body: string): string[] {
  const names: string[] = []
  for (const match of body.matchAll(/href\s*=\s*"([^"]+)"/gi)) {
    let href = match[1]!
    if (/^([a-z]+:|\/|\?|#)/i.test(href)) continue
    try { href = decodeURIComponent(href) } catch { continue }
    href = href.replace(/^\.\//, '')
    if (!href || href.startsWith('.') || /\/./.test(href)) continue
    if (!names.includes(href)) names.push(href)
    if (names.length >= MAX_LISTING_NAMES) break
  }
  return names
}

// ---------------------------------------------------------------------------------------------
// s3 (AWS Signature Version 4, implemented here so no SDK is needed)
// ---------------------------------------------------------------------------------------------

export interface S3Credentials { accessKeyId: string; secretAccessKey: string; region: string | null }

const ALGORITHM = 'AWS4-HMAC-SHA256'
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

/** `ACCESS_KEY_ID:SECRET[:REGION]`; the error never repeats the value. */
export function parseS3Credential(value: string): S3Credentials {
  const [accessKeyId, secretAccessKey, region] = value.trim().split(':')
  if (!accessKeyId || !secretAccessKey) throw new StorageAdapterError('the s3 credential must have the form ACCESS_KEY_ID:SECRET[:REGION]')
  return { accessKeyId, secretAccessKey, region: region || null }
}

/** `20130524T000000Z`. */
export const amzDate = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')

/** Parameters encoded with uriEncode and sorted by encoded name, then value. */
export function canonicalQueryString(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`).join('&')
}

const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest()
const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex')

function signature(credentials: S3Credentials, region: string, stamp: string, canonicalRequest: string): { scope: string; signature: string } {
  const day = stamp.slice(0, 8)
  const scope = `${day}/${region}/s3/aws4_request`
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), 's3'), 'aws4_request')
  return { scope, signature: createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex') }
}

const scopeFor = (credentials: S3Credentials, region: string, stamp: string): string => `${credentials.accessKeyId}/${stamp.slice(0, 8)}/${region}/s3/aws4_request`

/** A presigned GET URL (query-string SigV4, `UNSIGNED-PAYLOAD`, only `host` signed). The URL's path must already be uriEncoded. */
export function presignS3Url(input: { url: string; credentials: S3Credentials; region: string; date: Date; expiresSeconds: number }): string {
  const parsed = new URL(input.url)
  const stamp = amzDate(input.date)
  const query = canonicalQueryString([
    ...parsed.searchParams.entries(),
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', scopeFor(input.credentials, input.region, stamp)],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ])
  const canonicalRequest = ['GET', parsed.pathname, query, `host:${parsed.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  return `${parsed.origin}${parsed.pathname}?${query}&X-Amz-Signature=${signature(input.credentials, input.region, stamp, canonicalRequest).signature}`
}

/** Header-signed GET without a body: the Authorization, x-amz-date and x-amz-content-sha256 headers to send. */
export function signS3Headers(input: { url: string; credentials: S3Credentials; region: string; date: Date }): Record<string, string> {
  const parsed = new URL(input.url)
  const stamp = amzDate(input.date)
  const headers: Array<[string, string]> = [['host', parsed.host], ['x-amz-content-sha256', EMPTY_SHA256], ['x-amz-date', stamp]]
  const signedHeaders = headers.map(([name]) => name).join(';')
  const canonicalRequest = [
    'GET', parsed.pathname, canonicalQueryString([...parsed.searchParams.entries()]),
    headers.map(([name, value]) => `${name}:${value}\n`).join(''), signedHeaders, EMPTY_SHA256,
  ].join('\n')
  const signed = signature(input.credentials, input.region, stamp, canonicalRequest)
  return {
    authorization: `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${signed.scope}, SignedHeaders=${signedHeaders}, Signature=${signed.signature}`,
    'x-amz-date': stamp,
    'x-amz-content-sha256': EMPTY_SHA256,
  }
}

export interface S3Target {
  bucket: string
  prefix: string
  region: string
  /** The bucket's URL for ListObjectsV2 (`?list-type=2`). */
  bucketUrl: string
  objectUrl(key: string): string
}

const VIRTUAL_HOST = /^(.+?)\.s3(?:[.-](?:dualstack\.)?([a-z0-9-]+))?\.amazonaws\.com$/i
const PATH_HOST = /^s3(?:[.-](?:dualstack\.)?([a-z0-9-]+))?\.amazonaws\.com$/i

/**
 * `s3://bucket/prefix`, a virtual-hosted or path-style AWS URL, or any other http(s) endpoint taken as
 * path style (`https://endpoint/bucket/prefix`: MinIO, R2, a loopback fake).
 */
export function resolveS3Location(location: string, credentialRegion: string | null): S3Target {
  let origin: string
  let bucket: string
  let prefix: string
  let pathStyle: boolean
  let region = credentialRegion
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(location.trim())
  if (s3) {
    bucket = s3[1]!
    prefix = s3[2]!
    region ??= 'us-east-1'
    pathStyle = bucket.includes('.')
    origin = pathStyle ? `https://s3.${region}.amazonaws.com` : `https://${bucket}.s3.${region}.amazonaws.com`
  } else {
    let parsed: URL
    try { parsed = new URL(location) } catch { throw new StorageAdapterError(`s3 location ${location} is neither s3://bucket/prefix nor an http(s) bucket URL`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new StorageAdapterError(`s3 location ${location} is neither s3://bucket/prefix nor an http(s) bucket URL`)
    origin = parsed.origin
    const segments = parsed.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
    const virtual = VIRTUAL_HOST.exec(parsed.hostname)
    if (virtual && !PATH_HOST.test(parsed.hostname)) {
      bucket = virtual[1]!
      region ??= virtual[2] ?? null
      pathStyle = false
      prefix = segments.join('/')
    } else {
      region ??= PATH_HOST.exec(parsed.hostname)?.[1] ?? null
      const first = segments.shift()
      if (!first) throw new StorageAdapterError(`s3 location ${location} names no bucket (expected https://endpoint/bucket/prefix)`)
      bucket = first
      pathStyle = true
      prefix = segments.join('/')
    }
    if (prefix && parsed.pathname.endsWith('/')) prefix += '/'
    region ??= 'us-east-1'
  }
  const bucketUrl = pathStyle ? `${origin}/${uriEncode(bucket)}` : `${origin}/`
  return {
    bucket, prefix, region, bucketUrl,
    objectUrl: key => `${pathStyle ? `${bucketUrl}/` : bucketUrl}${uriEncode(key.replace(/^\/+/, ''), true)}`,
  }
}

const xmlText = (text: string): string => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, '&')
const tag = (xml: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match ? xmlText(match[1]!) : null
}

function s3Adapter(config: StorageConfig, options: StorageAdapterOptions, http: Http): StorageAdapter {
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)))
  const credentials = (): S3Credentials | null => {
    if (!config.credentialRef || !options.resolveCredential) return null
    const value = options.resolveCredential(config.credentialRef)
    return value ? parseS3Credential(value) : null
  }
  const requireCredentials = (what: string): S3Credentials => {
    const resolved = credentials()
    if (resolved) return resolved
    const ref = config.credentialRef
    throw new StorageAdapterError(`${what} needs an s3 credential (ACCESS_KEY_ID:SECRET[:REGION]): ${ref ? `credential ${ref.id} (${ref.source} ${ref.key}) did not resolve` : 'set credentialRef on the storage config'}`)
  }
  return {
    async inventory(prefix, limit) {
      const signing = requireCredentials('s3 inventory (ListObjectsV2)')
      const target = resolveS3Location(config.location, signing.region)
      const listPrefix = prefix === null ? target.prefix : normalizePrefix(prefix)
      const max = bound(limit)
      const entries: StorageEntry[] = []
      let token: string | null = null
      for (let page = 0; page < MAX_LIST_PAGES && entries.length < max; page++) {
        const params: Array<[string, string]> = [['list-type', '2'], ['max-keys', String(Math.min(1000, max - entries.length))]]
        if (listPrefix) params.push(['prefix', listPrefix])
        if (token) params.push(['continuation-token', token])
        const url = `${target.bucketUrl}?${canonicalQueryString(params)}`
        const { status, body } = await http.read(url, MAX_INVENTORY_BODY_BYTES, signS3Headers({ url, credentials: signing, region: target.region, date: now() }))
        if (!isSuccess(status)) {
          const code = tag(body, 'Code')
          throw new StorageAdapterError(`ListObjectsV2 on bucket ${target.bucket} answered HTTP ${status}${code ? ` (${code})` : ''}: check the credential's s3:ListBucket permission and the region ${target.region}`)
        }
        for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = tag(match[1]!, 'Key')
          if (key === null || entries.length >= max) continue
          const modified = tag(match[1]!, 'LastModified')
          entries.push({ key, bytes: Number(tag(match[1]!, 'Size')) || 0, public: isPublicKey(key, config.publicPrefixes), lastModified: modified, source: 'list-objects' })
        }
        token = tag(body, 'IsTruncated') === 'true' ? tag(body, 'NextContinuationToken') : null
        if (!token) break
      }
      return entries
    },
    async probeAnonymous(key) {
      let region: string | null = null
      try { region = credentials()?.region ?? null } catch { region = null }
      const target = resolveS3Location(config.location, region)
      if (!isDirectoryKey(key)) return http.probe(target.objectUrl(key), false)
      const params: Array<[string, string]> = [['list-type', '2'], ['max-keys', '1']]
      if (key) params.push(['prefix', key])
      return http.probe(`${target.bucketUrl}?${canonicalQueryString(params)}`, true)
    },
    async signedLinkExpiry(key, ttlSeconds) {
      if (isDirectoryKey(key)) throw new StorageAdapterError(`a signed link is minted for an object, not the directory ${key || '/'}`)
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_TTL_SECONDS) throw new StorageAdapterError(`signed-link TTL must be 1..${MAX_SIGNED_TTL_SECONDS} seconds (got ${ttlSeconds})`)
      const signing = requireCredentials('the signed-link expiry test')
      const target = resolveS3Location(config.location, signing.region)
      const url = presignS3Url({ url: target.objectUrl(key), credentials: signing, region: target.region, date: now(), expiresSeconds: ttlSeconds })
      const before = await http.probe(url, false)
      await sleep((ttlSeconds + 2) * 1000)
      const after = await http.probe(url, false)
      return { beforeStatus: before.status, afterStatus: after.status }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// custom-command
// ---------------------------------------------------------------------------------------------

/**
 * `location` is a command line the owner's project provides; it prints
 * `{"objects":[{"key","bytes","public","lastModified","url"}]}`. There is no default spawn here: the
 * runner injects `runCommand` (so the command runs where and how the runner decides). Probes go to
 * each object's `url`; a directory's URL is derived from an object below it whose URL ends in its key.
 */
function commandAdapter(config: StorageConfig, options: StorageAdapterOptions, http: Http): StorageAdapter {
  const urls = new Map<string, string>()
  const base = (): string | null => {
    for (const [key, url] of urls) {
      const tail = key.replace(/^\/+/, '').split('/').map(segment => uriEncode(segment)).join('/')
      if (url.endsWith(tail)) return url.slice(0, url.length - tail.length)
      if (url.endsWith(key)) return url.slice(0, url.length - key.length)
    }
    return httpUrl(config.publicBaseUrl)
  }
  return {
    async inventory(prefix, limit) {
      if (!options.runCommand) throw new StorageAdapterError('custom-command storage needs a command runner, and none was provided to the storage adapter')
      const wanted = normalizePrefix(prefix)
      const output = await options.runCommand(config.location)
      let parsed: unknown
      try { parsed = JSON.parse(output) } catch { throw new StorageAdapterError(`the storage command did not print JSON (${output.slice(0, 200)})`) }
      const objects = (parsed as { objects?: unknown })?.objects
      if (!Array.isArray(objects)) throw new StorageAdapterError('the storage command must print {"objects":[{"key","bytes","public","lastModified","url"}]}')
      const entries: StorageEntry[] = []
      const max = bound(limit)
      for (const item of objects) {
        if (entries.length >= max) break
        const record = item as Record<string, unknown>
        if (typeof record?.key !== 'string' || !record.key.startsWith(wanted)) continue
        if (typeof record.url === 'string' && httpUrl(record.url)) urls.set(record.key, record.url)
        entries.push({
          key: record.key, bytes: Number(record.bytes) || 0, public: record.public === true,
          lastModified: typeof record.lastModified === 'string' ? record.lastModified : null, source: 'command',
        })
      }
      return entries
    },
    async probeAnonymous(key) {
      let url = urls.get(key) ?? null
      if (!url) {
        const root = base()
        if (root) url = keyUrl(root, key)
      }
      if (!url) throw new StorageAdapterError(`no URL is known for ${key || '/'}: run the inventory first, print a url per object, or set publicBaseUrl`)
      return http.probe(url, isDirectoryKey(key))
    },
  }
}
