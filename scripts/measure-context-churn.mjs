// Measures how much of every native turn Conductor's own briefing occupies, from the logs the
// provider CLIs keep on disk and from the app's recall ledger. Read-only: nothing is sent to a
// model. Usage: node scripts/measure-context-churn.mjs [--days=14] [--json]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const m = /^--([^=]+)(?:=(.*))?$/.exec(arg); return m ? [m[1], m[2] ?? true] : [arg, true] }))
const days = Number(args.days ?? 14)
const since = Date.now() - days * 86_400_000
const MARKERS = ['Conductor project memory (current project evidence takes precedence):', 'Conductor keeps durable, project-scoped memory across sessions', '[Conductor coworker briefing', 'Conductor project tasks: feature-list.md', 'Conductor app control: a first-party local JSON protocol']
const BLOCKS = [['memory', /Conductor project memory \(current project evidence takes precedence\):[\s\S]*?(?=\n\n(?:Conductor keeps durable|\[Conductor coworker|Conductor project tasks:|Conductor app control:)|$)/],
  ['protocol', /Conductor keeps durable, project-scoped memory[\s\S]*?(?=\n\n(?:\[Conductor coworker|Conductor project tasks:|Conductor app control:)|$)/],
  ['coworker', /\[Conductor coworker briefing[\s\S]*?(?=\n\n(?:Conductor project tasks:|Conductor app control:)|$)/],
  ['tasks', /Conductor project tasks: feature-list\.md[\s\S]*?(?=\n\n(?:Conductor app control:)|$)/],
  ['control', /Conductor app control: a first-party[\s\S]*$/]]
const tokens = chars => Math.round(chars / 4)

function splitPrompt(text) {
  let cut = text.length
  for (const marker of MARKERS) { const at = text.indexOf(marker); if (at >= 0 && at < cut) cut = at }
  const own = text.slice(0, cut).trim(), appended = text.slice(cut)
  const blocks = {}
  for (const [name, re] of BLOCKS) { const m = re.exec(appended); if (m) blocks[name] = m[0].length }
  return { own, appended, blocks }
}

function claudeSessions() {
  const root = join(homedir(), '.claude', 'projects')
  const out = []
  if (!existsSync(root)) return out
  for (const dir of readdirSync(root)) {
    const full = join(root, dir)
    for (const name of readdirSync(full).filter(n => n.endsWith('.jsonl'))) {
      const file = join(full, name)
      if (statSync(file).mtimeMs < since) continue
      let lines
      try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { continue }
      const session = { provider: 'claude', project: dir, id: name.replace('.jsonl', ''), turns: 0, briefedTurns: 0, ownChars: 0, appendedChars: 0, blocks: {}, repeatedControl: 0, repeatedTasks: 0, memoryLines: 0, distinctMemoryLines: new Set(), cacheCreation: 0, cacheRead: 0, input: 0, output: 0, assistantMessages: 0, model: undefined, compactions: 0 }
      const seenControl = new Set(), seenTasks = new Set()
      for (const line of lines) {
        let o; try { o = JSON.parse(line) } catch { continue }
        if (o.type === 'user' && !o.isSidechain) {
          const c = o.message?.content
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('') : ''
          if (!text || (Array.isArray(c) && c.some(b => b.type === 'tool_result'))) continue
          session.turns++
          const { own, appended, blocks } = splitPrompt(text)
          if (!appended) continue
          session.briefedTurns++
          session.ownChars += own.length; session.appendedChars += appended.length
          for (const [k, v] of Object.entries(blocks)) session.blocks[k] = (session.blocks[k] ?? 0) + v
          const control = /Conductor app control:[\s\S]*$/.exec(appended)?.[0]
          if (control) { if (seenControl.has(control)) session.repeatedControl++; seenControl.add(control) }
          const tasks = /Conductor project tasks:[^\n]*/.exec(appended)?.[0]
          if (tasks) { if (seenTasks.has(tasks)) session.repeatedTasks++; seenTasks.add(tasks) }
          for (const m of appended.matchAll(/^- \[(?:semantic|episodic|procedural)\] .*$/gm)) { session.memoryLines++; session.distinctMemoryLines.add(m[0]) }
        }
        if (o.type === 'assistant' && o.message?.usage && !o.isSidechain) {
          const u = o.message.usage
          session.assistantMessages++
          session.cacheCreation += u.cache_creation_input_tokens ?? 0; session.cacheRead += u.cache_read_input_tokens ?? 0
          session.input += u.input_tokens ?? 0; session.output += u.output_tokens ?? 0
          session.model ??= o.message.model
        }
        if (o.type === 'system' && o.subtype === 'compact_boundary') session.compactions++
      }
      if (session.briefedTurns) out.push({ ...session, distinctMemoryLines: session.distinctMemoryLines.size })
    }
  }
  return out
}

function codexSessions() {
  const root = join(homedir(), '.codex', 'sessions')
  const out = []
  if (!existsSync(root)) return out
  const walk = dir => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : [] })
  for (const file of walk(root)) {
    if (statSync(file).mtimeMs < since) continue
    let lines
    try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { continue }
    const session = { provider: 'codex', id: file.split(/[\\/]/).pop(), turns: 0, briefedTurns: 0, ownChars: 0, appendedChars: 0, blocks: {}, repeatedControl: 0, repeatedTasks: 0, memoryLines: 0, distinctMemoryLines: new Set(), lastInput: 0, totalInput: 0, cached: 0, output: 0, contextWindow: undefined, model: undefined }
    const seenControl = new Set(), seenTasks = new Set()
    for (const line of lines) {
      let o; try { o = JSON.parse(line) } catch { continue }
      const p = o.payload ?? {}
      if (o.type === 'session_meta') session.model = p.model ?? p.turn_context?.model
      if (o.type === 'turn_context') session.model ??= p.model
      if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = (p.content ?? []).filter(b => b.type === 'input_text').map(b => b.text).join('')
        if (!text || /^<(?:environment_context|user_instructions|permissions instructions|turn_aborted)/.test(text.trim())) continue
        session.turns++
        const { own, appended, blocks } = splitPrompt(text)
        if (!appended) continue
        session.briefedTurns++
        session.ownChars += own.length; session.appendedChars += appended.length
        for (const [k, v] of Object.entries(blocks)) session.blocks[k] = (session.blocks[k] ?? 0) + v
        const control = /Conductor app control:[\s\S]*$/.exec(appended)?.[0]
        if (control) { if (seenControl.has(control)) session.repeatedControl++; seenControl.add(control) }
        const tasks = /Conductor project tasks:[^\n]*/.exec(appended)?.[0]
        if (tasks) { if (seenTasks.has(tasks)) session.repeatedTasks++; seenTasks.add(tasks) }
        for (const m of appended.matchAll(/^- \[(?:semantic|episodic|procedural)\] .*$/gm)) { session.memoryLines++; session.distinctMemoryLines.add(m[0]) }
      }
      if (o.type === 'event_msg' && p.type === 'token_count' && p.info) {
        session.totalInput = p.info.total_token_usage?.input_tokens ?? session.totalInput
        session.cached = p.info.total_token_usage?.cached_input_tokens ?? session.cached
        session.output = p.info.total_token_usage?.output_tokens ?? session.output
        session.lastInput = p.info.last_token_usage?.input_tokens ?? session.lastInput
        session.contextWindow = p.info.model_context_window ?? session.contextWindow
      }
    }
    if (session.briefedTurns) out.push({ ...session, distinctMemoryLines: session.distinctMemoryLines.size })
  }
  return out
}

