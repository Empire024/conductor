// Read-only accounting for native provider logs and Conductor's recall ledger.
// Usage: node scripts/measure-context-churn.mjs [--days=14] [--json]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const CHANGE_AT = '2026-09-21T16:30:00.000Z'
const MARKERS = ['Conductor project memory (current project evidence takes precedence):', 'Conductor keeps durable, project-scoped memory across sessions', '[Conductor coworker briefing', 'Conductor project tasks: feature-list.md', 'Conductor app control: a first-party local JSON protocol']
const BLOCKS = [['memory', /Conductor project memory \(current project evidence takes precedence\):[\s\S]*?(?=\n\n(?:Conductor keeps durable|\[Conductor coworker|Conductor project tasks:|Conductor app control:)|$)/], ['protocol', /Conductor keeps durable, project-scoped memory[\s\S]*?(?=\n\n(?:\[Conductor coworker|Conductor project tasks:|Conductor app control:)|$)/], ['coworker', /\[Conductor coworker briefing[\s\S]*?(?=\n\n(?:Conductor project tasks:|Conductor app control:)|$)/], ['tasks', /Conductor project tasks: feature-list\.md[\s\S]*?(?=\n\nConductor app control:|$)/], ['control', /Conductor app control: a first-party[\s\S]*$/]]
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0

export function splitPrompt(text) {
  let cut = text.length
  for (const marker of MARKERS) { const at = text.indexOf(marker); if (at >= 0 && at < cut) cut = at }
  const own = text.slice(0, cut).trim(), appended = text.slice(cut), blocks = {}
  for (const [name, pattern] of BLOCKS) { const match = pattern.exec(appended); if (match) blocks[name] = match[0].length }
  return { own, appended, blocks }
}

const contentText = (content, type = 'text') => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x?.type === type || (type === 'input_text' && x?.type === 'text')).map(x => x.text ?? '').join('') : ''
const base = (provider, id, project) => ({ provider, id, project, role: 'parent', parentId: null, model: undefined, userTurns: [], calls: [], compactions: 0, briefedTurns: 0, ownChars: 0, appendedChars: 0, blocks: {}, repeatedControl: 0, repeatedTasks: 0, memoryLines: 0, distinctMemoryLines: new Set(), duplicateUsageEvents: 0, _controls: new Set(), _tasks: new Set() })

function promptStats(session, text) {
  const { own, appended, blocks } = splitPrompt(text)
  if (!appended) return
  session.briefedTurns++; session.ownChars += own.length; session.appendedChars += appended.length
  for (const [key, value] of Object.entries(blocks)) session.blocks[key] = (session.blocks[key] ?? 0) + value
  const control = /Conductor app control:[\s\S]*$/.exec(appended)?.[0]
  if (control) { if (session._controls.has(control)) session.repeatedControl++; session._controls.add(control) }
  const tasks = /Conductor project tasks:[^\n]*/.exec(appended)?.[0]
  if (tasks) { if (session._tasks.has(tasks)) session.repeatedTasks++; session._tasks.add(tasks) }
  for (const match of appended.matchAll(/^- \[(?:semantic|episodic|procedural)\] .*$/gm)) { session.memoryLines++; session.distinctMemoryLines.add(match[0]) }
}

function finish(session) {
  delete session._controls; delete session._tasks
  session.distinctMemoryLines = session.distinctMemoryLines.size
  session.calls.sort((a, b) => time(a.timestamp) - time(b.timestamp)); session.userTurns.sort((a, b) => time(a.timestamp) - time(b.timestamp))
  return session
}

export function parseClaudeLines(lines, { id = 'claude-session', project } = {}) {
  const session = base('claude', id, project), requests = new Map(); let segment = 0
  for (const line of lines) {
    let event; try { event = typeof line === 'string' ? JSON.parse(line) : line } catch { continue }
    if (event.type === 'system' && event.subtype === 'compact_boundary') { session.compactions++; segment++; continue }
    if (event.type === 'user') {
      const content = event.message?.content, text = contentText(content)
      if (!text || (Array.isArray(content) && content.some(x => x?.type === 'tool_result'))) continue
      const role = event.isSidechain ? 'sidechain' : 'parent'; session.userTurns.push({ timestamp: event.timestamp, role, segment })
      if (role === 'parent') promptStats(session, text)
      continue
    }
    if (event.type !== 'assistant' || !event.message?.usage) continue
    const usage = event.message.usage, key = event.requestId || event.message.id || event.uuid
    if (!key) continue
    const call = { key, timestamp: event.timestamp, role: event.isSidechain ? 'sidechain' : 'parent', model: event.message.model, segment, inputTokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens), cachedInputTokens: n(usage.cache_read_input_tokens), cacheCreationInputTokens: n(usage.cache_creation_input_tokens), uncachedInputTokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens), outputTokens: n(usage.output_tokens) }
    call.contextTokens = call.inputTokens
    const prior = requests.get(key)
    if (prior) { session.duplicateUsageEvents++; for (const field of ['inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'uncachedInputTokens', 'outputTokens', 'contextTokens']) prior[field] = Math.max(prior[field], call[field]) } else requests.set(key, call)
    session.model ??= call.model
  }
  session.calls = [...requests.values()]
  return finish(session)
}

const codexRole = meta => { const source = JSON.stringify(meta.source ?? meta.thread_source ?? ''); return /guardian/i.test(source) ? 'guardian' : meta.parent_thread_id || /subagent/i.test(source) ? 'child' : 'parent' }
const usage = value => ({ input: n(value?.input_tokens), cached: n(value?.cached_input_tokens), output: n(value?.output_tokens), reasoning: n(value?.reasoning_output_tokens), total: n(value?.total_tokens) })

export function parseCodexLines(lines, { id = 'codex-session', project } = {}) {
  const session = base('codex', id, project); let segment = 0, previous = usage(), signature = null, index = 0
  for (const line of lines) {
    let event; try { event = typeof line === 'string' ? JSON.parse(line) : line } catch { continue }
    const payload = event.payload ?? {}
    if (event.type === 'session_meta') { session.role = codexRole(payload); session.parentId = payload.parent_thread_id ?? null; session.model ??= payload.model; continue }
    if (event.type === 'turn_context') { session.model ??= payload.model; continue }
    if ((event.type === 'event_msg' && /compact/i.test(payload.type ?? '')) || event.type === 'thread_compacted' || (event.type === 'response_item' && /compact/i.test(payload.type ?? ''))) { session.compactions++; segment++; continue }
    if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = contentText(payload.content, 'input_text')
      if (!text || /^<(?:environment_context|user_instructions|permissions instructions|turn_aborted)/.test(text.trim())) continue
      session.userTurns.push({ timestamp: event.timestamp, role: session.role, segment }); if (session.role === 'parent') promptStats(session, text); continue
    }
    if (event.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info?.total_token_usage) continue
    const total = usage(payload.info.total_token_usage), nextSignature = JSON.stringify(total)
    if (nextSignature === signature) { session.duplicateUsageEvents++; continue }
    const reset = Object.keys(total).some(key => total[key] < previous[key])
    const delta = Object.fromEntries(Object.keys(total).map(key => [key, reset ? total[key] : Math.max(0, total[key] - previous[key])]))
    previous = total; signature = nextSignature
    if (!(delta.input || delta.cached || delta.output || delta.reasoning)) continue
    const last = usage(payload.info.last_token_usage)
    session.calls.push({ key: `${id}:${++index}`, timestamp: event.timestamp, role: session.role, model: session.model, segment, inputTokens: delta.input, cachedInputTokens: Math.min(delta.input, delta.cached), cacheCreationInputTokens: 0, uncachedInputTokens: Math.max(0, delta.input - delta.cached), outputTokens: delta.output, contextTokens: last.input || last.total || undefined })
  }
  return finish(session)
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0, min: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, max: 0, mean: 0 }
  const q = p => { const at = (sorted.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at); return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)) }
  return { n: sorted.length, min: sorted[0], p25: q(.25), p50: q(.5), p75: q(.75), p90: q(.9), p95: q(.95), max: sorted.at(-1), mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) }
}

