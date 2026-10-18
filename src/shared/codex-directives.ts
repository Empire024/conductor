// Codex writes file references as a remark-directive of its own, meant for its own UI:
//   :codex-file-citation{path="C:/x/report.pdf" purpose="output"}
//   :codex-file-citation[codex-file-citation]{line_range_start=12 line_range_end=20 path=src/a.ts}
// Conductor's markdown has no directive support, so they showed up as raw text. Each becomes an
// ordinary markdown link to the file, which the existing file-link handling then opens.
const CITATION = /:codex-file-citation(?:\[[^\]\r\n]*\])?\{([^}\r\n]*)\}/g
const ATTRIBUTE = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g

function attributes(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of body.matchAll(ATTRIBUTE)) result[match[1]!] = match[2] ?? match[3] ?? match[4] ?? ''
  return result
}

/** The link target for a cited path: a drive path gets the leading slash a URL parser gives it, and
 *  each segment is percent-encoded so a space or bracket cannot end the markdown link early. */
function linkTarget(path: string, line: number | undefined): string {
  const posix = path.replaceAll('\\', '/')
  const encoded = posix.split('/').map((part) => /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)).join('/')
  return (/^[a-zA-Z]:\//.test(posix) ? '/' : '') + encoded + (line ? '#L' + line : '')
}

export function hasCodexDirectives(text: string): boolean {
  return text.includes(':codex-file-citation')
}

/** Replace every Codex file citation with a markdown link named after the file (and its line). A
 *  citation without a path is dropped rather than shown as markup. */
export function codexDirectivesToMarkdown(text: string): string {
  if (!hasCodexDirectives(text)) return text
  return text.replace(CITATION, (_whole, body: string) => {
    const attrs = attributes(body)
    const path = attrs.path?.trim()
    if (!path) return ''
    const start = Number(attrs.line_range_start ?? attrs.line ?? attrs.start_line)
    const line = Number.isSafeInteger(start) && start > 0 ? start : undefined
    const name = (path.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? path) + (line ? ':' + line : '')
    return '[' + name.replace(/([\\[\]])/g, '\\$1') + '](' + linkTarget(path, line) + ')'
  })
}
