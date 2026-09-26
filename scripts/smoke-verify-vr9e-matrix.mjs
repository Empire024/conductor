// VR9e restart matrix for grant-survives-restart (FX43 4781e54). Owner rule: a restart never breaks a
// running agent. One parked profile, three kinds of restart in a row (the owner credential's
// app.restart - the quit path an update install takes; a clean quit by closing the window, then a
// start; a crash by taskkill, then a start). Waiting through all three:
//   W  wizard, its own permissions.request (agent card)
//   D  plain tab, a classifier denial card
//   H  plain tab, a request approved once whose retry it holds (fixture PLAN HOLD)
//   X  plain tab, its own permissions.request; its tab is closed after the restarts -> expires
// After each restart: the cards are live (buttons), the owner's state and W's permissions.list hold
// them, H's grant is held. While the crashed app is down an entry whose conversation does not exist is
// planted in permission-grants.json: it must not come back. Then H retries (runs once, a second try
// refused), D is approved once in its restored denial card (runs once), W hands off after the restarts
// (successor:true) and the owner approves the moved card once in the successor (successor told once,
// runs once, W never). A last restart restores nothing used, and the file holds no credential.
//   --build=<worktree> (default .conductor-scratch/vr9e/wt-4781e54; the control passes wt-b420de4)
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9e-matrix.mjs
import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { REPO, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, relaunched, relaunchParked, shot, step, watchdog } from './verify-kit.mjs'
import { B5_COMMAND, errorText, grantHandoff, handoffEnv } from './lib/grant-handoff.mjs'

const BUILD_DIR = resolve(REPO, process.argv.find(value => value.startsWith('--build='))?.slice(8) ?? '.conductor-scratch/vr9e/wt-4781e54')
const tag = basename(BUILD_DIR).replace('wt-', '')
const OUTPUT = 'artifacts/verification/2026-09-26-vr9e'
configure({ name: `vr9e-matrix-${tag}`, output: OUTPUT })
watchdog(900)
const { capture, flagLog, env } = await handoffEnv('vr9e-m', { CONDUCTOR_TEST_UNIQUE_TOOL_IDS: '1', CONDUCTOR_TEST_FIXTURE_DIR: join(BUILD_DIR, 'scripts/fixtures') })
try {
  const inst = await launchParked({ mode: 'spawn', env, build: join(BUILD_DIR, 'out/main/index.js') })
  await scenario(inst)
} catch (error) { await failed(error, `M-${tag}`) }
await finish()