function ledger() {
  const file = join(process.env.APPDATA ?? '', 'Conductor', 'conductor.db')
  if (!existsSync(file)) return null
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const memories = db.prepare('SELECT project_id, COUNT(*) AS n, SUM(LENGTH(gist)) AS chars FROM memories GROUP BY project_id').all()
    const recalls = db.prepare(`SELECT agent_session_id, COUNT(*) AS turns, GROUP_CONCAT(memory_ids_json, '|') AS ids FROM memory_recalls WHERE created_at >= ? GROUP BY agent_session_id`).all(new Date(since).toISOString())
    const perSession = recalls.map(row => {
      const all = row.ids.split('|').flatMap(json => { try { return JSON.parse(json) } catch { return [] } })
      return { agentSessionId: row.agent_session_id, turns: row.turns, memoryRows: all.length, distinct: new Set(all).size }
    })
    const totals = perSession.reduce((t, s) => ({ turns: t.turns + s.turns, rows: t.rows + s.memoryRows, distinct: t.distinct + s.distinct }), { turns: 0, rows: 0, distinct: 0 })
    const intents = db.prepare(`SELECT kind, COUNT(*) AS n FROM agent_collaboration_messages WHERE created_at >= ? GROUP BY kind`).all(new Date(since).toISOString())
    const views = db.prepare(`SELECT COUNT(*) AS n FROM agent_collaboration_messages WHERE created_at >= ? AND kind = 'intent' AND body LIKE 'view %'`).get(new Date(since).toISOString())
    return { memories, sessionsWithRecall: perSession.length, recallTurns: totals.turns, memoryRowsSent: totals.rows, distinctMemoriesPerSessionSum: totals.distinct, redundantMemoryRows: totals.rows - totals.distinct, collaborationMessages: intents, viewIntents: views?.n ?? 0 }
  } finally { db.close() }
}