function aggregate(calls) {
  const sums = calls.reduce((out, call) => { for (const key of ['inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'uncachedInputTokens', 'outputTokens']) out[key] += call[key] ?? 0; return out }, { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0 })
  return { apiCalls: calls.length, ...sums, cacheRatio: sums.inputTokens ? Number((sums.cachedInputTokens / sums.inputTokens).toFixed(4)) : 0, distributions: { inputPerCall: distribution(calls.map(x => x.inputTokens)), cachedInputPerCall: distribution(calls.map(x => x.cachedInputTokens)), uncachedInputPerCall: distribution(calls.map(x => x.uncachedInputTokens)), outputPerCall: distribution(calls.map(x => x.outputTokens)), contextPerCall: distribution(calls.map(x => x.contextTokens).filter(Number.isFinite)) } }
}

function summarize(sessions, calls) {
  const turns = sessions.flatMap(x => x.userTurns), relevant = sessions.filter(x => x.calls.length || x.userTurns.length)
  const prompt = relevant.reduce((out, x) => { for (const key of ['briefedTurns', 'ownChars', 'appendedChars', 'repeatedControl', 'repeatedTasks', 'memoryLines', 'distinctMemoryLines']) out[key] += x[key]; for (const [key, value] of Object.entries(x.blocks)) out.blocks[key] = (out.blocks[key] ?? 0) + value; return out }, { briefedTurns: 0, ownChars: 0, appendedChars: 0, repeatedControl: 0, repeatedTasks: 0, memoryLines: 0, distinctMemoryLines: 0, blocks: {} })
  return { sessions: relevant.length, userTurns: turns.length, parentUserTurns: turns.filter(x => x.role === 'parent').length, callsPerUserTurn: turns.length ? Number((calls.length / turns.length).toFixed(2)) : null, ...aggregate(calls), sessionDistributions: { callsPerSession: distribution(relevant.map(x => x.calls.length)), userTurnsPerSession: distribution(relevant.map(x => x.userTurns.length)), callsPerParentTurn: distribution(relevant.filter(x => x.role === 'parent' && x.userTurns.length).map(x => x.calls.length / x.userTurns.length)) }, promptBriefing: { briefedTurns: prompt.briefedTurns, ownerEstimatedTokens: Math.round(prompt.ownChars / 4), appendedEstimatedTokens: Math.round(prompt.appendedChars / 4), appendedPerBriefedTurnEstimatedTokens: prompt.briefedTurns ? Math.round(prompt.appendedChars / prompt.briefedTurns / 4) : 0, blockEstimatedTokens: Object.fromEntries(Object.entries(prompt.blocks).map(([key, value]) => [key, Math.round(value / 4)])), repeatedControl: prompt.repeatedControl, repeatedTasks: prompt.repeatedTasks, memoryLines: prompt.memoryLines, distinctMemoryLinesWithinSessions: prompt.distinctMemoryLines, resentMemoryLines: prompt.memoryLines - prompt.distinctMemoryLines } }
}

function strategy(calls) {
  const groups = Map.groupBy(calls.filter(x => x.role === 'parent' && x.model && !x.model.startsWith('<') && Number.isFinite(x.contextTokens) && x.contextTokens > 0), x => x.model), rows = []
  for (const [model, modelCalls] of groups) {
    const observed = distribution(modelCalls.map(x => x.contextTokens)), context = Math.max(1, observed.p50)
    for (const cacheRatio of [0, .5, .9, 1]) {
      const weighted = tokens => tokens * (1 - cacheRatio + cacheRatio * .1), continuing = weighted(context), compactOneTime = weighted(context) + 1_200 * 3 + 1_500, compactEach = weighted(Math.min(40_000, context * .35)), freshOneTime = weighted(context) + 1_200 * 3 + weighted(18_904) + 8_600 + 1_200 + 2_500 + 4_000 + .15 * 6_000, freshEach = weighted(18_904 + 1_200)
      const payback = (once, each) => continuing > each ? Math.ceil(once / (continuing - each)) : null
      rows.push({ model, cacheRatio, observedContextP50: observed.p50, observedContextP90: observed.p90, continuingEstimatedEquivalentTokensPerCall: Math.round(continuing), compactingEstimatedOneTimeEquivalentTokens: Math.round(compactOneTime), compactingEstimatedEquivalentTokensPerCall: Math.round(compactEach), compactingPaybackCalls: payback(compactOneTime, compactEach), freshHandoffEstimatedOneTimeEquivalentTokens: Math.round(freshOneTime), freshEstimatedEquivalentTokensPerCall: Math.round(freshEach), freshHandoffPaybackCalls: payback(freshOneTime, freshEach) })
    }
  }
  return { label: 'ESTIMATE, not a measured product saving', assumptions: { cachedInputPriceMultiplier: .1, outputToInputMultiplier: 3, boundedHandoffTokens: 1_200, sharedFreshPrefixCachedTokens: 18_904, freshPrefixUncachedTokens: 8_600, reorientationTokens: 2_500, verificationTokens: 4_000, escalationProbability: .15, escalationTokensWhenNeeded: 6_000, compactedContext: 'min(40,000, 35% of observed model median context)', limitation: 'Static-context replay model; excludes latency, quality loss, context growth, quota rules, and provider-specific prices.' }, rows }
}

export function buildReport(sessions, { days = 14, since = 0, until = Date.now(), changeAt = CHANGE_AT, ledger = null, generatedAt = new Date(until).toISOString() } = {}) {
  const cutoff = Date.parse(changeAt), inWindow = x => time(x.timestamp) >= since && time(x.timestamp) <= until, selected = sessions.filter(x => x.calls.some(inWindow) || x.userTurns.some(inWindow)).map(x => ({ ...x, calls: x.calls.filter(inWindow), userTurns: x.userTurns.filter(inWindow) }))
  for (const session of selected) for (const call of session.calls) { call.provider = session.provider; call.role ??= session.role }
  const calls = selected.flatMap(x => x.calls), turns = selected.flatMap(x => x.userTurns)
  return { schemaVersion: 2, generatedAt, window: { days, since: new Date(since).toISOString(), changeAt }, privacy: 'Sanitized aggregates only; no prompt text, credentials, absolute log paths, or full session identifiers.', definitions: { userTurn: 'A non-tool user message; retries and tool rounds do not increase this count.', apiCall: 'Claude: one unique requestId/message id. Codex: one positive delta in cumulative total_token_usage.', cachedInput: 'Claude cache reads; Codex cached input (a subset of input).', uncachedInput: 'Claude input plus cache creation; Codex input minus cached input.', period: 'Durable event timestamp, not file modification time.' }, ingestion: { sessions: selected.length, userTurns: turns.length, apiCalls: calls.length, duplicateUsageEventsDiscarded: selected.reduce((sum, x) => sum + x.duplicateUsageEvents, 0), compactionBoundaries: selected.reduce((sum, x) => sum + x.compactions, 0) }, all: summarize(selected, calls), byProvider: Object.fromEntries(['claude', 'codex'].map(provider => [provider, summarize(selected.filter(x => x.provider === provider), calls.filter(x => x.provider === provider))])), byPeriod: { beforeV0136: aggregate(calls.filter(x => time(x.timestamp) < cutoff)), afterV0136: aggregate(calls.filter(x => time(x.timestamp) >= cutoff)) }, byRole: Object.fromEntries(['parent', 'sidechain', 'guardian', 'child'].map(role => [role, aggregate(calls.filter(x => x.role === role || (role === 'child' && ['sidechain', 'guardian', 'child'].includes(x.role))))])), ledger, strategySensitivity: strategy(calls) }
}

function walk(root) { const out = []; if (!existsSync(root)) return out; const visit = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); let stat; try { stat = statSync(path) } catch { continue }; if (stat.isDirectory()) visit(path); else if (path.endsWith('.jsonl')) out.push(path) } }; visit(root); return out }
const lines = path => { try { return readFileSync(path, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
function sessions(since) {
  const out = []
  for (const file of walk(join(homedir(), '.claude', 'projects'))) { try { if (statSync(file).mtimeMs < since) continue } catch { continue }; out.push(parseClaudeLines(lines(file), { id: basename(file, '.jsonl'), project: basename(dirname(file)) })) }
  for (const file of walk(join(homedir(), '.codex', 'sessions'))) { try { if (statSync(file).mtimeMs < since) continue } catch { continue }; out.push(parseCodexLines(lines(file), { id: basename(file, '.jsonl') })) }
  return out
}
function ledger(since) {
  const file = join(process.env.APPDATA ?? '', 'Conductor', 'conductor.db'); if (!existsSync(file)) return null
  const db = new DatabaseSync(file, { readOnly: true })
  try { const recalls = db.prepare(`SELECT agent_session_id, COUNT(*) turns, GROUP_CONCAT(memory_ids_json, '|') ids FROM memory_recalls WHERE created_at >= ? GROUP BY agent_session_id`).all(new Date(since).toISOString()), perSession = recalls.map(row => { const ids = row.ids.split('|').flatMap(json => { try { return JSON.parse(json) } catch { return [] } }); return { turns: row.turns, rows: ids.length, distinct: new Set(ids).size } }), totals = perSession.reduce((a, x) => ({ turns: a.turns + x.turns, rows: a.rows + x.rows, distinct: a.distinct + x.distinct }), { turns: 0, rows: 0, distinct: 0 }), collaboration = db.prepare(`SELECT kind, COUNT(*) n FROM agent_collaboration_messages WHERE created_at >= ? GROUP BY kind`).all(new Date(since).toISOString()), views = db.prepare(`SELECT COUNT(*) n FROM agent_collaboration_messages WHERE created_at >= ? AND kind = 'intent' AND body LIKE 'view %'`).get(new Date(since).toISOString()); return { sessionsWithRecall: perSession.length, recallTurns: totals.turns, memoryRowsSent: totals.rows, redundantMemoryRows: totals.rows - totals.distinct, collaborationMessages: Object.fromEntries(collaboration.map(x => [x.kind, Number(x.n)])), viewIntents: Number(views?.n ?? 0) } } finally { db.close() }
}
function human(report) { const out = [`Window: ${report.window.since} to ${report.generatedAt}; change boundary ${report.window.changeAt}`, `Parsed ${report.ingestion.sessions} sessions, ${report.ingestion.userTurns} user turns and ${report.ingestion.apiCalls} API calls; discarded ${report.ingestion.duplicateUsageEventsDiscarded} duplicate usage events.`]; for (const [name, x] of Object.entries(report.byProvider)) out.push(`${name}: ${x.userTurns} turns, ${x.apiCalls} calls (${x.callsPerUserTurn ?? 'n/a'}/turn); input/call p50 ${x.distributions.inputPerCall.p50}, p90 ${x.distributions.inputPerCall.p90}; ${Math.round(x.cacheRatio * 100)}% cached.`); for (const [name, x] of Object.entries(report.byPeriod)) out.push(`${name}: ${x.apiCalls} calls; input/call mean ${x.distributions.inputPerCall.mean}, p50 ${x.distributions.inputPerCall.p50}, p90 ${x.distributions.inputPerCall.p90}; ${Math.round(x.cacheRatio * 100)}% cached.`); out.push('Strategy sensitivity is an estimate, not a measured product saving.'); return out.join('\n') }
async function main() { const args = Object.fromEntries(process.argv.slice(2).map(arg => { const match = /^--([^=]+)(?:=(.*))?$/.exec(arg); return match ? [match[1], match[2] ?? true] : [arg, true] })), days = n(args.days || 14), until = args.until ? Date.parse(args.until) : Date.now(), since = args.since ? Date.parse(args.since) : until - days * 86_400_000, report = buildReport(sessions(since), { days, since, until, ledger: ledger(since) }); console.log(args.json ? JSON.stringify(report, null, 2) : human(report)) }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
