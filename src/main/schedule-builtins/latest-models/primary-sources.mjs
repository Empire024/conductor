// Latest models, step 3: facts from the providers' own pages. Conditional GETs of a fixed
// allowlist (the sources the old latest-models job used): 10 s timeout, a streaming 256 KB cap,
// no redirects (origins are pinned), no cookies or credentials. Only extracted facts are printed,
// never page text: the model ids a page names, llama.cpp's latest release tag, the Qwen model's
// revision sha.
//
// A network blip must not look like a change: facts are cached per source in
// CONDUCTOR_SCHEDULE_STATE_DIR, and on 304 or a failed fetch the cached facts are printed again
// (the failure goes to stderr). A source that keeps failing is marked `stale` from its third
// consecutive failed run, so a page that moved for good surfaces once instead of hiding forever.
// Exit 1 only when no source has fresh or cached facts.
//
// Tests only: CONDUCTOR_SCHEDULE_TEST_SOURCES may map source ids to loopback URLs
// ({"openai-models":"http://127.0.0.1:1234/openai"}), so the fetch, cache and extraction paths
// run against a local server. Any other host is refused, so it cannot widen the allowlist.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BODY_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 10_000
const STALE_AFTER_FAILURES = 3
const MAX_IDS = 400
const log = message => process.stderr.write(`[primary-sources] ${message}\n`)
// No process.exit(): on Windows, exiting while fetch keep-alive sockets are open can abort Node
// (0xC0000409). Idle sockets are unref'd, so the process ends by itself.
const finish = (value, code) => { process.exitCode = code; process.stdout.write(JSON.stringify(value, null, 2) + '\n') }

const SOURCES = [
  { id: 'anthropic-models', url: 'https://platform.claude.com/docs/en/models/overview.md', accept: 'text/markdown, text/plain;q=0.9', extract: 'anthropic' },
  { id: 'llama-cpp-release', url: 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', accept: 'application/vnd.github+json', extract: 'release' },
  { id: 'openai-models', url: 'https://developers.openai.com/api/docs/models/all.md', accept: 'text/markdown, text/plain;q=0.9', extract: 'openai' },
  { id: 'qwen-3.5-9b-metadata', url: 'https://huggingface.co/api/models/Qwen/Qwen3.5-9B?expand[]=sha&expand[]=lastModified&expand[]=tags', accept: 'application/json', extract: 'huggingface' }
]

function testOverrides() {
  const raw = process.env.CONDUCTOR_SCHEDULE_TEST_SOURCES
  if (!raw) return {}
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('CONDUCTOR_SCHEDULE_TEST_SOURCES is not JSON') }
  for (const [id, url] of Object.entries(parsed ?? {})) {
    let parsedUrl
    try { parsedUrl = new URL(String(url)) } catch { throw new Error(`CONDUCTOR_SCHEDULE_TEST_SOURCES: ${id} is not a URL`) }
    if (parsedUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)) throw new Error('CONDUCTOR_SCHEDULE_TEST_SOURCES may only name loopback http URLs')
  }
  return parsed
}

