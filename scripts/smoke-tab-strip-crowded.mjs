// Crowded tab strip (feature-list conductor-task 73762c1f): with ~15 tabs in one pane - a wizard
// MAIN, its coworkers (one of them leading its own coworker, one burning past the token alert) and
// plain owner tabs - every tab keeps its own box: no two tabs overlap, nothing a tab holds sticks
// out of it, every MAIN/COWORKER marker sits inside its own tab, the burn flame does not change the
// tab's width, and what has no room goes to "+N". S3 (tabs-focus-scroll-into-view): focusing an
// off-strip tab - tabs.focus, again once it is active, a sidebar row - brings it fully into the strip
// without focusing the parked window. Parked Electron window, synthetic Claude CLI (no inference).
// Screenshots: artifacts/verification/tab-strip-crowded/*.png.
//   node scripts/smoke-lock.mjs --timeout-min 15 -- node scripts/smoke-tab-strip-crowded.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'tab-strip-crowded', output: 'artifacts/verification/tab-strip-crowded' })
watchdog(900)

const capture = join(tmpdir(), `conductor-crowded-capture-${process.pid}.txt`)
// HOLD keeps the turn running; BURN reports a 6M-token turn. Every prompt is written to
// the capture file, whose app-control briefing carries the tab's own credential.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const text = (value, usage) => emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: value }], ...(usage ? { usage } : {}) } })
let holding = false
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const kind = message.request.subtype
    const response = kind === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    if (kind === 'interrupt' && holding) { holding = false; emit({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }) }
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  if (holding) return
  emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1' })
  const burn = prompt.includes('CROWDED BURN') ? { input_tokens: 2000000, cache_read_input_tokens: 4000000, output_tokens: 20000 } : undefined
  if (prompt.includes('CROWDED HOLD')) { holding = true; text('Working on it.', burn); return }
  text('Done: ' + prompt.split('\\n', 1)[0].slice(0, 60), burn)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: burn ?? {} })
})
`

const tabCall = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 800)}`)
  return body.result
}
const phaseOf = async id => (await call('agents.status', { agentSessionId: id })).phase
const settledAs = (id, phase, label) => poll(async () => await phaseOf(id) === phase, { timeoutMs: 45_000, label: `${label} ${phase}` })
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { endpoint, token }
}

/** Every tab and marker box in the first pane's strip, measured in the window. */
const measure = view => view.evaluate(() => {
  const strip = document.querySelector('.pane-tabs')
  const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } }
  const tabs = [...strip.querySelectorAll('.pane-tab[data-control-tab-id]')].map(tab => ({
    id: tab.dataset.controlTabId,
    title: tab.querySelector('.pane-tab-title')?.textContent ?? '',
    // The text's own box (font ascent to descent), not the span's taller line box.
    titleBox: (() => { const text = tab.querySelector('.pane-tab-title')?.firstChild; if (!text) return null; const range = document.createRange(); range.selectNodeContents(text); return box(range) })(),
    box: box(tab),
    burn: Boolean(tab.querySelector('.pane-tab-burn')),
    // Laid-out children only (display:none has no box); absolutely placed ones included.
    children: [...tab.querySelectorAll(':scope > *, :scope > .pane-tab-burn')].filter(child => child.getClientRects().length).map(child => ({ cls: String(child.className?.baseVal ?? child.className ?? child.tagName), box: box(child) }))
  }))
  const markers = [...strip.querySelectorAll('.agent-control-marker')].map(marker => ({ tabId: marker.dataset.markerTabId, text: marker.textContent, cls: marker.className, box: box(marker) }))
  const overflow = document.querySelector('.pane-overflow-button')?.textContent ?? ''
  return { strip: box(strip), tabs, markers, overflow }
})

