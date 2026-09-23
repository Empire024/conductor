import type { ToolOutputPolicy } from './agent-policy.ts'

/** What a tool result becomes before it enters the active prompt. The full result has already
 *  gone to the timeline (and to the raw-output log the session keeps), so nothing here loses
 *  information the owner can review; it only decides what the model re-reads on every later
 *  request. A test run keeps its failures and summary, a command keeps its head, tail, error
 *  lines and exit code, a diff keeps its hunks, and everything keeps a truthful count of what
 *  was left out and how to get it back. */
export interface ShapedOutput {
  text: string
  /** Characters of the raw result that did not enter the prompt. */
  excludedChars: number
  kind: 'command' | 'test' | 'diff' | 'read' | 'other'
}

const TEST_RUNNER = /\b(vitest|jest|mocha|pytest|node --test|node:test|npm (?:run )?test|npx (?:vitest|jest)|go test|cargo test|dotnet test|\.test\.(?:m?js|ts)|\.spec\.(?:m?js|ts))\b/
const DIFF_COMMAND = /\bgit\s+(?:diff|show|log\s+-p)\b/
const FAILURE_LINE = /(✗|×|✘|FAIL\b|failed|failing|not ok|Error\b|error\b|AssertionError|Expected|expected|Received|received|actual|\+ actual|- expected|Traceback|at .+:\d+:\d+|TypeError|ReferenceError|SyntaxError|exit code)/
const SUMMARY_LINE = /(\d+ (?:passed|failed|pass|fail|tests?|todo|skipped)|Tests:|Test Files|Test Suites|# (?:pass|fail|tests)|ok \d|not ok \d|Ran \d+ test|=+ .* (?:passed|failed))/i
const PASS_LINE = /^\s*(?:✓|✔|√|ok \d+ -|PASS\b|\[?PASS\]?)/

export const detectsTestRun = (command: string): boolean => TEST_RUNNER.test(command)

function omissionNote(excluded: number, hint: string): string {
  return excluded > 0 ? `\n[... ${excluded} characters not shown. ${hint} ...]` : ''
}

/** Head and tail of a long result, with the count of what fell between them. */
export function headAndTail(text: string, limit: number, hint = 'The full output is in the timeline; rerun with a narrower command or read the file you need.'): { text: string; excluded: number } {
  if (text.length <= limit) return { text, excluded: 0 }
  const note = omissionNote(text.length, hint)
  const room = Math.max(200, limit - note.length)
  const head = Math.ceil(room * 0.4)
  const tail = room - head
  const result = text.slice(0, head) + omissionNote(text.length - room, hint) + text.slice(text.length - tail)
  return { text: result, excluded: text.length - result.length }
}

/** A test report: every line that names a failure, an assertion or a stack frame, the summary
 *  lines, and the exit code. Passing-test lines are dropped, a thousand of them say nothing the
 *  summary does not. Kept in order so a failing test still reads top to bottom. */
export function shapeTestOutput(raw: string, limit: number): { text: string; excluded: number } {
  const lines = raw.split('\n')
  const kept: string[] = []
  let skippedPasses = 0
  let context = 0
  for (const line of lines) {
    if (PASS_LINE.test(line) && !FAILURE_LINE.test(line)) { skippedPasses++; continue }
    if (FAILURE_LINE.test(line) || SUMMARY_LINE.test(line) || /^(stdout|stderr):$/.test(line)) { kept.push(line); context = 3; continue }
    // A few lines after a failure carry the assertion diff; keep them.
    if (context > 0) { kept.push(line); context--; continue }
    if (/^\s*$/.test(line)) continue
  }
  const shaped = (skippedPasses ? `[${skippedPasses} passing-test lines omitted]\n` : '') + kept.join('\n')
  if (shaped.length <= limit) return { text: shaped, excluded: raw.length - shaped.length }
  const { text } = headAndTail(shaped, limit, 'Rerun the single failing test file to see one failure in full.')
  return { text, excluded: raw.length - text.length }
}

/** A diff: file headers and hunks are what the model works from; the surrounding git noise is
 *  not. Beyond the budget the tail is cut, since the first files are the ones the model asked
 *  about most often. */
export function shapeDiffOutput(raw: string, limit: number): { text: string; excluded: number } {
  const lines = raw.split('\n').filter(line => !/^(index |similarity index|rename from|rename to|new file mode|deleted file mode|old mode|new mode)/.test(line))
  const shaped = lines.join('\n')
  if (shaped.length <= limit) return { text: shaped, excluded: raw.length - shaped.length }
  const files = lines.filter(line => line.startsWith('diff --git ')).map(line => line.replace(/^diff --git a\/(\S+) b\/.*$/, '$1'))
  const note = `\n[... diff truncated; ${files.length} files changed: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ', ...' : ''}. Run git diff on one file for its full hunks ...]`
  const text = shaped.slice(0, Math.max(200, limit - note.length)) + note
  return { text, excluded: raw.length - text.length }
}

/** The shaped form of one raw tool result for the prompt. `input` is the parsed call arguments,
 *  used only to recognise what kind of command ran. */
export function shapeToolOutput(name: string, input: Record<string, unknown>, raw: string, policy: ToolOutputPolicy): ShapedOutput {
  // Execution evidence and retrieval handles survive test/diff shaping too. They are the
  // model's route back to the complete captured output, not merely a timeline reference.
  const evidence = raw.split('\n').filter(line => /^\[(execution|environment|result_artifact|script_artifact):/.test(line)).join('\n')
  if (name === 'run_command' && evidence) {
    const body = raw.split('\n').filter(line => !/^\[(execution|environment|result_artifact|script_artifact):/.test(line)).join('\n')
    const shaped = shapeToolOutput(name, input, body, policy)
    return { ...shaped, text: evidence + '\n' + shaped.text }
  }
  if (name === 'run_command') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (DIFF_COMMAND.test(command)) { const shaped = shapeDiffOutput(raw, policy.commandChars); return { text: shaped.text, excludedChars: shaped.excluded, kind: 'diff' } }
    if (detectsTestRun(command)) { const shaped = shapeTestOutput(raw, policy.testReportChars); return { text: shaped.text, excludedChars: shaped.excluded, kind: 'test' } }
    const shaped = headAndTail(raw, policy.commandChars)
    return { text: shaped.text, excludedChars: shaped.excluded, kind: 'command' }
  }
  if (name === 'read_file') {
    // read_file is bounded at the tool itself (a line window with a header); the prompt cap here
    // is only a backstop for a window of very long lines.
    const shaped = headAndTail(raw, policy.otherChars * 2, 'Read a narrower range with offset and limit.')
    return { text: shaped.text, excludedChars: shaped.excluded, kind: 'read' }
  }
  const shaped = headAndTail(raw, policy.otherChars, 'Narrow the query or read a specific file.')
  return { text: shaped.text, excludedChars: shaped.excluded, kind: 'other' }
}

/** What an old result shrinks to once later rounds have superseded it: the first line (usually
 *  the header, the status or the first failure) and the count. Enough for the model to know the
 *  call happened and what it found; not enough to re-read on every request. */
export function supersededSummary(raw: string, limit: number): string {
  if (raw.length <= limit) return raw
  const firstLines = raw.split('\n').filter(line => line.trim()).slice(0, 3).join('\n')
  const head = firstLines.slice(0, Math.max(80, limit - 90))
  return `${head}\n[... earlier result, ${raw.length - head.length} characters folded into the task state ...]`
}

/** Old assistant narration keeps its ending, where the conclusion is, not its deliberation. A
 *  message that is mostly "Wait, actually, let me trace this again" is what fills a window. */
export function narrationConclusion(content: string, limit: number): string {
  const trimmed = content.trim()
  if (trimmed.length <= limit) return trimmed
  return `[... ${trimmed.length - limit} characters of earlier reasoning omitted ...]\n${trimmed.slice(-limit)}`
}