// ---------------------------------------------------------------------------------------------
// Extraction: ids only, lower-cased, de-duplicated, sorted
// ---------------------------------------------------------------------------------------------
const tidy = token => token.toLowerCase().replace(/\.(?:md|html?)$/, '').replace(/[.-]+$/, '')
const sortedIds = ids => [...new Set(ids)].sort().slice(0, MAX_IDS)
const OPENAI_ID = /^(?:(?:gpt|chatgpt)-[a-z0-9]+(?:[.-][a-z0-9]+)*|codex-[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*|o\d+(?:-[a-z0-9]+)*)$/
// Product and tool names that share the codex- prefix, and prose such as "GPT-5.4-class".
const OPENAI_NOT_MODEL = /^codex-(?:cli|sdk|app|action|exec|rs|web|ide|cloud|agent|github|docs)\b|-(?:class|level|series|family|based|style|like)$/
const ANTHROPIC_ID = /^claude-(?:[a-z]{3,}-\d+(?:-\d+)*|\d+(?:-\d+)*-[a-z]+(?:-\d{8})?)$/

/** The catalog page links every model as /models/<id>(.md); those slugs are the model list.
 *  Scanning the prose is only the fallback for a page without such links. */
function extractOpenAi(body) {
  const keep = tokens => tokens.map(tidy).filter(id => OPENAI_ID.test(id) && !OPENAI_NOT_MODEL.test(id))
  const linked = keep([...body.matchAll(/\/models\/([a-z0-9][a-z0-9.-]*)/gi)].map(match => match[1]))
  const ids = linked.length ? linked : keep([...body.matchAll(/(?<![\w.-])(?:(?:gpt|chatgpt|codex)-[a-z0-9][a-z0-9.-]*|o\d+(?:-[a-z0-9]+)*)(?![\w])/gi)].map(match => match[0]))
  return ids.length ? { modelIds: sortedIds(ids) } : null
}
function extractAnthropic(body) {
  const ids = []
  for (const match of body.matchAll(/(?<![\w-])claude-[a-z0-9][a-z0-9.-]*/gi)) {
    // Cloud listings append a version (Bedrock `-v1:0`, cut at the colon here) or `@date` (Vertex, cut by the pattern).
    const id = tidy(match[0]).replace(/-v\d+$/, '')
    if (ANTHROPIC_ID.test(id)) ids.push(id)
  }
  return ids.length ? { modelIds: sortedIds(ids) } : null
}
function extractJson(body, key, pattern) {
  let parsed
  try { parsed = JSON.parse(body) } catch { return null }
  const value = parsed?.[key]
  return typeof value === 'string' && pattern.test(value) ? value : null
}
const EXTRACT = {
  openai: extractOpenAi,
  anthropic: extractAnthropic,
  release: body => { const tagName = extractJson(body, 'tag_name', /^[\w.-]{1,64}$/); return tagName ? { tagName } : null },
  huggingface: body => { const sha = extractJson(body, 'sha', /^[0-9a-f]{40}$/); return sha ? { sha } : null }
}

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------
async function boundedText(response) {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new Error('response exceeded 256 KB')
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Error('response exceeded 256 KB') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function fetchSource(source, cached) {
  const headers = { accept: source.accept, 'user-agent': 'conductor-schedule-latest-models' }
  const usable = cached?.url === source.url && cached.facts
  if (usable && cached.etag) headers['if-none-match'] = cached.etag
  if (usable && cached.lastModified) headers['if-modified-since'] = cached.lastModified
  const response = await fetch(source.url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (response.status === 304) {
    await response.body?.cancel().catch(() => {})
    if (!usable) throw new Error('HTTP 304 without cached facts')
    return { notModified: true }
  }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new Error(`redirected (HTTP ${response.status}); source origins are pinned`) }
  if (response.url && new URL(response.url).origin !== new URL(source.url).origin) throw new Error('answered from an unexpected origin')
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`) }
  const body = await boundedText(response)
  return { facts: EXTRACT[source.extract](body), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') }
}

// ---------------------------------------------------------------------------------------------
// Cache and main
// ---------------------------------------------------------------------------------------------
const stateDir = process.env.CONDUCTOR_SCHEDULE_STATE_DIR
const cacheFile = stateDir ? join(stateDir, 'primary-sources.json') : null
function loadCache() {
  if (!cacheFile) { log('CONDUCTOR_SCHEDULE_STATE_DIR is not set; no cache'); return {} }
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')).sources ?? {} } catch { return {} }
}
function saveCache(sources) {
  if (!cacheFile) return
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(`${cacheFile}.tmp`, JSON.stringify({ version: 1, sources }, null, 2))
    renameSync(`${cacheFile}.tmp`, cacheFile)
  } catch (error) { log(`cache not saved: ${error.message}`) }
}

/** One source's printed entry: its facts (fresh, not modified, or cached after a failure), or
 *  why there are none. */
async function check(source, cache) {
  const cached = cache[source.id]?.url === source.url ? cache[source.id] : null
  try {
    const result = await fetchSource(source, cached)
    if (result.notModified) {
      cache[source.id] = { ...cached, failures: 0 }
      return { ...cached.facts }
    }
    if (result.facts) {
      cache[source.id] = { url: source.url, etag: result.etag, lastModified: result.lastModified, facts: result.facts, failures: 0 }
      return { ...result.facts }
    }
    // A page that answers but no longer yields facts changed format: a finding, not a blip.
    log(`${source.id}: answered, but no facts could be extracted`)
    return { ...(cached?.facts ?? {}), problem: 'answered, but no facts could be extracted; the page format may have changed' }
  } catch (error) {
    const failures = (cached?.failures ?? 0) + 1
    log(`${source.id}: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message ?? error} (failed run ${failures} in a row)`)
    if (!cached?.facts) return { unavailable: true }
    cache[source.id] = { ...cached, failures }
    return { ...cached.facts, ...(failures >= STALE_AFTER_FAILURES ? { stale: true } : {}) }
  }
}

async function main(overrides) {
  const cache = loadCache()
  const entries = await Promise.all(SOURCES.map(source => check({ ...source, url: overrides[source.id] ?? source.url }, cache)))
  saveCache(cache)
  const sources = Object.fromEntries(SOURCES.map((source, index) => [source.id, entries[index]]))
  const withFacts = entries.filter(entry => Object.keys(entry).some(key => !['unavailable', 'problem', 'stale'].includes(key)))
  finish({ sources }, withFacts.length ? 0 : 1)
}

let overrides = null
try { overrides = testOverrides() } catch (error) { log(error.message); finish({ error: error.message }, 1) }
if (overrides) await main(overrides)
