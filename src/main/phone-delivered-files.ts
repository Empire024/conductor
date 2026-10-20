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

/** Every file the conversation's own replies delivered or linked, keyed by `linkedPathKey`. */
export function conversationLinkedFiles(projection: Pick<SessionProjection, 'items'> | null | undefined): Map<string, string> {
  const linked = new Map<string, string>()
  for (const item of projection?.items ?? []) {
    const data = item.data
    // A reply the agent wrote, at any depth: a subagent's report links files just as well.
    if (data.type !== 'text' || data.role !== 'assistant' || typeof data.text !== 'string') continue
    for (const file of deliveredFiles(data.text)) if (!linked.has(linkedPathKey(file.path))) linked.set(linkedPathKey(file.path), file.path)
  }
  return linked
}
