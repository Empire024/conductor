import {
  RELAY_ACK_FILE,
  RELAY_DIRECTORY_FILE,
  RELAY_GIST_DESCRIPTION,
  type RelayDirectoryEntry
} from '../shared/remote-relay'

/**
 * The mailbox itself: one private gist per machine, owned by the account both machines are signed
 * into. A machine writes only to the gist it created and only reads the others, so two machines
 * never race on one file and no server has to exist for them to meet.
 *
 * Nothing here understands a message. It moves opaque JSON files and keeps the API costs sane —
 * everything that decides what a message means, or who may read it, is in relay-crypto and
 * remote-relay.
 */

const GIST_ID_SETTING = 'remote-control.relay.gistId'
const LIST_PATH = '/gists?per_page=100'

export interface GistFile {
  filename: string
  size: number
  truncated?: boolean
  content?: string
  raw_url?: string
}

export interface GistSummary {
  id: string
  description: string
  updatedAt: string
  files: Record<string, GistFile>
}

export interface RelayApiResult {
  response: { status: number; ok: boolean; headers: { get(name: string): string | null } }
  body: unknown
}

export interface GitHubRelayMailboxDependencies {
  /** An authenticated api.github.com request; the relay only ever asks for /gists paths. */
  api(path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<RelayApiResult>
  /** Raw fetch for a gist file GitHub truncated out of the JSON response. */
  fetchRaw(url: string): Promise<string>
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  now?(): number
}

export class RelayUnavailableError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message) }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function readGist(value: unknown): GistSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.files)) return null
  const files: Record<string, GistFile> = {}
  for (const [name, raw] of Object.entries(value.files)) {
    if (!isRecord(raw) || typeof raw.filename !== 'string') continue
    files[name] = {
      filename: raw.filename,
      size: Number(raw.size) || 0,
      truncated: raw.truncated === true,
      content: typeof raw.content === 'string' ? raw.content : undefined,
      raw_url: typeof raw.raw_url === 'string' ? raw.raw_url : undefined
    }
  }
  return {
    id: value.id,
    description: typeof value.description === 'string' ? value.description : '',
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : '',
    files
  }
}

/**
 * A gist read is the relay's poll, so it is the one call that happens over and over. GitHub does
 * not charge rate limit for a 304, so every read is conditional: idle machines cost one free
 * request per poll instead of one of the account's 5000 per hour.
 */
interface CachedGist { etag: string; gist: GistSummary }

export class GitHubRelayMailbox {
  private cache = new Map<string, CachedGist>()
  private listEtag: string | null = null
  private listCache: GistSummary[] | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private rateLimitedUntil = 0

  constructor(private readonly deps: GitHubRelayMailboxDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private assertUsable(): void {
    if (this.rateLimitedUntil > this.now()) {
      throw new RelayUnavailableError('GitHub is rate limiting this account; the relay will retry shortly.', this.rateLimitedUntil - this.now())
    }
  }

  /**
   * Turns a GitHub answer into either a result or a reason to wait. A missing `gist` scope is the
   * one failure the owner has to act on, so it is named rather than reported as a network problem.
   */
  private check(result: RelayApiResult, what: string): RelayApiResult {
    const { response } = result
    if (response.ok) return result
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    if (remaining === '0' && Number.isFinite(reset) && reset > 0) {
      this.rateLimitedUntil = reset * 1000
      throw new RelayUnavailableError('GitHub is rate limiting this account; the relay will retry shortly.', Math.max(0, this.rateLimitedUntil - this.now()))
    }
    // A token without the `gist` scope is refused as 401, 403 or 404 depending on the endpoint, and
    // the owner has to re-authorize either way. Only the header actually settles it, so it decides
    // rather than the status: anyone signed in before the relay existed lands here exactly once.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      const scopes = response.headers.get('x-oauth-scopes')
      if (scopes !== null && !scopes.split(/\s*,\s*/).map(scope => scope.trim()).includes('gist')) {
        throw new RelayUnavailableError('Sign out of GitHub and back in on this machine, so Conductor may keep the encrypted relay mailbox in a private gist on your account.')
      }
    }
    throw new RelayUnavailableError(`GitHub could not ${what} (${response.status}).`)
  }