/** The layout invariants the owner's screenshot broke. Returns a list of violations. */
const violations = ({ tabs, markers }) => {
  const out = [], slack = 0.75
  const sorted = [...tabs].sort((a, b) => a.box.left - b.box.left)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], next = sorted[i]
    if (next.box.left < prev.box.right - slack) out.push(`tab "${next.title}" starts ${(prev.box.right - next.box.left).toFixed(1)}px inside "${prev.title}"`)
  }
  for (const tab of tabs) for (const child of tab.children) {
    if (child.box.left < tab.box.left - slack || child.box.right > tab.box.right + slack) out.push(`"${child.cls}" of "${tab.title}" spans ${child.box.left.toFixed(1)}-${child.box.right.toFixed(1)} outside its tab ${tab.box.left.toFixed(1)}-${tab.box.right.toFixed(1)}`)
  }
  for (const marker of markers) {
    const tab = tabs.find(entry => entry.id === marker.tabId)
    if (!tab) { out.push(`marker "${marker.text}" has no tab ${marker.tabId}`); continue }
    const b = marker.box, t = tab.box
    if (b.left < t.left - slack || b.right > t.right + slack || b.top < t.top - slack || b.bottom > t.bottom + slack) out.push(`marker "${marker.text}" (${b.left.toFixed(1)}-${b.right.toFixed(1)} x ${b.top.toFixed(1)}-${b.bottom.toFixed(1)}) crosses its tab "${tab.title}" (${t.left.toFixed(1)}-${t.right.toFixed(1)} x ${t.top.toFixed(1)}-${t.bottom.toFixed(1)})`)
    // The band sits above the title line, so it covers no part of the title's text.
    const title = tab.titleBox
    if (title && b.bottom > title.top + slack && b.left < title.right && b.right > title.left) out.push(`marker "${marker.text}" (bottom ${b.bottom.toFixed(1)}) covers the title of "${tab.title}" (top ${title.top.toFixed(1)})`)
  }
  return out
}

