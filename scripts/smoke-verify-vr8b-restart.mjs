// VR8b A1 + B2 (docs/verification/2026-09-26-vr8b.md). Owner: "Runtime host did not answer attach
// bug after restart here", "this didnt send also": at the 22:00 install eight kept runtimes
// reattached while the relaunched main thread was blocked ~71 s, and all eight were lost.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8b-restart.mjs [--runs 2] [--turns 8] [--stall-ms 80000] [--label fixed]
// Run it from the checkout whose out/ is under test (a pre-fix worktree for the control).
// A1 every kept turn reattaches through the stall, finishes in its tab, and a message sent to each
//    tab mid-turn and one after the turn both reach the same CLI process and are answered.
// B2 every app-control call the kept turns made during the restart and the stall was answered 200
//    (none refused), and the reattached turn got the one-line notice, not a new briefing.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunched, step, watchdog, safeClose } from './verify-kit.mjs'

const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback }
const runs = Number(argument('--runs', '2')), turns = Number(argument('--turns', '8')), stallMs = Number(argument('--stall-ms', '80000')), label = argument('--label', 'fixed')
configure({ name: `vr8b-restart-${label}`, output: argument('--output', 'artifacts/verification/2026-09-26-vr8b') })
watchdog(10 * 60 * runs)
await loadCheck()

const FIXTURE = readFileSync(new URL('./fixtures/vr8b-claude.mjs', import.meta.url), 'utf8')
const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const names = Array.from({ length: turns }, (_, i) => i === 0 ? 'wizard' : `coworker-${i}`)
const longSeconds = Math.round(stallMs / 1000) + 90
const text = async id => JSON.stringify(await call('agents.snapshot', { agentSessionId: id }, { timeoutMs: 150_000 }))

