/** Pure text shaping for local assist: what the local model reads out of a long log, and what
 *  a caller gets back verbatim whether or not the model answered. */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
export const stripAnsi = (text: string): string => text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')

/** Lines that usually carry the answer to "what failed": test failures, compiler errors,
 *  assertion diffs and stack frames that point into a file. */
const FAILURE = /\b(?:FAIL(?:ED)?|ERR!?|Error|error TS\d+|Exception|AssertionError|Assertion|expected|Expected|Received|panic|Traceback|failing|✗|×|✖)\b|^\s*(?:at |●|›|❯|>)\s|\.(?:[cm]?[jt]sx?|py|rs|go|cs|java):\d+/

export const splitLines = (text: string): string[] => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export const tailLines = (lines: string[], count: number): string[] => lines.slice(Math.max(0, lines.length - count))

/** Failure lines with a little context, in log order, without repeats. */
export function failureLines(lines: string[], limit: number, context = 1): string[] {
  const picked = new Set<number>()
  for (let index = 0; index < lines.length && picked.size < limit * 3; index++) {
    if (!FAILURE.test(lines[index]!)) continue
    for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near++) picked.add(near)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const index of [...picked].sort((a, b) => a - b)) {
    const line = lines[index]!.trimEnd()
    if (!line.trim() || seen.has(line)) continue
    seen.add(line)
    out.push(line)
    if (out.length >= limit) break
  }
  return out
}

export const clip = (line: string, max = 400): string => line.length > max ? `${line.slice(0, max)}…` : line

/** Splits already-numbered lines into consecutive windows of at most maxChars each, covering the
 *  whole input in order — nothing in the middle is dropped the way `modelExcerpt`'s failure-regex
 *  filter would drop it. A local model with a small context otherwise gets only the head and tail
 *  of a large file and answers confidently from what it saw, which for a plain read (not a test
 *  log) is worse than truncating in the caller's face: it has to say what it examined instead.
 *  Stops after maxChunks windows so one huge file cannot turn a call into an unbounded number of
 *  model round trips; `consumedLines` says how much of the input made it into a window. */
export function chunkLines(lines: string[], maxChars: number, maxChunks: number): { chunks: string[]; consumedLines: number } {
  const chunks: string[] = []
  let current: string[] = [], currentChars = 0, consumed = 0
  for (const line of lines) {
    const clipped = clip(line, 2000)
    const size = clipped.length + 1
    if (currentChars + size > maxChars && current.length) {
      if (chunks.length >= maxChunks) break
      chunks.push(current.join('\n'))
      current = []; currentChars = 0
    }
    current.push(clipped); currentChars += size; consumed++
  }
  if (current.length && chunks.length < maxChunks) chunks.push(current.join('\n'))
  return { chunks, consumedLines: consumed }
}

/** What the local model reads: the head, every failure region and the tail, within maxChars.
 *  A 30k-token context has to hold this plus the answer, so the long middle of a passing run is
 *  exactly what is left out. */
export function modelExcerpt(lines: string[], maxChars: number): string {
  const whole = lines.map(line => clip(line)).join('\n')
  if (whole.length <= maxChars) return whole
  const head = lines.slice(0, 40).map(line => clip(line))
  const tail = tailLines(lines, 120).map(line => clip(line))
  const failures = failureLines(lines, 600, 2).map(line => clip(line))
  const parts = [`[first ${head.length} lines]`, ...head, '', '[failure-related lines, in order]', ...failures, '', `[last ${tail.length} lines]`, ...tail]
  let text = parts.join('\n')
  if (text.length > maxChars) {
    // Keep the tail whole (the summary line of a test run lives there) and trim failures.
    const fixed = [`[first ${head.length} lines]`, ...head, '', `[last ${tail.length} lines]`, ...tail].join('\n')
    const room = Math.max(0, maxChars - fixed.length - 60)
    let failureText = ''
    for (const line of failures) { if (failureText.length + line.length + 1 > room) break; failureText += `${line}\n` }
    text = [`[first ${head.length} lines]`, ...head, '', '[failure-related lines, in order, truncated]', failureText.trimEnd(), '', `[last ${tail.length} lines]`, ...tail].join('\n')
    if (text.length > maxChars) text = text.slice(text.length - maxChars)
  }
  return `[${lines.length} lines, ${whole.length} characters; excerpt]\n${text}`
}

/** A model answer cut to maxLines, so a talkative model cannot spend the caller's tokens. */
export function capLines(text: string, maxLines: number): string {
  const lines = splitLines(text.trim())
  return lines.length <= maxLines ? lines.join('\n') : [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines cut)`].join('\n')
}
