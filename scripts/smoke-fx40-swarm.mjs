// FX40: does a local Dolphin swarm produce the right numbers? VR8c's B1 on the real running server:
// two monthly expense CSVs, one coworker per month, the controller merges. VR8c (before FX40):
// per-file sums right 2/8, merged totals 0/5 in 4/4 runs (sums done in the model's head, merges
// written as Python). FX40 gave the model the calculate tool, a coworker brief and a hold on
// uncomputed numbers. Same prompts as scripts/smoke-verify-vr8c-swarm.mjs B1, --runs N in one launch.
//   node scripts/smoke-lock.mjs --timeout-min 45 -- node scripts/smoke-fx40-swarm.mjs [--runs 4] [--label x]
// Grades: each coworker report's category totals against the exact sums, the merged totals (5), and
// whether calculate was used; mechanics (2 coworkers on the same model, one llama-server) as in VR8c.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, outputDir, poll, record, sleep, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = arg('--label', '')
const runs = Number(arg('--runs', '4'))
configure({ name: 'fx40-swarm' + (label ? '-' + label : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-fx40' })
watchdog(runs * 10 * 60 + 120)
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
const SETTLED = new Set(['completed', 'failed', 'interrupted', 'idle'])
const jan = [['rent', 950], ['groceries', 212.4], ['transport', 64], ['groceries', 87.1], ['utilities', 118.25], ['transport', 22.5], ['fun', 45], ['groceries', 51.3]]
const feb = [['rent', 950], ['groceries', 198.6], ['utilities', 131.75], ['transport', 88], ['fun', 120], ['groceries', 76.2], ['fun', 35.5], ['transport', 12]]
const csv = rows => 'category,amount\n' + rows.map(([c, a]) => `${c},${a}`).join('\n') + '\n'
const totals = rows => rows.reduce((sum, [c, a]) => ({ ...sum, [c]: Math.round(((sum[c] ?? 0) + a) * 100) / 100 }), {})
const expected = { jan: totals(jan), feb: totals(feb) }
expected.both = Object.fromEntries(Object.keys(expected.jan).map(c => [c, Math.round((expected.jan[c] + expected.feb[c]) * 100) / 100]))
expected.grewMost = Object.keys(expected.jan).sort((a, b) => (expected.feb[b] - expected.jan[b]) - (expected.feb[a] - expected.jan[a]))[0]
console.log('expected', JSON.stringify(expected))

const snap = id => call('agents.snapshot', { agentSessionId: id })
const toolItems = (state, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'tool' && (item.sequence ?? 0) > afterSeq).map(item => ({ name: String(item.data.name).split('__').at(-1), input: item.data.input, status: item.data.status, output: String(item.data.output ?? '').slice(0, 600) }))
const texts = (state, role, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === role && (item.sequence ?? 0) > afterSeq).map(item => item.data.text)
const llamaPids = async () => (await listProcesses()).list.filter(p => /^llama-server(\.exe)?$/i.test(p.name)).map(p => p.pid)
/** Category totals named in a text: "groceries=350.8", "groceries: 350.8", "groceries 350.8". */
const named = text => Object.fromEntries([...String(text).matchAll(/\b(rent|groceries|transport|utilities|fun)\b\W{0,4}(?:=|:|-|is|was|total(?:s|led)?(?: of)?)?\s*\$?\s*(\d+(?:\.\d+)?)/gi)].map(m => [m[1].toLowerCase(), Number(m[2])]))
const score = (text, truth) => { const got = named(text); return Object.keys(truth).filter(c => got[c] === truth[c]).length }
async function quiet(ids, { timeoutMs, label }) {
  let streak = 0
  await poll(async () => {
    const phases = await Promise.all(ids.map(async id => (await call('agents.status', { agentSessionId: id }).catch(() => ({ phase: 'gone' }))).phase))
    streak = phases.every(phase => SETTLED.has(phase) || phase === 'gone') ? streak + 1 : 0
    return streak >= 3
  }, { timeoutMs, intervalMs: 3000, label })
}
async function ask(id, prompt, others = [], timeoutMs = 5 * 60_000) {
  const before = (await snap(id)).sequence ?? 0
  const started = Date.now()
  await call('agents.submit', { agentSessionId: id, prompt })
  await poll(async () => Date.now() - started > 4000 && ((await snap(id)).sequence ?? 0) > before, { timeoutMs: 60_000, label: 'turn start' })
  await quiet([id, ...others], { timeoutMs, label: `turn of ${id}` })
  return { before, seconds: Math.round((Date.now() - started) / 1000) }
}
const localTabs = async () => (await call('tabs.list')).filter(tab => tab.kind === 'agent' && tab.state?.provider === 'local')

try {
  await launchParked({ mode: 'playwright' })
  const servers0 = await call('local.servers')
  const pid0 = await llamaPids()
  record('env', 'INFO', { servers: servers0.map(s => ({ pid: s.pid, model: s.model })), llamaServers: pid0 }, 'before the swarm')
  await openProject({ name: 'FX40 swarm', files: { 'jan.csv': csv(jan), 'feb.csv': csv(feb), 'README.md': '# Expenses\n\njan.csv and feb.csv: one row per expense.\n' } })
  const summary = []
  for (let run = 1; run <= runs; run++) {
    step(`run ${run}: controller opens two coworkers`)
    const known = new Set((await localTabs()).map(tab => tab.resourceId))
    const controller = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: `Controller ${run}` })
    const ctl = controller.resourceId
    known.add(ctl)
    const coPrompt = file => `Read ${file} with read_file. Add up the amount for each category. Then call the conductor tool with method agents.report and args {"text": "${file}: " followed by one category=total pair per category}.`
    const b1 = await ask(ctl, `You control a small swarm of coworkers. Use the conductor tool with method tabs.open twice:\n1. args {"title": "January", "prompt": ${JSON.stringify(coPrompt('jan.csv'))}}\n2. args {"title": "February", "prompt": ${JSON.stringify(coPrompt('feb.csv'))}}\nAfter both are open, end your turn and wait for their reports.`, [], 4 * 60_000)
    const coworkers = (await localTabs()).filter(tab => !known.has(tab.resourceId))
    step(`run ${run}: wait for coworkers and reports`)
    const t0 = Date.now()
    await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 8 * 60_000, label: 'swarm to settle' })
    await sleep(8000) // an automatic report can land a few seconds after a coworker settles
    await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 4 * 60_000, label: 'swarm to settle after reports' })
    const ctlState = await snap(ctl)
    const reports = texts(ctlState, 'user', b1.before).filter(text => /jan\.csv|feb\.csv|\[Automatic report|January|February/i.test(text))
    const coStatus = await Promise.all(coworkers.map(async tab => {
      const s = await snap(tab.resourceId)
      const tools = toolItems(s)
      const file = /feb/i.test(tab.title + JSON.stringify(s.items?.[0]?.data ?? '')) ? 'feb' : 'jan'
      const sent = tools.filter(t => t.name === 'conductor' && JSON.stringify(t.input).includes('agents.report') && t.status !== 'failed').map(t => String(t.input?.args?.text ?? JSON.stringify(t.input)))
      const reportText = sent.at(-1) ?? texts(s, 'assistant').join('\n')
      return { id: tab.resourceId, title: tab.title, file, model: s.settings?.model ?? tab.state?.model, permission: s.settings?.permission, tools: tools.map(t => `${t.name}:${t.status}`), calculated: tools.some(t => t.name === 'calculate' && t.status !== 'failed'), held: tools.some(t => t.name === 'conductor' && /not sent: this report/.test(t.output)), report: reportText.slice(0, 600), correct: score(reportText, expected[file]), calls: tools.filter(t => ['calculate', 'conductor'].includes(t.name)).map(t => ({ name: t.name, input: t.input, status: t.status, output: t.output.slice(0, 400) })) }
    }))
    step(`run ${run}: ask for the merge`)
    const merge = await ask(ctl, 'Using only the two reports your coworkers sent, give the total per category for January and February together, and say which category grew the most from January to February.')
    const mergeState = await snap(ctl)
    const mergeAnswer = texts(mergeState, 'assistant', merge.before).join('\n')
    const mergeTools = toolItems(mergeState, merge.before)
    const numbersIn = text => new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => Number(n.replace(',', ''))))
    const found = numbersIn(mergeAnswer)
    const correctTotals = Object.entries(expected.both).filter(([, v]) => found.has(v)).map(([c]) => c)
    const grew = new RegExp(`\\b${expected.grewMost}\\b`, 'i').test(mergeAnswer.split(/grew|increase|most/i).slice(1).join(' ') || mergeAnswer)
    const pids = await llamaPids()
    const result = {
      run, swarmSeconds: Math.round((Date.now() - t0) / 1000) + b1.seconds, mergeSeconds: merge.seconds,
      coworkers: coStatus.map(({ report, calls, ...rest }) => ({ ...rest, correct: `${rest.correct}/5` })),
      reports: reports.length, merged: `${correctTotals.length}/5`, mergeCalculated: mergeTools.some(t => t.name === 'calculate' && t.status !== 'failed'), mergeCode: /```/.test(mergeAnswer), grewMostNamed: grew,
      llamaServers: pids, sameServer: pids.length === 1 && pids[0] === pid0[0]
    }
    summary.push(result)
    writeFileSync(join(outputDir(), `B1${label ? '-' + label : ''}-run${run}.json`), JSON.stringify({ expected, result, coStatus, reports, mergeAnswer, mergeTools, controllerItems: mergeState.items?.map(item => item.data) }, null, 2))
    const mechanics = coStatus.length === 2 && coStatus.every(c => /dolphin/.test(c.model ?? '') && ['accept-edits', 'default', 'read-only'].includes(c.permission)) && result.sameServer
    record(`B1 run ${run}`, mechanics && correctTotals.length === 5 ? 'PASS' : 'FAIL', result, `merge answer: ${mergeAnswer.replace(/\s+/g, ' ').slice(0, 400)}`)
    for (const tab of [...coworkers, controller]) await call('tabs.close', { tabId: tab.id }).catch(() => undefined)
  }
  const passing = summary.filter(r => r.merged === '5/5').length
  const perFile = summary.flatMap(r => r.coworkers).filter(c => c.correct === '5/5').length
  record('B1 total', passing >= Math.min(3, runs) ? 'PASS' : 'FAIL', { mergedRight: `${passing}/${runs}`, perFileRight: `${perFile}/${summary.flatMap(r => r.coworkers).length}`, target: 'merged totals right in >= 3/4 runs; VR8c before FX40: merged 0/5 in 4/4, per-file 2/8' }, 'B1-run*.json')
} catch (error) {
  await failed(error)
}
await finish()
