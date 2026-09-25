// VR4 R1/R2 (docs/verification/2026-09-25-vr4.md), 22fc5f94 version backup. Owner: "say if we update codex
// CLI and something stops working properly ... we need to be able to, within couple clicks, get back to a
// working version". Fake Claude Code / Codex exes (FX20's fixture: compiled here, version baked in) in a
// fake home; the owner's CLIs are never run, read or changed. Spawn mode, since R2 relaunches.
//   R1  the CLIs update to Claude 2.1.290 / Codex 0.156.0 and delete their old versions; Versions >
//       "Roll back CLIs only" > Confirm; a new Codex tab launches 0.155.1 and a Claude turn runs 2.1.278.
//   R2  "Roll back to this version" (app + CLIs) through the test-mode installer stub: the relaunched app
//       reports the stub's version and new tabs run the recorded CLIs.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr4-rollback.mjs --feed <FX12 feed>
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, page, poll, record, relaunched, shot, sleep, step, watchdog } from './verify-kit.mjs'

const argv = process.argv.slice(2)
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
configure({ name: 'vr4-rollback', output: 'C:/Claude/conductor/artifacts/verification/2026-09-25-vr4' })
watchdog(18 * 60)
await loadCheck()

const root = join(tmpdir(), `vr4-rollback-${process.pid}`)
const home = join(root, 'home'), fixtures = join(root, 'fx')
mkdirSync(home, { recursive: true }); mkdirSync(fixtures, { recursive: true })
const invocations = join(fixtures, 'invocations.log')
writeFileSync(invocations, '')
const script = join(fixtures, 'fake-cli.mjs')
writeFileSync(script, `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const [provider, version, ...args] = process.argv.slice(2)
appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ at: Date.now(), provider, version, args: args.slice(0, 6) }) + '\\n')
if (args.includes('--version')) { process.stdout.write(provider === 'claude' ? version + ' (Claude Code)\\n' : 'codex-cli ' + version + '\\n'); process.exit(0) }
if (provider !== 'claude') process.exit(0)
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'vr4-rollback', parent_tool_use_id: null, ...m })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {} } })
  if (message.type !== 'user') return
  const text = 'Running on Claude Code ' + version + '.'
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: version })
  const id = randomUUID()
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)
const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const literal = value => '@"' + value.replaceAll('"', '""') + '"'
const compile = (provider, version) => {
  const source = join(fixtures, `${provider}-${version}.cs`), exe = join(fixtures, `${provider}-${version}.exe`)
  writeFileSync(source, `using System; using System.Diagnostics; using System.IO; using System.Text; using System.Threading;
class FakeCli {
  static string Quote(string a) { if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\\t', '"' }) < 0) return a; var sb = new StringBuilder("\\""); int bs = 0;
    foreach (char c in a) { if (c == '\\\\') { bs++; continue; } if (c == '"') { sb.Append('\\\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; } sb.Append('\\\\', bs); bs = 0; sb.Append(c); }
    sb.Append('\\\\', bs * 2); sb.Append('"'); return sb.ToString(); }
  static void Pump(Stream from, Stream to, bool close) { var buffer = new byte[65536]; int n; try { while ((n = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, n); to.Flush(); } } catch { } if (close) try { to.Close(); } catch { } }
  static int Main(string[] args) {
    var line = new StringBuilder(); line.Append(Quote(${literal(script)})).Append(" ${provider} ${version}"); foreach (var a in args) line.Append(' ').Append(Quote(a));
    var child = Process.Start(new ProcessStartInfo(${literal(process.execPath)}, line.ToString()) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
    new Thread(() => Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true)) { IsBackground = true }.Start();
    var o = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false)); var e = new Thread(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false));
    o.Start(); e.Start(); child.WaitForExit(); o.Join(); e.Join(); return child.ExitCode; } }
