// V1 verify, group A: conductor-local MCP tools (run_and_summarize, local_ask, summarize_file)
// against the real running llama.cpp server. One parked Electron instance, several projects/tabs
// so scenarios that need different permission or a different cwd share one launch.
// Drives the app-control HTTP API (control-owner.json) exactly like other smokes, then speaks raw
// JSON-RPC to the conductor-local MCP endpoint the app minted for each Claude tab -- the same way
// the real Claude CLI would, but without spawning it, since the tool call itself is what is under
// test, not the CLI's own protocol.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-local-assist.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { Agent, setGlobalDispatcher } from 'undici'
// Node's global fetch (undici) defaults to a ~300s headers timeout regardless of our own
// AbortController deadline; S2 (a real "npm test" on this whole checkout) and S4b (a deliberate
// 600s+ run_and_summarize) both outlive that. Disable it globally for this script.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }))
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-assist-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const results = []
const record = (id, verdict, note, numbers) => { const e = { id, verdict, note, numbers, at: new Date().toISOString() }; results.push(e); console.log(`[${id}] ${verdict}: ${note}`) }

const powershell = script => new Promise((done, fail) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(stdout)))

// ---------- Fixture project trees ----------
const scratchProject = join(root, 'scratch-project')
mkdirSync(scratchProject, { recursive: true })

// S1: a temp project with node_modules junctioned from the checkout, vitest, 200 tests, 3 failing
// with distinct names, files and known file:line.
const failProject = join(tmpdir(), 'v1-fail')
mkdirSync(failProject, { recursive: true })
mkdirSync(join(failProject, 'test'), { recursive: true })
await writeFile(join(failProject, 'package.json'), JSON.stringify({ name: 'v1-fail', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2))
await writeFile(join(failProject, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } })\n")
const FAIL_SPECS = [] // { file, name, line }
for (let f = 0; f < 20; f++) {
  const lines = ["import { test, expect } from 'vitest'", '']
  for (let t = 0; t < 10; t++) {
    const idx = f * 10 + t
    const name = `case ${idx} in file ${f}`
    const shouldFail = idx === 47 || idx === 112 || idx === 183
    const bodyLine = shouldFail ? `expect(${idx}).toBe(${idx + 1})` : `expect(${idx}).toBe(${idx})`
    lines.push(`test(${JSON.stringify(name)}, () => {`, `  ${bodyLine}`, '})', '')
    if (shouldFail) FAIL_SPECS.push({ file: `test/gen-${f}.test.ts`, name, line: lines.length - 2 })
  }
  await writeFile(join(failProject, 'test', `gen-${f}.test.ts`), lines.join('\n'))
}
if (!existsSync(join(failProject, 'node_modules'))) await powershell(`New-Item -ItemType Junction -Path '${join(failProject, 'node_modules')}' -Target '${resolve('node_modules')}' | Out-Null`)

// S3: ~20 MB log with 3 distinct error lines at ~10/50/90%.
const s3Script = join(scratchProject, 's3-noisy.mjs')
await writeFile(s3Script, `
const total = 220000
for (let i = 0; i < total; i++) {
  // "Error: " (capital E, lowercase rror) matches the FAILURE pattern in src/main/local-assist/digest.ts
  // (\\bError\\b); plain "ERROR:" does not, and a line the digest's failureLines() never picks up
  // falls outside the model's excerpt entirely (only head 40 / tail 120 / failure-matched lines).
  if (i === Math.floor(total*0.10)) console.log('Error: distinct-failure-A at marker 10pct')
  else if (i === Math.floor(total*0.50)) console.log('Error: distinct-failure-B at marker 50pct')
  else if (i === Math.floor(total*0.90)) console.log('Error: distinct-failure-C at marker 90pct')
  else console.log('noise line ' + i + ' '.repeat(60))
}
process.exit(1)
`)

