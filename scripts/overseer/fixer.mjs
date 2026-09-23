import { CLAUDE_SETTLED, waitSettled } from './agent-wait.mjs'
import { projectItems } from './evaluate.mjs'
import { fetchAllHistory } from './evidence.mjs'
import { clip } from './util.mjs'

export const MARKER = 'OVERSEER_RESULT'
const MARKER_LINE = /^[ \t>*_`]*OVERSEER_RESULT:[ \t]*(fixed|blocked|no-change)\b[ \t:\-–—*_`]*(.*?)[ \t*_`]*$/gim

/** The last OVERSEER_RESULT line in a text, as {result, summary}, or null. */
export function parseMarker(text) {
  if (typeof text !== 'string' || !text.includes(MARKER)) return null
  let found = null
  for (const match of text.matchAll(MARKER_LINE)) found = { result: match[1].toLowerCase(), summary: match[2].trim() }
  return found
}

/** Marker from lastAnswer first, then the latest assistant text items in history, newest first. */
export function findMarker(status, events) {
  const direct = parseMarker(status?.lastAnswer)
  if (direct) return { ...direct, source: 'lastAnswer' }
  const items = projectItems(events).filter(item => item.data.type === 'text' && item.data.role === 'assistant')
  for (let index = items.length - 1; index >= 0; index--) {
    const marker = parseMarker(items[index].data.text)
    if (marker) return { ...marker, source: 'history' }
  }
  return null
}

/** Exact configured model if the claude catalog lists it, else the first opus id, else the default. */
export function chooseClaudeModel(catalog, wanted) {
  const claude = (Array.isArray(catalog) ? catalog : []).find(entry => entry?.provider === 'claude')
  const models = claude?.models ?? []
  if (wanted && models.some(model => model.id === wanted)) return wanted
  const opus = models.find(model => /opus/i.test(model.id))
  if (opus) return opus.id
  return models.find(model => model.isDefault)?.id ?? models[0]?.id ?? wanted
}

/** Human-readable failure digest for one goal run. */
export function failureSummary(result) {
  const evaluation = result?.evaluation ?? {}
  const status = result?.status ?? {}
  const stop = status.stop
  const lines = []
  for (const failure of result?.failures ?? evaluation.failures ?? []) lines.push(`- ${failure}`)
  if (stop) lines.push(`- Stop report: ${stop.reason}: ${stop.detail ?? ''} (rounds ${stop.rounds}/${stop.hardLimit}, loop warnings ${stop.loopWarnings ?? 0}, compactions ${stop.compactions ?? 0}${stop.context ? `, context ${stop.context.usedTokens}/${stop.context.capacityTokens}` : ''})`)
  else if (status.phase) lines.push(`- Phase ${status.phase}; no local stop report`)
  if (status.lastTool) lines.push(`- Last tool: ${status.lastTool.name} [${status.lastTool.status}]`)
  if (status.lastError) lines.push(`- Last error: ${clip(status.lastError, 400)}`)
  if (evaluation.counts?.outcomes) lines.push(`- Artifact outcomes: ${JSON.stringify(evaluation.counts.outcomes)}`)
  for (const note of evaluation.oracle?.notes ?? []) lines.push(`- Oracle: ${note}`)
  if (result?.error) lines.push(`- Overseer error: ${result.error}`)
  return lines.join('\n')
}

/** The whole fixer brief. Pure, so its contents are testable. */
export function buildFixerPrompt({ goal, iteration, iterations, result, checkout }) {
  const status = result?.status ?? {}
  const files = result?.evidenceFiles ?? {}
  const answerTail = (status.lastAnswer ?? result?.evaluation?.answer ?? '').slice(-600)
  const evidence = [
    ['Evidence folder', result?.evidenceDir],
    ['Timeline (one line per event)', files.timeline],
    ['Raw events', files.events],
    ['agents.status', files.status],
    ['Final answer', files.answer],
    ['Evaluation', files.evaluation],
    ['Local server log tail', files.serverLog]
  ].filter(([, path]) => path).map(([label, path]) => `- ${label}: ${path}`)
  return [
    `You are an autonomous fixer dispatched by the Conductor overseer (scripts/overseer.mjs), iteration ${iteration} of ${iterations}. Nobody is watching this tab; the overseer reads your final message.`,
    '',
    '## Goal that failed',
    `- Id: ${goal.id}`,
    `- Title: ${goal.title}`,
    `- Worker: provider ${goal.worker.provider}, model ${goal.worker.model}${goal.worker.permission ? `, permission ${goal.worker.permission}` : ''}`,
    `- Prompt the worker received: ${goal.prompt}`,
    `- Project inputs: ${goal.project.inputs.join(', ') || '(none)'} from ${goal.project.path}`,
    '',
    '## What went wrong',
    failureSummary(result) || '- (no failure details recorded)',
    '',
    'Last 600 characters of the worker\'s answer:',
    '```',
    answerTail || '(no answer)',
    '```',
    '',
    '## Evidence',
    ...(evidence.length ? evidence : ['- (no evidence files were written)']),
    ...(goal.fixer.focus?.length ? ['', `Likely area: ${goal.fixer.focus.join(', ')}`] : []),
    ...(goal.fixer.notes ? ['', `Background from the owner: ${goal.fixer.notes}`] : []),
    '',
    '## How to work',
    `1. Read AGENTS.md and docs/overseer.md in the checkout (${checkout}) first.`,
    '2. Find and fix the root cause in the checkout. Do not paper over it for this one input, and do not edit the goal file or its oracle to make it pass.',
    '3. Add or adjust tests that capture the failure, and run the relevant vitest files (npx vitest run <files>).',
    '4. Never run `npm run dev`, never launch the app over the owner\'s screen, and never start a local model yourself; the overseer rebuilds, relaunches and retests after you finish.',
    '5. Deliver with app control: `git.ship({message, paths:[<only the files you changed>]})`, then call `git.ship.status({waitSeconds:100})` until it settles. Never publish (no `publish:true`), never push, never tag.',
    '6. Other fixers may be working in the same checkout at the same time on other goals: touch only what your fix needs and keep their changes.',
    '',
    '## How to finish',
    'End your final message with exactly one line, one of:',
    `${MARKER}: fixed <short summary of the fix and the commit>`,
    `${MARKER}: blocked <what only the owner can decide or provide>`,
    `${MARKER}: no-change <why no change is needed or possible>`
  ].join('\n')
}

