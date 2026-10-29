// Parked check: threads without a project (src/shared/threads.ts, docs/perf-evidence/t3code-cloud-threads.md).
// node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-cloud-threads.mjs
// First launch with no project offers "Start without a project"; a new thread opens in the General
// project (a folder Conductor made under the projects root), its agent works in that folder, the
// Threads view lists it, a second new thread reuses General, an app.restart keeps all of it, and a
// General thread can continue in a real project (drafted, unsent) or General can become a project in place.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, page, poll, record, relaunched, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'cloud-threads', output: 'artifacts/cloud-threads' })
watchdog(900)

// Answers any prompt, saying where it runs, so the working directory is evidence, not an assumption.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') { send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {} } }); return }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', cwd: process.cwd() })
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Working in ' + process.cwd() + ': ' + prompt.split('\\n', 1)[0].slice(0, 60) }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const threadsOf = view => view.evaluate(() => window.conductor.threads.list(''))
const listed = (view, id) => poll(async () => (await threadsOf(view)).groups.flatMap(group => group.threads).find(thread => thread.id === id) ?? null, { timeoutMs: 30_000, label: `thread ${id} listed` })

try {
  const inst = await launchParked({ mode: 'spawn', fixtures: { 'fake-claude.mjs': FIXTURE } })
  let view = await page(inst)

  step('first launch, no project: the empty state offers a thread first')
  assert.deepEqual(await view.evaluate(() => window.conductor.projects.list()), [])
  await view.locator('[data-empty-new-thread]').waitFor({ timeout: 30_000 })
  record('first-launch', 'PASS', {}, `empty state offers "${await view.locator('[data-empty-new-thread]').innerText()}"; ${await shot('first-launch')}`)

  step('Start without a project: General is made under the projects root and shows a launcher')
  await view.locator('[data-empty-new-thread]').click()
  await view.locator('.project-row.active[data-general-project]').waitFor({ timeout: 30_000 })
  await view.locator('.pane-workspace').first().waitFor({ timeout: 30_000 })
  const projects = await view.evaluate(() => window.conductor.projects.list())
  const general = projects.find(project => project.general)
  const expected = join(inst.root, 'projects', 'General')
  record('general-made', projects.length === 1 && general?.path.toLowerCase() === expected.toLowerCase() && existsSync(expected) ? 'PASS' : 'FAIL', { projects: projects.length }, `${general?.name} at ${general?.path}`)
  inst.projectId = general.id

  step('a conversation in General works in the General folder and is listed as a General thread')
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Logo ideas' }, { projectId: general.id })
  await poll(() => call('agents.status', { agentSessionId: tab.resourceId }), { timeoutMs: 30_000, label: 'agents.status' })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'Sketch three logo directions' })
  await poll(async () => (await call('agents.status', { agentSessionId: tab.resourceId })).phase === 'completed', { timeoutMs: 60_000, label: 'turn completed' })
  const reply = await view.evaluate(id => window.conductor.structured.snapshot(id).then(state => state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join(' ')), tab.resourceId)
  record('general-cwd', reply.toLowerCase().includes(general.path.toLowerCase()) ? 'PASS' : 'FAIL', {}, reply.slice(0, 200))
  const thread = await listed(view, tab.resourceId)
  await view.locator(`[data-thread-id="${tab.resourceId}"][data-thread-general]`).waitFor({ timeout: 20_000 })
  record('thread-listed', thread.general && thread.tabId ? 'PASS' : 'FAIL', { state: thread.state }, `${thread.title} (${thread.projectName}); ${await shot('thread-listed')}`)

  step('Ctrl+Alt+N again reuses General')
  await view.keyboard.press('Control+Alt+n')
  await view.waitForTimeout(1500)
  const again = await view.evaluate(() => window.conductor.projects.list())
  record('reuse-general', again.length === 1 && again[0].id === general.id ? 'PASS' : 'FAIL', { projects: again.length })

  step('app.restart keeps General, the thread and its turn')
  const firstPid = inst.credential.pid
  await call('app.restart', { force: true })
  const seconds = await relaunched(inst, firstPid, { timeoutMs: 90_000 })
  view = await page(inst)
  const restarted = (await view.evaluate(() => window.conductor.projects.list())).find(project => project.general)
  const kept = await listed(view, tab.resourceId)
  const items = await view.evaluate(id => window.conductor.structured.snapshot(id).then(state => state?.items.filter(item => item.data.type === 'text').length ?? 0), tab.resourceId)
  record('restart', restarted?.id === general.id && kept.tabId && items >= 2 ? 'PASS' : 'FAIL', { seconds, items }, await shot('after-restart'))

  step('continue in a real project: a new thread there with the handoff drafted and unsent')
  await mkdir(join(inst.root, 'src', 'brand'), { recursive: true })
  const brand = await call('projects.open', { path: join(inst.root, 'src', 'brand'), name: 'Brand' }, { projectId: null })
  // As verify-kit's openProject does: a project made through control reaches an open window on reload.
  if (!await view.locator('.project-row').filter({ hasText: 'Brand' }).first().isVisible().catch(() => false)) { await view.reload(); await view.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 }) }
  await view.locator(`[data-thread-id="${tab.resourceId}"]`).click({ button: 'right' })
  await view.locator(`[data-continue-project="${brand.id}"]`).click()
  await view.locator('.project-row.active').filter({ hasText: 'Brand' }).first().waitFor({ timeout: 30_000 })
  const drafted = await poll(() => view.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('conductor.structured.draft.')).some(key => (localStorage.getItem(key) ?? '').includes('Sketch three logo directions'))), { timeoutMs: 20_000, label: 'handoff draft' })
  record('continue-in-project', drafted ? 'PASS' : 'FAIL', {}, await shot('continued-in-brand'))

  step('turn General into a project in place: same folder, the thread still answers, a fresh General next time')
  const promoted = await view.evaluate(() => window.conductor.threads.promote('Logo work'))
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'One more direction' }, { projectId: general.id })
  await poll(async () => (await call('agents.status', { agentSessionId: tab.resourceId }, { projectId: general.id })).phase === 'completed', { timeoutMs: 60_000, label: 'turn after promote' })
  const next = await view.evaluate(() => window.conductor.threads.newGeneral())
  record('promote-in-place', promoted.id === general.id && promoted.path === general.path && next.project.id !== general.id ? 'PASS' : 'FAIL', { promoted: promoted.name }, `next General at ${next.project.path}`)
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await finish()
