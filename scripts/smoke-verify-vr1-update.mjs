// VR1 group update (feature-list.md app-update-no-dialog-in-auto): "app.update from a native
// Claude/Codex coworker in Auto should just run, without the owner dialog and without needing
// app.update.authorize; keep the dialog ... for tabs below Auto". F-fx12 S18 covers a Claude tab in
// Auto; this covers
//   U1  a Codex coworker in Auto: 200, authorizedBy 'auto', no owner confirmation pending
//       control: a Claude tab opened below Auto (exactPermission) gets the confirmation
// The project is a tiny repository with a stub build script that exits 1; the decision is what counts.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr1-update.mjs
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'

configure({ name: 'vr1-update', output: 'artifacts/verification/2026-09-25-vr1' })
watchdog(10 * 60)

try {
  await loadCheck()
  const capture = join(await mkdtemp(join(tmpdir(), 'vr1-capture-')), 'provider-input.txt')
  await launchParked({ mode: 'playwright', name: 'vr1-update', env: { CONDUCTOR_TEST_FIXTURE_DIR: join(REPO, 'scripts', 'fixtures'), CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  // app.update refuses anything that does not look like a Conductor checkout (LocalUpdateBuilder
  // .unsupported) before it decides on the dialog; these stubs pass that check and the build script
  // exits at once, so no real build runs.
  await openProject({ name: 'VR1 update', git: true, files: { 'package.json': '{"name":"conductor-desktop","private":true}\n', 'node_modules/electron-builder/cli.js': '// VR1 stub\n', 'scripts/build-local-update.mjs': "console.log('VR1 stub build: nothing is built'); process.exit(1)\n" } })
  const view = await page()
  const pending = () => view.evaluate(() => window.conductor.agentConfirm.pending())
  const settings = id => view.evaluate(async value => (await window.conductor.structured.snapshot(value))?.settings, id)
  const credentialFor = async (id, prompt) => {
    await call('agents.submit', { agentSessionId: id, prompt })
    await poll(async () => (await readFile(capture, 'utf8').catch(() => '')).startsWith(prompt), { timeoutMs: 30_000, label: `${id} to receive its prompt` })
    const text = await readFile(capture, 'utf8')
    await poll(async () => (await call('agents.status', { agentSessionId: id })).phase === 'completed', { timeoutMs: 30_000, label: `${id} to settle` })
    return { endpoint: text.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: text.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  }
  const raw = async (auth, method, args = {}) => { const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) }); return { status: response.status, body: await response.json() } }

  step('U1 Codex coworker in Auto')
  const codexTab = await openTab({ provider: 'codex', title: 'VR1 Codex coworker' })
  const codexSettings = await settings(codexTab.resourceId)
  const codex = await credentialFor(codexTab.resourceId, 'SYNTHETIC B codex coworker')
  const before = await pending()
  const call1 = raw(codex, 'app.update')
  await sleep(1500)
  const during = await pending()
  const answered = await withDeadline(call1, 30_000)
  const status = await call('app.update.status').catch(error => ({ error: String(error.message) }))

  step('U1 control: Claude below Auto')
  const lowTab = await openTab({ provider: 'claude', title: 'VR1 ask-mode coworker', permission: 'default', exactPermission: true })
  const lowSettings = await settings(lowTab.resourceId)
  const low = await credentialFor(lowTab.resourceId, 'SYNTHETIC B ask-mode coworker')
  const lowCall = raw(low, 'app.update')
  const asked = await poll(async () => (await pending()).length > 0, { timeoutMs: 30_000, label: 'the owner confirmation' }).then(() => true, () => false)
  const lowShot = await shot('vr1-U1-below-auto-asks')
  if (asked) await view.locator('.agent-confirm-backdrop').getByRole('button', { name: 'Cancel' }).click().catch(() => {})
  const lowAnswer = await withDeadline(lowCall, 30_000)
  const numbers = {
    codexPermission: codexSettings?.permission, pendingBefore: before.length, pendingDuring: during.length,
    codex: answered.ok ? { status: answered.value.status, authorizedBy: answered.value.body?.result?.authorizedBy, error: answered.value.body?.error ?? null } : 'no answer in 30 s',
    buildState: status.state ?? status.error, lowPermission: lowSettings?.permission, lowAsked: asked, low: lowAnswer.ok ? { status: lowAnswer.value.status, error: String(lowAnswer.value.body?.error ?? '').slice(0, 120) } : 'no answer'
  }
  const control = asked && lowSettings?.permission !== 'auto' && lowAnswer.ok && lowAnswer.value.status !== 200
  record('U1', control && codexSettings?.permission === 'auto' && during.length === 0 && answered.ok && answered.value.status === 200 && answered.value.body?.result?.authorizedBy === 'auto' ? 'PASS' : 'FAIL', numbers, `control: a Claude tab below Auto was asked (${asked}) and declined; ${lowShot}`)
} catch (error) {
  await failed(error, 'vr1-update')
}
await finish()
