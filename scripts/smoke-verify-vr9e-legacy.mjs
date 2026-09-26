// VR9e legacy path: the owner's B5 card (grant:632b2e2a) was filed under the installed build
// 0.1.54-local.1790381958664 (3a66883), which kept grants in memory only. FX43 (4781e54) brings such a
// card back on its first launch from the tabs' timelines. Reproduced here in the owner's order, on one
// parked profile: the OLD build's wizard W files permissions.request and its turn ends (idle, as the
// haftheme wizard), the OLD build quits the way app.update.install does (the owner credential's
// app.restart({force:true}): prepareForUpdateInstall + disposeRuntimeServices; the relaunch is skipped
// with CONDUCTOR_RECOVERY_TEST_SKIP_RELAUNCH so the NEW build starts in its place, as the installer
// does), then the NEW build starts on the same profile with no permission-grants.json.
//   --new=<dir>   the worktree whose out/ starts second (default .conductor-scratch/vr9e/wt-4781e54;
//                 the control passes wt-b420de4)
//   --quit=restart|crash   how the OLD build ends (crash = taskkill, the neighbour control: no quit path)
//   --old=<dir>   default .conductor-scratch/vr9e/wt-3a66883
//   --after=<n>   after filing, W runs a SYNTHETIC LONG <n> turn (its timeline outgrows the projection)
// Only the Claude process is the synthetic fixture (SYNTHETIC CLASSIFIER: nothing executes), the same
// fixture file for both builds.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9e-legacy.mjs --quit=restart
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { REPO, call, configure, failed, finish, launchParked, openProject, page, poll, record, relaunchParked, shot, step, watchdog } from './verify-kit.mjs'
import { B5_COMMAND, errorText, grantHandoff, handoffEnv } from './lib/grant-handoff.mjs'

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const NEW = resolve(REPO, arg('new', '.conductor-scratch/vr9e/wt-4781e54'))
const OLD = resolve(REPO, arg('old', '.conductor-scratch/vr9e/wt-3a66883'))
const QUIT = arg('quit', 'restart')
const AFTER = Number(arg('after', '0'))
const label = `${basename(OLD).replace('wt-', '')}-${QUIT}-${basename(NEW).replace('wt-', '')}${AFTER ? `-after${AFTER}` : ''}`
const OUTPUT = 'artifacts/verification/2026-09-26-vr9e'
configure({ name: `vr9e-legacy-${label}`, output: OUTPUT })
watchdog(600)
const { capture, flagLog, env } = await handoffEnv('vr9e', { CONDUCTOR_RECOVERY_TEST_SKIP_RELAUNCH: '1', CONDUCTOR_TEST_UNIQUE_TOOL_IDS: '1', CONDUCTOR_TEST_FIXTURE_DIR: join(REPO, '.conductor-scratch/vr9e/wt-4781e54/scripts/fixtures') })
try {
  const inst = await launchParked({ mode: 'spawn', env, build: join(OLD, 'out/main/index.js') })
  await scenario(inst)
} catch (error) { await failed(error, `L-${label}`) }
await finish()