/**
 * Dispatch one fixer tab in the fixer app, wait for it, and return its verdict.
 * `app` = {call, scope} for the checkout project in the fixer app. `head()` reads git HEAD.
 */
export async function dispatchFixer({ app, goal, iteration, iterations, result, checkout, head, log = () => {}, pollMs = 10_000, sleep, now }) {
  const catalog = await app.call('models.list', {}, app.scope)
  const model = chooseClaudeModel(catalog, goal.fixer.model)
  const title = `Overseer fixer: ${goal.id} #${iteration}`
  const tab = await app.call('tabs.open', { provider: 'claude', model, title, focus: false, projectId: app.scope.projectId, workspaceId: app.scope.workspaceId }, app.scope)
  const agentSessionId = tab.resourceId
  const before = await app.call('agents.status', { agentSessionId }, app.scope)
  const headBefore = head()
  const prompt = buildFixerPrompt({ goal, iteration, iterations, result, checkout })
  await app.call('agents.submit', { agentSessionId, prompt }, app.scope)
  log(`fixer ${goal.id} #${iteration}: tab ${tab.id} on ${model}`)
  const timeoutMs = goal.fixer.timeoutMinutes * 60_000
  const call = (method, args) => app.call(method, args, app.scope)
  const { status, timedOut } = await waitSettled({ call, agentSessionId, settled: CLAUDE_SETTLED, baselineSequence: before?.sequence ?? 0, pollMs, timeoutMs, sleep, now })
  const base = { goalId: goal.id, tabId: tab.id, agentSessionId, model, headBefore, phase: status?.phase ?? null }
  if (timedOut) {
    try { await call('agents.interrupt', { agentSessionId }) } catch (error) { log(`fixer ${goal.id}: interrupt failed: ${error.message}`) }
    return { ...base, result: 'blocked', summary: `fixer timed out after ${goal.fixer.timeoutMinutes} minutes`, headAfter: head() }
  }
  let marker = parseMarker(status?.lastAnswer)
  if (!marker) marker = findMarker(status, await fetchAllHistory(call, agentSessionId))
  const headAfter = head()
  if (!marker) return { ...base, result: 'no-change', summary: `fixer settled at ${status?.phase} without an ${MARKER} line`, headAfter, answerTail: (status?.lastAnswer ?? '').slice(-600) }
  if (marker.result === 'fixed' && headAfter === headBefore) return { ...base, result: 'no-change', summary: `claimed fixed but HEAD did not move: ${marker.summary}`, claimed: 'fixed', headAfter }
  return { ...base, result: marker.result, summary: marker.summary, headAfter }
}
