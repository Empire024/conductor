import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectTaskDispatchOptions } from '../../shared/project-backlog'
import type { ScheduleDefinition } from '../../shared/schedules'
import type { ScheduleStore, ScheduleSourceState } from '../schedule-store'
import type { ScheduleJobContext, ScheduleJobResult } from './index'

const MAX_BODY_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 10_000
const SOURCE_TTL_MS = 24 * 60 * 60_000

export const LATEST_MODEL_SOURCES = [
  { id: 'openai-models', url: 'https://developers.openai.com/api/docs/models/all.md', origin: 'https://developers.openai.com', accept: 'text/markdown, text/plain;q=0.9' },
  { id: 'anthropic-models', url: 'https://platform.claude.com/docs/en/models/overview.md', origin: 'https://platform.claude.com', accept: 'text/markdown, text/plain;q=0.9' },
  { id: 'llama-cpp-release', url: 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', origin: 'https://api.github.com', accept: 'application/vnd.github+json' },
  { id: 'qwen-3.5-9b-metadata', url: 'https://huggingface.co/api/models/Qwen/Qwen3.5-9B?expand[]=sha&expand[]=lastModified&expand[]=tags', origin: 'https://huggingface.co', accept: 'application/json' }
] as const

type FetchLike = typeof fetch
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const decodeEntities = (value: string): string => value
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")

/** Stable text only: scripts, styles, volatile build identifiers, nonces and timestamps never enter evidence. */
export function normalizePrimarySource(value: string): string {
  return decodeEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/\b(?:nonce|csrf|build(?:Id|Hash)?)["']?\s*[:=]\s*["'][^"']+["']/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BODY_BYTES)
}

const readableDiff = (before: string, after: string): string => {
  if (!before) return 'Initial validated snapshot recorded.'
  const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9._-]{2,}/g) ?? [])
  const oldWords = words(before), newWords = words(after)
  const added = [...newWords].filter(word => !oldWords.has(word)).slice(0, 12)
  const removed = [...oldWords].filter(word => !newWords.has(word)).slice(0, 12)
  const parts = [added.length ? `added: ${added.join(', ')}` : '', removed.length ? `removed: ${removed.join(', ')}` : ''].filter(Boolean)
  return parts.length ? parts.join('; ') : 'Content changed without a stable keyword-level difference.'
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) throw new Error('Source response exceeded 256 KB')
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) {
        await reader.cancel('Source response exceeded 256 KB')
        throw new Error('Source response exceeded 256 KB')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export class LatestModelsJob {
  constructor(private readonly options: {
    store: ScheduleStore
    artifactDirectory: string
    catalog(projectId: string): ProjectTaskDispatchOptions
    fetch?: FetchLike
  }) {}

  async run(context: ScheduleJobContext): Promise<ScheduleJobResult> {
    const now = context.now, fetchedAt = now.toISOString(), validUntil = new Date(now.getTime() + SOURCE_TTL_MS).toISOString()
    const changes: string[] = [], failures: string[] = []
    const evidence: Array<{source:string;digest?:string;validUntil?:string;summary:string;status:'fresh'|'failed'}> = []
    const staged: ScheduleSourceState[] = []
    const fetcher = this.options.fetch ?? fetch

    for (const source of LATEST_MODEL_SOURCES) {
      try {
        if (context.signal.aborted) throw context.signal.reason
        const previous = this.options.store.source(context.schedule.id, source.id)
        const headers = new Headers({ Accept: source.accept })
        if (previous?.etag) headers.set('If-None-Match', previous.etag)
        if (previous?.lastModified) headers.set('If-Modified-Since', previous.lastModified)
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        const response = await fetcher(source.url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal })
        if (response.status !== 304 && response.status >= 300 && response.status < 400) throw new Error('attempted a redirect; source origins are pinned')
        if (new URL(response.url || source.url).origin !== source.origin) throw new Error('returned an unexpected origin')
        if (response.status === 304) {
          if (!previous) throw new Error('returned 304 without cached evidence')
          const refreshed = { ...previous, fetchedAt, validUntil }
          staged.push(refreshed)
          evidence.push({ source: source.id, digest: previous.digest, validUntil, summary: 'Not modified by primary source.', status: 'fresh' })
          continue
        }
        if (!response.ok) throw new Error(`returned HTTP ${response.status}`)
        const normalized = normalizePrimarySource(await boundedText(response))
        if (normalized.length < 40) throw new Error('did not contain enough readable content to validate')
        const current: ScheduleSourceState = {
          scheduleId: context.schedule.id, sourceId: source.id, etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'), digest: digest(normalized), normalized, fetchedAt, validUntil
        }
        const changed = previous?.digest !== current.digest
        const summary = changed ? readableDiff(previous?.normalized ?? '', normalized) : 'Normalized content is unchanged.'
        if (changed) changes.push(`${source.id}: ${summary}`)
        staged.push(current)
        evidence.push({ source: source.id, digest: current.digest, validUntil, summary, status: 'fresh' })
      } catch (reason) {
        if (context.signal.aborted) throw reason
        const message = `${source.id}: ${reason instanceof Error ? reason.message : String(reason)}`
        failures.push(message)
        evidence.push({ source: source.id, summary: message, status: 'failed' })
      }
    }

    context.signal.throwIfAborted()
    const localId = 'conductor-model-catalog'
    const previousLocal = this.options.store.source(context.schedule.id, localId)
    const catalog = this.options.catalog(context.schedule.projectId)
    const normalizedLocal = JSON.stringify(catalog.providers.map(provider => ({
      provider: provider.provider, available: provider.available, source: provider.source,
      models: provider.models.map(model => ({ id: model.id, label: model.label, effort: model.effort ?? [], defaultEffort: model.defaultEffort ?? null })).sort((a, b) => a.id.localeCompare(b.id))
    })).sort((a, b) => a.provider.localeCompare(b.provider)))
    const localState: ScheduleSourceState = { scheduleId: context.schedule.id, sourceId: localId, etag: null, lastModified: null, digest: digest(normalizedLocal), normalized: normalizedLocal, fetchedAt, validUntil }
    const localChanged = previousLocal?.digest !== localState.digest
    const localSummary = localChanged ? readableDiff(previousLocal?.normalized ?? '', normalizedLocal) : 'Runtime catalog is unchanged.'
    if (localChanged) changes.push(`${localId}: ${localSummary}`)
    staged.push(localState)
    evidence.push({ source: localId, digest: localState.digest, validUntil, summary: localSummary, status: 'fresh' })

    const successful = evidence.filter(item => item.status === 'fresh')
    if (successful.length === 1 && failures.length) throw new Error(`No remote primary source produced fresh evidence. ${failures.join(' | ')}`)
    const overallDigest = digest(successful.map(item => `${item.source}:${item.digest}`).join('\n'))
    if (!changes.length) {
      context.signal.throwIfAborted()
      for (const state of staged) this.options.store.saveSource(state)
      return failures.length
        ? { outcome: 'stale', detail: `Unchanged usable evidence; ${failures.join(' | ')} No agent turn was started.`, digest: overallDigest, validUntil }
        : { outcome: 'unchanged', detail: 'All primary sources and the runtime catalog are unchanged. No agent turn was started.', digest: overallDigest, validUntil }
    }

    const artifactPath = join(this.options.artifactDirectory, `${context.schedule.projectId}-${context.schedule.id}-${fetchedAt.replace(/[:.]/g, '-')}.json`)
    await mkdir(dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, JSON.stringify({ fetchedAt, validUntil, digest: overallDigest, changes, failures, evidence }, null, 2), 'utf8')
    context.signal.throwIfAborted()
    for (const state of staged) this.options.store.saveSource(state)
    return { outcome: 'changed', detail: [...changes, ...failures.map(item => `Warning: ${item}`)].join('\n'), digest: overallDigest, validUntil, artifactPath }
  }
}