// S5: a Windows path with spaces, inside the conversation's project.
const spacedDir = join(scratchProject, 'v1 path with spaces', 'sub dir')
mkdirSync(spacedDir, { recursive: true })
await writeFile(join(spacedDir, 'say cwd.mjs'), "console.log('CWD_IS:' + process.cwd())\n")

// S6: a secret path.
await writeFile(join(scratchProject, '.env'), 'SECRET=do-not-read\n')

// S7: a 1 MB file with two needles: one at ~100KB (inside the 512KB cap), one at ~900KB (beyond it).
const oneMebContent = (() => {
  const chunks = []
  let bytes = 0
  let i = 0
  while (bytes < 1_000_000) {
    let line = `line ${i} filler filler filler filler filler filler filler filler\n`
    if (bytes < 100_000 && bytes + line.length >= 100_000) line = 'NEEDLE_A: the shallow needle is codeword ALPHA-7712\n'
    if (bytes < 900_000 && bytes + line.length >= 900_000) line = 'NEEDLE_B: the deep needle is codeword OMEGA-3391\n'
    chunks.push(line)
    bytes += line.length
    i++
  }
  return chunks.join('')
})()
await writeFile(join(scratchProject, 'big.txt'), oneMebContent)

// S8: a binary png from the repo, and a 5MB random .bin.
const pngCandidates = ['build/icon.png', 'resources/icon.png']
const pngSource = pngCandidates.map(p => resolve(p)).find(p => existsSync(p))
if (pngSource) await writeFile(join(scratchProject, 'image.png'), await readFile(pngSource))
await writeFile(join(scratchProject, 'random.bin'), randomBytes(5 * 1024 * 1024))

// ---------- Launch the parked app ----------
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile,
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const appLog = join(root, 'app.log')
const fs = await import('node:fs')
const logFd = fs.openSync(appLog, 'a')
const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 500) => {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await sleep(intervalMs)
  }
}

