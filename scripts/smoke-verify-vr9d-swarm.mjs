// VR9d (verify loop v3) dolphin-useful-like-any-model after FX42 (557e32f): a NEW small numeric swarm
// task asked the way the owner would (no tool arguments spelled out): two days of bakery sales, one
// coworker of itself per file counts items sold, the controller gives the weekend totals and the best
// seller (bagels 34 against muffins 33, so a merge done in the head shows). VR9a's timesheet task runs
// through the committed smoke-verify-vr9a-swarm.mjs.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9d-swarm.mjs [--runs 2] [--label L]
// Grades the model's own prose apart from the "Computed with calculate" block Conductor appends.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, outputDir, poll, record, sleep, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = arg('--label', '')
const runs = Number(arg('--runs', '2'))
configure({ name: 'vr9d-swarm' + (label ? '-' + label : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr9d' })
watchdog(Math.min(19 * 60, runs * 9 * 60 + 90))
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
const SETTLED = new Set(['completed', 'failed', 'interrupted', 'idle'])
const sat = [['muffin', 12], ['scone', 5], ['bagel', 9], ['muffin', 7], ['bagel', 4], ['scone', 8], ['muffin', 3]]
const sun = [['bagel', 11], ['muffin', 6], ['scone', 9], ['bagel', 7], ['scone', 4], ['muffin', 5], ['bagel', 3]]
const csv = rows => 'item,sold\n' + rows.map(([item, n]) => `${item},${n}`).join('\n') + '\n'
const sum = rows => rows.reduce((acc, [item, n]) => ({ ...acc, [item]: (acc[item] ?? 0) + n }), {})
const d1 = sum(sat), d2 = sum(sun)
const both = Object.fromEntries(Object.keys(d1).map(item => [item, d1[item] + d2[item]])) // muffin 33, scone 26, bagel 34
const best = Object.keys(both).sort((a, b) => both[b] - both[a])[0]
console.log('expected', JSON.stringify({ d1, d2, both, best }))

const snap = id => call('agents.snapshot', { agentSessionId: id })
const toolItems = state => (state.items ?? []).filter(item => item.data?.type === 'tool').map(item => ({ name: String(item.data.name).split('__').at(-1), input: item.data.input, status: item.data.status }))
const texts = (state, role, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === role && (item.sequence ?? 0) > afterSeq).map(item => item.data.text)
const llamaPids = async () => (await listProcesses()).list.filter(p => /^llama-server(\.exe)?$/i.test(p.name)).map(p => p.pid)
const named = text => Object.fromEntries([...String(text).matchAll(/\b(muffin|scone|bagel)s?\b[^\d\n]{0,30}?(\d+)/gi)].map(m => [m[1].toLowerCase(), Number(m[2])]))
const score = (text, truth) => { const got = named(text); return Object.keys(truth).filter(item => got[item] === truth[item]).length }
const prose = text => String(text).split(/Computed with calculate/)[0]
async function quiet(ids, { timeoutMs, label: what }) {
  let streak = 0
  await poll(async () => {
    const phases = await Promise.all(ids.map(async id => (await call('agents.status', { agentSessionId: id }).catch(() => ({ phase: 'gone' }))).phase))
    streak = phases.every(phase => SETTLED.has(phase) || phase === 'gone') ? streak + 1 : 0
    return streak >= 3
  }, { timeoutMs, intervalMs: 3000, label: what })
}
async function ask(id, prompt, timeoutMs = 4 * 60_000) {
  const before = (await snap(id)).sequence ?? 0
  const started = Date.now()
  await call('agents.submit', { agentSessionId: id, prompt })
  await poll(async () => Date.now() - started > 4000 && ((await snap(id)).sequence ?? 0) > before, { timeoutMs: 60_000, label: 'turn start' })
  await quiet([id], { timeoutMs, label: `turn of ${id}` })
  return { before, seconds: Math.round((Date.now() - started) / 1000) }
}
const localTabs = async () => (await call('tabs.list')).filter(tab => tab.kind === 'agent' && tab.state?.provider === 'local')

try {
  await launchParked({ mode: 'playwright' })
  const pid0 = await llamaPids()
  record('env', 'INFO', { servers: (await call('local.servers')).map(s => ({ pid: s.pid, model: s.model })), llamaServers: pid0 }, 'before the swarm')
  await openProject({ name: 'VR9d bakery', files: { 'sat.csv': csv(sat), 'sun.csv': csv(sun), 'README.md': '# Bakery\n\nsat.csv and sun.csv: one row per batch sold.\n' } })
  for (let run = 1; run <= runs; run++) {
    step(`run ${run}: owner asks for a swarm`)
    const known = new Set((await localTabs()).map(tab => tab.resourceId))
    const controller = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: `Bakery ${run}` })
    const ctl = controller.resourceId
    known.add(ctl)
    const first = await ask(ctl, "i've got the weekend's bakery sales in sat.csv and sun.csv. get a coworker on each file to count how many of each item we sold that day, then give me the weekend totals per item and tell me which one sold best.")
    const coworkers = (await localTabs()).filter(tab => !known.has(tab.resourceId))
    const t0 = Date.now()
    await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 6 * 60_000, label: 'swarm to settle' })
    await sleep(8000)
    await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 3 * 60_000, label: 'swarm to settle after reports' })
    let state = await snap(ctl)
    let answer = texts(state, 'assistant', first.before).at(-1) ?? ''
    let followUp = null
    if (score(prose(answer), both) < 3) {
      step(`run ${run}: owner asks for the totals`)
      followUp = await ask(ctl, 'ok so what are the weekend totals for each item, and which sold best?')
      state = await snap(ctl)
      answer = texts(state, 'assistant', followUp.before).join('\n')
    }
    const co = await Promise.all(coworkers.map(async tab => {
      const s = await snap(tab.resourceId)
      const tools = toolItems(s)
      const file = /sun\.csv/i.test(JSON.stringify(s.items?.slice(0, 3).map(item => item.data) ?? '')) ? 'sun' : 'sat'
      const sent = tools.filter(t => t.name === 'conductor' && JSON.stringify(t.input).includes('agents.report') && t.status !== 'failed').map(t => String(t.input?.args?.text ?? JSON.stringify(t.input))).at(-1) ?? texts(s, 'assistant').join('\n')
      return { title: tab.title, file, model: s.settings?.model ?? tab.state?.model, tools: tools.map(t => `${t.name}:${t.status}`), report: sent.slice(0, 500), correct: `${score(sent, file === 'sun' ? d2 : d1)}/3` }
    }))
    const pids = await llamaPids()
    const result = {
      run, seconds: Math.round((Date.now() - t0) / 1000) + first.seconds, coworkers: co.map(({ report, ...rest }) => rest), neededFollowUp: Boolean(followUp),
      proseRight: `${score(prose(answer), both)}/3`, withBlockRight: `${score(answer, both)}/3`, bestInProse: new RegExp(`\\b${best}s?\\b[^.\\n]*(best|most|top|highest)|(best|most|top|highest)[^.\\n]*\\b${best}s?\\b`, 'i').test(prose(answer)),
      hasBlock: /Computed with calculate/.test(answer), code: /```/.test(prose(answer)), sameServer: pids.length === 1 && pids[0] === pid0[0]
    }
    writeFileSync(join(outputDir(), `${label}B-run${run}.json`), JSON.stringify({ expected: { d1, d2, both, best }, result, co, answer, controllerItems: state.items?.map(item => item.data) }, null, 2))
    const mechanics = co.length === 2 && co.every(c => /dolphin/.test(c.model ?? '')) && result.sameServer
    record(`${label}B run ${run}`, mechanics && result.proseRight === '3/3' && result.bestInProse ? 'PASS' : 'FAIL', result, `answer: ${answer.replace(/\s+/g, ' ').slice(0, 500)}`)
    for (const tab of [...coworkers, controller]) await call('tabs.close', { tabId: tab.id }).catch(() => undefined)
  }
} catch (error) {
  await failed(error)
}
await finish()