async function scenario(inst) {
  let view = await page(inst)
  await openProject({ name: 'VR9e legacy' })
  let g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  // A card further back than the pane shows is reached the owner's way: "Show earlier activities".
  const reveal = async (tab, itemId) => {
    await g.show(tab)
    for (let tries = 0; tries < 20 && !await g.article(itemId).count(); tries++) {
      const earlier = view.locator('.sa-load-earlier').first()
      if (!await earlier.isVisible().catch(() => false)) break
      await earlier.click()
      await new Promise(done => setTimeout(done, 500))
    }
    return g.cardView(tab, itemId)
  }
  const cards = async (id, requestId) => (await g.items(id)).filter(item => item.data.type === 'notice' && item.data.payload?.permissionGrant?.id === requestId).map(item => item.data.payload.permissionGrant.status)

  step('OLD build: wizard W files the B5 request and its turn ends')
  const w = await g.wizard('VR9e wizard W', 'SYNTHETIC CLASSIFIER PLAN OTHER vr9ewizard')
  const asked = await w.as('permissions.request', { command: B5_COMMAND, reason: 'B5 lsphp pool fix (stand-in)', rollback: 'none: the fixture never runs it' })
  await poll(async () => (await cards(w.id, asked.requestId)).at(-1) === 'pending', { timeoutMs: 10_000, label: "W's pending card" })
  if (AFTER) {
    // The wizard keeps working after it filed: its timeline grows past the projection's last
    // MAX_TIMELINE_ITEMS (2000), which is all the first-launch recovery reads.
    await g.submit(w.id, `SYNTHETIC LONG ${AFTER}`, false)
    await g.settled(w.id, 'W long turn settles', 180_000)
    await g.rewizard(w.id)
  }
  const inWindow = (await cards(w.id, asked.requestId)).length
  const before = await reveal(w, asked.requestId)
  const phase = (await g.snap(w.id))?.phase
  if (AFTER) record(`L-${label}-old-window`, 'INFO', { items: (await g.items(w.id)).length, truncated: (await g.snap(w.id))?.truncated ?? null, cardInProjection: inWindow, ownerState: (await g.grantsState()).requests.find(entry => entry.id === asked.requestId)?.status ?? null }, "OLD build after W's long turn: the card's place in the projection")
  record(`L-${label}-old-files`, asked.status === 'pending' && (AFTER || before.buttons === 3) ? 'PASS' : 'FAIL', { requestId: asked.requestId, rule: asked.rule, buttons: before.buttons, phase }, `OLD build ${basename(OLD)}: W's card is live before the update; ${await shot(`L-${label}-old-card`)}`)

  step(`OLD build ends (${QUIT})`)
  const oldPid = inst.credential.pid
  if (QUIT === 'crash') execFileSync('taskkill.exe', ['/pid', String(oldPid), '/T', '/F'], { stdio: 'ignore' })
  else await call('app.restart', { force: true })
  await poll(() => { try { process.kill(oldPid, 0); return false } catch { return true } }, { timeoutMs: 60_000, label: 'the OLD build to exit' })
  const fileAfterOld = await readFile(join(inst.profile, 'permission-grants.json'), 'utf8').then(() => true, () => false)

  step(`NEW build ${basename(NEW)} starts on the same profile`)
  await relaunchParked(inst, { build: join(NEW, 'out/main/index.js') })
  view = await page(inst)
  await openProject({ name: 'VR9e legacy', path: inst.projectPath })
  g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  const history = await cards(w.id, asked.requestId)
  const state = await g.grantsState()
  const waiting = state.requests.find(entry => entry.id === asked.requestId)
  let listW
  try { listW = await w.as('permissions.list') } catch (error) { listW = { error: errorText(error) } }
  const card = await reveal(w, asked.requestId)
  const saved = JSON.parse(await readFile(join(inst.profile, 'permission-grants.json'), 'utf8').catch(() => 'null'))
  const live = waiting?.status === 'pending' && waiting.agentSessionId === w.id && card.buttons === 3 && Array.isArray(listW.requests) && listW.requests.some(entry => entry.id === asked.requestId && entry.status === 'pending')
  record(`L-${label}-card-live`, live ? 'PASS' : 'FAIL', { cardHistory: history, fileBeforeNew: fileAfterOld, owner: waiting ? { status: waiting.status, holderIsW: waiting.agentSessionId === w.id } : null, listW: listW.error ?? listW.requests?.map(entry => ({ id: entry.id, status: entry.status })), card, savedRequests: saved?.requests?.map(entry => ({ id: entry.id, status: entry.status })) ?? null }, `after the update W's B5 card is live, listed and held pending; ${await shot(`L-${label}-new-card`)}`)
  if (!live) return

  step('the owner approves once in the restored card')
  await g.click(w, asked.requestId, 'Approve once')
  await poll(async () => await g.told(w.id) === 1, { timeoutMs: 20_000, label: 'W told approved' })
  await poll(async () => await g.ran(w.id, asked.rule) === 1, { timeoutMs: 30_000, label: 'W retry ran' })
  await g.settled(w.id, 'W settles after its retry')
  await g.submit(w.id, `[Conductor] approved: ${asked.rule} (once); retry it now.`, false)
  await g.settled(w.id, 'W second retry settles')
  const last = (await g.texts(w.id, 'assistant')).at(-1) ?? ''
  const spent = (await g.grantsState()).requests.find(entry => entry.id === asked.requestId)
  const told = (await g.texts(w.id, 'user')).filter(text => text.startsWith('[Conductor] approved:'))
  record(`L-${label}-approve-once`, told.length === 2 && told[0].startsWith(`[Conductor] approved: ${asked.rule} (once)`) && await g.ran(w.id, asked.rule) === 1 && /SYNTHETIC classifier refused Bash/.test(last) && spent?.status === 'used' ? 'PASS' : 'FAIL',
    { toldByConductor: told.length - 1, ran: await g.ran(w.id, asked.rule), last: last.slice(0, 160), status: spent?.status }, 'one click: W told once, ran once, grant used, the replayed retry refused')
}
