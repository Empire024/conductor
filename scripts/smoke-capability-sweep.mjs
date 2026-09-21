// Capability sweep in the real Conductor window, parked off-screen (CONDUCTOR_TEST_USER_DATA), with
// a throwaway profile. For every model a provider advertises it records what the composer shows
// (label, effort choices, effort position), what View usage shows (context window, usage figures)
// and takes a screenshot. Requires `npm.cmd run build` first.
//
//   node scripts/smoke-capability-sweep.mjs                 offline: synthetic fixtures mirroring the
//                                                           2026-09-21 CLI catalogs, plus context,
//                                                           compaction and unknown-metadata states
//   node scripts/smoke-capability-sweep.mjs --live          the installed CLIs, discovery only: no
//                                                           prompt reaches a model
//   node scripts/smoke-capability-sweep.mjs --live --turns  one one-word prompt per advertised model
//                                                           family, counted and recorded (real
//                                                           inference on the owner's accounts)
//   --local                                                 also open the default local model tab,
//                                                           only when its server already answers
//
// The offline run builds a temporary copy of `out/` next to a fixtures folder that holds the two
// swarm-capabilities fixtures under the names the production factory resolves, so the production
// adapters, store and renderer run unchanged and no protected file is edited.
import { _electron as electron, expect } from '@playwright/test'
import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const m = /^--([^=]+)(?:=(.*))?$/.exec(arg); return m ? [m[1], m[2] ?? true] : [arg, true] }))
const live = Boolean(args.live)
const turns = live && Boolean(args.turns)
const includeLocal = Boolean(args.local)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = live ? (turns ? 'live-turns' : 'live') : 'offline'
const output = resolve(String(args.out ?? 'artifacts/swarm-2026-09-21/capabilities'), 'smoke-' + mode)
mkdirSync(output, { recursive: true })
if (!existsSync(join(repo, 'out/main/index.js'))) throw new Error('Run npm.cmd run build first')

const root = await mkdtemp(join(tmpdir(), 'conductor-capability-sweep-'))
let entry = join(repo, 'out/main/index.js')
if (!live) {
  // Production factory resolves fixtures at out/main/../../scripts/fixtures/fake-<provider>.mjs.
  const tree = join(root, 'app')
  cpSync(join(repo, 'out'), join(tree, 'out'), { recursive: true })
  cpSync(join(repo, 'package.json'), join(tree, 'package.json'))
  mkdirSync(join(tree, 'scripts/fixtures'), { recursive: true })
  cpSync(join(repo, 'scripts/fixtures/swarm-capabilities-claude.mjs'), join(tree, 'scripts/fixtures/fake-claude.mjs'))
  cpSync(join(repo, 'scripts/fixtures/swarm-capabilities-codex.mjs'), join(tree, 'scripts/fixtures/fake-codex.mjs'))
  symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'junction')
  entry = join(tree, 'out/main/index.js')
}
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
if (live) delete env.CONDUCTOR_OFFLINE_TESTS; else env.CONDUCTOR_OFFLINE_TESTS = '1'

