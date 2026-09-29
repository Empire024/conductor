import { _electron as electron, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// codex-credit-burn fixes (1) and (4), through a real controller conversation's own app-control
// credential (the synthetic Codex fixture records each prompt, briefing included):
//   (1) a controller in one workspace messages a conversation in another workspace of the same
//       project directly (acrossWorkspaces, no control taken, no relay tab opened), and that
//       conversation replies to it the same way;
//   (4) a coworker whose turn ends on the provider's usage limit is reported to its controller at
//       once, with the error and whether anything resumes it.
// A throwaway test profile; CONDUCTOR_TEST_USER_DATA parks the window off every display.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-credit-burn-controller.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-credit-burn-'))
const output = resolve('artifacts/credit-burn-controller')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project'), capture = join(root, 'last-prompt.txt')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Credit burn controller smoke\n')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures'),
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_BACKGROUND_WINDOWS: '1'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const checks = [], evidence = {}
const check = label => { checks.push(label); console.log('PASS ' + label) }
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const ok = async (auth, method, args, scope) => { const r = await request(auth, method, args, scope); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }

const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const settled = async id => expect.poll(async () => (await snapshot(id))?.phase, { timeout: 30000 }).toMatch(/^(completed|idle|failed)$/)
const userTexts = async id => (await snapshot(id)).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)
/** The app-control credential in the briefing of the prompt a conversation just received. */
const credential = async () => {
  const briefing = await readFile(capture, 'utf8')
  const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  assert.ok(auth.endpoint && auth.token, 'the conversation received an app-control briefing')
  return auth
}

try {
  await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30000 }).toBe(true)
  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const project = await ok(owner, 'projects.open', { path: projectPath, name: 'Credit burn smoke' })
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'Credit burn smoke' }).first().click()
  const build = (await page.evaluate(id => window.conductor.sessions.list(id), project.id))[0]
  const review = await page.evaluate(id => window.conductor.sessions.create(id, 'Review room'), project.id)
  // The window reads its workspaces again, so both can receive tabs.
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'Credit burn smoke' }).first().click()
  const buildScope = { projectId: project.id, workspaceId: build.id }, reviewScope = { projectId: project.id, workspaceId: review.id }

  // The controller: a Codex conversation in the build workspace, driven with its own credential.
  const controllerTab = await ok(owner, 'tabs.open', { kind: 'agent', provider: 'codex', title: 'Build controller' }, buildScope)
  const controller = controllerTab.resourceId
  await writeFile(capture, '')
  await ok(owner, 'agents.submit', { agentSessionId: controller, prompt: 'synthetic:relay-context\nYou coordinate the build.' }, buildScope)
  await settled(controller)
  const asController = await credential()

  // (1) The review room's lead, opened by the owner, is nobody's coworker.
  const leadTab = await ok(owner, 'tabs.open', { kind: 'agent', provider: 'codex', title: 'Review room lead' }, reviewScope)
  const lead = leadTab.resourceId
  const tabCount = async () => (await ok(owner, 'tabs.list', {}, buildScope)).length + (await ok(owner, 'tabs.list', {}, reviewScope)).length
  const before = await tabCount()
  await writeFile(capture, '')
  const sent = await ok(asController, 'agents.steer', { agentSessionId: lead, prompt: 'The build is green; please start the review.' })
  assert.equal(sent.acrossWorkspaces, true)
  assert.equal(sent.controlled, false)
  await settled(lead)
  const received = (await userTexts(lead)).at(-1) ?? ''
  assert.ok(received.startsWith(`[From Build controller (${controller}), workspace "${build.name}"] The build is green; please start the review.`), received.slice(0, 200))
  const listed = await ok(owner, 'agents.list', {}, reviewScope)
  assert.ok(!listed.find(entry => entry.agentSessionId === lead)?.controlledBy, 'the lead stays uncontrolled')
  assert.equal(await tabCount(), before, 'no relay tab was opened')
  check(`(1) The build controller messaged the review room's lead in another workspace directly (acrossWorkspaces, delivery ${sent.delivery}, no control, no relay tab)`)
  // The lead's reply goes back the same way, with the lead's own credential.
  const asLead = await credential()
  const replied = await ok(asLead, 'agents.steer', { agentSessionId: controller, prompt: 'Review started.' })
  assert.equal(replied.acrossWorkspaces, true)
  await settled(controller)
  const reply = (await userTexts(controller)).find(text => text.startsWith(`[From Review room lead (${lead}), workspace "Review room"] Review started.`))
  assert.ok(reply, 'the controller received the reply')
  evidence.crossWorkspace = { controller, lead, sent: { delivery: sent.delivery, acrossWorkspaces: sent.acrossWorkspaces, controlled: sent.controlled }, replied: { delivery: replied.delivery, acrossWorkspaces: replied.acrossWorkspaces } }
  check('(1) The lead replied to the controller across the workspaces the same way')

  // (4) A coworker stopped by its provider's usage limit is reported at once.
  const worker = await ok(asController, 'tabs.open', { kind: 'agent', provider: 'codex', title: 'Limited worker', prompt: 'synthetic:usage-limit' })
  const workerId = worker.resourceId
  await expect.poll(async () => (await snapshot(workerId))?.phase, { timeout: 30000 }).toBe('failed')
  const stoppedAt = Date.now()
  await expect.poll(async () => (await userTexts(controller)).some(text => text.startsWith(`[Conductor] Your coworker "Limited worker" (${workerId}, codex) stopped on its provider's usage limit`)), { timeout: 15000 }).toBe(true)
  const report = (await userTexts(controller)).find(text => text.startsWith('[Conductor] Your coworker "Limited worker"'))
  assert.match(report, /You've hit your session limit/)
  assert.match(report, /(Its usage window reopens at \S+; nothing resumes it automatically\.|The provider gave no reset time)/)
  assert.match(report, /Do not wait on its report/)
  evidence.limitStop = { worker: workerId, reportedWithinMs: Date.now() - stoppedAt, report }
  check(`(4) The controller was told within ${evidence.limitStop.reportedWithinMs} ms that its coworker stopped on the usage limit: "${report.slice(0, 160)}…"`)
  await page.locator('.pane-tabs').first().screenshot({ path: join(output, '1-controller.png') })
  assert.deepEqual(errors, [])
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, evidence, errors }, null, 2))
  await app.close().catch(() => {})
}