  /** Own mailbox, created on first use. The id is remembered so the list call is not the hot path. */
  async ensureGist(): Promise<string> {
    this.assertUsable()
    const known = this.deps.getSetting(GIST_ID_SETTING)
    if (known) {
      const result = await this.deps.api(`/gists/${encodeURIComponent(known)}`)
      if (result.response.ok) return known
      // A 404 means the owner deleted it; anything else is not a reason to make a second mailbox.
      if (result.response.status !== 404) this.check(result, 'read the relay mailbox')
    }
    const created = this.check(await this.deps.api('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: RELAY_GIST_DESCRIPTION,
        public: false,
        files: { [RELAY_ACK_FILE]: { content: JSON.stringify({ version: 1, acked: [] }) } }
      })
    }), 'create the relay mailbox')
    const gist = readGist(created.body)
    if (!gist) throw new RelayUnavailableError('GitHub returned a relay mailbox this version cannot read.')
    this.deps.setSetting(GIST_ID_SETTING, gist.id)
    this.cache.delete(gist.id)
    return gist.id
  }

  /** Writes to this machine's own gist, serialized so two callers cannot lose each other's files. */
  async write(files: Record<string, string | null>): Promise<void> {
    const run = async (): Promise<void> => {
      this.assertUsable()
      const payload: Record<string, { content: string } | null> = {}
      for (const [name, content] of Object.entries(files)) payload[name] = content === null ? null : { content }
      const patch = async (id: string): Promise<RelayApiResult> =>
        await this.deps.api(`/gists/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ files: payload }) })
      let id = await this.ensureGist()
      let result = await patch(id)
      if (result.response.status === 404) {
        // The owner deleted the mailbox out from under us, which is their right. Make another one
        // and write there rather than reporting the relay broken until the app restarts.
        this.deps.setSetting(GIST_ID_SETTING, '')
        id = await this.ensureGist()
        result = await patch(id)
      }
      this.check(result, 'update the relay mailbox')
      this.cache.delete(id)
      // Our own gist just moved, so the account's gist list is no longer what the ETag describes.
      this.listEtag = null
      this.listCache = null
    }
    const queued = this.writes.then(run, run)
    // The chain must survive a failed write, or one error would stop every later one.
    this.writes = queued.catch(() => undefined)
    return queued
  }

  async publishDirectory(entry: RelayDirectoryEntry): Promise<void> {
    await this.write({ [RELAY_DIRECTORY_FILE]: JSON.stringify(entry, null, 2) })
  }

  /**
   * Every Conductor mailbox on this account except this machine's own. The list is what the poll
   * loop asks for over and over, so it is conditional as well; only the file names come back here,
   * and `read` fetches the contents of the ones that matter.
   */
  async peerGists(): Promise<GistSummary[]> {
    this.assertUsable()
    const own = this.deps.getSetting(GIST_ID_SETTING)
    const result = await this.deps.api(LIST_PATH, this.listEtag ? { headers: { 'If-None-Match': this.listEtag } } : undefined)
    if (result.response.status === 304 && this.listCache) return this.listCache.filter(gist => gist.id !== own)
    this.check(result, 'list the relay mailboxes')
    const entries = Array.isArray(result.body) ? result.body : []
    const gists = entries.flatMap(entry => {
      const gist = readGist(entry)
      return gist && gist.description === RELAY_GIST_DESCRIPTION ? [gist] : []
    })
    const etag = result.response.headers.get('etag')
    this.listEtag = etag
    this.listCache = etag ? gists : null
    return gists.filter(gist => gist.id !== own)
  }

  /** One gist with its file contents, conditional on the last ETag so an idle poll is free. */
  async read(gistId: string): Promise<GistSummary | null> {
    this.assertUsable()
    const cached = this.cache.get(gistId)
    const result = await this.deps.api(`/gists/${encodeURIComponent(gistId)}`, cached ? { headers: { 'If-None-Match': cached.etag } } : undefined)
    if (result.response.status === 304 && cached) return cached.gist
    if (result.response.status === 404) { this.cache.delete(gistId); return null }
    this.check(result, 'read a relay mailbox')
    const gist = readGist(result.body)
    if (!gist) return null
    const etag = result.response.headers.get('etag')
    if (etag) this.cache.set(gistId, { etag, gist })
    return gist
  }

  /** The ETag a conditional read of this gist should carry, if one is known. */
  etag(gistId: string): string | null { return this.cache.get(gistId)?.etag ?? null }

  /** This machine's own mailbox as it stands on GitHub, for collecting what it left behind. */
  async own(): Promise<GistSummary | null> {
    return await this.read(await this.ensureGist())
  }

  /** GitHub omits the content of a gist file over 1 MB, which only a malformed message reaches. */
  async content(file: GistFile): Promise<string | null> {
    if (typeof file.content === 'string' && !file.truncated) return file.content
    if (!file.raw_url) return null
    try { return await this.deps.fetchRaw(file.raw_url) } catch { return null }
  }

  forget(): void {
    this.cache.clear()
    this.listEtag = null
    this.listCache = null
    this.rateLimitedUntil = 0
  }
}
