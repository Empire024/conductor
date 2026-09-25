import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// FX20: rolling back restores the CLIs too. Fake Claude Code and Codex CLIs (real .exe files
// compiled here, each with its version baked in, that hand their stdio to a node script) live in a
// fake home laid out the way the real installers lay theirs out; the owner's own CLIs are never
// run, read or changed. The app runs its real (not offline) Claude adapter against them.
//   1  the app saves the installed CLIs (Claude 2.1.278, Codex 0.155.1) into its version cache
//   2  the CLIs "update" to Claude 2.1.290 / Codex 0.156.0 and remove their old version folders,
//      and a Claude turn runs on 2.1.290
//   3  Versions > Roll back CLIs only shows the plan (screenshot), Confirm pins 2.1.278 / 0.155.1
//      from the saved copies: no installer, no network, app version unchanged
//   4  a new Claude tab's turn runs on 2.1.278; the installed CLI is untouched
//   5  Use installed CLIs goes back to 2.1.290
//   node scripts/smoke-lock.mjs --timeout-min 30 -- node scripts/smoke-fx20-cli-rollback.mjs [--build] [--keep]

const argv = process.argv.slice(2)
const repo = resolve('.')
const output = resolve('.conductor-scratch/fx20')
mkdirSync(output, { recursive: true })
if (argv.includes('--build')) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: repo, stdio: 'inherit', shell: true })

const root = await mkdtemp(join(tmpdir(), 'conductor-fx20-'))
const profile = join(root, 'profile'), home = join(root, 'home'), fixtures = join(root, 'fixtures'), projects = join(root, 'projects')
for (const dir of [profile, home, fixtures, projects]) mkdirSync(dir, { recursive: true })
const invocations = join(fixtures, 'invocations.log')
writeFileSync(invocations, '')
const summary = { root, checks: [] }
const check = (label, data = {}) => { summary.checks.push({ label, ...data }); console.log('PASS ' + label + (Object.keys(data).length ? ' ' + JSON.stringify(data) : '')) }