const claude = claudeSessions(), codex = codexSessions()
const summarize = list => {
  const t = list.reduce((acc, s) => { acc.sessions++; acc.turns += s.turns; acc.briefed += s.briefedTurns; acc.own += s.ownChars; acc.appended += s.appendedChars; acc.repeatedControl += s.repeatedControl; acc.repeatedTasks += s.repeatedTasks; acc.memoryLines += s.memoryLines; acc.distinctMemoryLines += s.distinctMemoryLines; for (const [k, v] of Object.entries(s.blocks)) acc.blocks[k] = (acc.blocks[k] ?? 0) + v; return acc }, { sessions: 0, turns: 0, briefed: 0, own: 0, appended: 0, repeatedControl: 0, repeatedTasks: 0, memoryLines: 0, distinctMemoryLines: 0, blocks: {} })
  return { ...t, appendedTokens: tokens(t.appended), ownTokens: tokens(t.own), appendedPerBriefedTurnTokens: t.briefed ? tokens(t.appended / t.briefed) : 0, blockTokens: Object.fromEntries(Object.entries(t.blocks).map(([k, v]) => [k, tokens(v)])) }
}
const report = { days, claude: summarize(claude), codex: summarize(codex), ledger: ledger(), worstClaude: [...claude].sort((a, b) => b.appendedChars - a.appendedChars).slice(0, 5).map(s => ({ id: s.id, project: s.project, model: s.model, turns: s.turns, briefed: s.briefedTurns, appendedTokens: tokens(s.appendedChars), ownTokens: tokens(s.ownChars), repeatedControl: s.repeatedControl, memoryLines: s.memoryLines, distinctMemoryLines: s.distinctMemoryLines, cacheCreation: s.cacheCreation, cacheRead: s.cacheRead, output: s.output, compactions: s.compactions })), codexSessions: codex.map(s => ({ id: s.id, model: s.model, turns: s.turns, briefed: s.briefedTurns, appendedTokens: tokens(s.appendedChars), ownTokens: tokens(s.ownChars), repeatedControl: s.repeatedControl, memoryLines: s.memoryLines, distinctMemoryLines: s.distinctMemoryLines, lastInput: s.lastInput, totalInput: s.totalInput, cached: s.cached, contextWindow: s.contextWindow })) }
if (args.json) console.log(JSON.stringify(report, null, 2))
else {
  const { claude: c, codex: x, ledger: l } = report
  console.log(`Window: last ${days} days`)
  for (const [name, s] of [['Claude', c], ['Codex', x]]) {
    console.log(`\n${name}: ${s.sessions} sessions, ${s.turns} user turns, ${s.briefed} carried a Conductor briefing`)
    console.log(`  owner text ≈ ${s.ownTokens} tokens; appended briefing ≈ ${s.appendedTokens} tokens (${s.appendedPerBriefedTurnTokens} per briefed turn)`)
    console.log(`  by block (tokens): ${JSON.stringify(s.blockTokens)}`)
    console.log(`  control briefing repeated verbatim in ${s.repeatedControl} turns; task briefing repeated in ${s.repeatedTasks} turns`)
    console.log(`  memory lines sent ${s.memoryLines}, distinct within their session ${s.distinctMemoryLines} → ${s.memoryLines - s.distinctMemoryLines} re-sent`)
  }
  if (l) {
    console.log(`\nApp database: ${l.sessionsWithRecall} conversations recalled memory across ${l.recallTurns} turns; ${l.memoryRowsSent} memory rows sent, ${l.redundantMemoryRows} of them repeats of a memory that conversation had already received`)
    console.log(`  memories per project: ${JSON.stringify(l.memories)}`)
    console.log(`  collaboration messages: ${JSON.stringify(l.collaborationMessages)}; 'view' intents: ${l.viewIntents}`)
  }
  console.log('\nHeaviest Claude sessions:')
  for (const s of report.worstClaude) console.log(`  ${s.project}/${s.id.slice(0, 8)} ${s.model ?? ''}: ${s.turns} turns, briefing ≈ ${s.appendedTokens} tok vs owner ≈ ${s.ownTokens} tok; control repeated ${s.repeatedControl}×; memory lines ${s.memoryLines} (${s.distinctMemoryLines} distinct); cache write ${s.cacheCreation}, cache read ${s.cacheRead}, output ${s.output}; compactions ${s.compactions}`)
  console.log('\nCodex sessions:')
  for (const s of report.codexSessions) console.log(`  ${s.id.slice(8, 27)} ${s.model ?? ''}: ${s.turns} turns, briefing ≈ ${s.appendedTokens} tok vs owner ≈ ${s.ownTokens} tok; control repeated ${s.repeatedControl}×; memory lines ${s.memoryLines} (${s.distinctMemoryLines} distinct); last input ${s.lastInput}, total input ${s.totalInput}, cached ${s.cached}, window ${s.contextWindow}`)
}