for (let run = 1; run <= runs; run++) {
  try {
    const inst = await launchParked({ mode: 'spawn', name: `vr8b-restart-${label}-${run}`, env: { CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_TEST_STARTUP_BLOCK_MS: stallMs }, fixtures: { 'fake-claude.mjs': FIXTURE } })
    const fixtures = join(inst.root, 'fixtures')
    await page(inst)
    await openProject({ name: `VR8b restart ${label} ${run}`, git: true })
    const tabs = {}
    for (const name of names) tabs[name] = (await openTab({ provider: 'claude', title: name })).resourceId
    await (await page(inst)).evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true }) }, tabs.wizard)

    step(`run ${run}: ${turns} kept turns under way, then the update-style restart`)
    for (const name of names) await call('agents.submit', { agentSessionId: tabs[name], prompt: `VR8B LONG ${name} ${longSeconds}` })
    await poll(() => names.every(name => lines(join(fixtures, 'calls.jsonl')).some(entry => entry.name === name && entry.status === 200)), { timeoutMs: 90_000, intervalMs: 500, label: 'every turn to stream and call app control' })
    const pidOf = Object.fromEntries(names.map(name => [name, lines(join(fixtures, 'prompts.jsonl')).find(entry => entry.prompt.startsWith(`VR8B LONG ${name} `))?.pid]))
    const before = inst.credential, restartAt = new Date().toISOString()
    await call('app.restart', { force: true })
    const seconds = await relaunched(inst, before.pid, { timeoutMs: 90_000 })
    step(`run ${run}: relaunched in ${seconds.toFixed(1)} s, main blocked ${stallMs} ms; a message to each tab mid-turn`)
    await poll(() => call('app.state', {}, { timeoutMs: 150_000 }), { timeoutMs: stallMs + 90_000, intervalMs: 2000, label: 'the relaunched app to answer after its stall' })
    // What the owner's composer does with a message while the turn runs (agents.steer).
    const midSent = [], midMs = {}
    for (const name of names) { const sent = Date.now(); try { await call('agents.steer', { agentSessionId: tabs[name], prompt: `VR8B ACK mid ${name}` }, { timeoutMs: 150_000 }); midSent.push(name) } catch (error) { console.log(`[mid] ${name}: ${error.message.slice(0, 200)}`) } midMs[name] = Date.now() - sent }

    step(`run ${run}: A1 the kept turns finish and both messages are answered`)
    let settled = null
    try {
      settled = await poll(async () => {
        const all = await Promise.all(names.map(name => text(tabs[name])))
        return all.every((body, i) => body.includes(`ack:mid:${names[i]}`)) ? all : null
      }, { timeoutMs: (longSeconds + 60) * 1000, intervalMs: 3000, label: 'every tab to answer its mid-turn message' })
    } catch (error) { console.log(`[A1] ${error.message.slice(0, 300)}`) }
    const afterSent = []
    for (const name of names) { try { await call('agents.submit', { agentSessionId: tabs[name], prompt: `VR8B ACK after ${name}` }, { timeoutMs: 60_000 }); afterSent.push(name) } catch (error) { console.log(`[after] ${name}: ${error.message.slice(0, 200)}`) } }
    const final = await poll(async () => {
      const all = await Promise.all(names.map(name => text(tabs[name])))
      return all.every((body, i) => body.includes(`ack:after:${names[i]}`)) ? all : null
    }, { timeoutMs: 60_000, intervalMs: 2000, label: 'every tab to answer after its turn' }).catch(async () => Promise.all(names.map(name => text(tabs[name]))))
    const byName = Object.fromEntries(names.map((name, i) => [name, final[i]]))
    const attachErrors = names.filter(name => /did not answer attach|could not be reattached|Runtime host did not answer/.test(byName[name]))
    const longDone = names.filter(name => byName[name].includes(`long-done:${name}`))
    const acks = lines(join(fixtures, 'prompts.jsonl')).filter(entry => /VR8B ACK (mid|after)/.test(entry.prompt))
    const samePid = tag => names.filter(name => acks.some(entry => entry.prompt.startsWith(`VR8B ACK ${tag} ${name}`) && entry.pid === pidOf[name]) && byName[name].includes(`ack:${tag}:${name}`))
    const mid = samePid('mid'), after = samePid('after')
    record(`A1-kept-turns-through-${stallMs / 1000}s-stall-run${run}`, !attachErrors.length && longDone.length === turns && mid.length === turns && after.length === turns ? 'PASS' : 'FAIL',
      { turns, attachErrors: attachErrors.length, finished: longDone.length, midAnswered: mid.length, afterAnswered: after.length, midSent: midSent.length, slowestMidSendMs: Math.max(0, ...Object.values(midMs)), afterSent: afterSent.length, relaunchSeconds: seconds, settled: Boolean(settled) },
      JSON.stringify({ attachErrors, missingLong: names.filter(name => !longDone.includes(name)), missingMid: names.filter(name => !mid.includes(name)), missingAfter: names.filter(name => !after.includes(name)), sample: attachErrors.length ? byName[attachErrors[0]].match(/.{0,160}(did not answer attach|could not be reattached).{0,160}/)?.[0] : undefined }))

    step(`run ${run}: B2 control calls through the gap and the reattach notice`)
    const during = lines(join(fixtures, 'calls.jsonl')).filter(entry => entry.at >= restartAt)
    const refused = during.filter(entry => entry.status !== 200)
    const notices = lines(join(fixtures, 'inbox.jsonl')).filter(entry => entry.at >= restartAt && /^\[Conductor\].*kept running/.test(entry.text))
    const oneLine = notices.filter(entry => /keeps the same endpoint and credential/.test(entry.text) && !/Bearer|POST http/.test(entry.text))
    record(`B2-control-through-restart-run${run}`, during.length >= turns * 2 && !refused.length && notices.length === turns && oneLine.length === turns ? 'PASS' : 'FAIL',
      { calls: during.length, refused: refused.length, slowestMs: Math.max(0, ...during.map(entry => entry.ms)), notices: notices.length, oneLineNotices: oneLine.length, endpointSame: inst.credential.endpoint === before.endpoint, ownerTokenSame: inst.credential.token === before.token },
      JSON.stringify({ refusedByError: refused.reduce((count, entry) => ({ ...count, [entry.error ?? entry.status]: (count[entry.error ?? entry.status] ?? 0) + 1 }), {}), notice: notices[0]?.text.slice(0, 260) }))
    const close = await safeClose(inst)
    record(`close-run${run}`, close.leftovers.length ? 'FAIL' : 'PASS', { killed: close.killed.length, leftovers: close.leftovers.length })
  } catch (error) { await failed(error, `run${run}`) }
}
await finish()
