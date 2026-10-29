// Cloud-only evidence run (Linux, Xvfb): the same steps as scripts/smoke-cloud-threads.mjs without
// verify-kit (its process accounting is Windows-only). Usage: xvfb-run node linux-threads-run.mjs <repo> <outdir>
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const repo = process.argv[2], out = process.argv[3]
const require = createRequire(join(repo, 'package.json'))
const { _electron } = require('@playwright/test')
await mkdir(out, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-cloud-threads-'))
const profile = join(root, 'profile'); await mkdir(profile)
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
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Three directions, working in ' + process.cwd() + ': ' + prompt.split('\\n', 1)[0].slice(0, 60) }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`
const fixtures = join(root, 'fixtures'); await mkdir(fixtures); await writeFile(join(fixtures, 'fake-claude.mjs'), FIXTURE)
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: fixtures }
for (const key of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_LIVE_TESTS', 'CONDUCTOR_BACKGROUND_WINDOWS']) delete env[key]
const results = []
const record = (id, ok, detail) => { results.push({ id, verdict: ok ? 'PASS' : 'FAIL', detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`) }
const poll = async (fn, label, timeoutMs = 45_000) => { const end = Date.now() + timeoutMs; for (;;) { const value = await fn().catch(() => null); if (value) return value; if (Date.now() > end) throw new Error('timed out: ' + label); await new Promise(r => setTimeout(r, 400)) } }

let app, view
const launch = async () => {
  app = await _electron.launch({ args: ['--no-sandbox', join(repo, 'out/main/index.js')], env, timeout: 60_000 })
  view = await app.firstWindow(); view.setDefaultTimeout(20_000)
  view.on('pageerror', error => results.push({ id: 'pageerror', verdict: 'FAIL', detail: error.message }))
  await view.waitForFunction(() => Boolean(window.conductor), null, { timeout: 60_000 })
}
const credential = () => poll(async () => { const value = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return value.token ? value : null }, 'control-owner.json')
const call = async (method, args = {}, scope) => {
  const { endpoint, token } = await credential()
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  const body = await response.json()
  if (response.status !== 200 || body.error) throw new Error(`${method}: ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 600)}`)
  return body.result
}
const shot = async name => { const path = join(out, name + '.png'); await view.screenshot({ path }); return path }

try {
  await launch()
  // 1. First launch, no project: the empty state offers a thread first.
  const before = await view.evaluate(() => window.conductor.projects.list())
  await view.locator('[data-empty-new-thread]').waitFor()
  record('first-launch-empty-state', before.length === 0, { projects: before.length, offer: await view.locator('[data-empty-new-thread]').innerText() })
  await shot('1-first-launch')

  // 2. New thread: General is made, marked, and its workspace shows a launcher.
  await view.locator('[data-empty-new-thread]').click()
  await view.locator('.project-row.active[data-general-project]').waitFor()
  await view.locator('.pane-workspace').first().waitFor()
  const projects = await view.evaluate(() => window.conductor.projects.list())
  const general = projects.find(project => project.general)
  record('new-thread-general', projects.length === 1 && general?.name === 'General' && general.path === join(root, 'projects', 'General') && existsSync(general.path), { projects: projects.map(p => ({ name: p.name, path: p.path, general: p.general })) })
  const launchers = await view.locator('.launcher-pane, [data-pane-kind="launcher"], .pane-tab:has-text("New tab")').count()
  record('new-thread-launcher', launchers > 0, { launchers })
  await shot('2-new-thread')

  // 3. A real (offline fixture) Claude conversation in General: cwd is the General folder, it is listed.
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Logo ideas' }, { projectId: general.id })
  await poll(() => call('agents.status', { agentSessionId: tab.resourceId }, { projectId: general.id }), 'agents.status')
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'Sketch three logo directions' }, { projectId: general.id })
  let lastStatus = null
  await poll(async () => { lastStatus = await call('agents.status', { agentSessionId: tab.resourceId }, { projectId: general.id }); return ['completed', 'idle'].includes(lastStatus.phase) }, 'turn settles', 60_000).catch(error => { console.log('STATUS', JSON.stringify(lastStatus).slice(0, 1500)); throw error })
  const spec = await view.evaluate(id => window.conductor.structured.snapshot(id).then(s => ({ title: s?.title, phase: s?.phase })), tab.resourceId)
  const status = await call('agents.status', { agentSessionId: tab.resourceId }, { projectId: general.id })
  const threads = await poll(async () => { const v = await view.evaluate(() => window.conductor.threads.list('')); return v.total ? v : null }, 'thread view')
  const listed = threads.groups.flatMap(g => g.threads).find(t => t.id === tab.resourceId)
  const reply = await view.evaluate(id => window.conductor.structured.snapshot(id).then(s => s.items.filter(i => i.data.type === 'text' && i.data.role === 'assistant').map(i => i.data.text).join(' ')), tab.resourceId)
  record('general-thread-listed', Boolean(listed?.general && listed.tabId), { state: listed?.state, title: listed?.title, projectName: listed?.projectName, phase: spec.phase })
  record('agent-cwd-is-general-folder', reply.includes(general.path), { reply: reply.slice(0, 200) })
  await view.locator(`[data-thread-id="${tab.resourceId}"][data-thread-general]`).waitFor()
  await shot('3-thread-in-sidebar')

  // 4. Ctrl+Alt+N again reuses General: no second project.
  await view.keyboard.press('Control+Alt+n')
  await new Promise(r => setTimeout(r, 1500))
  const again = await view.evaluate(() => window.conductor.projects.list())
  record('new-thread-reuses-general', again.length === 1 && again[0].id === general.id, { projects: again.length })

  // 5. Restart: same General, same thread listed, conversation still has its turn.
  await view.evaluate(() => window.dispatchEvent(new Event('conductor:flush-session')))
  await new Promise(r => setTimeout(r, 1500))
  await app.close()
  await launch()
  const afterProjects = await view.evaluate(() => window.conductor.projects.list())
  const afterGeneral = afterProjects.find(p => p.general)
  const afterThreads = await poll(async () => { const v = await view.evaluate(() => window.conductor.threads.list('')); return v.total ? v : null }, 'thread view after restart')
  const kept = afterThreads.groups.flatMap(g => g.threads).find(t => t.id === tab.resourceId)
  const snapshot = await view.evaluate(id => window.conductor.structured.snapshot(id).then(s => ({ items: s?.items?.filter(i => i.data.type === 'text').length ?? 0 })), tab.resourceId)
  record('restart-keeps-general-thread', afterGeneral?.id === general.id && Boolean(kept) && snapshot.items > 0, { general: afterGeneral?.id, kept: Boolean(kept), textItems: snapshot.items })
  await view.locator('.project-row[data-general-project]').first().waitFor()
  await shot('4-after-restart')

  // 6. Association: continue in a real project (handoff drafted, unsent), then turn General into a project in place.
  const brandPath = join(root, 'projects-src', 'Brand'); await mkdir(brandPath, { recursive: true }); await writeFile(join(brandPath, 'README.md'), '# Brand\n')
  const brand = await call('projects.open', { path: brandPath, name: 'Brand' })
  // Same fallback as verify-kit openProject: a control-made project reaches an open window on reload.
  if (!await view.locator('.project-row').filter({ hasText: 'Brand' }).first().isVisible().catch(() => false)) { await view.reload(); await view.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 }) }
  await view.locator('.project-row').filter({ hasText: 'Brand' }).first().waitFor()
  await view.locator(`[data-thread-id="${tab.resourceId}"]`).waitFor()
  const handoff = await view.evaluate(([id, target]) => window.conductor.threads.handoff(id, target), [tab.resourceId, brand.id])
  record('continue-in-project-handoff', Boolean(handoff?.text.includes('Sketch three logo directions') && handoff.text.includes(general.path) && handoff.provider === 'claude'), { chars: handoff?.text.length, provider: handoff?.provider })
  await view.locator(`[data-thread-id="${tab.resourceId}"]`).click({ button: 'right' })
  await view.locator(`[data-continue-project="${brand.id}"]`).click()
  await view.locator('.project-row.active').filter({ hasText: 'Brand' }).first().waitFor()
  const draftOk = await poll(async () => (await view.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('conductor.structured.draft.')).map(k => localStorage.getItem(k)).some(v => v && v.includes('Sketch three logo directions')))) || null, 'seeded draft', 20_000).catch(() => false)
  record('continue-in-project-draft', Boolean(draftOk), {})
  await shot('5-continued-in-brand')
  const promoted = await view.evaluate(() => window.conductor.threads.promote('Logo work'))
  const promotedStatus = await call('agents.status', { agentSessionId: tab.resourceId }, { projectId: general.id }).catch(error => ({ error: error.message }))
  const nextGeneral = await view.evaluate(() => window.conductor.threads.newGeneral())
  record('promote-in-place', promoted.id === general.id && promoted.path === general.path && promoted.name === 'Logo work' && nextGeneral.project.id !== general.id, { promoted: { name: promoted.name, path: promoted.path }, nextGeneral: nextGeneral.project.path, status: promotedStatus.phase ?? promotedStatus.error })
  await shot('6-promoted')
} catch (error) {
  results.push({ id: 'error', verdict: 'FAIL', detail: String(error?.stack ?? error) })
  console.error(error)
  if (view) await shot('error').catch(() => {})
} finally {
  await app?.close().catch(() => {})
  await writeFile(join(out, 'results.json'), JSON.stringify({ root, results }, null, 2))
  console.log(JSON.stringify(results.map(r => `${r.verdict} ${r.id}`)))
}
