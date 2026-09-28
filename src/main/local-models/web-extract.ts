import { createHash } from 'node:crypto'

/** What one public page is to local research: its text and the source facts that go with it
 *  (docs/verification/2026-09-28-local-scraper.md). Pure: the fetch, clock and cache belong to
 *  web.ts, so every rule here is tested on saved markup. */
export const EXTRACTOR = 'conductor-html/2'

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', middot: '·', bull: '•' }
const entity = (name: string): string | undefined => {
  const lower = name.toLowerCase()
  if (!lower.startsWith('#')) return entities[lower]
  const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10)
  return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : undefined
}
export const decodeEntities = (value: string): string => value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => entity(name) ?? match)
export const plain = (value: string): string => decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** A tag, reading quoted attribute values whole: Hugging Face puts JSON holding "<|im_start|>"
 *  in an attribute, and a plain <[^>]*> ended the tag there and let the rest in as page text. */
export const TAG = /<[a-z/!?](?:[^>"']|"[^"]*"|'[^']*')*>/gi

/** Fewer characters of text than this is a page with nothing to read. */
export const EMPTY_PAGE_CHARS = 200

export interface PageMeta { title?: string; description?: string; siteName?: string; canonical?: string; published?: string; modified?: string; author?: string }
/** open: the page answered with its content. login-wall: it answered with a sign-in page instead.
 *  challenge: it answered with a bot check. The last two are access refused, never absence. */
export type PageAccess = 'open' | 'login-wall' | 'challenge'
export interface ExtractedPage {
  requestedUrl: string; finalUrl: string; fetchedAt: string; extractor: string
  access: PageAccess; meta: PageMeta
  /** body: the page's own text. structured-data: its articleBody, the visible body being drawn by
   *  script. site-data: a known site's own embedded list (instagramPosts). metadata-only: nothing
   *  but the page's title and description could be read. */
  textSource: 'body' | 'structured-data' | 'site-data' | 'metadata-only'
  text: string; contentSha256: string; cut: boolean; warnings: string[]
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const [, name, double, single, bare] of tag.matchAll(/([a-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi))
    found[name!.toLowerCase()] ??= decodeEntities(double ?? single ?? bare ?? '')
  return found
}

/** A date only when it reads as one: a page's "date" field is sometimes a word or a template. */
const dated = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length <= 40 && /^\d{4}-\d{2}/.test(text) && Number.isFinite(Date.parse(text.slice(0, 10))) ? text : undefined
}
const clipped = (value: unknown, max = 600): string | undefined => typeof value === 'string' && value.trim() ? plain(value).slice(0, max) : undefined

interface Structured { headline?: string; description?: string; published?: string; modified?: string; author?: string; body?: string }
/** Nodes a walk over a page's embedded JSON may take in, over all its blocks together. Counted
 *  when a node is queued, not when it is read, so a huge array costs its first few items only:
 *  spreading a 150,000-item array into push() overflowed the call stack (review, 2026-09-28). */
class NodeBudget {
  constructor(private left: number) {}
  /** Queue the items of an array or the values of an object, in order, while the budget lasts. */
  add(queue: unknown[], items: readonly unknown[]): void {
    for (let index = 0; index < items.length && this.left > 0; index++, this.left--) queue.push(items[index])
  }
  get spent(): boolean { return this.left <= 0 }
}

/** JSON-LD: the dates, headline and sometimes the whole article a script-drawn page states for
 *  search engines. Bounded: eight blocks, 512 KiB each, 400 nodes over all of them. */
function structuredData(html: string): Structured {
  const found: Structured = {}
  const budget = new NodeBudget(400)
  let blocks = 0
  for (const [, raw] of html.matchAll(/<script\b[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (++blocks > 8 || budget.spent || raw!.length > 512 * 1024) continue
    let data: unknown
    try { data = JSON.parse(raw!.trim()) } catch { continue }
    const queue: unknown[] = []
    budget.add(queue, [data])
    for (let next = 0; next < queue.length; next++) {
      const item = queue[next]
      if (Array.isArray(item)) { budget.add(queue, item); continue }
      if (!item || typeof item !== 'object') continue
      const node = item as Record<string, unknown>
      found.headline ??= clipped(node.headline, 300)
      found.description ??= clipped(node.description)
      found.published ??= dated(node.datePublished)
      found.modified ??= dated(node.dateModified)
      const author = Array.isArray(node.author) ? node.author[0] : node.author
      found.author ??= clipped(typeof author === 'object' && author ? (author as Record<string, unknown>).name : author, 200)
      if (typeof node.articleBody === 'string' && !found.body) found.body = decodeEntities(node.articleBody).replace(/\r/g, '').trim()
      budget.add(queue, [node['@graph'], node.mainEntity, node.mainEntityOfPage].filter(nested => nested && typeof nested === 'object'))
    }
  }
  return found
}

export function pageMeta(html: string): PageMeta & { body?: string } {
  const values = new Map<string, string>()
  for (const [tag] of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const found = attributes(tag)
    const key = (found.property ?? found.name ?? found.itemprop)?.toLowerCase()
    const content = found.content?.replace(/\s+/g, ' ').trim()
    if (key && content && !values.has(key)) values.set(key, content)
  }
  const ld = structuredData(html)
  const canonical = [...html.matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map(([tag]) => attributes(tag)).find(found => /(^|\s)canonical(\s|$)/i.test(found.rel ?? ''))?.href
  // A <time> the page marks as its publication, or the first one in an article's own header.
  const time = [...html.matchAll(/<time\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map(([tag]) => ({ tag, found: attributes(tag) })).find(({ tag, found }) => found.itemprop?.toLowerCase() === 'datepublished' || /\spubdate(\s|=|>|\/)/i.test(tag))?.found.datetime
    ?? (/<article\b[^>]*>[\s\S]*?<header\b[^>]*>([\s\S]*?)<\/header>/i.exec(html)?.[1]?.match(/<time\b(?:[^>"']|"[^"]*"|'[^']*')*>/i)?.map(tag => attributes(tag).datetime)[0])
  const title = values.get('og:title') ?? values.get('twitter:title') ?? clipped(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], 300) ?? ld.headline
  const meta: PageMeta & { body?: string } = {
    title: title ? plain(title).slice(0, 300) : undefined,
    // The fullest of the page's summaries: Instagram's og:description has the counts, its plain
    // description the counts and the bio.
    description: clipped([values.get('og:description'), values.get('description'), values.get('twitter:description'), ld.description].filter(Boolean).map(text => plain(text!)).sort((a, b) => b.length - a.length)[0]),
    siteName: clipped(values.get('og:site_name'), 200),
    canonical: canonical && /^https:\/\//i.test(canonical) ? canonical : undefined,
    published: dated(values.get('article:published_time')) ?? dated(values.get('datepublished')) ?? ld.published ?? dated(time) ?? dated(values.get('date')),
    modified: dated(values.get('article:modified_time')) ?? dated(values.get('og:updated_time')) ?? dated(values.get('datemodified')) ?? ld.modified,
    author: clipped(values.get('author') ?? values.get('article:author'), 200) ?? ld.author,
    body: ld.body
  }
  for (const key of Object.keys(meta) as Array<keyof typeof meta>) if (meta[key] === undefined) delete meta[key]
  return meta
}

/** Instagram's signed-out profile page is a script shell, but the response itself carries the
 *  posts it shows (measured 2026-09-28 on /wearlegohead/: 12 posts with their code, a dated
 *  accessibility caption and the caption text, inside application/json blocks). Only what the
 *  page already sent is read: no API, no sign-in, no media. Bounded: 64 blocks of at most 1 MiB,
 *  20,000 nodes queued over all of them, 50 posts. */
export function instagramPosts(html: string, finalUrl: string): string[] {
  if (!/^https:\/\/(www\.)?instagram\.com\//i.test(finalUrl)) return []
  const posts: string[] = []
  const seen = new Set<string>()
  // Depth first in page order: a node's first budget-many children are pushed last-first.
  let blocks = 0, left = 20_000
  const push = (stack: unknown[], items: readonly unknown[]): void => {
    const taken = Math.min(items.length, left)
    left -= taken
    for (let index = taken - 1; index >= 0; index--) stack.push(items[index])
  }
  for (const [, raw] of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (++blocks > 64 || left <= 0 || posts.length >= 50 || raw!.length > 1024 * 1024 || !raw!.includes('"code"')) continue
    let data: unknown
    try { data = JSON.parse(raw!) } catch { continue }
    const stack: unknown[] = []
    push(stack, [data])
    while (stack.length && posts.length < 50) {
      const item = stack.pop()
      if (!item || typeof item !== 'object') continue
      if (Array.isArray(item)) { push(stack, item); continue }
      const node = item as Record<string, unknown>
      const code = node.code
      const caption = (node.caption as { text?: unknown } | null | undefined)?.text
      const described = node.accessibility_caption
      if (typeof code === 'string' && /^[\w-]{5,40}$/.test(code) && (typeof caption === 'string' || typeof described === 'string')) {
        if (!seen.has(code)) {
          seen.add(code)
          const kind = node.product_type === 'clips' ? 'reel' : node.media_type === 2 ? 'video' : node.media_type === 8 ? 'carousel' : 'photo'
          posts.push([`- https://www.instagram.com/p/${code}/ (${kind})`, typeof described === 'string' && `  Described by Instagram: ${plain(described).slice(0, 300)}`, typeof caption === 'string' && `  Caption: ${plain(caption).slice(0, 600)}`].filter(Boolean).join('\n'))
        }
        continue
      }
      push(stack, Object.values(node))
    }
  }
  return posts
}

/** Markup that is never page text, wherever it stands. */
const HIDDEN = /<(script|style|noscript|svg|template|head|title|iframe|object)\b[^>]*>[\s\S]*?<\/\1>/gi
/** A page's chrome. An article's own <header> holds its title and date, so only the page's is dropped. */
const CHROME = /<(nav|aside|form|footer|dialog)\b[^>]*>[\s\S]*?<\/\1>/gi
const PAGE_HEADER_TAG = /<header\b[^>]*>[\s\S]*?<\/header>/gi

/** Markup to lines: headings marked with #, table cells kept apart by | and rows on their own
 *  lines, so a value stays beside its label. */
function lines(fragment: string): string {
  return decodeEntities(fragment
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => '\n' + '#'.repeat(Number(level)) + ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|table|ul|ol|blockquote|pre|figure|figcaption|dd|dt)>|<br\s*\/?>/gi, '\n')
    .replace(TAG, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n').replace(/ ?\|(?=\n|$)/g, '').replace(/\n\|? ?(?=\n)/g, '').trim()
}

/** The page's readable text. Every <article> is kept, in order (a listing's second story is as much
 *  the page as its first); failing those, its <main>; failing that, the whole body without chrome. */
export function pageText(html: string): string {
  // A page cut at the byte limit can end inside a script or style; what follows its opening tag is not text.
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '').replace(HIDDEN, ' ').replace(/<(script|style|svg)\b[\s\S]*$/i, ' ')
  const blocks = (name: string): string[] => [...cleaned.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi'))].map(match => match[1]!.replace(CHROME, ' '))
  const long = (parts: string[]): boolean => plain(parts.join(' ')).length > 400
  const articles = blocks('article')
  if (articles.length && long(articles)) return articles.map(lines).filter(Boolean).join('\n\n')
  const main = blocks('main')
  if (main.length && long(main)) return main.map(lines).filter(Boolean).join('\n\n')
  return lines(cleaned.replace(CHROME, ' ').replace(PAGE_HEADER_TAG, ' '))
}

const SIGN_IN_PATH = /(^|\/)(accounts\/)?(log-?in|sign-?in|auth|authenticate)(\/|\.|$)/i
/** What an interstitial says instead of the page. A captcha widget alone is not one: a support
 *  page's contact form carries g-recaptcha, and Cloudflare adds its challenge-platform script to
 *  ordinary pages it serves (review, 2026-09-28). */
const CHALLENGE_TEXT = /just a moment\.\.\.|attention required|verify (that )?you are (a )?human|are you a robot|checking your browser|enable javascript and cookies to continue|unusual traffic from your computer/i
/** Markup only a block page carries: Cloudflare's challenge form, DataDome's and PerimeterX's
 *  block frames. Counted only on a page with almost no text of its own. */
const CHALLENGE_MARKUP = /\bcf-chl-|captcha-delivery\.com|\bpx-captcha\b/i

export function pageAccess(requested: URL, final: URL, html: string, text: string, title = ''): PageAccess {
  if (SIGN_IN_PATH.test(final.pathname) && !SIGN_IN_PATH.test(requested.pathname)) return 'login-wall'
  if (text.length >= 1500) return 'open'
  if (/<input\b[^>]*type=["']?password/i.test(html) && !SIGN_IN_PATH.test(requested.pathname)) return 'login-wall'
  if (CHALLENGE_TEXT.test(`${title}\n${text}`) || (text.length < EMPTY_PAGE_CHARS && CHALLENGE_MARKUP.test(html))) return 'challenge'
  return 'open'
}

export function extractPage(input: { html: string; requestedUrl: string; finalUrl: string; fetchedAt: string; cut?: boolean }): ExtractedPage {
  const { body, ...meta } = pageMeta(input.html)
  let text = pageText(input.html)
  let textSource: ExtractedPage['textSource'] = 'body'
  const warnings: string[] = []
  const posts = text.length < EMPTY_PAGE_CHARS ? instagramPosts(input.html, input.finalUrl) : []
  if (posts.length) { text = `Posts in the data this page sent (${posts.length}, in the page's order):\n${posts.join('\n')}`; textSource = 'site-data'; warnings.push('Visible body is drawn by script; text is the post list embedded in the page response.') }
  else if (text.length < EMPTY_PAGE_CHARS && body && body.length >= EMPTY_PAGE_CHARS) { text = body; textSource = 'structured-data'; warnings.push('Visible body is drawn by script; text is the page\'s structured-data articleBody.') }
  else if (text.length < EMPTY_PAGE_CHARS && meta.description) { textSource = 'metadata-only'; warnings.push('Visible body is drawn by script; only the page\'s own metadata was readable.') }
  const access = pageAccess(new URL(input.requestedUrl), new URL(input.finalUrl), input.html, text, meta.title)
  if ((input.html.match(/<article\b/gi)?.length ?? 0) > 1) warnings.push('Several articles on one page; all are kept in order.')
  if (!meta.published) warnings.push('No publication date stated on the page.')
  if (input.cut) warnings.push('Response cut at the transport limit; later text is missing.')
  return {
    requestedUrl: input.requestedUrl, finalUrl: input.finalUrl, fetchedAt: input.fetchedAt, extractor: EXTRACTOR,
    access, meta, textSource, text, contentSha256: createHash('sha256').update(text).digest('hex'), cut: Boolean(input.cut), warnings
  }
}

/** Said beside a page of which only the metadata could be read, so a model does not take what
 *  the metadata leaves out as not being there. */
export const METADATA_ONLY_NOTE = '[Only this page\'s own title and description could be read: its body is drawn by script. Anything not stated here is unknown from this page, not absent.]'

/** The source facts a page states about itself, for the lines above its text. Dates are the
 *  page's own; the time Conductor fetched it is never offered as one. */
export function metaLines(page: ExtractedPage): string[] {
  const { meta } = page
  return [
    meta.title && `Title: ${meta.title}`,
    meta.published && `Published: ${meta.published} (as the page states it)`,
    meta.modified && `Updated: ${meta.modified} (as the page states it)`,
    meta.author && `Author: ${meta.author}`,
    meta.description && `Description (the page's own summary): ${meta.description}`,
    page.textSource === 'metadata-only' && METADATA_ONLY_NOTE,
    page.textSource === 'structured-data' && '[The text below is the page\'s structured-data article body: its visible body is drawn by script.]',
    page.textSource === 'site-data' && '[The page\'s visible body is drawn by script; below is the post list the page response itself carries. Posts it did not send are unknown, not absent.]'
  ].filter((line): line is string => Boolean(line))
}

/** Page boundaries of `size` characters, each ending at a line break when one falls in its last
 *  fifth, so a table row or sentence is not split between two reads. */
export function pageBounds(text: string, size: number): Array<[number, number]> {
  const bounds: Array<[number, number]> = []
  for (let start = 0; start < text.length || !bounds.length;) {
    let end = Math.min(text.length, start + size)
    if (end < text.length) { const cut = text.lastIndexOf('\n', end); if (cut > start + size * 0.8) end = cut + 1 }
    bounds.push([start, end])
    if (end >= text.length) break
    start = end
  }
  return bounds
}

/** A continuation read rides in the URL's fragment, which is never sent to the server:
 *  https://site/page#conductor-page=2&sha=<first 12 hex of the content hash>. */
export const continuationUrl = (url: string, page: number, sha: string): string => `${url.replace(/#.*$/, '')}#conductor-page=${page}&sha=${sha.slice(0, 12)}`
export function continuationOf(value: string): { page: number; sha: string } | undefined {
  const hash = /#(.*)$/.exec(value)?.[1]
  if (!hash || !hash.startsWith('conductor-page=')) return undefined
  const match = /^conductor-page=(\d{1,5})&sha=([0-9a-f]{12})$/.exec(hash)
  if (!match || Number(match[1]) < 1) throw new Error('This continuation link is malformed: use the exact web_read url the previous page gave, or read the page again from its first page')
  return { page: Number(match[1]), sha: match[2]! }
}

/** Continuation copies of pages this process read, per conversation scope: bounded in entries,
 *  characters and age. Only complete extracts are kept; a miss is read again from the web and
 *  must hash the same. */
export const PAGE_CACHE_MS = 15 * 60_000
export const PAGE_CACHE_ENTRIES = 32
export const PAGE_CACHE_CHARS = 8 * 1024 * 1024
export class PageStore {
  private readonly entries = new Map<string, { at: number; page: ExtractedPage }>()
  constructor(private readonly clock: () => number = Date.now) {}
  private key(scope: string, url: string): string { return `${scope}\n${url.replace(/#.*$/, '')}` }
  put(scope: string, page: ExtractedPage): void {
    if (page.cut || page.text.length > PAGE_CACHE_CHARS / 2) return
    const key = this.key(scope, page.finalUrl)
    this.entries.delete(key)
    this.entries.set(key, { at: this.clock(), page })
    let chars = [...this.entries.values()].reduce((sum, entry) => sum + entry.page.text.length, 0)
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= PAGE_CACHE_ENTRIES && chars <= PAGE_CACHE_CHARS) break
      this.entries.delete(oldest); chars -= entry.page.text.length
    }
  }
  get(scope: string, url: string): ExtractedPage | undefined {
    const key = this.key(scope, url)
    const entry = this.entries.get(key)
    if (entry && this.clock() - entry.at > PAGE_CACHE_MS) { this.entries.delete(key); return undefined }
    return entry?.page
  }
  clear(): void { this.entries.clear() }
}
