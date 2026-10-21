import { runInNewContext } from 'node:vm'
import markdownJs from '../phone/markdown.js?raw'
import type { SessionProjection } from '../shared/structured-agent'

/**
 * Which files a conversation handed over or linked, by the very rule the phone uses to draw its
 * Delivered chips and file links (src/phone/markdown.js `deliveredFiles`). It is the phone's own
 * script run once in a bare context rather than a second copy of the parsing, so a chip the phone
 * shows is exactly a file the computer will serve for that conversation, and nothing else is.
 */
type DeliveredFile = { name: string; path: string }
let parser: ((text: unknown) => DeliveredFile[]) | null = null

function deliveredFiles(text: string): DeliveredFile[] {
  if (!parser) {
    const window: { ConductorMarkdown?: { deliveredFiles(text: unknown): DeliveredFile[] } } = {}
    runInNewContext(markdownJs, { window })
    const found = window.ConductorMarkdown?.deliveredFiles
    if (typeof found !== 'function') throw new Error('The phone markdown script has no deliveredFiles.')
    parser = found
  }
  return parser(text)
}

/** One spelling for a path, whichever separators and case a reply used for it. */
export const linkedPathKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** One linked file: the spelling the first reply used, and when replies linked it. */
export interface LinkedFile { path: string; firstAt: string; lastAt: string; lastSequence: number }

/* A long conversation's replies are parsed once per change, not once per tap: the file list and
   each capability request read the same result while the projection's sequence stands still. Keyed
   by the items array itself, so another projection that happens to share an id and a sequence (a
   reimported archive) is never answered from this one. */
const parsed = new WeakMap<readonly unknown[], { sequence: number | undefined; count: number; files: Map<string, LinkedFile> }>()

/** Every file the conversation's own replies delivered or linked, keyed by `linkedPathKey`. Do not modify the answer: it is shared. */
export function conversationLinkedFileEntries(projection: Pick<SessionProjection, 'items'> & Partial<Pick<SessionProjection, 'sequence'>> | null | undefined): Map<string, LinkedFile> {
  const items = projection?.items ?? []
  const sequence = projection?.sequence
  const cached = parsed.get(items)
  if (cached && cached.sequence === sequence && cached.count === items.length) return cached.files
  const linked = new Map<string, LinkedFile>()
  for (const item of items) {
    const data = item.data
    // A reply the agent wrote, at any depth: a subagent's report links files just as well.
    if (data.type !== 'text' || data.role !== 'assistant' || typeof data.text !== 'string') continue
    for (const file of deliveredFiles(data.text)) {
      const key = linkedPathKey(file.path), known = linked.get(key)
      if (!known) linked.set(key, { path: file.path, firstAt: item.timestamp, lastAt: item.timestamp, lastSequence: item.sequence })
      else if (item.sequence >= known.lastSequence) { known.lastAt = item.timestamp; known.lastSequence = item.sequence }
    }
  }
  parsed.set(items, { sequence, count: items.length, files: linked })
  return linked
}

/** Every file the conversation's own replies delivered or linked: key to the path as written. */
export function conversationLinkedFiles(projection: Pick<SessionProjection, 'items'> & Partial<Pick<SessionProjection, 'sequence'>> | null | undefined): Map<string, string> {
  return new Map([...conversationLinkedFileEntries(projection)].map(([key, file]) => [key, file.path]))
}