`)
  execFileSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, source], { stdio: 'pipe', windowsHide: true })
  return exe
}
const exes = { claude: { '2.1.278': compile('claude', '2.1.278'), '2.1.290': compile('claude', '2.1.290') }, codex: { '0.155.1': compile('codex', '0.155.1'), '0.156.0': compile('codex', '0.156.0') } }
const claudeVersions = join(home, '.local', 'share', 'claude', 'versions'), claudeBin = join(home, '.local', 'bin')
mkdirSync(claudeVersions, { recursive: true }); mkdirSync(claudeBin, { recursive: true })
for (const [version, exe] of Object.entries(exes.claude)) copyFileSync(exe, join(claudeVersions, version))
const installedClaude = join(claudeBin, 'claude.exe')
copyFileSync(exes.claude['2.1.278'], installedClaude)
const standalone = join(home, '.codex', 'packages', 'standalone'), release = version => join(standalone, 'releases', `${version}-x86_64-pc-windows-msvc`)
for (const [version, exe] of Object.entries(exes.codex)) {
  for (const dir of ['bin', 'codex-resources', 'codex-path']) mkdirSync(join(release(version), dir), { recursive: true })
  copyFileSync(exe, join(release(version), 'bin', 'codex.exe'))
  writeFileSync(join(release(version), 'codex-resources', 'codex-command-runner.exe'), 'runner ' + version)
  writeFileSync(join(release(version), 'codex-path', 'rg.exe'), 'rg')
  writeFileSync(join(release(version), 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version, target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path' }))
}
const current = join(standalone, 'current')
const pointCodexAt = version => { rmSync(current, { force: true }); symlinkSync(release(version), current, 'junction') }
pointCodexAt('0.155.1')
const installedCodex = join(current, 'bin', 'codex.exe')
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')

// The owner's restore points, from FX12's three real local builds; each records the CLIs that worked.
const feedSource = option('--feed')
if (!feedSource || !existsSync(join(feedSource, 'restore-points.json'))) throw new Error('--feed <FX12 local-updates with three builds> is required')
const target = JSON.parse(readFileSync(join(feedSource, 'restore-points.json'), 'utf8')).points.map(point => point.version).sort().at(0)

const inst = await launchParked({ mode: 'spawn', env: {
  CONDUCTOR_OFFLINE_TESTS: undefined, CONDUCTOR_UPDATE_DEV: '1', CONDUCTOR_RUNTIME_HOST: '0', CONDUCTOR_TEST_STOP_DECISION: 'background',
  CONDUCTOR_CLAUDE_PATH: installedClaude, CONDUCTOR_CODEX_PATH: installedCodex, CONDUCTOR_GROK_PATH: join(root, 'no-grok.exe'),
  CONDUCTOR_TEST_CLI_HOME: home, CONDUCTOR_TEST_CLI_SNAPSHOT_MS: '500'
}, launchTimeoutMs: 90_000 }).catch(error => { throw error })
// Seed the feed after the profile exists (launchParked creates it), then relaunch-free: the app reads
// restore-points.json when the Versions menu asks. Written before any UI step.
const feed = join(inst.profile, 'local-updates'), cache = join(feed, 'cli-cache')
cpSync(feedSource, feed, { recursive: true, force: false, errorOnExist: false })
copyFileSync(join(feedSource, 'restore-points.json'), join(feed, 'restore-points.json'))
const points = JSON.parse(readFileSync(join(feed, 'restore-points.json'), 'utf8'))
for (const point of points.points) { point.cliVersions = { claude: '2.1.278 (Claude Code)', codex: 'codex-cli 0.155.1', grok: null }; point.cliPinning = true; point.pinned = point.version === target }
writeFileSync(join(feed, 'restore-points.json'), JSON.stringify(points, null, 2))

const invocationLines = () => readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const claudeTurn = async title => {
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title })
  const id = tab.resourceId
  await call('agents.submit', { agentSessionId: id, prompt: 'Which CLI are you?' })
  await poll(async () => ['completed', 'failed'].includes((await call('agents.status', { agentSessionId: id })).phase), { timeoutMs: 60_000, label: `${title} turn` })
  const snapshot = await (await page(inst)).evaluate(value => window.conductor.structured.snapshot(value), id)
  return { runtimeVersion: snapshot?.capabilities?.runtimeVersion ?? null, said: /Running on Claude Code \d+\.\d+\.\d+/.exec(JSON.stringify(snapshot))?.[0] ?? null }
}
/** Opens a Codex tab and submits once. The tab's own runtimeVersion is the measure (a refused version never
 *  spawns app-server, so the invocation log alone misses it); launched lists app-server spawns by version. */
const codexLaunch = async title => {
  const since = Date.now()
  const tab = await call('tabs.open', { kind: 'agent', provider: 'codex', title })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'Which CLI are you?' }).catch(error => ({ error: String(error.message) }))
  const snapshot = await poll(async () => { const value = await (await page(inst)).evaluate(id => window.conductor.structured.snapshot(id), tab.resourceId); const version = value?.capabilities?.runtimeVersion; return version && version !== 'unknown' ? value : null }, { timeoutMs: 45_000, label: `${title}: codex runtime version` }).catch(() => null)
  const launched = invocationLines().filter(entry => entry.provider === 'codex' && entry.at >= since && entry.args[0] === 'app-server').map(entry => entry.version)
  const refused = /outside the tested [^\"]*/.exec(JSON.stringify(snapshot ?? {}))?.[0] ?? null
  return { versions: snapshot ? [snapshot.capabilities.runtimeVersion] : [], launched: [...new Set(launched)], refused }
}
const openVersions = async view => {
  let clicks = 0
  const prompt = view.locator('.update-prompt')
  if (await prompt.isVisible().catch(() => false)) await prompt.getByRole('button', { name: 'Not now' }).last().click()
  const menu = view.locator('.update-versions-menu').first()
  if (!await menu.evaluate(element => element.open)) { await menu.locator('summary').click(); clicks++ }
  return { menu, clicks }
}

try {
  await openProject({ name: 'VR4 rollback' })
  const view = await page(inst)
  await view.evaluate(() => { window.confirm = () => true })
  step('R1 installed CLIs saved')
  await poll(() => existsSync(join(cache, 'claude', '2.1.278', 'cli-version.json')) && existsSync(join(cache, 'codex', '0.155.1', 'cli-version.json')), { timeoutMs: 60_000, label: 'CLI cache of the installed versions' })

  // ---- R1
  try {
    step('R1 the CLIs update and delete their old versions')
    copyFileSync(exes.claude['2.1.290'], installedClaude)
    rmSync(join(claudeVersions, '2.1.278'))
    pointCodexAt('0.156.0')
    rmSync(release('0.155.1'), { recursive: true, force: true })
    const installedHashes = { claude: sha(installedClaude), codex: sha(installedCodex) }
    const brokenCodex = await codexLaunch('Codex after the CLI update')
    const brokenClaude = await claudeTurn('Claude after the CLI update')
    step('R1 Versions > Roll back CLIs only > Confirm')
    const { menu, clicks: opened } = await openVersions(view)
    let clicks = opened
    const row = menu.locator('li').filter({ hasText: target }).filter({ has: view.getByRole('button', { name: 'Roll back CLIs only' }) })
    await row.getByRole('button', { name: 'Roll back CLIs only' }).click(); clicks++
    const plan = menu.locator('.update-restore-plan')
    await plan.getByRole('button', { name: 'Confirm rollback' }).waitFor({ timeout: 20_000 })
    const planText = await plan.innerText()
    await shot('R1-plan')
    await plan.getByRole('button', { name: 'Confirm rollback' }).click(); clicks++
    await menu.locator('.update-cli-pins').waitFor({ timeout: 30_000 })
    const pinsText = await menu.locator('.update-cli-pins').innerText()
    await shot('R1-pinned')
    const fixedCodex = await codexLaunch('Codex after the rollback')
    const fixedClaude = await claudeTurn('Claude after the rollback')
    const untouched = sha(installedClaude) === installedHashes.claude && sha(installedCodex) === installedHashes.codex
    const stubAbsent = !existsSync(join(inst.profile, 'installer-stub.json'))
    const { menu: again } = await openVersions(view)
    await again.getByRole('button', { name: 'Use installed CLIs' }).click()
    await poll(async () => (await view.locator('.update-cli-pins').count()) === 0, { timeoutMs: 15_000, label: 'pins cleared' })
    const backCodex = await codexLaunch('Codex on installed CLIs again')
    const pass = /Codex 0\.156\.0 → 0\.155\.1/.test(planText) && /Claude Code 2\.1\.290 → 2\.1\.278/.test(planText) && clicks <= 3
      && fixedCodex.versions.join() === '0.155.1' && fixedCodex.launched.join() === '0.155.1' && fixedClaude.said === 'Running on Claude Code 2.1.278' && untouched && stubAbsent && backCodex.versions.join() === '0.156.0'
      && brokenCodex.versions.join() === '0.156.0' && brokenClaude.said === 'Running on Claude Code 2.1.290'
    record('R1', pass ? 'PASS' : 'FAIL', { clicks, before: { codex: brokenCodex.versions, codexRefused: brokenCodex.refused, codexLaunched: brokenCodex.launched, claude: brokenClaude.said }, after: { codex: fixedCodex.versions, codexLaunched: fixedCodex.launched, claude: fixedClaude.said, runtime: fixedClaude.runtimeVersion }, useInstalled: backCodex.versions, installedUntouched: untouched, stubAbsent }, `plan: ${planText.replace(/\s+/g, ' ').slice(0, 400)}; pins: ${pinsText.replace(/\s+/g, ' ').slice(0, 200)}; R1-plan.png R1-pinned.png`)
  } catch (error) { await failed(error, 'R1') }

  // ---- R2
  try {
    step('R2 Versions > Roll back to this version > Confirm (app + CLIs)')
    const { menu } = await openVersions(view)
    const row = menu.locator('li').filter({ hasText: target }).filter({ has: view.getByRole('button', { name: 'Roll back to this version' }) })
    await row.getByRole('button', { name: 'Roll back to this version' }).click()
    const plan = menu.locator('.update-restore-plan')
    await plan.getByRole('button', { name: 'Confirm rollback' }).waitFor({ timeout: 20_000 })
    const planText = await plan.innerText()
    await shot('R2-plan')
    const oldPid = inst.credential.pid
    // Click from inside the page after CDP detaches: an open CDP session kept a relaunched app's port shut (FX12).
    await plan.getByRole('button', { name: 'Confirm rollback' }).evaluate(element => { setTimeout(() => element.click(), 1500) })
    if (inst.browser) { await inst.browser.close().catch(() => {}); inst.browser = null; inst.page = null }
    const seconds = await relaunched(inst, oldPid, { timeoutMs: 180_000 })
    const stub = JSON.parse(readFileSync(join(inst.profile, 'installer-stub.json'), 'utf8'))
    const state = await (await page(inst)).evaluate(() => window.conductor.updates.getState())
    const pins = JSON.parse(readFileSync(join(cache, 'cli-pins.json'), 'utf8')).pins
    await openProject({ name: 'VR4 rollback', path: inst.projectPath }).catch(() => {})
    const codex = await codexLaunch('Codex after the full rollback')
    const claude = await claudeTurn('Claude after the full rollback')
    await shot('R2-after-relaunch')
    const pass = new RegExp(`Roll back to Conductor ${target.replace(/\./g, '\\.')}`).test(planText) && /Codex 0\.156\.0 → 0\.155\.1/.test(planText) && /Claude Code 2\.1\.290 → 2\.1\.278/.test(planText)
      && stub.version === target && stub.reason === 'rollback' && state.currentVersion === target && pins.claude?.version === '2.1.278' && pins.codex?.version === '0.155.1'
      && codex.versions.join() === '0.155.1' && claude.said === 'Running on Claude Code 2.1.278'
    record('R2', pass ? 'PASS' : 'FAIL', { relaunchSeconds: Math.round(seconds), stub: { version: stub.version, reason: stub.reason }, reported: state.currentVersion, pins: { claude: pins.claude?.version, codex: pins.codex?.version }, codex: codex.versions, claude: claude.said }, `plan: ${planText.replace(/\s+/g, ' ').slice(0, 500)}; R2-plan.png R2-after-relaunch.png`)
  } catch (error) { await failed(error, 'R2') }
} catch (error) { await failed(error, 'R-setup') }
await sleep(200)
await finish()