// The node side of every fake CLI: `--version`, and for Claude a stream-json turn that says which
// version answered.
const script = join(fixtures, 'fake-cli.mjs')
writeFileSync(script, `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const [provider, version, ...args] = process.argv.slice(2)
appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ provider, version, args: args.slice(0, 6) }) + '\\n')
if (args.includes('--version')) { process.stdout.write(provider === 'claude' ? version + ' (Claude Code)\\n' : 'codex-cli ' + version + '\\n'); process.exit(0) }
if (provider !== 'claude') process.exit(0)
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'fx20-smoke', parent_tool_use_id: null, ...m })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const text = 'Running on Claude Code ' + version + '.'
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', claude_code_version: version })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

// A console .exe per fake version: runs `node fake-cli.mjs <provider> <version> ...args` and pumps
// stdio both ways, so the app's adapters spawn it like the real native CLIs (no shell, no .cmd).
const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
assert.ok(existsSync(csc), 'the smoke compiles its fake CLIs with the .NET Framework csc.exe')
const literal = value => '@"' + value.replaceAll('"', '""') + '"'
const compile = (provider, version) => {
  const source = join(fixtures, `${provider}-${version}.cs`), exe = join(fixtures, `${provider}-${version}.exe`)
  writeFileSync(source, `using System; using System.Diagnostics; using System.IO; using System.Text; using System.Threading;
class FakeCli {
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\\""); int bs = 0;
    foreach (char c in a) {
      if (c == '\\\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\\\', bs * 2); sb.Append('"'); return sb.ToString();
  }
  static void Pump(Stream from, Stream to, bool close) {
    var buffer = new byte[65536]; int n;
    try { while ((n = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, n); to.Flush(); } } catch { }
    if (close) try { to.Close(); } catch { }
  }
  static int Main(string[] args) {
    var line = new StringBuilder();
    line.Append(Quote(${literal(script)})).Append(" ${provider} ${version}");
    foreach (var a in args) line.Append(' ').Append(Quote(a));
    var info = new ProcessStartInfo(${literal(process.execPath)}, line.ToString()) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
    var child = Process.Start(info);
    new Thread(() => Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true)) { IsBackground = true }.Start();
    var output = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
    var error = new Thread(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false));
    output.Start(); error.Start();
    child.WaitForExit(); output.Join(); error.Join();
    return child.ExitCode;
  }
}
`)
  execFileSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, source], { stdio: 'pipe', windowsHide: true })
  return exe
}
const exes = { claude: {}, codex: {} }
for (const version of ['2.1.278', '2.1.290']) exes.claude[version] = compile('claude', version)
for (const version of ['0.155.1', '0.156.0']) exes.codex[version] = compile('codex', version)
assert.equal(execFileSync(exes.claude['2.1.278'], ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), '2.1.278 (Claude Code)')

// The installers' layouts: Claude Code keeps every version in ~/.local/share/claude/versions and
// copies the current one to ~/.local/bin/claude.exe; Codex keeps releases/<version>-<target> and a
// `current` link to one of them.
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
  writeFileSync(join(release(version), 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version, target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path' }, null, 2))
}
const current = join(standalone, 'current')
const pointCodexAt = version => { rmSync(current, { force: true, recursive: false }); symlinkSync(release(version), current, 'junction') }
pointCodexAt('0.155.1')
const installedCodex = join(current, 'bin', 'codex.exe')

// The restore point the owner rolls back to: it recorded the CLIs that worked.
const feed = join(profile, 'local-updates'), pointVersion = '0.1.0-local.1'
mkdirSync(feed, { recursive: true })
writeFileSync(join(feed, 'restore-points.json'), JSON.stringify({ schemaVersion: 1, points: [{
  version: pointVersion, commit: 'a'.repeat(40), createdAt: '2026-09-24T12:00:00.000Z', dirty: false,
  cliVersions: { claude: '2.1.278 (Claude Code)', codex: 'codex-cli 0.155.1', grok: null },
  models: [{ provider: 'claude', models: [{ id: 'synthetic-claude' }] }],
  installer: `Conductor-Setup-${pointVersion}.exe`, blockmap: `Conductor-Setup-${pointVersion}.exe.blockmap`,
  pinned: true, knownGood: true, crashCount: 0, failedShipCount: 0, cliPinning: true
}] }, null, 2))

const env = {
  ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: projects,
  CONDUCTOR_CLAUDE_PATH: installedClaude, CONDUCTOR_CODEX_PATH: installedCodex, CONDUCTOR_GROK_PATH: join(root, 'no-grok.exe'),
  CONDUCTOR_TEST_CLI_HOME: home, CONDUCTOR_TEST_CLI_SNAPSHOT_MS: '500'
}
for (const key of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_LIVE_TESTS', 'CONDUCTOR_OFFLINE_TESTS', 'CONDUCTOR_UPDATE_DEV', 'CONDUCTOR_BACKGROUND_WINDOWS', 'CONDUCTOR_TEST_DIALOGS']) delete env[key]
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(20_000)
const cache = join(feed, 'cli-cache')
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const control = async (method, args = {}, projectId) => {
  const credential = JSON.parse(readFileSync(join(profile, 'control-owner.json'), 'utf8'))
  const response = await fetch(credential.endpoint, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}
let projectId
/** Opens a new Claude tab, runs one turn, returns the version it ran on and what it said. */
const claudeTurn = async title => {
  const tab = await control('tabs.open', { kind: 'agent', provider: 'claude', title }, projectId)
  const id = tab.resourceId ?? tab.agentSessionId
  await control('agents.submit', { agentSessionId: id, prompt: 'Which CLI are you?' }, projectId)
  await expect.poll(async () => (await control('agents.status', { agentSessionId: id }, projectId)).phase, { timeout: 60_000, intervals: [300] }).toBe('completed')
  const snapshot = await page.evaluate(id => window.conductor.structured.snapshot(id), id)
  const said = /Running on Claude Code \d+\.\d+\.\d+/.exec(JSON.stringify(snapshot))?.[0] ?? null
  return { id, runtimeVersion: snapshot?.capabilities?.runtimeVersion ?? null, said }
}
const openVersions = async () => {
  const prompt = page.locator('.update-prompt')
  if (await prompt.isVisible().catch(() => false)) await prompt.getByRole('button', { name: 'Not now' }).last().click()
  const menu = page.locator('.update-versions-menu').first()
  if (!await menu.evaluate(element => element.open)) await menu.locator('summary').click()
  return menu
}

let failure = null
try {
  await page.waitForFunction(() => Boolean(window.conductor?.updates?.restorePlan))
  const project = await page.evaluate(() => window.conductor.projects.create('FX20 CLI rollback'))
  projectId = project.id
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).first().click()

  // 1. The running CLIs are saved shortly after launch.
  await expect.poll(() => existsSync(join(cache, 'claude', '2.1.278', 'cli-version.json')) && existsSync(join(cache, 'codex', '0.155.1', 'cli-version.json')), { timeout: 60_000, intervals: [500] }).toBe(true)
  assert.ok(existsSync(join(cache, 'codex', '0.155.1', 'codex-resources', 'codex-command-runner.exe')), 'the whole Codex package is saved, not just codex.exe')
  check('installed CLIs saved into the version cache', { claude: '2.1.278', codex: '0.155.1' })

  // 2. The CLIs update themselves and clean up the old version folders.
  copyFileSync(exes.claude['2.1.290'], installedClaude)
  rmSync(join(claudeVersions, '2.1.278'))
  pointCodexAt('0.156.0')
  rmSync(release('0.155.1'), { recursive: true, force: true })
  const installedClaudeHash = sha(installedClaude)
  const broken = await claudeTurn('After the CLI update')
  assert.equal(broken.runtimeVersion, '2.1.290'); assert.equal(broken.said, 'Running on Claude Code 2.1.290')
  check('a turn runs on the updated Claude Code', broken)

  // 3. Versions > Roll back CLIs only: the plan first, then Confirm.
  const menu = await openVersions()
  const row = menu.locator('li').filter({ hasText: pointVersion }).filter({ has: page.getByRole('button', { name: 'Roll back CLIs only' }) })
  await row.getByRole('button', { name: 'Roll back CLIs only' }).click()
  const planPanel = menu.locator('.update-restore-plan')
  await expect(planPanel).toContainText(`Roll back the CLIs to those of ${pointVersion}`)
  await expect(planPanel).toContainText('Claude Code 2.1.290 → 2.1.278 (saved copy)')
  await expect(planPanel).toContainText('Codex 0.156.0 → 0.155.1 (saved copy)')
  const planText = await planPanel.innerText()
  await page.screenshot({ path: join(output, 'fx20-plan.png') })
  assert.ok(!/Conductor .* → /.test(planText), 'a CLI-only rollback leaves the app alone')
  check('the plan names what will change before confirming', { planText })
  await planPanel.getByRole('button', { name: 'Confirm rollback' }).click()
  await expect(menu.locator('.update-cli-pins')).toContainText('Using restored CLIs: Claude Code 2.1.278 (installed 2.1.290) · Codex 0.155.1 (installed 0.156.0)')
  await page.screenshot({ path: join(output, 'fx20-pinned.png') })
  const pins = JSON.parse(readFileSync(join(cache, 'cli-pins.json'), 'utf8')).pins
  assert.equal(pins.claude.version, '2.1.278'); assert.equal(pins.codex.version, '0.155.1')
  assert.equal(execFileSync(pins.codex.executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), 'codex-cli 0.155.1')
  assert.ok(!existsSync(join(profile, 'installer-stub.json')), 'no installer, real or stubbed, ran for a CLI-only rollback')
  const state = await page.evaluate(() => window.conductor.updates.getState())
  check('CLI-only rollback pinned the recorded versions from the saved copies', { pins, appVersion: state.currentVersion })

  // 4. A new tab's turn runs on the restored Claude Code; the installed CLI is untouched.
  const restored = await claudeTurn('After the CLI rollback')
  assert.equal(restored.runtimeVersion, '2.1.278'); assert.equal(restored.said, 'Running on Claude Code 2.1.278')
  assert.equal(sha(installedClaude), installedClaudeHash, 'the installed claude.exe was not changed')
  assert.equal(execFileSync(installedCodex, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), 'codex-cli 0.156.0')
  check('a turn runs on the restored Claude Code 2.1.278; installed CLIs untouched', restored)

  // The full rollback's plan would install the app too (not run: FX12 covers the install itself).
  const fullPlan = await page.evaluate(version => window.conductor.updates.restorePlan(version, 'all'), pointVersion)
  assert.equal(fullPlan.app?.to, pointVersion)
  check('app + CLIs plan names the app change', { app: fullPlan.app, blocked: fullPlan.blocked ?? null, clis: fullPlan.clis.map(change => `${change.provider}:${change.action}`) })

  // 5. Use installed CLIs.
  await (await openVersions()).getByRole('button', { name: 'Use installed CLIs' }).click()
  await expect(page.locator('.update-cli-pins')).toHaveCount(0)
  const back = await claudeTurn('Installed CLIs again')
  assert.equal(back.runtimeVersion, '2.1.290')
  check('Use installed CLIs goes back to the installed versions', back)
} catch (error) {
  failure = error
  await page.screenshot({ path: join(output, 'fx20-failure.png') }).catch(() => {})
} finally {
  summary.invocations = readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).map(entry => `${entry.provider} ${entry.version} ${entry.args.join(' ')}`.slice(0, 120))
  try { summary.mainErrors = readFileSync(join(profile, 'main-errors.log'), 'utf8').slice(-4000) } catch { /* none */ }
  summary.passed = !failure
  if (failure) summary.error = String(failure?.stack ?? failure)
  writeFileSync(join(output, 'fx20-summary.json'), JSON.stringify(summary, null, 2))
  await app.close().catch(() => {})
  if (!argv.includes('--keep')) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
if (failure) { console.error(failure); process.exit(1) }
console.log(`FX20 smoke passed; evidence in ${output}`)