async function scenario(inst) {
  const NAME = 'VR9e matrix'
  let view = await page(inst)
  await openProject({ name: NAME })
  let g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  const rebind = async () => { view = await page(inst); g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT }) }
  const file = join(inst.profile, 'permission-grants.json')
  const saved = async () => JSON.parse(await readFile(file, 'utf8').catch(() => 'null'))
  const plain = async (title, marker, prompt) => {
    const tab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title })
    const t = { id: tab.resourceId, tabId: tab.id, title }
    await rm(capture, { force: true })
    await g.submit(t.id, `${prompt} ${marker}`, false)
    t.as = await g.credentialOf(marker)
    await g.settled(t.id, `${title} settles`)
    return t
  }

  step('W files, D is refused, H holds an approved-once grant, X files')
  const w = await g.wizard('VR9e W', 'SYNTHETIC CLASSIFIER PLAN OTHER vr9ewiz')
  const askW = await w.as('permissions.request', { command: B5_COMMAND, reason: 'B5 stand-in', rollback: 'none' })
  const d = await plain('VR9e D', 'vr9edenied', 'SYNTHETIC CLASSIFIER OTHER')
  const denial = await poll(async () => (await g.grantsState()).requests.find(entry => entry.source === 'denial' && entry.agentSessionId === d.id && entry.status === 'pending') ?? null, { timeoutMs: 15_000, label: "D's denial card" })
  const h = await plain('VR9e H', 'vr9eheld', 'SYNTHETIC CLASSIFIER PLAN HOLD')
  const askH = await h.as('permissions.request', { command: B5_COMMAND, reason: 'approved before the restarts' })
  await g.click(h, askH.requestId, 'Approve once')
  await poll(async () => await g.told(h.id) === 1, { timeoutMs: 15_000, label: 'H told approved' })
  await g.settled(h.id, 'H notes the approval')
  const x = await plain('VR9e X', 'vr9ex', 'SYNTHETIC CLASSIFIER PLAN OTHER')
  const askX = await x.as('permissions.request', { command: 'bash app/prod/x-card.sh', reason: 'its tab closes after the restarts' })
  const rule = askW.rule
  const first = await g.grantsState()
  record(`M-${tag}-setup`, [askW, askX].every(a => a.status === 'pending') && first.grants.length === 1 && first.grants[0].agentSessionId === h.id ? 'PASS' : 'FAIL',
    { requests: first.requests.map(entry => ({ id: entry.id, source: entry.source, status: entry.status })), grants: first.grants.length, rule }, 'W and X pending agent requests, D a pending denial, H one approved-once grant')
  const secrets = async when => {
    const text = await readFile(file, 'utf8').catch(() => ''), parsed = JSON.parse(text || 'null')
    const credential = JSON.parse(await readFile(join(inst.profile, 'control-owner.json'), 'utf8'))
    const hex64 = [...text.matchAll(/[a-f0-9]{64}/g)].length
    record(`M-${tag}-no-secrets-${when}`, text && !/bearer|authorization|password|secret|api[_-]?key/i.test(text) && hex64 === 0 && !text.includes(credential.token) ? 'PASS' : 'FAIL', { bytes: text.length, requests: parsed?.requests?.length, grants: parsed?.grants?.length, keys: parsed ? Object.keys(parsed) : null, requestKeys: [...new Set((parsed?.requests ?? []).flatMap(entry => Object.keys(entry)))], grantKeys: [...new Set((parsed?.grants ?? []).flatMap(entry => Object.keys(entry)))], hex64 }, 'permission-grants.json holds card fields only, no token')
  }
  await secrets('full')

  const survived = async kind => {
    const state = await g.grantsState()
    const req = id => state.requests.find(entry => entry.id === id)
    let listW
    try { listW = await w.as('permissions.list') } catch (error) { listW = { error: errorText(error) } }
    const cardW = await g.cardView(w, askW.requestId), cardD = await g.cardView(d, denial.id), cardX = await g.cardView(x, askX.requestId)
    const cardH = await g.cardView(h, askH.requestId)
    cardH.status = await g.article(askH.requestId).locator('.sa-grant-card').getAttribute('data-grant-status').catch(() => null)
    const grantH = state.grants.find(entry => entry.agentSessionId === h.id)
    const ok = req(askW.requestId)?.status === 'pending' && req(askW.requestId).agentSessionId === w.id && req(denial.id)?.status === 'pending' && req(askX.requestId)?.status === 'pending'
      && cardW.buttons === 3 && cardD.buttons === 3 && cardX.buttons === 3 && Array.isArray(listW.requests) && listW.requests.some(entry => entry.id === askW.requestId && entry.status === 'pending')
      && grantH?.rule === rule && cardH.buttons === 0 && cardH.status === 'approved-once'
    record(`M-${tag}-${kind}`, ok ? 'PASS' : 'FAIL', { W: req(askW.requestId)?.status, D: req(denial.id)?.status, X: req(askX.requestId)?.status, buttons: { W: cardW.buttons, D: cardD.buttons, X: cardX.buttons, H: cardH.buttons }, cardH: cardH.status, grantH: grantH ? grantH.delivery : null, listW: listW.error ?? listW.requests?.map(entry => entry.id) }, `after ${kind}: W/D/X cards live, W lists its own, H's grant held; ${await shot(`M-${tag}-${kind}`)}`)
  }

  step('update-style restart (owner app.restart, force)')
  const pid1 = inst.credential.pid
  await call('app.restart', { force: true })
  await relaunched(inst, pid1, { timeoutMs: 90_000 })
  await rebind()
  await survived('update-restart')

  step('clean quit: the window closes, then Conductor starts again')
  const pid2 = inst.credential.pid
  await view.evaluate(() => window.close()).catch(() => undefined)
  const quit = await poll(() => { try { process.kill(pid2, 0); return false } catch { return true } }, { timeoutMs: 45_000, label: 'the window close to quit the app' }).then(() => true, () => false)
  if (!quit) { record(`M-${tag}-clean-quit`, 'NOT RUN (harness)', {}, 'closing the window did not quit the parked app within 45 s; killed instead'); execFileSync('taskkill.exe', ['/pid', String(pid2), '/T', '/F'], { stdio: 'ignore' }) }
  await relaunchParked(inst)
  await rebind()
  await openProject({ name: NAME, path: inst.projectPath })
  if (quit) await survived('clean-quit')

  step('crash (taskkill), a holder-less entry planted while down, start again')
  const pid3 = inst.credential.pid
  execFileSync('taskkill.exe', ['/pid', String(pid3), '/T', '/F'], { stdio: 'ignore' })
  await poll(() => { try { process.kill(pid3, 0); return false } catch { return true } }, { timeoutMs: 30_000, label: 'the crashed app to exit' })
  const planted = await saved()
  const template = planted.requests.find(entry => entry.id === askX.requestId)
  planted.requests.push({ ...template, id: 'grant:vr9e-gone', agentSessionId: 'agent_vr9e_gone_for_good' })
  await writeFile(file, JSON.stringify(planted) + '\n')
  await relaunchParked(inst)
  await rebind()
  await openProject({ name: NAME, path: inst.projectPath })
  await survived('crash')
  const afterCrash = await g.grantsState(), fileCrash = await saved()
  record(`M-${tag}-gone-holder-dropped`, !afterCrash.requests.some(entry => entry.id === 'grant:vr9e-gone') && !fileCrash?.requests?.some(entry => entry.id === 'grant:vr9e-gone') ? 'PASS' : 'FAIL', { inState: afterCrash.requests.some(entry => entry.id === 'grant:vr9e-gone'), inFile: Boolean(fileCrash?.requests?.some(entry => entry.id === 'grant:vr9e-gone')) }, 'an entry whose conversation does not exist is not restored')

  step("X's tab is closed after the restarts: its restored request expires")
  await call('tabs.close', { tabId: x.tabId })
  await poll(async () => !(await g.grantsState()).requests.some(entry => entry.id === askX.requestId), { timeoutMs: 20_000, label: "X's request to end" })
  record(`M-${tag}-closed-expires`, 'PASS', { statusRecorded: (await g.grantsState()).settled?.find(entry => entry.id === askX.requestId)?.status ?? null }, "a restored request ends when its tab is closed")

  step('H retries: its grant from before three restarts runs once')
  await g.submit(h.id, 'SYNTHETIC CLASSIFIER OTHER retry after the restarts', false)
  await g.settled(h.id, 'H retry settles')
  await poll(async () => !(await g.grantsState()).grants.some(grant => grant.agentSessionId === h.id), { timeoutMs: 15_000, label: "H's grant spent" })
  const ranH = await g.ran(h.id, rule)
  await g.submit(h.id, 'SYNTHETIC CLASSIFIER OTHER a second try', false)
  await g.settled(h.id, 'H second try settles')
  const lastH = (await g.texts(h.id, 'assistant')).at(-1) ?? ''
  record(`M-${tag}-H-once`, ranH === 1 && await g.ran(h.id, rule) === 1 && /SYNTHETIC classifier refused Bash/.test(lastH) ? 'PASS' : 'FAIL', { ranFirst: ranH, ranAfterSecond: await g.ran(h.id, rule), last: lastH.slice(0, 120) }, 'approved-not-consumed grant ran once after the restarts, then refused')

  step("D's restored denial card is approved once")
  await g.click(d, denial.id, 'Approve once')
  await poll(async () => await g.ran(d.id, rule) === 1, { timeoutMs: 30_000, label: 'D retry ran' })
  await g.settled(d.id, 'D settles')
  record(`M-${tag}-D-once`, await g.told(d.id) === 1 && await g.ran(d.id, rule) === 1 ? 'PASS' : 'FAIL', { told: await g.told(d.id), ran: await g.ran(d.id, rule) }, 'the denial card from before the restarts answered once: told once, ran once')

  step('W hands off after the restarts; the owner approves the moved card in the successor')
  await g.wizardAgain(w)
  const s = await g.handOff(w, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr9esucc')
  const moved = await poll(async () => (await g.grantsState()).requests.find(entry => entry.id === askW.requestId && entry.agentSessionId === s.id) ?? null, { timeoutMs: 15_000, label: "W's request moved to the successor" }).catch(() => null)
  const cardS = await g.cardView(s, askW.requestId)
  record(`M-${tag}-handoff-moves`, moved?.status === 'pending' && cardS.buttons === 3 ? 'PASS' : 'FAIL', { holder: moved ? 'successor' : (await g.grantsState()).requests.find(entry => entry.id === askW.requestId)?.agentSessionId ?? null, buttons: cardS.buttons }, await shot(`M-${tag}-successor-card`))
  if (moved) {
    await g.click(s, askW.requestId, 'Approve once')
    await poll(async () => await g.ran(s.id, rule) === 1, { timeoutMs: 30_000, label: 'successor retry ran' })
    await g.settled(s.id, 'successor settles')
    await g.submit(s.id, `[Conductor] approved: ${rule} (once); retry it now.`, false)
    await g.settled(s.id, 'successor second retry settles')
    const lastS = (await g.texts(s.id, 'assistant')).at(-1) ?? ''
    record(`M-${tag}-successor-once`, await g.told(s.id) === 2 && await g.ran(s.id, rule) === 1 && await g.ran(w.id, rule) === 0 && /SYNTHETIC classifier refused Bash/.test(lastS) ? 'PASS' : 'FAIL', { toldByConductor: await g.told(s.id) - 1, ranS: await g.ran(s.id, rule), ranW: await g.ran(w.id, rule), last: lastS.slice(0, 120) }, 'one Approve once after restart + handoff: the successor told once and ran once, W never, a replayed retry refused')
  }

  step('a last restart restores nothing used; the file holds no credential')
  const pid4 = inst.credential.pid
  await call('app.restart', { force: true })
  await relaunched(inst, pid4, { timeoutMs: 90_000 })
  await rebind()
  const final = await g.grantsState(), fin = await saved()
  const used = [askW.requestId, askH.requestId, denial.id, askX.requestId]
  record(`M-${tag}-nothing-used-restored`, !final.requests.some(entry => used.includes(entry.id)) && final.grants.length === 0 && !fin?.requests?.some(entry => used.includes(entry.id)) ? 'PASS' : 'FAIL', { requests: final.requests.map(entry => ({ id: entry.id, source: entry.source, status: entry.status })), grants: final.grants.length, fileRequests: fin?.requests?.map(entry => entry.id), settled: fin?.settled?.length }, 'used, answered and closed requests are not restored')
  await secrets('final')
}
