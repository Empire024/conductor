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
//   --local-turn                                            with --local: one one-word prompt to the
//                                                           running local model (real local inference,
//                                                           one request) to record its context figures
//
// The offline run points the production factory (CONDUCTOR_TEST_FIXTURE_DIR) at a temporary folder
// that holds the two swarm-capabilities fixtures under the names it resolves, so the production
// adapters, store and renderer run unchanged from the repository's own `out/`.
import { _electron as electron, expect } from '@playwright/test'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const m = /^--([^=]+)(?:=(.*))?$/.exec(arg); return m ? [m[1], m[2] ?? true] : [arg, true] }))
const live = Boolean(args.live)
const turns = live && Boolean(args.turns)
const includeLocal = Boolean(args.local)
const localTurn = includeLocal && Boolean(args['local-turn'])
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = live ? (turns ? 'live-turns' : 'live') : 'offline'
const output = resolve(String(args.out ?? 'artifacts/swarm-2026-09-21/capabilities'), 'smoke-' + mode)
mkdirSync(output, { recursive: true })
if (!existsSync(join(repo, 'out/main/index.js'))) throw new Error('Run npm.cmd run build first')

const root = await mkdtemp(join(tmpdir(), 'conductor-capability-sweep-'))
const entry = join(repo, 'out/main/index.js')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
if (!live) {
  const fixtures = join(root, 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  cpSync(join(repo, 'scripts/fixtures/swarm-capabilities-claude.mjs'), join(fixtures, 'fake-claude.mjs'))
  cpSync(join(repo, 'scripts/fixtures/swarm-capabilities-codex.mjs'), join(fixtures, 'fake-codex.mjs'))
  env.CONDUCTOR_TEST_FIXTURE_DIR = fixtures
}
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
async function sendTurn(id, prompt, settings, viaComposer = false, timeout = live ? 300_000 : 30_000) {
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
  await expect.poll(async () => (await snapshot(id)).phase, { timeout, intervals: [300, 1000, 2000] }).toMatch(/^(completed|failed|disconnected)$/)
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
  // The pane reads its projection (static capabilities, saved settings) once after mounting; both
  // CLI providers declare a static effort ladder, so the slider marks that read as complete.
  await expect(pane.getByRole('slider', { name: 'Reasoning effort', exact: true })).toBeVisible()
  report.beforeDiscovery = await readControls(pane)
  report.beforeDiscoveryCapabilities = (await snapshot(id)).capabilities ?? null
  await shot(`${provider}-00-before-discovery`)
  check(`${provider}: before discovery the composer shows "${report.beforeDiscovery.label}" with ${report.beforeDiscovery.effortControl ? `an effort control of ${report.beforeDiscovery.effortControl.positions} positions at "${report.beforeDiscovery.effortControl.value}"` : 'no effort control'} (no runtime was started)`)
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
  report.limitations = state.capabilities?.limitations ?? []
  check(`${provider}: discovery reported ${state.capabilities.models.length} models, runtime ${report.runtimeVersion}, without a prompt`)
  // The adapter baselines: Codex 0.153.4 exactly, Claude 2.1.278 since the 2026-09-21 sweep (R9).
  // A runtime on the baseline must not carry the "newer than the fixture-verified" limitation.
  const unverified = report.limitations.filter(text => /newer than the fixture-verified|unverified/i.test(text))
  if (live && ((provider === 'claude' && report.runtimeVersion === '2.1.278') || (provider === 'codex' && /0\.153\.4/.test(report.runtimeVersion ?? '')))) expect(unverified).toEqual([])
  check(`${provider}: runtime ${report.runtimeVersion} carries ${unverified.length ? 'the limitation "' + unverified.join('; ') + '"' : 'no version limitation'}`)
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
    // R7/R4: nothing has chosen an effort, so the runtime was launched without --effort (the CLI
    // applies its own configured level) and the composer says "Account default" instead of a
    // guessed "Medium"; the model stand-in before discovery is the 1M Opus the account defaults to.
    expect(claude.report.beforeDiscovery.label).toBe('Account default')
    expect(claude.report.beforeDiscovery.effortControl?.value).toBe('Account default')
    expect((await snapshot(claude.id)).settings.effort).toBeUndefined()
    const discovered = await page.evaluate(id => window.conductor.structured.discover(id), claude.id)
    const launchArgs = discovered?.initialize?.swarm_launch_args ?? []
    expect(launchArgs).not.toContain('--effort')
    expect(launchArgs[launchArgs.indexOf('--model') + 1]).toBe('opus[1m]')
    claude.report.launchArgs = launchArgs
    check(`claude: before discovery the composer read "Account default" for model and effort, no effort was saved, and the runtime was launched with "${launchArgs.filter((arg, i) => /^--(model|effort)$/.test(launchArgs[i - 1]) || /^--(model|effort)$/.test(arg)).join(' ')}" (no --effort)`)
    // Context window learned from the first result, the ring against usable capacity, then a
    // compaction boundary that clears the old figure. Sonnet: 1M window in the fixture. The model
    // is chosen through the picker the way the owner does it, so the composer state is what the
    // owner would see after the turn (R15: the alias's catalog label, the resolved name as tooltip).
    await chooseModel(claude.pane, 'sonnet')
    let turn = await sendTurn(claude.id, 'SYNTHETIC CONTEXT 700000', {}, true)
    claude.report.turns.push({ prompt: 'SYNTHETIC CONTEXT 700000', model: 'sonnet', ...turn })
    expect(turn.limits?.modelContextWindow).toBe(1_000_000)
    expect(turn.limits?.contextCapacityTokens).toBe(1_000_000 - 64_000 - 13_000)
    await expect(claude.pane.locator('.sa-context-circle')).toHaveAttribute('aria-label', 'Context 75% used')
    let controls = await readControls(claude.pane)
    expect(controls.contextRing?.level).toBe('warning')
    expect(controls.label).toBe('Sonnet')
    expect(controls.title).toContain('Sonnet (claude-sonnet-5)')
    expect(turn.effectiveSettings?.model).toBe('claude-sonnet-5')
    await shot('claude-10-context-75')
    let usage = await readUsage(claude.pane, 'claude-11-usage-sonnet-1m')
    expect(usage.contextWindow).toBe('1,000,000 tokens')
    expect(usage.model).toContain('Sonnet')
    check(`claude: after one turn on Sonnet the ring shows ${controls.contextRing.label}, the composer reads "${controls.label}" (tooltip "${controls.title}") although the runtime resolved ${turn.effectiveSettings?.model}, and View usage shows "${usage.model}" with a 1,000,000-token window (${usage.context})`)
    // Every Claude turn goes through the composer: a settings write over IPC is not seen by the
    // mounted composer (its state is read once at mount), so the controls read afterwards would
    // describe a different model than the turn ran on.
    turn = await sendTurn(claude.id, 'SYNTHETIC COMPACT', {}, true)
    claude.report.turns.push({ prompt: 'SYNTHETIC COMPACT', model: 'sonnet', ...turn })
    expect(turn.notices.some(text => /compacted/i.test(text))).toBe(true)
    await expect(claude.pane.locator('.sa-context-circle')).toHaveCount(0)
    controls = await readControls(claude.pane)
    await shot('claude-12-after-compaction')
    usage = await readUsage(claude.pane, 'claude-13-usage-after-compaction')
    check(`claude: the compaction boundary raised the reset notice, cleared the ring and View usage now shows ${usage.context}`)
    await chooseModel(claude.pane, 'haiku')
    turn = await sendTurn(claude.id, 'SYNTHETIC CONTEXT 150000', {}, true)
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
    // the [1m] suffix, modelUsage keyed with it). R14: the adapter now resolves the suffixed entry,
    // so the window, the capacity and the ring appear on opus[1m] as they do on the other models.
    await chooseModel(claude.pane, 'opus[1m]')
    const opusSlider = claude.pane.getByRole('slider', { name: 'Reasoning effort', exact: true })
    await opusSlider.press('Home'); await expect(opusSlider).toHaveAttribute('aria-valuetext', 'Low')
    turn = await sendTurn(claude.id, 'SYNTHETIC CONTEXT 100000', {}, true)
    claude.report.turns.push({ prompt: 'SYNTHETIC CONTEXT 100000', model: 'opus[1m]', effort: 'low', ...turn })
    expect(turn.effectiveSettings?.effort).toBe('low')
    expect(turn.limits?.modelContextWindow).toBe(1_000_000)
    expect(turn.limits?.contextCapacityTokens).toBe(1_000_000 - 64_000 - 13_000)
    expect(turn.limits?.contextUsedTokens).toBe(100_001)
    controls = await readControls(claude.pane)
    await shot('claude-17-opus-1m-window', claude.pane.locator('.sa-composer'))
    usage = await readUsage(claude.pane, 'claude-18-usage-opus-1m')
    expect(usage.contextWindow).toBe('1,000,000 tokens')
    expect(usage.context).toContain('100,001 / 923,000')
    // The composer ring only paints once usage reaches its warning band; at 11% View usage is the evidence.
    check(`claude: on opus[1m] (message model ${turn.effectiveSettings?.model}, modelUsage keyed claude-opus-5[1m]) the adapter learned a ${turn.limits.modelContextWindow.toLocaleString('en-US')}-token window with ${turn.limits.contextCapacityTokens.toLocaleString('en-US')} usable; View usage shows ${usage.contextWindow} (${usage.context}); composer ring ${controls.contextRing ? controls.contextRing.label : 'not painted below the warning band'}`)
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
    // R12: the static label and the discovered display name read the same ("GPT-6-Astra", as
    // model/list names it), never re-spaced. R1/R2: the pre-discovery ladder is the CLI's union
    // (low … ultra, six positions, no minimal) and Astra's discovered ladder matches it.
    expect(codex.report.beforeDiscovery.label).toBe('GPT-6-Astra')
    expect(codex.report.beforeDiscovery.effortControl?.positions).toBe(6)
    expect(codex.report.pickerOptions).toEqual(expect.arrayContaining(['GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5']))
    expect(codex.report.models.find(model => model.id === 'gpt-6-astra')?.shown?.label).toBe('GPT-6-Astra')
    expect(codex.report.beforeDiscoveryCapabilities?.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    check(`codex: the composer read "${codex.report.beforeDiscovery.label}" with ${codex.report.beforeDiscovery.effortControl?.positions} effort positions before discovery and "${codex.report.models.find(model => model.id === 'gpt-6-astra')?.shown?.label}" after it; the picker lists ${codex.report.pickerOptions.join(', ')}`)
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
    // R11: the "compacted" reset notice and the item's generic notice carry different item ids
    // now, so both survive in the projection and the owner sees that a compaction happened.
    expect(turn.notices).toContain('Codex compacted this conversation; Conductor restates its briefing with the next message.')
    expect(turn.notices).toContain('Codex contextCompaction')
    codex.report.compactionNotices = turn.notices
    await expect(codex.pane.locator('.sa-context-circle')).toHaveCount(0)
    controls = await readControls(codex.pane)
    await shot('codex-12-after-compaction')
    usage = await readUsage(codex.pane, 'codex-13-usage-after-compaction')
    check(`codex: compaction raised both notices (${turn.notices.filter(text => /compact/i.test(text)).map(text => JSON.stringify(text)).join(' and ')}), cleared the ring; View usage shows ${usage.context}`)
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
      // R8: the router and task assignment (agents.listProviders) name a local model the way the
      // launcher tile, the composer and models.list do, from the shared catalog.
      const providers = await page.evaluate(async () => { const api = window.conductor; const list = api.agents?.listProviders ?? api.listProviders ?? api.runtimes?.listProviders; return list ? await list() : null }).catch(() => null)
      const providerLabels = providers?.find(provider => provider.id === 'local')?.models?.map(entry => entry.label) ?? null
      if (providerLabels) expect(providerLabels).toContain(controls.label)
      results.providers.local = { model: model.id, shown: controls, providerLabels, capabilities: state.capabilities, usage: { contextWindow: usage.contextWindow, context: usage.context, accountLimits: usage.accountLimits } }
      check(`local: the composer shows "${controls.label}" with ${controls.effortControl ? 'an effort control' : 'no effort control'}; agents.listProviders names the local models ${providerLabels ? providerLabels.map(label => JSON.stringify(label)).join(', ') : '(not exposed to the renderer)'}; View usage reports ${usage.contextWindow ?? 'no context window'} before a turn`)
      if (localTurn) {
        // R10: one real local request. The window is the configured contextTokens and the capacity
        // holds back the answer reserve, so the ring and "Model context window" work as for the CLIs.
        results.inferenceTurns++
        const turn = await sendTurn(id, 'OK', {}, true, 300_000)
        const after = await readControls(pane)
        const afterUsage = await readUsage(pane, 'local-usage-after-turn')
        await shot('local-composer-after-turn', pane.locator('.sa-composer'))
        expect(turn.limits?.modelContextWindow).toBe(model.contextTokens)
        expect(turn.limits?.contextCapacityTokens).toBe(model.contextTokens - 4096)
        expect(afterUsage.contextWindow).toBe(model.contextTokens.toLocaleString('en-US') + ' tokens')
        results.providers.local.turn = { prompt: 'OK', ...turn, shown: after, usage: { contextWindow: afterUsage.contextWindow, context: afterUsage.context } }
        // The composer ring only paints once usage reaches its warning band; View usage is the evidence.
        check(`local: after one turn (${turn.phase}, ${turn.limits.contextUsedTokens.toLocaleString('en-US')} tokens used) the adapter reported a ${turn.limits.modelContextWindow.toLocaleString('en-US')}-token window with ${turn.limits.contextCapacityTokens.toLocaleString('en-US')} usable; View usage shows ${afterUsage.contextWindow} (${afterUsage.context}); composer ring ${after.contextRing ? after.contextRing.label : 'not painted below the warning band'}`)
      }
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