const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex' }
const TEXTBOX = { claude: 'Message Claude Code', codex: 'Message Codex', local: 'Message Local model' }
const results = { mode, synthetic: !live, startedAt: new Date().toISOString(), inferenceTurns: 0, providers: {}, checks: [], failures: [], screenshots: [] }
const app = await electron.launch({ args: [entry], env, timeout: 30_000 })
const page = await app.firstWindow()
page.setDefaultTimeout(30_000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const snapshot = id => page.evaluate(id => window.conductor.structured.snapshot(id), id)
const shot = async (name, locator) => { const path = join(output, name + '.png'); await (locator ?? page).screenshot({ path }); results.screenshots.push(path); return path }
const check = text => { results.checks.push(text); console.log('✓ ' + text) }

async function openTab(provider, buttonText) {
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').first().click()
  if (!await page.locator('.launcher-grid').count()) await page.locator('.session-add').click()
  await page.locator('.launcher-grid button').filter({ hasText: buttonText }).first().click()
  // The composer is labelled "Message <runtime name>"; the local runtime is named after its model.
  const textbox = provider === 'local' ? page.getByRole('textbox', { name: /^Message / }).last() : page.getByRole('textbox', { name: TEXTBOX[provider], exact: true })
  await expect(textbox).toBeVisible()
  const pane = page.locator('.structured-agent-pane', { has: textbox }).last()
  const id = await pane.getAttribute('data-structured-session')
  if (!id) throw new Error('No structured session for ' + provider)
  return { id, pane }
}

/** What the composer control line shows right now. */
async function readControls(pane) {
  const combobox = pane.getByRole('combobox', { name: 'Model', exact: true })
  const slider = pane.getByRole('slider', { name: 'Reasoning effort', exact: true })
  const unavailable = pane.locator('.sa-effort-unavailable')
  const ring = pane.locator('.sa-context-circle')
  // Read in one pass from whatever is in the DOM right now: the ring and the working-token
  // counter appear and vanish with usage reports, so a count followed by a read can race.
  const [sliders, unavailables, rings, liveTokens] = await Promise.all([
    slider.evaluateAll(nodes => nodes.map(node => ({ positions: Number(node.getAttribute('max')) + 1, value: node.getAttribute('aria-valuetext'), ticks: node.closest('.agent-effort-slider')?.querySelectorAll('.agent-effort-ticks i').length ?? 0 }))),
    unavailable.evaluateAll(nodes => nodes.map(node => ({ unavailable: node.textContent?.trim() }))),
    ring.evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), level: node.className.replace(/.*level-/, '') }))),
    pane.locator('.sa-live-tokens').evaluateAll(nodes => nodes.map(node => node.textContent?.trim() ?? null))
  ])
  return {
    label: (await combobox.textContent())?.trim() ?? null,
    title: await combobox.getAttribute('title'),
    effortControl: sliders[0] ?? unavailables[0] ?? null,
    contextRing: rings[0] ?? null,
    liveTokens: liveTokens[0] ?? null
  }
}
/** Open View usage, read the figures that matter, screenshot, close. */
async function readUsage(pane, name) {
  await pane.getByRole('button', { name: 'View usage', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const text = await dialog.innerText()
  const shotPath = await shot(name, dialog)
  await page.getByRole('button', { name: 'Close Usage', exact: true }).click()
  const pick = (label) => new RegExp(label + '\\s*\\n?\\s*([^\\n]+)').exec(text)?.[1]?.trim() ?? null
  return { model: pick('Conversation model'), contextWindow: pick('Model context window'), context: /Context window\s*\n?\s*([^\n]+)/.exec(text)?.[1]?.trim() ?? null, accountLimits: text.includes('Account limits have not been reported') ? 'not reported' : 'reported', screenshot: shotPath, text }
}
async function chooseModel(pane, query) {
  const combobox = pane.getByRole('combobox', { name: 'Model', exact: true })
  await combobox.click()
  const search = pane.getByRole('textbox', { name: 'Search models', exact: true })
  await search.fill(query)
  // The picker filters on label and id together; an option only shows its label, so the id is
  // typed into the search and Enter takes the first match, the way the composer is used.
  if (await pane.getByRole('option').count() === 0) { await page.keyboard.press('Escape'); return false }
  await search.press('Enter')
  await expect(combobox).toBeFocused()
  return true
}
async function sendTurn(id, prompt, settings, viaComposer = false) {
  const before = await snapshot(id)
  if (viaComposer) {
    const pane = page.locator(`.structured-agent-pane[data-structured-session="${id}"]`)
    await pane.getByRole('textbox', { name: /^Message / }).fill(prompt)
    await pane.getByRole('button', { name: 'Send message', exact: true }).click()
  } else await page.evaluate(async ({ id, prompt, settings }) => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    // Saved first so the composer shows the model the turn runs on, as a picker choice would.
    await window.conductor.structured.saveSettings(id, { ...state.settings, ...settings })
    await window.conductor.structured.submit(id, prompt, { ...state.settings, ...settings }, [])
  }, { id, prompt, settings })
  await expect.poll(async () => (await snapshot(id)).phase, { timeout: live ? 300_000 : 30_000, intervals: [300, 1000, 2000] }).toMatch(/^(completed|failed|disconnected)$/)
  const after = await snapshot(id)
  const items = after.items.filter(item => (item.updatedSequence ?? item.sequence) > before.sequence && !item.parentId)
  const usage = items.filter(item => item.data.type === 'usage')
  const context = [...after.items].reverse().find(item => !item.parentId && item.data.type === 'usage' && item.data.limits && 'contextUsedTokens' in item.data.limits)
  const message = usage.find(item => item.data.scope === 'message')
  const session = usage.filter(item => item.data.scope === 'session').at(-1)
  const notices = items.filter(item => item.data.type === 'notice').map(item => item.data.message)
  return {
    phase: after.phase, reply: items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('').trim().slice(0, 80),
    errors: items.filter(item => item.data.type === 'error').map(item => item.data.message), notices,
    effectiveSettings: after.capabilities?.effectiveSettings ?? null,
    limits: context?.data.limits ?? null,
    firstCall: message ? { context: message.data.inputTokens, cached: message.data.cachedTokens, cacheWrite: message.data.cacheCreationTokens, output: message.data.outputTokens } : undefined,
    sessionTotals: session ? { input: session.data.inputTokens, cached: session.data.cachedTokens, output: session.data.outputTokens, total: session.data.totalTokens } : undefined
  }
}

async function sweepProvider(provider) {
  const report = { models: [], turns: [] }
  results.providers[provider] = report
  const { id, pane } = await openTab(provider, PROVIDER_LABEL[provider])
  report.beforeDiscovery = await readControls(pane)
  report.beforeDiscoveryCapabilities = (await snapshot(id)).capabilities ?? null
  await shot(`${provider}-00-before-discovery`)
  check(`${provider}: before discovery the composer shows "${report.beforeDiscovery.label}" with ${report.beforeDiscovery.effortControl ? 'an effort control' : 'no effort control'} (no runtime was started)`)
  // Opening the picker is what triggers metadata discovery: initialize for Claude, thread/start +
  // model/list for Codex. Neither sends a prompt.
  await pane.getByRole('combobox', { name: 'Model', exact: true }).click()
  await expect.poll(async () => (await snapshot(id)).capabilities?.models?.length ?? 0, { timeout: live ? 120_000 : 30_000 }).toBeGreaterThan(0)
  await expect(pane.getByRole('option').first()).toBeVisible()
  report.pickerOptions = await pane.getByRole('option').allTextContents()
  await shot(`${provider}-01-model-picker`)
  await page.keyboard.press('Escape')
  const state = await snapshot(id)
  report.capabilities = state.capabilities
  report.runtimeVersion = state.capabilities?.runtimeVersion ?? null
  check(`${provider}: discovery reported ${state.capabilities.models.length} models, runtime ${report.runtimeVersion}, without a prompt`)
  for (const model of state.capabilities.models) {
    if (model.id === 'default') continue
    const chosen = await chooseModel(pane, model.id)
    const controls = chosen ? await readControls(pane) : null
    const settings = (await snapshot(id)).settings
    const efforts = (model.effort ?? state.capabilities.effort ?? []).filter(effort => effort !== 'auto')
    const entry = { id: model.id, catalogLabel: model.label, catalogEfforts: model.effort ?? null, defaultEffort: model.defaultEffort ?? null, isDefault: model.isDefault ?? false, pickerFound: chosen, shown: controls, savedSettings: { model: settings.model, effort: settings.effort } }
    if (chosen) {
      entry.screenshot = await shot(`${provider}-model-${model.id.replace(/[^a-z0-9.]+/gi, '_')}`, pane.locator('.sa-composer'))
      const positions = controls.effortControl?.positions ?? 0
      entry.effortMatches = positions === efforts.length
      if (!entry.effortMatches) results.failures.push(`${provider}/${model.id}: composer offers ${positions} effort positions, catalog lists ${efforts.length} (${efforts.join(', ')})`)
    }
    report.models.push(entry)
    console.log(`  ${provider} ${model.id}: label "${controls?.label}" effort ${controls?.effortControl ? controls.effortControl.positions + ' positions, at ' + controls.effortControl.value : 'none'}`)
  }
  check(`${provider}: every advertised model was selectable and its effort ladder matched the catalog (${report.models.filter(m => m.effortMatches).length}/${report.models.filter(m => m.pickerFound).length})`)
  return { id, pane, report }
}

/** One one-word prompt per advertised model family, in the tab that is on screen. Real inference. */
async function runTurns(provider, tab) {
  const families = { claude: ['opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku'], codex: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'] }
  for (const model of families[provider]) {
    const info = tab.report.capabilities.models.find(m => m.id === model)
    if (!info) { tab.report.turns.push({ model, skipped: 'not advertised' }); continue }
    const effort = (info.effort ?? []).includes('low') ? 'low' : undefined
    // Through the composer, as the owner would: pick the model, drag effort to its lowest
    // position, type the one word and press Send. The pane's own state then shows the model the
    // turn ran on; a settings write over IPC would not reach the mounted composer.
    await chooseModel(tab.pane, model)
    if (effort) { const slider = tab.pane.getByRole('slider', { name: 'Reasoning effort', exact: true }); await slider.press('Home'); await expect(slider).toHaveAttribute('aria-valuetext', 'Low') }
    results.inferenceTurns++
    const turn = await sendTurn(tab.id, 'OK', {}, true)
    const controls = await readControls(tab.pane)
    const usage = await readUsage(tab.pane, `${provider}-turn-${model.replace(/[^a-z0-9.]+/gi, '_')}-usage`)
    // What the runtime said about itself once a turn ran: Claude's system/init (model, effort,
    // tools, MCP servers, version), read back from the adapter without another runtime call.
    const discovered = await page.evaluate(id => window.conductor.structured.discover(id), tab.id).catch(() => null)
    const init = discovered?.configuration ?? null
    tab.report.turns.push({ prompt: 'OK', model, effort, ...turn, shown: controls, usage: { model: usage.model, contextWindow: usage.contextWindow, context: usage.context, accountLimits: usage.accountLimits }, runtimeInit: init ? { model: init.model, effort: init.effort, permissionMode: init.permissionMode, version: init.claude_code_version, tools: init.tools, mcpServers: init.mcp_servers, capabilities: init.capabilities } : null })
    console.log(`  turn ${results.inferenceTurns}: ${provider} ${model} ${effort ?? ''} → ${turn.phase}; window ${turn.limits?.modelContextWindow ?? '?'}, used ${turn.limits?.contextUsedTokens ?? '?'}, capacity ${turn.limits?.contextCapacityTokens ?? '?'}; reply "${turn.reply}"`)
  }
  check(`${provider}: ${families[provider].length} one-word turns recorded context window, usage and the composer state per model family`)
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  await page.evaluate(() => window.conductor.projects.create('Capability sweep'))

  // ----------------------------------------------------------------------------------- Claude
  const claude = await sweepProvider('claude')
  if (!live) {
    // Context window learned from the first result, the ring against usable capacity, then a
    // compaction boundary that clears the old figure. Sonnet: 1M window in the fixture.
    let turn = await sendTurn(claude.id, 'SYNTHETIC CONTEXT 700000', { model: 'sonnet', effort: 'low' })
    claude.report.turns.push({ prompt: 'SYNTHETIC CONTEXT 700000', model: 'sonnet', ...turn })
    expect(turn.limits?.modelContextWindow).toBe(1_000_000)
    expect(turn.limits?.contextCapacityTokens).toBe(1_000_000 - 64_000 - 13_000)
    await expect(claude.pane.locator('.sa-context-circle')).toHaveAttribute('aria-label', 'Context 75% used')
    let controls = await readControls(claude.pane)
    expect(controls.contextRing?.level).toBe('warning')
    await shot('claude-10-context-75')
    let usage = await readUsage(claude.pane, 'claude-11-usage-sonnet-1m')
    expect(usage.contextWindow).toBe('1,000,000 tokens')
    check(`claude: after one turn on Sonnet the ring shows ${controls.contextRing.label} and View usage shows a 1,000,000-token window (${usage.context})`)
    turn = await sendTurn(claude.id, 'SYNTHETIC COMPACT', { model: 'sonnet', effort: 'low' })
    claude.report.turns.push({ prompt: 'SYNTHETIC COMPACT', model: 'sonnet', ...turn })
    expect(turn.notices.some(text => /compacted/i.test(text))).toBe(true)
    await expect(claude.pane.locator('.sa-context-circle')).toHaveCount(0)
    controls = await readControls(claude.pane)
    await shot('claude-12-after-compaction')
    usage = await readUsage(claude.pane, 'claude-13-usage-after-compaction')
    check(`claude: the compaction boundary raised the reset notice, cleared the ring and View usage now shows ${usage.context}`)
    turn = await sendTurn(claude.id, 'SYNTHETIC CONTEXT 150000', { model: 'haiku', effort: undefined })
    claude.report.turns.push({ prompt: 'SYNTHETIC CONTEXT 150000', model: 'haiku', ...turn })
    expect(turn.limits?.modelContextWindow).toBe(200_000)
    await expect(claude.pane.locator('.sa-context-circle')).toHaveAttribute('aria-label', 'Context 100% used')
    controls = await readControls(claude.pane)
    expect(controls.contextRing?.level).toBe('critical'); expect(controls.effortControl).toBeNull()
    await shot('claude-14-haiku-critical')
    usage = await readUsage(claude.pane, 'claude-15-usage-haiku')
    expect(usage.contextWindow).toBe('200,000 tokens')
    check(`claude: switching to Haiku reset the window to 200,000, the ring is ${controls.contextRing.label} (${controls.contextRing.level}) and there is no effort control`)
    // The account default: the fixture answers the way the live CLI did (message model without
    // the [1m] suffix, modelUsage keyed with it). Recorded, not asserted: today the window is not
    // learned (parity ledger R14); once repaired this line reports 1,000,000.
    turn = await sendTurn(claude.id, 'SYNTHETIC CONTEXT 100000', { model: 'opus[1m]', effort: 'low' })
    claude.report.turns.push({ prompt: 'SYNTHETIC CONTEXT 100000', model: 'opus[1m]', ...turn })
    await shot('claude-17-opus-1m-window', claude.pane.locator('.sa-composer'))
    check(`claude: on opus[1m] the adapter learned a context window of ${turn.limits?.modelContextWindow ?? 'nothing (R14: message model lacks the [1m] suffix the modelUsage key carries)'}`)
    await chooseModel(claude.pane, 'swarm-unknown-model')
    controls = await readControls(claude.pane)
    await shot('claude-16-unknown-metadata', claude.pane.locator('.sa-composer'))
    check(`claude: a model with no metadata shows as "${controls.label}" with ${controls.effortControl ? 'an effort control' : 'no effort control'}`)
    claude.report.unknownMetadata = controls
  }
  // Turns run while this provider's pane is the visible one; the next sweep opens another workspace.
  if (turns) await runTurns('claude', claude)

  // ------------------------------------------------------------------------------------ Codex
  const codex = await sweepProvider('codex')
  if (!live) {
    let turn = await sendTurn(codex.id, 'synthetic:context 300000', { model: 'gpt-6-astra', effort: 'low' })
    codex.report.turns.push({ prompt: 'synthetic:context 300000', model: 'gpt-6-astra', ...turn })
    expect(turn.limits?.modelContextWindow).toBe(400_000)
    await expect(codex.pane.locator('.sa-context-circle')).toHaveAttribute('aria-label', 'Context 75% used')
    let controls = await readControls(codex.pane)
    await shot('codex-10-context-75')
    let usage = await readUsage(codex.pane, 'codex-11-usage-astra')
    expect(usage.contextWindow).toBe('400,000 tokens')
    check(`codex: after one turn the ring shows ${controls.contextRing.label}; View usage shows ${usage.contextWindow} and account limits ${usage.accountLimits}`)
    turn = await sendTurn(codex.id, 'synthetic:compact', { model: 'gpt-6-astra', effort: 'low' })
    codex.report.turns.push({ prompt: 'synthetic:compact', model: 'gpt-6-astra', ...turn })
    // The adapter emits its "compacted" reset notice and the item's generic notice under the same
    // item id, so the timeline keeps whichever arrived last; either text proves the item reached
    // the projection. The recorded notice texts show which one survived.
    expect(turn.notices.some(text => /compact/i.test(text))).toBe(true)
    codex.report.compactionNotices = turn.notices
    await expect(codex.pane.locator('.sa-context-circle')).toHaveCount(0)
    controls = await readControls(codex.pane)
    await shot('codex-12-after-compaction')
    usage = await readUsage(codex.pane, 'codex-13-usage-after-compaction')
    check(`codex: compaction raised the reset notice, cleared the ring; View usage shows ${usage.context}`)
    await chooseModel(codex.pane, 'swarm-plain')
    controls = await readControls(codex.pane)
    expect(controls.effortControl).toBeNull()
    await shot('codex-14-effortless-model', codex.pane.locator('.sa-composer'))
    check(`codex: an effort-less model shows as "${controls.label}" with no effort control`)
    codex.report.unknownMetadata = controls
  }
  if (turns) await runTurns('codex', codex)


  // ------------------------------------------------------------------------------------ Local
  if (includeLocal) {
    const config = await import(pathToFileURL(join(repo, 'src/main/local-models/config.ts')).href)
    let healthy = false
    let model
    try {
      const stack = config.loadConfig()
      model = stack.models[config.DEFAULT_LOCAL_MODEL ?? 'local/qwen3.5-9b'] ?? Object.values(stack.models)[0]
      const response = await fetch(`http://127.0.0.1:${config.recordedPort(model)}/v1/models`, { headers: { Authorization: `Bearer ${config.readApiKey()}` }, signal: AbortSignal.timeout(3000) })
      healthy = response.ok
    } catch { healthy = false }
    if (!healthy) results.providers.local = { skipped: 'the default local model server is not running; opening a tab would start one, which this sweep never does' }
    else {
      const { id, pane } = await openTab('local', 'Qwen 3.5 9B')
      const controls = await readControls(pane)
      const state = await snapshot(id)
      const usage = await readUsage(pane, 'local-usage')
      await shot('local-composer', pane.locator('.sa-composer'))
      results.providers.local = { model: model.id, shown: controls, capabilities: state.capabilities, usage: { contextWindow: usage.contextWindow, context: usage.context, accountLimits: usage.accountLimits } }
      check(`local: the composer shows "${controls.label}" with ${controls.effortControl ? 'an effort control' : 'no effort control'}; View usage reports ${usage.contextWindow ?? 'no context window'}`)
    }
  }
  if (errors.length) throw new Error('Renderer errors: ' + errors.join('\n'))
  if (results.failures.length) throw new Error(results.failures.join('\n'))
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  results.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
console.log(JSON.stringify({ mode, inferenceTurns: results.inferenceTurns, checks: results.checks.length, failures: results.failures, screenshots: results.screenshots.length, output }, null, 2))
