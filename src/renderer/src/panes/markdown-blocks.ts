/** Splits Markdown into top-level blocks that parse the same apart as together, so a message can be
 *  rendered one memoized block at a time: while a reply streams, only its last block changes, and
 *  only that block is parsed again. Re-parsing a whole long reply on every streamed frame, in a
 *  render nothing can interrupt, is what made typing stall behind a running turn.
 *
 *  A block ends only at a blank line outside a fenced code block whose next line starts a new
 *  top-level construct at column 0: a paragraph, heading, fence, table or rule. A blank line before
 *  an indented line (a list item's continuation, indented code), another list item or a blockquote
 *  line never splits, so lists and quotes stay whole. Text with link reference or footnote
 *  definitions, which reach across blocks, stays one block. */
export function markdownBlocks(text: string): string[] {
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return [text]
  const lines = text.split('\n')
  const blocks: string[] = []
  let start = 0
  let fence: { marker: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (opening && opening[1]![0] === fence.marker && opening[1]!.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null
      continue
    }
    if (opening) { fence = { marker: opening[1]![0]!, length: opening[1]!.length }; continue }
    if (line.trim() || index + 1 >= lines.length) continue
    // The first non-blank line after this run of blank lines decides whether a new block starts.
    let next = index + 1
    while (next < lines.length && !lines[next]!.trim()) next++
    if (next >= lines.length || !startsTopLevelBlock(lines[next]!)) continue
    blocks.push(lines.slice(start, next).join('\n'))
    start = next
    index = next - 1
  }
  blocks.push(lines.slice(start).join('\n'))
  return blocks
}

/** Anything that could continue what came before (a list item, a quote, an indented line) keeps
 *  the block together; that includes a `- - -` rule, which only costs a larger block. */
const startsTopLevelBlock = (line: string): boolean => !/^\s/.test(line) && !/^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line) && !line.startsWith('>')
