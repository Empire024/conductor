const DIRECTIVE_TOKEN = 'CONDUCTOR_MEMORY'

// Anchored to the start of a line: a directive merely mentioned mid-sentence or fenced in
// backticks (` `CONDUCTOR_MEMORY[...]: ...` `) never matches, only a standalone control line.
const DIRECTIVE_LINE = /^[ \t]*CONDUCTOR_MEMORY(?:\[[a-zA-Z]*\])?:[^\r\n]*\r?\n?/gim

/** True once a trailing, still-streaming line could plausibly grow into the sentinel: either it
 *  is a strict prefix of the literal token, or the token is already complete and the rest of the
 *  line (kind, gist, cues) simply has not finished arriving yet. */
function isPartialDirective(line: string): boolean {
  const trimmed = line.replace(/^[ \t]*/, '')
  if (trimmed.length < 3) return false
  const upper = trimmed.toLocaleUpperCase()
  return DIRECTIVE_TOKEN.startsWith(upper) || upper.startsWith(DIRECTIVE_TOKEN)
}

/**
 * Strips Conductor's `CONDUCTOR_MEMORY[<kind>]: <gist> | cues: <cues>` control line out of
 * assistant text before it reaches the conversation. The instruction is a directive to write
 * memory, not something the user asked to read, so it is removed whether it lands mid-reply, as
 * the last line, or surrounded by blank lines — and a line still being typed out is held back
 * rather than shown half-formed while the reply streams in.
 */
export const stripMemoryDirectives = (text: string): string => {
  const withoutComplete = text.replace(DIRECTIVE_LINE, '')
  const lastBreak = Math.max(withoutComplete.lastIndexOf('\n'), withoutComplete.lastIndexOf('\r')) + 1
  const tail = withoutComplete.slice(lastBreak)
  return isPartialDirective(tail) ? withoutComplete.slice(0, lastBreak) : withoutComplete
}
