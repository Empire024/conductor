// VR3 group A (docs/verification/2026-09-25-vr3.md): local-models-save-tokens.
//   A1  S11: the "saved ~N tokens" figure is in app control (usage.limits.localSavings) and equals the Usage view's.
//   A2  RV1 A2: run_and_summarize with no timeoutSec returns early and still kills its command at 600 s
//       (a self-excluding process query, verify-kit processAlive); plus S13b: prepare-deps through the
//       tool is refused and creates no Docker volume.
// The conductor-local tools are called on the tab's own loopback MCP endpoint, like
// scripts/smoke-local-assist-savings-control.mjs; no local model is needed (short outputs).
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr3-local-assist.mjs
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'
// --only-a1 re-runs A1 alone (A2 waits out the 600 s bound).
const ONLY_A1 = process.argv.includes('--only-a1')
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, processAlive, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))
configure({ name: 'vr3-local-assist', output: process.env.VR3_OUT ?? 'artifacts/verification/2026-09-25-vr3' })
watchdog(18 * 60)
await loadCheck()

const DAY = 86_400_000
const dockerVolumes = () => { const run = spawnSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }); return run.status === 0 ? run.stdout.split(/\r?\n/).filter(Boolean) : null }
const saved = (raw, returned) => Math.max(0, Math.round(raw / 4 - returned / 4))
const textOf = result => (result?.result?.content ?? []).map(part => part.text ?? '').join('\n') + (result?.error ? JSON.stringify(result.error) : '')

