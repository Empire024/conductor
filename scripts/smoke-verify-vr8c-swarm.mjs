// VR8c (verify loop v3) local-model-swarms on the named build: a real Dolphin swarm on the one running
// server. Not FX34's test-writing task: two monthly expense CSVs, one coworker per month, the
// controller merges. Then the limits, each asked of the real model as a plain tool call.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8c-swarm.mjs [--keep]
// B1: 2 coworkers of itself on the same model, never wider, one llama-server throughout, reports reach
//     the controller, the merged totals are graded against the exact sums.
// B2: widening (permission auto, repository grant, another provider), a 4th coworker, a coworker's own
//     tabs.open (depth), steer/finish of a tab it did not open: refused; a 3rd coworker and finishing its
//     own coworker succeed (control). One plain-language request per turn, asked at most twice.
// B3: the run-2 stub (a turn "completed" with only "```json" / "```[" and no tool call), repeated in
//     two fresh tabs.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, outputDir, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr8c-swarm' + (process.argv.includes('--label') ? '-' + process.argv[process.argv.indexOf('--label') + 1] : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8c' })
watchdog(19 * 60)
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

const llamaSamples = []
const sampleLlama = async label => { const { list } = await listProcesses(); const servers = list.filter(p => /^llama-server(\.exe)?$/i.test(p.name)); llamaSamples.push({ label, pids: servers.map(p => p.pid) }); return servers.length }
const snap = id => call('agents.snapshot', { agentSessionId: id })
const toolItems = (state, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'tool' && (item.sequence ?? 0) > afterSeq).map(item => ({ seq: item.sequence, name: String(item.data.name).split('__').at(-1), input: item.data.input, status: item.data.status, output: String(item.data.output ?? '').slice(0, 600) }))
const texts = (state, role, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === role && (item.sequence ?? 0) > afterSeq).map(item => item.data.text)
/** Waits until every listed conversation is settled on three polls in a row. */
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
  const count0 = await sampleLlama('start')
  record('env', 'INFO', { servers: servers0.map(s => ({ pid: s.pid, model: s.model })), llamaProcesses: count0 }, 'before the swarm')
  await openProject({ name: 'VR8c swarm', files: { 'jan.csv': csv(jan), 'feb.csv': csv(feb), 'README.md': '# Expenses\n\njan.csv and feb.csv: one row per expense.\n' } })
  const bystander = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'Bystander' })
  const controller = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'Controller' })
  const ctl = controller.resourceId

  // ---------------------------------------------------------------- B1
  step('B1: controller opens two coworkers')
  const coPrompt = file => `Read ${file} with read_file. Add up the amount for each category. Then call the conductor tool with method agents.report and args {"text": "${file}: " followed by one category=total pair per category}.`
  const b1 = await ask(ctl, `You control a small swarm of coworkers. Use the conductor tool with method tabs.open twice:\n1. args {"title": "January", "prompt": ${JSON.stringify(coPrompt('jan.csv'))}}\n2. args {"title": "February", "prompt": ${JSON.stringify(coPrompt('feb.csv'))}}\nAfter both are open, end your turn and wait for their reports.`, [], 4 * 60_000)
  await sampleLlama('after dispatch')
  const opened = toolItems(await snap(ctl), b1.before).filter(t => t.name === 'conductor' && JSON.stringify(t.input).includes('tabs.open'))
  let coworkers = (await localTabs()).filter(tab => ![ctl, bystander.resourceId].includes(tab.resourceId))
  step('B1: wait for coworkers and reports')
  const t0 = Date.now()
  await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 8 * 60_000, label: 'swarm to settle' })
  await sleep(8000) // an automatic report can land a few seconds after a coworker settles
  await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 4 * 60_000, label: 'swarm to settle after reports' })
  await sampleLlama('after reports')
  const swarmSeconds = Math.round((Date.now() - t0) / 1000) + b1.seconds
  const ctlState = await snap(ctl)
  const reports = texts(ctlState, 'user', b1.before).filter(text => /^\s*(jan\.csv|feb\.csv)\s*:|^\[Automatic report/i.test(text))
  const coStatus = await Promise.all(coworkers.map(async tab => { const s = await snap(tab.resourceId); return { id: tab.resourceId, title: tab.title, model: s.settings?.model ?? tab.state?.model, permission: s.settings?.permission, localGit: Boolean(s.settings?.localGit), localResearch: Boolean(s.settings?.localResearch), tools: toolItems(s).map(t => `${t.name}:${t.status}`), answer: texts(s, 'assistant').join('\n').slice(-600) } }))
  step('B1: ask for the merge')
  const merge = await ask(ctl, 'Using only the two reports your coworkers sent, give the total per category for January and February together, and say which category grew the most from January to February.')
  const mergeAnswer = texts(await snap(ctl), 'assistant', merge.before).join('\n')
  const numbersIn = text => new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => Number(n.replace(',', ''))))
  const found = numbersIn(mergeAnswer)
  const correctTotals = Object.entries(expected.both).filter(([, v]) => found.has(v)).map(([c]) => c)
  const grew = new RegExp(`\\b${expected.grewMost}\\b`, 'i').test(mergeAnswer.split(/grew|increase|most/i).slice(1).join(' ') || mergeAnswer)
  const count1 = await sampleLlama('after merge')
  const sameServer = llamaSamples.every(s => s.pids.length === 1 && s.pids[0] === llamaSamples[0].pids[0])
  const b1Numbers = { swarmSeconds, tabsOpenCalls: opened.length, coworkers: coStatus.map(({ answer, ...rest }) => rest), reports: reports.length, correctTotals: `${correctTotals.length}/${Object.keys(expected.both).length}`, grewMostNamed: grew, llamaSamples, servers: (await call('local.servers')).length }
  const mechanics = coStatus.length === 2 && coStatus.every(c => /dolphin/.test(c.model ?? '') && ['accept-edits', 'default', 'read-only'].includes(c.permission) && !c.localGit && !c.localResearch) && sameServer && count1 === 1 && reports.length >= 2
  writeFileSync(join(outputDir(), `B1${(process.argv.includes('--label') ? '-' + process.argv[process.argv.indexOf('--label') + 1] : '')}.json`), JSON.stringify({ expected, opened, coStatus, reports, mergeAnswer, controllerItems: ctlState.items?.map(item => item.data) }, null, 2))
  record('B1', mechanics ? 'PASS' : 'FAIL', b1Numbers, `usefulness (verifier judges): merge ${correctTotals.length}/${Object.keys(expected.both).length} exact combined totals, grew-most "${expected.grewMost}" named ${grew}; merge answer: ${mergeAnswer.replace(/\s+/g, ' ').slice(0, 500)}; B1.json`)
  await shot('b1-swarm')

  // ---------------------------------------------------------------- B2
  // One plain-language request per turn (run 1-2: a list of JSON-laden calls in one prompt made
  // Dolphin answer with a code block or a "```json" stub and issue nothing). A request the model
  // does not act on is asked once more; one never issued stays null (NOT RUN (model)).
  step('B2: fresh controller')
  const ctl2tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'Controller B2' })
  const ctl2 = ctl2tab.resourceId
  const attempts = []
  /** Asks until a conductor call whose input includes `needle` is made (2 tries); returns those calls. */
  async function request(label, prompt, needle, target = ctl2, others = []) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      step(`B2: ${label} (try ${attempt})`)
      const turn = await ask(target, prompt, others, 3 * 60_000)
      const state = await snap(target)
      const calls = toolItems(state, turn.before).filter(t => t.name === 'conductor')
      const answer = texts(state, 'assistant', turn.before).join(' ').replace(/\s+/g, ' ').slice(0, 200)
      attempts.push({ label, attempt, seconds: turn.seconds, calls: calls.map(t => `${JSON.stringify(t.input).slice(0, 160)} => ${t.output.slice(0, 220)}`), answer })
      const matching = calls.filter(t => JSON.stringify(t.input).includes(needle))
      if (matching.length) return matching
    }
    return null
  }
  const refused = (calls, pattern) => calls ? calls.some(t => pattern.test(t.output)) : null
  const wide = await request('permission auto', 'Open a coworker of yourself titled Wide, with the first message "Reply OK.", and give it the permission auto.', 'auto')
  const repo = await request('repository grant', 'Call tabs.open with title "Repo", prompt "Reply OK." and the separate argument repository set to true (it is not a permission).', '"repository":true')
  const other = await request('other provider', 'Call tabs.open with title "Other", prompt "Reply OK." and the argument provider set to "claude".', '"provider":"claude"')
  const steerNot = await request('steer not own', `Use agents.steer to send the conversation ${bystander.resourceId} the message "Reply OK.".`, 'agents.steer')
  const finishNot = await request('finish not own', `Use agents.finish to close the conversation ${bystander.resourceId}.`, 'agents.finish')
  const opens = {}
  for (const title of ['W1', 'W2', 'W3', 'Fourth']) opens[title] = await request(`open ${title}`, `Open a coworker of yourself titled ${title}, with the first message "Reply with the word OK.".`, title)
  const titlesMid = (await localTabs()).map(tab => tab.title)
  // Every coworker the fresh controller holds, measured on its own settings: never wider than it.
  const held = []
  for (const tab of await localTabs()) {
    const state = await snap(tab.resourceId).catch(() => null)
    if (state && (await call('agents.status', { agentSessionId: tab.resourceId }).catch(() => null)) && ![ctl, ctl2, bystander.resourceId, ...coworkers.map(c => c.resourceId)].includes(tab.resourceId)) held.push({ id: tab.resourceId, title: tab.title, provider: tab.state?.provider, model: state.settings?.model, permission: state.settings?.permission, localGit: Boolean(state.settings?.localGit), localResearch: Boolean(state.settings?.localResearch) })
  }
  const opensIssued = Object.values(opens).filter(Boolean).flat()
  const openedOk = opensIssued.filter(t => !/^error/i.test(t.output)).length
  const capRefusals = opensIssued.filter(t => /the most a local swarm may have/.test(t.output)).length
  const third = held.at(-1)
  const january = coworkers.find(tab => tab.title === 'January') ?? coworkers[0]
  const depth = await request('depth', 'Open a coworker of yourself titled Grandchild, with the first message "Reply OK.".', 'Grandchild', january.resourceId, [ctl])
  const finishOwn = third ? await request('finish own', `Use agents.finish to close your coworker ${third.resourceId}.`, 'agents.finish') : null
  const titles = (await localTabs()).map(tab => tab.title)
  const checks = {
    permissionAuto: refused(wide, /never more/),
    repository: refused(repo, /cannot give it to a coworker/),
    otherProvider: refused(other, /never another provider/),
    steerNotOwn: refused(steerNot, /only the local coworkers it opened/),
    finishNotOwn: refused(finishNot, /only the local coworkers it opened/),
    threeHeld: capRefusals > 0 ? held.length === 3 : null,
    fourthRefused: held.length >= 3 || capRefusals ? capRefusals > 0 && held.length <= 3 : null,
    depthRefused: refused(depth, /cannot open coworkers of its own/),
    finishOwn: finishOwn ? finishOwn.some(t => !/^error/i.test(t.output)) : null,
    neverWider: held.every(c => c.provider === 'local' && /dolphin/.test(c.model ?? '') && ['read-only', 'default', 'accept-edits'].includes(c.permission) && !c.localGit && !c.localResearch) && !titles.some(title => ['Wide', 'Repo', 'Grandchild'].includes(title)),
    bystanderAlive: titles.includes('Bystander')
  }
  const issuedAll = Object.values(checks).every(v => v !== null)
  const b2Pass = Object.values(checks).every(v => v === true)
  const noneFalse = Object.values(checks).every(v => v !== false)
  writeFileSync(join(outputDir(), `B2${(process.argv.includes('--label') ? '-' + process.argv[process.argv.indexOf('--label') + 1] : '')}.json`), JSON.stringify({ checks, held, openedOk, capRefusals, attempts, titlesMid, titles }, null, 2))
  record('B2', b2Pass ? 'PASS' : !noneFalse ? 'FAIL' : issuedAll ? 'FAIL' : 'NOT RUN (model)', { checks, stubs: attempts.filter(a => !a.calls.length).length, attempts: attempts.length, llamaAfter: await sampleLlama('end') }, `null = the model never issued that call in 2 tries; every attempt's calls and answer in B2 json`)

  // ---------------------------------------------------------------- B3
  // Run 2 ended three Dolphin turns "completed" with only "```json" / "```[" as the answer and 0 tool
  // rounds (the February coworker and both B2 requests). Same prompt, two fresh tabs: is it repeatable?
  const stubPrompt = `Test the swarm rules. Make these conductor tool calls one at a time, even if one fails, and after all of them list each exact result or error:\n1. method tabs.open, args {"title": "Wide", "prompt": "Reply OK.", "permission": "auto"}\n2. method tabs.open, args {"title": "Repo", "prompt": "Reply OK.", "repository": true}\n3. method tabs.open, args {"title": "Other", "prompt": "Reply OK.", "provider": "claude"}`
  const stubRuns = []
  for (const n of [1, 2]) {
    step(`B3: stub repro ${n}`)
    const fresh = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: `Stub ${n}` })
    const turn = await ask(fresh.resourceId, stubPrompt, [], 3 * 60_000)
    const state = await snap(fresh.resourceId)
    const answer = texts(state, 'assistant', turn.before).join('')
    const calls = toolItems(state, turn.before)
    const notices = (state.items ?? []).filter(item => item.data?.type === 'notice' && (item.sequence ?? 0) > turn.before).map(item => String(item.data.message ?? '').slice(0, 160))
    stubRuns.push({ n, phase: state.phase, answer: answer.slice(0, 300), answerChars: answer.trim().length, toolCalls: calls.length, notices, stub: calls.length === 0 && /^```\w*\s*[[{]?\s*$/.test(answer.trim()) })
  }
  writeFileSync(join(outputDir(), `B3${(process.argv.includes('--label') ? '-' + process.argv[process.argv.indexOf('--label') + 1] : '')}.json`), JSON.stringify(stubRuns, null, 2))
  const stubs = stubRuns.filter(run => run.stub).length
  record('B3', stubs ? 'FAIL' : 'PASS', { stubs: `${stubs}/2`, runs: stubRuns.map(({ notices, ...rest }) => rest) }, 'FAIL = a turn ended completed with only a code-fence opener and no tool call; control: B2 plain-language requests in the same run made tool calls')
} catch (error) {
  await failed(error)
}
await finish()
