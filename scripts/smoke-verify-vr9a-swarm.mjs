// VR9a (verify loop v3) dolphin-useful-like-any-model, local swarm numbers after FX40 (8174e69). A new
// numeric task, asked the way the owner would ask it (no tool arguments spelled out, unlike VR8c B1):
// two weekly timesheets, one coworker of itself per file, the controller merges. VR8c B1 itself runs
// through the committed smoke-fx40-swarm.mjs.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9a-swarm.mjs [--runs 2] [--label L]
// Grades the model's own prose apart from the "Computed with calculate" block Conductor appends:
// per-person totals for both weeks together (3) and who worked the most. Mechanics: 2 coworkers on
// the same model, one llama-server.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, outputDir, poll, record, sleep, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = arg('--label', '')
const runs = Number(arg('--runs', '2'))
configure({ name: 'vr9a-swarm' + (label ? '-' + label : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr9a' })
watchdog(Math.min(19 * 60, runs * 9 * 60 + 90))
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
const SETTLED = new Set(['completed', 'failed', 'interrupted', 'idle'])
const week1 = [['ana', 7.5], ['ben', 8], ['ana', 6.25], ['cara', 9], ['ben', 4.5], ['cara', 3.75], ['ana', 8], ['ben', 7.25]]
const week2 = [['ana', 5], ['ben', 9.5], ['cara', 8.5], ['ana', 7.75], ['cara', 6], ['ben', 3.25], ['ana', 4.5], ['cara', 2.5]]
const csv = rows => 'person,hours\n' + rows.map(([p, h]) => `${p},${h}`).join('\n') + '\n'
const sum = rows => rows.reduce((acc, [p, h]) => ({ ...acc, [p]: (acc[p] ?? 0) + h }), {})
const w1 = sum(week1), w2 = sum(week2)
const both = Object.fromEntries(Object.keys(w1).map(p => [p, w1[p] + w2[p]])) // ana 39, ben 32.5, cara 29.75
const most = Object.keys(both).sort((a, b) => both[b] - both[a])[0]
console.log('expected', JSON.stringify({ w1, w2, both, most }))

const snap = id => call('agents.snapshot', { agentSessionId: id })
const toolItems = (state, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'tool' && (item.sequence ?? 0) > afterSeq).map(item => ({ name: String(item.data.name).split('__').at(-1), input: item.data.input, status: item.data.status, output: String(item.data.output ?? '').slice(0, 600) }))
const texts = (state, role, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === role && (item.sequence ?? 0) > afterSeq).map(item => item.data.text)
const llamaPids = async () => (await listProcesses()).list.filter(p => /^llama-server(\.exe)?$/i.test(p.name)).map(p => p.pid)
const named = text => Object.fromEntries([...String(text).matchAll(/\b(ana|ben|cara)\b[^\d\n]{0,30}?(\d+(?:\.\d+)?)/gi)].map(m => [m[1].toLowerCase(), Number(m[2])]))
const score = (text, truth) => { const got = named(text); return Object.keys(truth).filter(p => got[p] === truth[p]).length }
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
  await openProject({ name: 'VR9a swarm', files: { 'week1.csv': csv(week1), 'week2.csv': csv(week2), 'README.md': '# Timesheets\n\nweek1.csv and week2.csv: one row per shift, hours worked.\n' } })
  for (let run = 1; run <= runs; run++) {
    step(`run ${run}: owner asks for a swarm`)
    const known = new Set((await localTabs()).map(tab => tab.resourceId))
    const controller = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: `Timesheets ${run}` })
    const ctl = controller.resourceId
    known.add(ctl)
    const first = await ask(ctl, 'I have two timesheets, week1.csv and week2.csv. Open one coworker of yourself per file to add up the hours per person and report back to you. When both have reported, tell me how many hours each person worked over the two weeks together, and who worked the most.')
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
      followUp = await ask(ctl, 'so, how many hours did each person work over both weeks, and who worked the most?')
      state = await snap(ctl)
      answer = texts(state, 'assistant', followUp.before).join('\n')
    }
    const co = await Promise.all(coworkers.map(async tab => {
      const s = await snap(tab.resourceId)
      const tools = toolItems(s)
      const file = /week2/i.test(JSON.stringify(s.items?.slice(0, 3).map(item => item.data) ?? '')) ? 'w2' : 'w1'
      const sent = tools.filter(t => t.name === 'conductor' && JSON.stringify(t.input).includes('agents.report') && t.status !== 'failed').map(t => String(t.input?.args?.text ?? JSON.stringify(t.input))).at(-1) ?? texts(s, 'assistant').join('\n')
      return { title: tab.title, file, model: s.settings?.model ?? tab.state?.model, permission: s.settings?.permission, tools: tools.map(t => `${t.name}:${t.status}`), report: sent.slice(0, 500), correct: `${score(sent, file === 'w2' ? w2 : w1)}/3` }
    }))
    const pids = await llamaPids()
    const result = {
      run, seconds: Math.round((Date.now() - t0) / 1000) + first.seconds, coworkers: co.map(({ report, ...rest }) => rest), neededFollowUp: Boolean(followUp),
      proseRight: `${score(prose(answer), both)}/3`, withBlockRight: `${score(answer, both)}/3`, mostInProse: new RegExp(`\\b${most}\\b[^.\\n]*(most|highest)|(most|highest)[^.\\n]*\\b${most}\\b`, 'i').test(prose(answer)),
      hasBlock: /Computed with calculate/.test(answer), code: /```/.test(prose(answer)), sameServer: pids.length === 1 && pids[0] === pid0[0]
    }
    writeFileSync(join(outputDir(), `${label}T-run${run}.json`), JSON.stringify({ expected: { w1, w2, both, most }, result, co, answer, controllerItems: state.items?.map(item => item.data) }, null, 2))
    const mechanics = co.length === 2 && co.every(c => /dolphin/.test(c.model ?? '')) && result.sameServer
    record(`${label}T run ${run}`, mechanics && result.proseRight === '3/3' && result.mostInProse ? 'PASS' : 'FAIL', result, `answer: ${answer.replace(/\s+/g, ' ').slice(0, 500)}`)
    for (const tab of [...coworkers, controller]) await call('tabs.close', { tabId: tab.id }).catch(() => undefined)
  }
} catch (error) {
  await failed(error)
}
await finish()