try {
  const mcpBefore = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('conductor-local-mcp-')))
  const inst = await launchParked({ mode: 'playwright' })
  const project = await openProject({ name: 'VR3 local assist', files: { 'README.md': '# VR3 local assist\n' } })
  const model = (await call('models.list')).find(entry => entry.provider === 'claude')?.models?.[0]?.id
  step('open an Auto Claude tab')
  const tab = await openTab({ provider: 'claude', model, permission: 'auto', exactPermission: true, title: 'VR3 local assist' })
  const tabId = tab.resourceId
  await call('agents.submit', { agentSessionId: tabId, prompt: 'SYNTHETIC LONG 4' })
  await poll(async () => { const status = await call('agents.status', { agentSessionId: tabId }); return ['completed', 'failed', 'interrupted', 'idle'].includes(status.phase) ? status : null }, { timeoutMs: 60_000, label: 'the fixture turn to settle' })
  const configFile = await poll(() => {
    for (const dir of readdirSync(tmpdir()).filter(name => name.startsWith('conductor-local-mcp-') && !mcpBefore.has(name))) {
      const file = join(tmpdir(), dir, `${tabId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
      if (existsSync(file)) return file
    }
    return null
  }, { timeoutMs: 60_000, label: 'the conductor-local MCP config of the tab' })
  const server = JSON.parse(readFileSync(configFile, 'utf8')).mcpServers['conductor-local']
  let rpcId = 0
  const tool = async (name, args) => {
    const response = await fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) })
    return response.json()
  }

  let defaultCall = null, started = Date.now()
  const marker = `VR3A2SLEEP${Date.now()}`
  // ---- A2 part 1: the default call (no timeoutSec) on a 700 s sleeper. Started first; checked at 615 s.
  if (!ONLY_A1) step('A2 start the default-bound sleeper')
  if (!ONLY_A1) defaultCall = tool('run_and_summarize', { command: `node -e "setTimeout(()=>{},700000)" ${marker}` }).then(result => ({ result, ms: Date.now() - started }), error => ({ error: String(error), ms: Date.now() - started }))

  // ---- A1: savings figure in control equals the Usage view's.
  try {
    step('A1 seed the ledger')
    const ledger = join(inst.profile, 'local-assist', 'savings.jsonl')
    const now = Date.now()
    const base = { tool: 'local_ask', projectId: project.id, agentSessionId: tabId, provider: 'claude', localInputTokens: 10_000, localOutputTokens: 100, usedModel: true, model: 'local/qwen3.6-35b-a3b' }
    const seeds = [1, 2, 3].map(days => ({ ...base, at: new Date(now - days * DAY).toISOString(), rawChars: 40_000, returnedChars: 400 }))
    const stale = { ...base, at: new Date(now - 10 * DAY).toISOString(), rawChars: 400_000, returnedChars: 0 }
    const beforeLimits = (await call('usage.limits')).localSavings
    mkdirSync(join(inst.profile, 'local-assist'), { recursive: true })
    for (const entry of [...seeds, stale]) appendFileSync(ledger, JSON.stringify(entry) + '\n')
    step('A1 one real call')
    const echo = await tool('run_and_summarize', { command: 'echo vr3 savings figure', timeoutSec: 30 })
    const lines = readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    const real = lines.filter(entry => new Date(entry.at).getTime() > now - DAY && entry.tool === 'run_and_summarize')
    const expected = (beforeLimits?.tokensSaved ?? 0) + 3 * saved(40_000, 400) + real.reduce((sum, entry) => sum + saved(entry.rawChars ?? 0, entry.returnedChars ?? 0), 0)
    const control = (await call('usage.limits')).localSavings
    const view = await page(inst)
    await view.reload()
    await view.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 })
    const uiText = (await view.locator('.weekly-usage-local').first().textContent({ timeout: 30_000 }))?.trim() ?? ''
    const controlLabel = await view.evaluate(value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value), control?.tokensSaved ?? -1)
    const uiShot = await shot('A1-usage-view')
    const ok = control && control.tokensSaved === expected && uiText.includes(`saved ≈ ${controlLabel} tokens`) && control.calls === (beforeLimits?.calls ?? 0) + 3 + real.length && real.length >= 1
    record('A1', ok ? 'PASS' : 'FAIL', { controlTokensSaved: control?.tokensSaved, expected, controlCalls: control?.calls, realCalls: real.length, staleExcluded: (control?.tokensSaved ?? 0) < 100_000 }, `ui "${uiText}" vs control label ${controlLabel}; echo -> ${textOf(echo).slice(0, 120)}; ${uiShot}; control: the 10-day-old line (100k saved) is excluded from both`)
  } catch (error) { await failed(error, 'A1') }

  if (ONLY_A1) await finish()
  // ---- A2 part 2: an explicit timeoutSec is the kill bound (the neighbour of the default path).
  const shortMarker = `VR3A2SHORT${Date.now()}`
  let shortResult = null
  try {
    step('A2 timeoutSec 30 sleeper')
    const shortStart = Date.now()
    const result = await tool('run_and_summarize', { command: `node -e "setTimeout(()=>{},700000)" ${shortMarker}`, timeoutSec: 30 })
    await sleep(5000)
    shortResult = { seconds: Math.round((Date.now() - shortStart) / 1000), alive: await processAlive(shortMarker), text: textOf(result).slice(0, 200) }
  } catch (error) { shortResult = { error: String(error) } }

  // ---- S13b: prepare-deps through the agent's tool is refused and creates no volume.
  let deps = null
  try {
    step('A2 S13b prepare-deps through run_and_summarize')
    const volumesBefore = dockerVolumes()
    const cli = join(REPO, 'scripts', 'local-models', 'cli.ts').replace(/\\/g, '/')
    const refused = await tool('run_and_summarize', { command: `node --experimental-transform-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "${cli}" prepare-deps --cwd "${project.path.replace(/\\/g, '/')}"`, timeoutSec: 120 })
    const neighbour = await tool('run_and_summarize', { command: 'node --version', timeoutSec: 30 })
    const volumesAfter = dockerVolumes()
    const added = volumesBefore && volumesAfter ? volumesAfter.filter(name => !volumesBefore.includes(name)) : null
    deps = { refusedText: textOf(refused), neighbourText: textOf(neighbour).slice(0, 160), newVolumes: added, docker: volumesBefore != null }
  } catch (error) { deps = { error: String(error) } }

  // ---- A2 part 3: at 130 s the default sleeper is still alive (the query sees it); at 615 s it is gone.
  step('A2 wait for the early return')
  const early = await defaultCall
  const earlyText = textOf(early.result)
  await sleep(Math.max(0, started + 130_000 - Date.now()))
  const aliveAt130 = await processAlive(marker)
  step('A2 wait for the 600 s bound')
  await sleep(Math.max(0, started + 615_000 - Date.now()))
  const aliveAt615 = await processAlive(marker)
  const stillRunning = early.result?.result?.structuredContent?.stillRunning ?? /still running/i.test(earlyText)
  const refusedOk = deps && !deps.error && /interactive terminal|owner/i.test(deps.refusedText) && !/exit(ed)?( code)? 0\b/i.test(deps.refusedText) && /v\d+\.\d+/.test(deps.neighbourText) && (deps.newVolumes == null || deps.newVolumes.length === 0)
  const ok = stillRunning && early.ms < 150_000 && aliveAt130 && !aliveAt615 && shortResult && !shortResult.alive && refusedOk
  record('A2', ok ? 'PASS' : 'FAIL', { earlyReturnS: Math.round(early.ms / 1000), stillRunning: Boolean(stillRunning), aliveAt130, aliveAt615, short: { seconds: shortResult?.seconds, alive: shortResult?.alive }, s13bNewVolumes: deps?.newVolumes, docker: deps?.docker }, `early: ${earlyText.slice(0, 160)} | short: ${shortResult?.text ?? shortResult?.error} | prepare-deps: ${(deps?.refusedText ?? deps?.error ?? '').slice(-260)} | node --version: ${deps?.neighbourText}`)
} catch (error) { await failed(error) }
await finish()