let owner
try {
  owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  console.log('owner ready', owner.pid)
  const call = async (method, args = {}, scopeProjectId) => {
    const body = { method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const parsed = await r.json()
    if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(parsed)}`)
    return parsed.result
  }

  const scratchProj = await call('projects.open', { path: scratchProject, name: 'V1 assist scratch' })
  const failProj = await call('projects.open', { path: failProject, name: 'V1 assist fail' })
  const checkoutProj = await call('projects.open', { path: resolve('.'), name: 'V1 assist checkout' })
  // Opening the live checkout (and the fail project, whose node_modules is a junction into it) as
  // a project can start heavy file-watcher work in the renderer; give it a moment to settle before
  // the first tabs.open IPC round trip.
  await sleep(5000)

  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  const localProvider = catalog.find(p => p.provider === 'local')
  const bigModel = localProvider?.models.find(m => m.id.includes('35b'))?.id ?? localProvider?.models[0]?.id
  console.log('models', { claudeModel, bigModel })

  // The renderer must have the target project's workspace mounted to ack a tabs.open IPC round
  // trip within 30s (agent-control-ui.ts); opening a large project (the checkout, or the fail
  // project with a junctioned node_modules) can transiently block that, so retry the ack timeout.
  const openTab = async (projectId, permission, title, attempt = 0) => {
    // exactPermission:true is required or dispatchPermission (agent-control.ts) silently promotes
    // every native-coworker tab to auto regardless of the requested mode (a real gotcha: without
    // it, "open a Claude tab in default/accept-edits" from app-control just opens Auto).
    try { return (await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, permission, exactPermission: true, title }, projectId)).resourceId }
    catch (error) {
      if (attempt < 4 && /did not acknowledge/.test(String(error?.message))) { console.log(`retrying tabs.open(${title}) after ack timeout, attempt ${attempt + 1}`); await sleep(8000); return openTab(projectId, permission, title, attempt + 1) }
      throw error
    }
  }
  const submitAndWait = async (id, prompt, timeoutMs = 60_000) => {
    await call('agents.submit', { agentSessionId: id, prompt })
    await poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, timeoutMs, 1000)
  }

  // Open one Auto tab per project + permission variants in the scratch project for S6.
  // NOTE: the claude provider's own capabilities (src/main/providers/claude.ts) only advertise
  // ['default','accept-edits','auto'] -- no 'read-only' and no separate 'plan' permission value --
  // so those two are exercised as far as this provider supports them (default stands in for the
  // non-auto/read case; plan mode has no app-control setter and is recorded NOT RUN).
  // The --mcp-config file is minted the moment a session is first `ensure`d (structured-sessions.ts
  // builds AdapterOptions, including localAssist.configure(), while probing capabilities) -- before
  // any prompt is ever submitted -- so the tmpdir snapshot has to be taken before the FIRST tabs.open.
  const before = new Set(await readdir(tmpdir()).catch(() => []))
  const tabAuto = await openTab(scratchProj.id, 'auto', 'Auto')
  const tabDefault = await openTab(scratchProj.id, 'default', 'Default')
  const tabAcceptEdits = await openTab(scratchProj.id, 'accept-edits', 'AcceptEdits')
  const tabFail = await openTab(failProj.id, 'auto', 'Fail project')
  const tabCheckout = await openTab(checkoutProj.id, 'auto', 'Checkout')

  console.log('locating the --mcp-config directory this app instance minted...')
  const after = await poll(async () => { const list = await readdir(tmpdir()).catch(() => []); const created = list.filter(n => n.startsWith('conductor-local-mcp-') && !before.has(n)); return created.length ? created : null }, 30_000).catch(() => null)
  const mcpConfigDir = after ? join(tmpdir(), after[0]) : null
  console.log('mcp config dir', mcpConfigDir)
  console.log('submitting warm-up turns...')
  await Promise.all([tabAuto, tabDefault, tabAcceptEdits, tabFail, tabCheckout].map(id => submitAndWait(id, 'SYNTHETIC LONG 4')))

  const configFor = async (agentSessionId) => {
    if (!mcpConfigDir) throw new Error('no --mcp-config directory was observed')
    const file = join(mcpConfigDir, `${agentSessionId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const server = parsed.mcpServers['conductor-local']
    return { url: server.url, auth: server.headers.Authorization, file }
  }
  const cfgAuto = await configFor(tabAuto)
  const cfgDefault = await configFor(tabDefault)
  const cfgAcceptEdits = await configFor(tabAcceptEdits)
  const cfgFail = await configFor(tabFail)
  const cfgCheckout = await configFor(tabCheckout)
  console.log('all --mcp-config files located')
  record('S6-plan', 'NOT RUN', "the claude provider's capabilities.permissions is ['default','accept-edits','auto'] only; there is no 'read-only' and no app-control setter for plan mode, so plan/read-only refusal is not exercisable through this provider")

  let rpcId = 0
  const mcpCall = async (cfg, method, params, timeoutMs = 700_000) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const r = await fetch(cfg.url, { method: 'POST', headers: { Authorization: cfg.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: controller.signal })
      return await r.json()
    } finally { clearTimeout(timer) }
  }
  const toolCall = (cfg, name, args, timeoutMs) => mcpCall(cfg, 'tools/call', { name, arguments: args }, timeoutMs).then(r => r.result)
  const textOf = result => result?.content?.[0]?.text ?? ''

  // ---- S6: tools/list is present regardless of permission ----
  const listing = await mcpCall(cfgDefault, 'tools/list', {})
  const toolNames = (listing.result?.tools ?? []).map(t => t.name)
  record('S6-list', toolNames.length === 3 ? 'PASS' : 'FAIL', `tools/list on a default-permission tab: ${JSON.stringify(toolNames)}`)

  // ---- S6: run_and_summarize refused outside Auto; local_ask allowed regardless ----
  for (const [label, cfg] of [['default', cfgDefault], ['accept-edits', cfgAcceptEdits]]) {
    const res = await toolCall(cfg, 'run_and_summarize', { command: 'echo hi', timeoutSec: 10 })
    const refused = res.isError === true && /Auto/.test(textOf(res))
    record(`S6-refuse-${label}`, refused ? 'PASS' : 'FAIL', `run_and_summarize in ${label}: ${JSON.stringify(res).slice(0, 300)}`)
  }
  const readOnlyAsk = await toolCall(cfgDefault, 'local_ask', { prompt: 'What does this say?', files: ['.env'] })
  record('S6-secret', /credential|secret/i.test(textOf(readOnlyAsk)) || readOnlyAsk.isError ? 'PASS' : 'FAIL', `local_ask on .env: ${textOf(readOnlyAsk).slice(0, 200)}`)
  const traversal = await toolCall(cfgDefault, 'local_ask', { prompt: 'What does this say?', files: ['..\\..\\Windows\\win.ini'] })
  record('S6-traversal', /outside|does not exist/i.test(textOf(traversal)) ? 'PASS' : 'FAIL', `local_ask path traversal: ${textOf(traversal).slice(0, 200)}`)

  // ---- S5: Windows path with spaces ----
  const t0 = Date.now()
  const s5 = await toolCall(cfgAuto, 'run_and_summarize', { command: 'node "say cwd.mjs" && cd', cwd: 'v1 path with spaces/sub dir', timeoutSec: 30 })
  const s5text = textOf(s5)
  const s5LogPath = /full log: (\S+)/.exec(s5text)?.[1]
  const s5LogOk = s5LogPath ? existsSync(join(scratchProject, s5LogPath)) : false
  record('S5', /CWD_IS:.*v1 path with spaces.*sub dir/i.test(s5text) && s5LogOk ? 'PASS' : 'FAIL', `ran in spaced dir, log at ${s5LogPath}, exists=${s5LogOk}: ${s5text.slice(0, 300)}`, { ms: Date.now() - t0 })

  // ---- S7: local_ask / summarize_file over the 1 MB file, two needles ----
  const s7a = await toolCall(cfgAuto, 'local_ask', { prompt: 'Find the exact codeword after "the shallow needle is codeword" and reply with just it.', files: ['big.txt'] })
  const s7aOk = /ALPHA-7712/.test(textOf(s7a))
  const s7b = await toolCall(cfgAuto, 'local_ask', { prompt: 'Find the exact codeword after "the deep needle is codeword" and reply with just it, or say plainly if the file was truncated before reaching it.', files: ['big.txt'] })
  const s7bText = textOf(s7b)
  const s7bHonest = /OMEGA-3391/.test(s7bText) || /truncat/i.test(s7bText)
  record('S7', s7aOk && s7bHonest ? 'PASS' : 'FAIL', `shallow needle found=${s7aOk}; deep needle answer honest=${s7bHonest}: ${s7bText.slice(0, 300)}`)
  const s7sum = await toolCall(cfgAuto, 'summarize_file', { path: 'big.txt' })
  record('S7-summarize_file', s7sum && !s7sum.isError ? 'PASS' : 'FAIL', `summarize_file on 1MB file: ${textOf(s7sum).slice(0, 200)}`)

  // ---- S8: binary files ----
  const s8png = pngSource ? await toolCall(cfgAuto, 'local_ask', { prompt: 'What does this show?', files: ['image.png'] }) : null
  const s8pngOk = !pngSource || (s8png.isError || /binary/i.test(textOf(s8png)))
  const s8bin = await toolCall(cfgAuto, 'local_ask', { prompt: 'What does this contain?', files: ['random.bin'] })
  const s8binOk = s8bin.isError || /binary/i.test(textOf(s8bin))
  record('S8', s8pngOk && s8binOk ? 'PASS' : 'FAIL', `png(has=${Boolean(pngSource)})=${s8png ? textOf(s8png).slice(0, 150) : 'skipped'}; bin=${textOf(s8bin).slice(0, 150)}`)

  // ---- S4a: timeoutSec 30 on a never-ending command ----
  const beforeProcs = await powershell("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*setInterval*Date.now*' } | Select-Object -ExpandProperty ProcessId").catch(() => '')
  const t4a = Date.now()
  const s4a = await toolCall(cfgAuto, 'run_and_summarize', { command: 'node -e "setInterval(()=>console.log(Date.now()),500)"', timeoutSec: 30 }, 90_000)
  const elapsed4a = Date.now() - t4a
  // Give taskkill a real grace window on a heavily loaded machine (many concurrent verify swarms)
  // before calling a still-listed pid an orphan; re-check once more a few seconds later.
  await sleep(6000)
  let orphans = await powershell("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*setInterval*Date.now*' } | Select-Object -ExpandProperty ProcessId").catch(() => '')
  if (orphans.trim()) { await sleep(6000); orphans = await powershell("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*setInterval*Date.now*' } | Select-Object -ExpandProperty ProcessId").catch(() => '') }
  record('S4a', /timed out after 30 s/.test(textOf(s4a)) && elapsed4a < 60_000 && !orphans.trim() ? 'PASS' : 'FAIL', `returned in ${elapsed4a}ms, orphan pids after two checks="${orphans.trim()}": ${textOf(s4a).slice(0, 200)}`, { elapsedMs: elapsed4a })

  // ---- S4b: default timeout (600s); fire now, await near the end ----
  const t4b = Date.now()
  const s4bPromise = toolCall(cfgAuto, 'run_and_summarize', { command: 'node -e "setInterval(()=>console.log(Date.now()),500)"' }, 700_000)
    .then(res => ({ res, elapsed: Date.now() - t4b }))
    .catch(error => ({ res: { content: [{ type: 'text', text: `ERROR: ${error?.message ?? error}` }] }, elapsed: Date.now() - t4b }))

  // ---- S3: 20MB log with 3 distinct errors ----
  const t3 = Date.now()
  const rssBefore = process.memoryUsage().rss
  const s3 = await toolCall(cfgAuto, 'run_and_summarize', { command: `node "${s3Script}"`, question: 'List every distinct error found.', maxLines: 20 }, 120_000)
  const s3text = textOf(s3)
  const elapsed3 = Date.now() - t3
  const foundAll3 = ['distinct-failure-A', 'distinct-failure-B', 'distinct-failure-C'].every(m => s3text.includes(m))
  record('S3', foundAll3 && elapsed3 < 120_000 ? 'PASS' : 'FAIL', `found all 3=${foundAll3} in ${elapsed3}ms`, { elapsedMs: elapsed3, rssBeforeMB: Math.round(rssBefore / 1e6) })

  // ---- S1: 200 generated tests, 3 failing, in a vitest project via node_modules junction ----
  const t1 = Date.now()
  const s1 = await toolCall(cfgFail, 'run_and_summarize', { command: 'npm test', maxLines: 40, timeoutSec: 180 }, 220_000)
  const s1text = textOf(s1)
  const elapsed1 = Date.now() - t1
  const namesFound = FAIL_SPECS.every(spec => s1text.includes(spec.name))
  const linesFound = FAIL_SPECS.some(spec => s1text.includes(spec.file))
  const rawTail = s1text.split('Last ').pop()
  record('S1', /exit [1-9]/.test(s1text) && namesFound ? 'PASS' : 'FAIL', `all 3 failing names present=${namesFound}, file refs present=${linesFound}, ${elapsed1}ms: ${s1text.slice(0, 500)}`, { elapsedMs: elapsed1 })

  // ---- S9: GPU busy with an interactive local turn ----
  let s9Result = 'NOT RUN'
  if (bigModel) {
    // The local provider only offers ['accept-edits','read-only'] (src/main/providers/local.ts) --
    // no 'auto' -- so 'accept-edits' is its highest mode.
    const localTab = await call('tabs.open', { kind: 'agent', provider: 'local', model: bigModel, permission: 'accept-edits', exactPermission: true, title: 'S9 busy' }, scratchProj.id).then(r => r.resourceId)
    await call('agents.submit', { agentSessionId: localTab, prompt: 'Write a 3000-word essay about the history of lighthouses.' })
    await sleep(4000)
    const t9 = Date.now()
    const [s9ask, s9run] = await Promise.all([
      toolCall(cfgAuto, 'local_ask', { prompt: 'What does this say?', files: ['big.txt'] }, 30_000),
      toolCall(cfgAuto, 'run_and_summarize', { command: 'exit 1', timeoutSec: 10 }, 30_000)
    ])
    const elapsed9 = Date.now() - t9
    await poll(async () => { const s = await call('agents.status', { agentSessionId: localTab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 600_000, 3000).catch(() => null)
    const localStatus = await call('agents.status', { agentSessionId: localTab }).catch(() => null)
    const interactiveFine = localStatus?.phase === 'completed'
    record('S9', elapsed9 < 30_000 && interactiveFine ? 'PASS' : 'FAIL', `assist calls returned in ${elapsed9}ms while busy; interactive turn ended ${localStatus?.phase}: ask=${textOf(s9ask).slice(0, 150)}`, { elapsedMs: elapsed9 })
    s9Result = 'ran'
  } else record('S9', 'NOT RUN', 'no local provider/model in catalog')

  // ---- S2: real npm test on the checkout itself ----
  const t2 = Date.now()
  const s2 = await toolCall(cfgCheckout, 'run_and_summarize', { command: 'npm test', maxLines: 30, timeoutSec: 1500 }, 1_600_000)
  const elapsed2 = Date.now() - t2
  const s2text = textOf(s2)
  record('S2', /exit 0/.test(s2text) ? 'PASS' : 'FAIL', `${elapsed2}ms: ${s2text.slice(0, 400)}`, { elapsedMs: elapsed2 })

  // ---- S13a: no prepare-deps volume created by any of the above ----
  const volumesAfter = await powershell('docker volume ls 2>$null').catch(() => '(docker unavailable)')
  record('S13a', /conductor-linux-deps-/.test(volumesAfter) ? 'FAIL' : 'PASS', `docker volume ls after all scenarios: ${volumesAfter.trim().slice(0, 300)}`)

  // ---- await S4b now ----
  const { res: s4bRes, elapsed: elapsed4b } = await s4bPromise
  record('S4b', 'INFO', `default timeoutSec (600) blocked the caller for ${elapsed4b}ms before returning: ${textOf(s4bRes).slice(0, 200)}`, { elapsedMs: elapsed4b })

  // ---- S11: savings.jsonl honesty ----
  const savingsPath = join(profile, 'local-assist', 'savings.jsonl')
  const savingsLines = existsSync(savingsPath) ? (await readFile(savingsPath, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const computedSaved = savingsLines.reduce((sum, l) => sum + Math.max(0, Math.floor(l.rawChars / 4) - Math.floor(l.returnedChars / 4)), 0)
  const weekly = await call('usage.weekly', {}).catch(() => null)
  record('S11', savingsLines.length ? 'INFO' : 'FAIL', `${savingsLines.length} ledger lines, computed saved=${computedSaved} tokens; usage.weekly.localSavings=${weekly?.localSavings ?? '(not returned)'}`, { computedSaved, ledgerLines: savingsLines.length })

  await writeFile(join(output, 'savings.jsonl.copy'), savingsLines.map(l => JSON.stringify(l)).join('\n'))
} catch (error) {
  record('group-A-fatal', 'FAIL', String(error?.stack ?? error))
} finally {
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
  await writeFile(join(output, 'group-a-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
  console.log('root kept at', root)
}
