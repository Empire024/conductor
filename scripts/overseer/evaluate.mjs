import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHECKOUT } from './util.mjs'

/**
 * Fold raw history events into timeline items the way the app's reducer does: events sharing an
 * itemId are one item; text deltas append, tool output deltas append, later fields win.
 * Returned in first-seen order, each with its first sequence and timestamp.
 */
export function projectItems(events) {
  const items = new Map()
  for (const event of events ?? []) {
    const data = event?.data
    if (!data || typeof data !== 'object') continue
    const key = event.itemId ? `item:${event.itemId}` : `seq:${event.sequence}`
    const previous = items.get(key)
    if (!previous || previous.data.type !== data.type) {
      items.set(key, { key, sequence: event.sequence, timestamp: event.timestamp, updatedSequence: event.sequence, data: { ...data } })
      continue
    }
    previous.updatedSequence = event.sequence
    if (data.type === 'text') previous.data = { ...data, text: data.mode === 'delta' ? (previous.data.text ?? '') + (data.text ?? '') : (data.text ?? '') }
    else if (data.type === 'tool') previous.data = {
      ...previous.data, ...data,
      input: data.input ?? previous.data.input,
      output: data.output === undefined ? previous.data.output : data.outputMode === 'delta' ? (previous.data.output ?? '') + data.output : data.output
    }
    else previous.data = { ...previous.data, ...data }
  }
  return [...items.values()]
}

/** The final answer: assistant text after the last user message, falling back to status.lastAnswer. */
export function answerOf(items, status) {
  let lastUser = -1
  items.forEach((item, index) => { if (item.data.type === 'text' && item.data.role === 'user') lastUser = index })
  const text = items.slice(lastUser + 1).filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text ?? '').join('\n').trim()
  return text || (status?.lastAnswer ?? '')
}

/** The last completed process_files call whose output is its JSON result object. */
export function findValidatedArtifact(items) {
  for (let index = items.length - 1; index >= 0; index--) {
    const data = items[index].data
    if (data.type !== 'tool' || data.name !== 'process_files' || data.status !== 'completed') continue
    const output = typeof data.output === 'string' ? data.output.trim() : ''
    if (!output.startsWith('{')) continue
    let parsed
    try { parsed = JSON.parse(output) } catch { continue }
    if (parsed?.result && Array.isArray(parsed.result.outcomes)) return { sequence: items[index].sequence, result: parsed.result }
  }
  return null
}

/**
 * History carries only the tail of a large tool output, with an outputArtifactId for the rest.
 * Fetch the full text for the tools the predicate reads (process_files by default) through
 * agents.artifact; a fetch that fails leaves the tail in place.
 */
export async function resolveArtifactOutputs(items, call, agentSessionId, { names = ['process_files'] } = {}) {
  for (const item of items) {
    const data = item.data
    if (data?.type !== 'tool' || !names.includes(data.name) || !data.outputArtifactId) continue
    try {
      const full = await call('agents.artifact', { agentSessionId, artifactId: data.outputArtifactId })
      if (typeof full?.content === 'string') item.data = { ...data, output: full.content, outputResolved: true }
    } catch { /* the tail stays; the predicate reports the artifact as missing */ }
  }
  return items
}

export function countOutcomes(outcomes) {
  const counts = {}
  for (const outcome of outcomes ?? []) counts[outcome?.status ?? 'unknown'] = (counts[outcome?.status ?? 'unknown'] ?? 0) + 1
  return counts
}

/**
 * The success predicate. Pure: status is agents.status, events the full agents.history.
 * Returns {pass, failures, counts, answer, artifact}.
 */
export function evaluateRun({ goal, status, events, oracle, items: resolvedItems }) {
  const success = goal.success ?? {}
  const failures = []
  // Items whose large outputs were already fetched in full (resolveArtifactOutputs) are preferred
  // over a fresh fold of the events, which would only hold the tails again.
  const items = resolvedItems ?? projectItems(events)
  const answer = answerOf(items, status)
  const stop = status?.stop ?? null
  const tools = items.filter(item => item.data.type === 'tool')
  const counts = {
    events: events?.length ?? 0,
    toolCalls: tools.length,
    toolFailures: tools.filter(item => item.data.status === 'failed').length,
    errors: items.filter(item => item.data.type === 'error').length,
    rounds: stop?.rounds ?? null,
    loopWarnings: stop?.loopWarnings ?? null,
    outcomes: null
  }
  if (success.phases?.length && !success.phases.includes(status?.phase)) failures.push(`phase is ${JSON.stringify(status?.phase ?? null)}, expected one of ${success.phases.join(', ')}`)
  if (success.stopReasons?.length) {
    if (!stop) failures.push('no local stop report on the timeline')
    else if (!success.stopReasons.includes(stop.reason)) failures.push(`stop reason ${stop.reason}${stop.detail ? ` (${stop.detail})` : ''}, expected ${success.stopReasons.join(' or ')}`)
  }
  for (const pattern of success.answerMatches ?? []) if (!new RegExp(pattern).test(answer)) failures.push(`answer does not match /${pattern}/`)
  for (const pattern of success.answerRejects ?? []) {
    const expression = new RegExp(pattern)
    if (expression.test(answer) || (status?.lastAnswer && expression.test(status.lastAnswer))) failures.push(`answer contains rejected text /${pattern}/`)
  }
  if (success.maxLoopWarnings !== undefined && (stop?.loopWarnings ?? 0) > success.maxLoopWarnings) failures.push(`${stop.loopWarnings} loop warnings, at most ${success.maxLoopWarnings} allowed`)
  const artifact = findValidatedArtifact(items)
  if (artifact) counts.outcomes = { total: artifact.result.outcomes.length, ...countOutcomes(artifact.result.outcomes) }
  if (success.requireValidatedArtifact) {
    if (!artifact) failures.push('no validated process_files artifact (completed tool call with a JSON result.outcomes)')
    else if (artifact.result.outcomes.some(outcome => outcome?.status === 'blocked')) failures.push(`validated artifact has ${counts.outcomes.blocked} blocked outcome(s)`)
  }
  if (oracle && !oracle.skipped && !oracle.pass) failures.push(`oracle failed: ${(oracle.notes ?? []).join('; ') || 'no notes'}`)
  return { pass: failures.length === 0, failures, counts, answer, artifact: artifact?.result ?? null, oracle: oracle ?? null }
}

/** Load and run the goal's oracle module. A missing file is skipped with a note, a throwing one fails. */
export async function runOracle(goal, context, { checkout = CHECKOUT } = {}) {
  const spec = goal.success?.oracle
  if (!spec) return null
  const path = isAbsolute(spec) ? spec : resolve(checkout, spec)
  if (!existsSync(path)) return { skipped: true, pass: true, notes: [`oracle ${spec} not found; skipped`] }
  try {
    const module = await import(pathToFileURL(path).href + `?t=${Date.now()}`)
    if (typeof module.evaluate !== 'function') return { pass: false, notes: [`oracle ${spec} exports no evaluate()`] }
    const result = await module.evaluate({ goal, ...context })
    return { pass: Boolean(result?.pass), notes: Array.isArray(result?.notes) ? result.notes.map(String) : [] }
  } catch (error) {
    return { pass: false, notes: [`oracle ${spec} threw: ${error?.message ?? error}`] }
  }
}
