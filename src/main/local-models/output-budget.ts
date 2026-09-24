/** Recovery from a tool call the local output limit cut off mid-arguments.
 *
 *  A small model asked for a report tends to put the whole report in one write_file. At a
 *  2,560-token output limit that call is cut before its JSON closes, nothing runs, and at
 *  13 tokens a second the attempt has already cost three minutes. The runtime answers the first
 *  cut with a concrete, smaller chunk size; a second cut of the same tool in the turn is the
 *  output-budget loop, and the turn stops with what it has instead of paying for a third. */

/** Content characters one call can carry and still close its JSON inside the output limit,
 *  with room for the model's reasoning and the escaping JSON adds. */
export function chunkCharsFor(limitTokens: number): number {
  return Math.max(800, Math.min(6000, Math.round(limitTokens * 1.2 / 250) * 250))
}

/** The first cut: nothing ran, here is the size that fits, and a second cut ends the turn. */
export function truncatedCallResult(name: string, raw: string, limitTokens: number): string {
  const chunk = chunkCharsFor(limitTokens)
  const parts = name === 'write_file'
    ? ` Write a large file in parts: write_file the first part, then write_file with append: true for each further part, keeping every call under about ${chunk} characters of content.`
    : ` Split the work into smaller calls of under about ${chunk} characters each.`
  return `failed: the ${name} call was cut off at the local output limit of ${limitTokens} tokens after ${raw.length} characters, before its arguments were complete, so nothing ran and nothing was written.${parts} If the next ${name} call is cut off too, Conductor ends the turn instead of retrying.`
}

/** Read a JSON string value from arguments that may stop anywhere inside it. */
function partialString(raw: string, key: string): string | undefined {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw)
  if (!start) return undefined
  let body = '', index = start.index + start[0].length
  for (; index < raw.length; index++) {
    const char = raw[index]!
    if (char === '"') break
    if (char !== '\\') { body += char; continue }
    // An escape the cut split in two is dropped rather than decoded wrongly.
    const next = raw[index + 1]
    if (next === undefined) break
    if (next === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(index + 2, index + 6))) break; body += raw.slice(index, index + 6); index += 5; continue }
    body += char + next; index++
  }
  try { return JSON.parse(`"${body}"`) as string } catch { return undefined }
}

/** What the cut call was about to do: its target path and the content it had produced. */
export function salvageTruncatedArguments(raw: string): { path?: string; content?: string } {
  const path = partialString(raw, 'path'), content = partialString(raw, 'content')
  return { ...(path !== undefined ? { path } : {}), ...(content !== undefined ? { content } : {}) }
}

export interface OutputBudgetLoop {
  name: string
  limitTokens: number
  /** Argument characters of each cut call, in order. */
  cutChars: number[]
  /** The last cut call's raw arguments. */
  raw: string
  /** Files this turn wrote successfully, with their size now. */
  written: Array<{ path: string; bytes?: number }>
}

const SALVAGE_CHARS = 12000

/** The stop: one sentence for the report, and the durable partial result for the conversation
 *  — what was written, what failed, the content the cut call had produced (never written to
 *  disk, so no half file exists), and how to continue. */
export function outputBudgetLoopStop(loop: OutputBudgetLoop): { detail: string; partial: string } {
  const chunk = chunkCharsFor(loop.limitTokens)
  const salvage = salvageTruncatedArguments(loop.raw)
  const detail = `Output-budget loop: ${loop.cutChars.length} ${loop.name} calls in this turn were cut off at the ${loop.limitTokens}-token output limit (${loop.cutChars.join(' and ')} characters), the second after the runtime asked for parts under ${chunk} characters; the turn stopped instead of retrying.`
  const written = loop.written.length
    ? loop.written.map(file => `- ${file.path}${file.bytes !== undefined ? ` (${file.bytes} bytes)` : ''}`).join('\n')
    : '- nothing: no file was written in this turn.'
  const target = salvage.path ? ` for ${salvage.path}` : ''
  const content = salvage.content
    ? `\n\nContent the cut ${loop.name} call had produced${target} (${salvage.content.length} characters, NOT written to disk):\n~~~~\n${salvage.content.length > SALVAGE_CHARS ? `${salvage.content.slice(0, SALVAGE_CHARS)}\n[... ${salvage.content.length - SALVAGE_CHARS} more characters ...]` : salvage.content}\n~~~~`
    : ''
  const next = loop.name === 'write_file'
    ? `To continue: write_file${target} with the first part only, then write_file with append: true for each further part, every call under ${chunk} characters of content${salvage.content ? '; the content above can be reused as those parts' : ''}.`
    : `To continue: split the ${loop.name} work into calls of under ${chunk} characters each.`
  return { detail, partial: `Partial result.\nWritten so far:\n${written}\nFailure: ${detail}${content}\n\n${next}` }
}