let view
try {
  step('launch and open the project')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_TOKEN_BURN_MS: 1000 } })
  await openProject({ name: 'crowded strip', git: true })
  view = await page(inst)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)
  await view.evaluate(() => window.conductor.tokenBurn.setAlertPerHour(5_000_000))
  await inst.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900))

  step('a wizard MAIN dispatches six running coworkers; one leads its own coworker, one burns')
  const wizard = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Wizard: Conductor + miron rosin watch' })
  await view.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true, model: 'claude-fable-5-1' })
  }, wizard.resourceId)
  const wizardAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: wizard.resourceId, prompt: 'CROWDED plan the V46 rejection work' }))
  await settledAs(wizard.resourceId, 'completed', 'wizard')
  const coworkers = []
  const titles = ['V46 rejection inclusion', 'V43 rejection include owner', 'V42 rejection Opus B', 'V46 rejection Fable follow-up', 'V39 rejection audit', 'V37 audit burn']
  let lead, leadAuth, burner
  for (const [index, title] of titles.entries()) {
    const tab = await tabCall(wizardAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title })
    const prompt = index === titles.length - 1 ? 'CROWDED BURN ' + title : 'CROWDED HOLD ' + title
    if (index === 0) { leadAuth = await credentialAfter(() => tabCall(wizardAuth, 'agents.submit', { agentSessionId: tab.resourceId, prompt })); lead = tab }
    else await tabCall(wizardAuth, 'agents.submit', { agentSessionId: tab.resourceId, prompt })
    if (index === titles.length - 1) burner = tab
    coworkers.push(tab)
  }
  const grandchild = await tabCall(leadAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title: 'V46 inclusion helper' })
  await tabCall(leadAuth, 'agents.submit', { agentSessionId: grandchild.resourceId, prompt: 'CROWDED HOLD helper' })
  for (const tab of [...coworkers.filter(tab => tab !== burner), grandchild]) await settledAs(tab.resourceId, 'running', tab.title)
  // The burn turn ends (a usage cap may stop it); viewing it once keeps a finished tab in the strip.
  await poll(async () => !['starting', 'running'].includes(await phaseOf(burner.resourceId)), { timeoutMs: 45_000, label: 'burn turn settled' })
  await call('tabs.focus', { tabId: burner.id })
  await poll(async () => await view.locator('.pane-tab.active[data-control-tab-id="' + burner.id + '"]').count() === 1, { timeoutMs: 15_000, label: 'burner tab shown' })

  step('the owner opens seven more tabs')
  const plain = []
  for (const title of ['free-hand notes', 'owner review', '(continued) relay', '(continued) phone', 'V33 audit', 'V35 audit', 'miron rosin watch']) plain.push(await openTab({ provider: 'claude', model: 'synthetic-claude', title }))
  await call('tabs.focus', { tabId: wizard.id })
  const total = 1 + coworkers.length + 1 + plain.length
  record('setup', 'INFO', { tabs: total, coworkers: coworkers.length + 1 }, `wizard ${wizard.id}; lead ${lead.id} leads ${grandchild.id}; burner ${burner.id}`)

  step('the burn alert reaches the burner tab')
  const burnBadge = view.locator(`.pane-tab[data-control-tab-id="${burner.id}"] .pane-tab-burn`)
  await poll(async () => await burnBadge.count() > 0, { timeoutMs: 30_000, label: 'burn badge on the burner tab' })
  await poll(async () => (await measure(view)).markers.length >= 1 + coworkers.length + 1, { timeoutMs: 20_000, label: 'role markers on every linked tab' })
  await view.waitForTimeout(1500)

  for (const [width, name] of [[1600, 'wide'], [1100, 'narrow']]) {
    step(`S1 ${width}px window: tabs, contents and markers stay in their own boxes`)
    await inst.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 900), width)
    await view.waitForTimeout(800)
    const layout = await measure(view)
    const bad = violations(layout)
    const file = await shot(`tab-strip-crowded-${name}`)
    assert.deepEqual(bad, [], `${width}px: ${bad.join('; ')}`)
    assert.match(layout.overflow, /^\+\d+$/, `the strip lists what has no room in "+N" (got "${layout.overflow}")`)
    const roles = layout.markers.map(marker => marker.text)
    assert.ok(roles.some(text => /^MAIN\d*$/.test(text)), 'MAIN marker: ' + JSON.stringify(roles))
    assert.ok(roles.filter(text => text === 'COWORKER').length >= 3, 'COWORKER markers: ' + JSON.stringify(roles))
    assert.ok(layout.tabs.find(tab => tab.id === burner.id)?.burn, 'the burner tab carries its flame')
    record(`S1-${name}`, 'PASS', { tabs: layout.tabs.length, markers: layout.markers.length, overflow: layout.overflow, stripWidth: Math.round(layout.strip.width) }, `no tab overlaps the next, every child and marker (${[...new Set(roles)].join(', ')}) inside its own tab; ${file}`)
  }

  step('S2 the burn alert does not change the tab geometry')
  await inst.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900))
  await call('tabs.focus', { tabId: burner.id })
  await view.locator(`.pane-tab[data-control-tab-id="${burner.id}"]`).evaluate(node => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  await view.waitForTimeout(800)
  const burning = await measure(view)
  assert.deepEqual(violations(burning), [])
  await shot('tab-strip-crowded-burning-active')
  await view.evaluate(() => window.conductor.tokenBurn.setAlertPerHour(20_000_000))
  await poll(async () => await burnBadge.count() === 0, { timeoutMs: 20_000, label: 'burn badge cleared' })
  await view.waitForTimeout(500)
  const calm = await measure(view)
  const widths = layout => layout.tabs.map(tab => [tab.id, Math.round(tab.box.width * 10) / 10])
  assert.deepEqual(widths(burning), widths(calm), 'every tab keeps its width when the flame goes away')
  record('S2', 'PASS', { burnerWidth: burning.tabs.find(tab => tab.id === burner.id)?.box.width }, 'the active burner and every other tab have identical widths with and without the burn flame')

  step('S3 focusing a tab off the strip brings it fully into view, without focusing the window')
  const windowFocused = () => inst.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())
  const focusedBefore = await windowFocused()
  const stripState = () => view.evaluate(() => {
    const strip = document.querySelector('.pane-tabs'), bounds = strip.getBoundingClientRect()
    const tabs = [...strip.querySelectorAll('.pane-tab[data-control-tab-id]')].map(node => { const r = node.getBoundingClientRect(); return { id: node.dataset.controlTabId, active: node.classList.contains('active'), left: r.left, right: r.right, inside: r.left >= bounds.left - 0.5 && r.right <= bounds.right + 0.5 } })
    return { scrollLeft: strip.scrollLeft, tabs, overflow: document.querySelector('.pane-overflow-button')?.textContent ?? '' }
  })
  const revealed = (tabId, label) => poll(async () => { const state = await stripState(); const tab = state.tabs.find(entry => entry.id === tabId); return tab?.active && tab.inside ? state : null }, { timeoutMs: 5000, intervalMs: 100, label })
  await call('tabs.focus', { tabId: wizard.id })
  await revealed(wizard.id, 'the wizard shown at the start of the strip')
  const before = await stripState()
  const last = [...before.tabs].sort((a, b) => b.left - a.left).find(tab => !tab.inside)
  assert.ok(last, 'a tab sits off the strip: ' + JSON.stringify(before.tabs.map(tab => [tab.id, tab.inside])))
  const startedAt = Date.now()
  await call('tabs.focus', { tabId: last.id })
  const afterFocus = await revealed(last.id, 'tabs.focus revealed the last off-strip tab')
  const revealMs = Date.now() - startedAt
  await shot('tab-strip-crowded-focus-revealed')
  record('S3-tabs.focus', 'PASS', { scrollLeft: Math.round(afterFocus.scrollLeft), ms: revealMs, overflow: afterFocus.overflow }, `the last off-strip tab ${last.id} is active and fully inside the strip after tabs.focus`)

  // Already active, scrolled away by hand: focusing it again changes no layout and still reveals it.
  await view.evaluate(() => { document.querySelector('.pane-tabs').scrollLeft = 0 })
  await poll(async () => !(await stripState()).tabs.find(tab => tab.id === last.id)?.inside, { timeoutMs: 3000, label: 'scrolled away from the active tab' })
  await call('tabs.focus', { tabId: last.id })
  await revealed(last.id, 'tabs.focus revealed the already-active tab')
  record('S3-already-active', 'PASS', {}, 'tabs.focus on the active tab that the strip had scrolled away from brings it back into view')

  // The sidebar: another off-strip tab, picked from its row.
  await view.evaluate(() => { document.querySelector('.pane-tabs').scrollLeft = 0 })
  const offStrip = (await poll(async () => { const state = await stripState(); return state.scrollLeft === 0 ? state : null }, { timeoutMs: 3000, label: 'strip at its start' })).tabs.filter(tab => !tab.inside && tab.id !== last.id)
  const sidebarTarget = []
  for (const tab of offStrip) if (await view.locator(`.session-tree [data-clarity-row="${tab.id}"] .workspace-tab-select`).count()) { sidebarTarget.push(tab); break }
  assert.ok(sidebarTarget.length, 'an off-strip tab has a sidebar row')
  await view.locator(`.session-tree [data-clarity-row="${sidebarTarget[0].id}"] .workspace-tab-select`).click()
  await revealed(sidebarTarget[0].id, 'the sidebar row revealed its tab')
  record('S3-sidebar', 'PASS', {}, `selecting ${sidebarTarget[0].id} in the sidebar brings its off-strip tab fully into view`)

  assert.equal(await windowFocused(), focusedBefore, 'revealing tabs never changes whether the parked window has focus')
  record('S3-window-focus', 'PASS', { focused: focusedBefore }, 'the parked window kept its focus state through every reveal')

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
