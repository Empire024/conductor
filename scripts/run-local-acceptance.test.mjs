import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as realKit from './verify-kit.mjs'
import { canonicalBuild, createRedactor, evidenceWriter, judgeAdmission, manifestCommand, parseArgs, runAcceptance, sanitizeText, validateSlot } from './run-local-acceptance.mjs'

// Nothing here launches a smoke, touches a model server or kills a process: the child, the
// process inventory, the kill helper, the control calls and the slot are all injected.

const BUILD = 'C:\\repo\\out\\main\\index.js'
const SHA = 'b'.repeat(64)
const SMOKE = `node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --app=${BUILD} --app-sha256=${SHA}`
const FAULT = `node scripts/smoke-lock.mjs --timeout-min 45 -- ${SMOKE} --kill-server --restart-app --extras=none`
const TOKEN = 'f'.repeat(64)
const argv = (over = {}) => Object.entries({ scenario: 'fault', controller: 'agent_ctrl_1', executor: 'agent_exec_1', generation: '42', script: FAULT, build: 'C:\\repo\\out\\main\\index.js', commit: 'a'.repeat(40), 'candidate-sha256': 'b'.repeat(64), 'timeout-min': '45', ...over }).map(([key, value]) => `--${key}=${value}`)
const slot = (now, over = {}) => ({ status: 'granted', agentSessionId: 'agent_exec_1', generation: 42, script: FAULT, build: 'C:\\repo\\out\\main\\index.js', grantedAt: new Date(now - 60_000).toISOString(), ...over })
const quietLoad = { quiet: true, cpuPercent: 10, gpuPercent: 5, lock: { held: false }, midTurn: { count: 2, tabs: [{ agentSessionId: 'agent_ctrl_1' }, { agentSessionId: 'agent_exec_1' }] }, reasons: [] }
const paused = [{ id: 's1', enabled: false, running: false }, { id: 's2', enabled: false, running: false }]

test('manifestCommand names the exact durable commands, with the granted build and hash, and refuses the rest', () => {
  const named = { build: BUILD, sha256: SHA }
  assert.equal(manifestCommand('fault', { timeoutMin: 45, ...named }).join(' '), FAULT)
  // The matching control carries --acceptance: the same completed-and-correct gate as the fault run.
  assert.equal(manifestCommand('fault-control', { timeoutMin: 45, ...named }).join(' '), `node scripts/smoke-lock.mjs --timeout-min 45 -- ${SMOKE} --acceptance --extras=none`)
  assert.equal(manifestCommand('soak', { timeoutMin: 395, ...named }).join(' '), `node scripts/smoke-lock.mjs --timeout-min 395 -- ${SMOKE} --fixture=crossref --soak`)
  assert.throws(() => manifestCommand('soak', { timeoutMin: 370, ...named }), /at least 390/)
  assert.throws(() => manifestCommand('fault', named), /exact --timeout-min/)
  assert.throws(() => manifestCommand('fault', { timeoutMin: 45, build: BUILD }), /full sha256/)
  assert.throws(() => manifestCommand('guard', { timeoutMin: 60, ...named }), /not been reviewed/)
  assert.throws(() => manifestCommand('typing-after', named), /unknown scenario/)
})

test('canonicalBuild: the checked path is the launched path, so only a canonical absolute index.js passes', () => {
  assert.equal(canonicalBuild(BUILD), BUILD)
  for (const bad of ['out/main/index.js', 'C:\\repo\\out\\..\\out\\main\\index.js', 'C:\\my repo\\out\\main\\index.js', 'C:\\repo\\out\\main\\index.js.bak', 'C:\\repo\\index.js', undefined])
    assert.throws(() => canonicalBuild(bad), /canonical absolute path/, String(bad))
})

test('sanitizeText removes known secrets and secret-shaped process data', () => {
  const text = sanitizeText(`token ${TOKEN}; llama-server --api-key SYNTHETICKEY0123456789 --port 1; --api-key="QUOTEDKEY0123456789"; Authorization: Bearer abcdefgh12345678`, [TOKEN])
  for (const secret of [TOKEN, 'SYNTHETICKEY0123456789', 'QUOTEDKEY0123456789', 'abcdefgh12345678']) assert.ok(!text.includes(secret), secret)
  assert.match(text, /--api-key \[redacted\] --port 1/)
})

test('createRedactor: a secret split at every byte position never reaches the output', () => {
  const text = `line one\nthe token is ${TOKEN} here\nlast line without newline ${TOKEN}`
  const bytes = Buffer.from(text, 'utf8')
  for (let cut = 1; cut < bytes.length; cut++) {
    const redactor = createRedactor([TOKEN])
    const out = redactor.push(bytes.subarray(0, cut)) + redactor.push(bytes.subarray(cut)) + redactor.end()
    assert.ok(!out.includes(TOKEN), `cut at ${cut}`)
    assert.equal(out, text.split(TOKEN).join('[redacted]'), `cut at ${cut}`)
  }
  // A long line with no newline flushes early but still holds back enough to catch a split secret.
  const long = 'x'.repeat(300) + TOKEN + 'y'.repeat(300)
  for (const cut of [250, 300, 301, 330, 363, 364]) {
    const redactor = createRedactor([TOKEN], { maxLine: 200 })
    const out = redactor.push(long.slice(0, cut)) + redactor.push(long.slice(cut)) + redactor.end()
    assert.equal(out, long.split(TOKEN).join('[redacted]'), `long cut at ${cut}`)
  }
})

// ---- Correction review S-B6: a secret straddling the over-maxLine cut, for all three shapes.
const KEY = 'SYNTHKEY0123456789abcdef0123456789abcdef'
const SHAPES = [['literal token', TOKEN, TOKEN], ['--api-key value', `--api-key ${KEY}`, KEY], ['Bearer value', `Authorization: Bearer ${KEY}`, KEY]]
/** No 12-character window of the secret survives: a secret written as two raw halves fails this. */
const noFragment = (out, secret) => { for (let i = 0; i + 12 <= secret.length; i++) if (out.includes(secret.slice(i, i + 12))) return `fragment at ${i}`; return null }

for (const [name, shape, secret] of SHAPES) {
  test(`createRedactor: a ${name} at every offset across the 64 KiB cut is never written raw (one push, the reviewer's case)`, () => {
    const separator = name === 'literal token' ? '' : ' '
    for (let tail = 0; tail <= 256 + shape.length + 2; tail++) {
      const text = 'x'.repeat(65536) + separator + shape + separator + 'y'.repeat(tail)
      const redactor = createRedactor([TOKEN])
      const out = redactor.push(text) + redactor.end()
      assert.equal(noFragment(out, secret), null, `tail ${tail}`)
      assert.equal(out.length > 65536, true)
    }
  })

  test(`createRedactor: a ${name} split into two chunks at every offset around a small maxLine cut is never written raw`, () => {
    const separator = name === 'literal token' ? '' : ' '
    const text = 'x'.repeat(400) + separator + shape + separator + 'y'.repeat(300)
    for (let cut = 380; cut <= 420 + shape.length; cut++) {
      const redactor = createRedactor([TOKEN], { maxLine: 300 })
      const out = redactor.push(text.slice(0, cut)) + redactor.push(text.slice(cut)) + redactor.end()
      assert.equal(noFragment(out, secret), null, `split at ${cut}`)
      assert.equal(out, sanitizeText(text, [TOKEN]), `split at ${cut}`)
    }
  })
}

test('createRedactor: an --api-key value longer than the hard bound is released redacted and its continuation dropped', () => {
  const redactor = createRedactor([TOKEN], { maxLine: 100, hardMax: 500 })
  let out = redactor.push('start --api-key ')
  for (let i = 0; i < 20; i++) out += redactor.push('k'.repeat(100))
  out += redactor.push(' after\n') + redactor.end()
  assert.ok(!out.includes('kkkk'), out.slice(0, 200))
  assert.match(out, /^start --api-key \[redacted\] after\n$/)
})

test('createRedactor: a line longer than maxLine but shorter than the held tail releases nothing early', () => {
  const redactor = createRedactor([TOKEN], { maxLine: 100 })
  assert.equal(redactor.push('a'.repeat(200) + TOKEN.slice(0, 20)), '')
  assert.equal(redactor.push(TOKEN.slice(20)) + redactor.end(), 'a'.repeat(200) + '[redacted]')
})

test('createRedactor: UTF-8 split at every byte position is reassembled, not mangled', () => {
  const text = 'héllo wörld 😀 ünïcode ✓\nzweite Zeile 😀\n'
  const bytes = Buffer.from(text, 'utf8')
  for (let cut = 1; cut < bytes.length; cut++) {
    const redactor = createRedactor([TOKEN], { maxLine: 4 })
    assert.equal(redactor.push(bytes.subarray(0, cut)) + redactor.push(bytes.subarray(cut)) + redactor.end(), text, `cut at ${cut}`)
  }
})

test('parseArgs needs distinct exact agents, full hashes and the exact manifest script', () => {
  assert.equal(parseArgs(argv()).command, FAULT)
  assert.throws(() => parseArgs(argv({ script: FAULT + ' --keep' })), /exact manifest command/)
  assert.throws(() => parseArgs(argv({ executor: 'agent_ctrl_1' })), /distinct/)
  assert.throws(() => parseArgs(argv({ generation: 'latest' })), /numeric/)
  assert.throws(() => parseArgs(argv({ commit: 'HEAD' })), /full hashes/)
})

test('validateSlot accepts only a fresh exact grant', () => {
  const now = Date.parse('2026-09-28T12:00:00Z'), args = parseArgs(argv())
  assert.equal(validateSlot(slot(now), args, now).generation, 42)
  for (const over of [{ status: 'released' }, { agentSessionId: 'agent_other' }, { generation: 41 }, { script: 'node other.mjs' }, { build: 'C:\\x\\index.js' }, { grantedAt: new Date(now - 6 * 60_000).toISOString() }, { grantedAt: new Date(now + 60_000).toISOString() }, { grantedAt: 'soon' }])
    assert.throws(() => validateSlot(slot(now, over), args, now), /NOT RUN \(slot\)/, JSON.stringify(over))
})

test('judgeAdmission refuses servers, load, foreign tabs, a held lock and live schedules', () => {
  const allowed = ['agent_ctrl_1', 'agent_exec_1']
  judgeAdmission({ appServers: [], osServers: [], load: quietLoad, schedules: paused, allowed })
  for (const over of [
    { appServers: [{ model: 'm', pid: 1 }] }, { osServers: [{ pid: 2 }] }, { appServers: null },
    { load: { ...quietLoad, quiet: false, reasons: ['CPU 45%'] } }, { load: { ...quietLoad, gpuPercent: 40 } }, { load: { ...quietLoad, lock: { held: true } } },
    { load: { ...quietLoad, midTurn: { count: 3, tabs: [...quietLoad.midTurn.tabs, { agentSessionId: 'agent_x' }] } } },
    { load: { ...quietLoad, midTurn: { count: 2, tabs: [{ agentSessionId: 'agent_ctrl_1' }, { agentSessionId: 'agent_x' }] } } },
    { schedules: [{ id: 's1', enabled: true, running: false }] }, { schedules: [] }
  ]) assert.throws(() => judgeAdmission({ appServers: [], osServers: [], load: quietLoad, schedules: paused, allowed, ...over }), /NOT RUN \(admission\)/, JSON.stringify(over))
})

test('evidenceWriter never reuses a generation that already has evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-acceptance-'))
  try {
    const first = evidenceWriter(join(dir, 'fault-1'))
    first.run.status = 'X'; first.save()
    assert.throws(() => evidenceWriter(join(dir, 'fault-1')), /no automatic retry/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- One scripted run: smoke-lock child 4000 -> electron 4001 -> llama-server 4002; a foreign
// llama-server neighbour appears only where a test puts it.
const EXE = 'C:\\node\\node.exe'
const p = (pid, ppid, created, name = 'node.exe', executable = EXE) => ({ pid, ppid, name, commandLine: '', creationTime: String(created), executable })
const neighbour = p(9000, 1, 5, 'notepad.exe', 'C:\\Windows\\notepad.exe')
// Creation times are listProcesses' microseconds since 1601, just after the scripted spawn time.
const NOW = Date.parse('2026-09-28T12:00:00Z')
const US_1601 = ms => String((BigInt(ms) + 11_644_473_600_000n) * 1000n)
const lock = p(4000, 100, US_1601(NOW + 10)), electron = p(4001, 4000, US_1601(NOW + 11), 'electron.exe', 'C:\\e\\electron.exe'), llama = p(4002, 4001, US_1601(NOW + 12), 'llama-server.exe', 'D:\\llama\\llama-server.exe')

const SECRET_ERROR = `denied for Bearer ${TOKEN} running llama-server --api-key SYNTHETICKEY0123456789`
function world({ exitCode = 0, exitsBeforeSnapshot = false, admissionList = [neighbour], running = [lock, electron, llama, neighbour], afterExit = [electron, llama, neighbour], cleanupFails = false, trackFails = false, appServers = [], slots, digests = [], credential = { endpoint: 'http://127.0.0.1:5999/control', token: TOKEN }, loadCheck = async () => quietLoad } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'local-acceptance-'))
  let phase = 'admission', slotReads = 0, spawned = 0, spawnEnv = null, runningCalls = 0, digestCalls = 0
  const killed = []
  const lists = { admission: admissionList, running, after: afterExit }
  // Killed processes leave the inventory; everything else - neighbours included - stays.
  const listNow = () => lists[phase].filter(entry => !killed.includes(entry.pid))
  // trackFails: the registering inventory works, every later tracking inventory fails with a secret in its error.
  const kit = { ...realKit, listProcesses: async () => { if (phase === 'running' && trackFails && ++runningCalls > 1) throw new Error(SECRET_ERROR); return { list: listNow() } } }
  const now = NOW
  const deps = {
    kit, evidenceRoot: root, credential, now: () => now, loadCheck,
    readSlot: () => (slots?.[slotReads++] ?? slot(now)),
    head: () => 'a'.repeat(40), digest: () => digests[digestCalls++] ?? SHA,
    call: async method => method === 'schedules.list' ? paused : method === 'local.servers' ? (phase === 'admission' ? appServers : []) : null,
    spawnSmoke: (file, args, options) => {
      spawned++; spawnEnv = options.env
      const child = new EventEmitter()
      Object.assign(child, { pid: 4000, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
      phase = 'running'
      const exit = () => { child.exitCode = exitCode; child.emit('exit', exitCode, null) }
      // exitsBeforeSnapshot: Node has already seen the child exit when the identity snapshot returns.
      if (exitsBeforeSnapshot) { child.exitCode = exitCode; setTimeout(() => { phase = 'after'; child.emit('exit', exitCode, null) }, 0) }
      else setTimeout(() => { child.stdout.write(`token leak ${TOKEN}\n`); phase = 'after'; exit() }, 40)
      return child
    },
    closeDeps: {
      listProcesses: async () => { if (cleanupFails) throw new Error(`inventory unavailable: ${SECRET_ERROR}`); return { list: listNow() } },
      terminate: async identity => { killed.push(identity.pid); return { state: 'exited' } },
      now: () => now, sleep: async () => {}
    },
    trackMs: 5, heartbeatMs: 10
  }
  return { deps, root, killed, spawned: () => spawned, env: () => spawnEnv, dir: join(root, 'fault-42'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const quiet = async work => { const log = console.log; console.log = () => {}; try { return await work() } finally { console.log = log } }

test('a clean injected run tracks the tree by identity, kills leaves first and awaits judgment', async () => {
  const w = world()
  try {
    const run = await quiet(() => runAcceptance(argv(), w.deps))
    assert.equal(run.status, 'AWAITING CONTROLLER JUDGMENT', run.reason)
    assert.deepEqual(w.killed, [4002, 4001])
    assert.equal(run.cleanup.leftovers.length, 0)
    assert.equal(run.cleanup.unresolved.length, 0)
    assert.equal(run.root.pid, 4000)
    assert.equal(w.env().CONDUCTOR_CONTROL_TOKEN, undefined)
    assert.equal(w.env().CONDUCTOR_BACKGROUND_WINDOWS, '1')
    for (const file of ['run.json', 'events.ndjson', 'full.log']) {
      assert.ok(existsSync(join(w.dir, file)), file)
      assert.ok(!readFileSync(join(w.dir, file), 'utf8').includes(TOKEN), `${file} holds the token`)
    }
    assert.match(readFileSync(join(w.dir, 'full.log'), 'utf8'), /\[redacted\]/)
    assert.match(readFileSync(join(w.dir, 'events.ndjson'), 'utf8'), /"event":"tracked"/)
  } finally { w.cleanup() }
})

test('the foreign neighbour is never killed, even when it is a llama-server left at exit', async () => {
  const foreignLlama = p(9100, 1, 7, 'llama-server.exe', 'D:\\other\\llama-server.exe')
  const w = world({ afterExit: [electron, llama, neighbour, foreignLlama] })
  try {
    const run = await quiet(() => runAcceptance(argv(), w.deps))
    assert.ok(!w.killed.includes(9100) && !w.killed.includes(9000))
    assert.notEqual(run.status, 'AWAITING CONTROLLER JUDGMENT')
  } finally { w.cleanup() }
})

for (const [name, options, reason] of [
  ['an app model server', { appServers: [{ model: 'm', pid: 7 }] }, /admission/],
  ['an OS llama-server', { admissionList: [neighbour, p(9100, 1, 7, 'llama-server.exe')] }, /admission/],
  ['a busy machine', { loadCheck: async () => ({ ...quietLoad, quiet: false, reasons: ['CPU 50%'] }) }, /admission/],
  ['a slot that went stale before spawn', { slots: [undefined, { status: 'released' }] }, /slot/],
  ['no own credential', { credential: { endpoint: undefined, token: undefined } }, /credential/]
]) {
  test(`refused before any spawn: ${name}`, async () => {
    const w = world(options)
    try {
      const run = await quiet(() => runAcceptance(argv(), w.deps))
      assert.equal(run.status, 'NOT RUN')
      assert.match(run.reason, reason)
      assert.equal(w.spawned(), 0)
      assert.deepEqual(w.killed, [])
      assert.ok(existsSync(join(w.dir, 'run.json')))
    } finally { w.cleanup() }
  })
}

test('an inventory that fails at cleanup kills nothing and leaves the run UNVERIFIED', async () => {
  const w = world({ cleanupFails: true })
  try {
    const run = await quiet(() => runAcceptance(argv(), w.deps))
    assert.equal(run.status, 'UNVERIFIED (cleanup)')
    assert.deepEqual(w.killed, [])
  } finally { w.cleanup() }
})

test('a failing smoke with clean cleanup is FAIL, never awaiting judgment', async () => {
  const w = world({ exitCode: 1 })
  try {
    const run = await quiet(() => runAcceptance(argv(), w.deps))
    assert.equal(run.status, 'FAIL')
    assert.deepEqual(w.killed, [4002, 4001])
  } finally { w.cleanup() }
})

test('a build that changed between the grant check and the spawn (A checked, B present) is refused before spawn', async () => {
  const w = world({ digests: [SHA, 'c'.repeat(64)] })
  try {
    const run = await quiet(() => runAcceptance(argv(), w.deps))
    assert.equal(run.status, 'NOT RUN')
    assert.match(run.reason, /NOT RUN \(build\).*not the granted/)
    assert.equal(w.spawned(), 0)
  } finally { w.cleanup() }
})

test('the smoke is told to launch exactly the granted build and to re-hash it', async () => {
  const w = world()
  let launched = null
  const spawnSmoke = w.deps.spawnSmoke
  w.deps.spawnSmoke = (file, args, options) => { launched = args; return spawnSmoke(file, args, options) }
  try {
    await quiet(() => runAcceptance(argv(), w.deps))
    assert.ok(launched.includes(`--app=${BUILD}`) && launched.includes(`--app-sha256=${SHA}`), JSON.stringify(launched))
  } finally { w.cleanup() }
})

for (const [name, options] of [['tracking errors', { trackFails: true }], ['cleanup errors', { cleanupFails: true }]]) {
  test(`${name} carrying a token and an API key reach no artifact raw, but stay classified`, async () => {
    const w = world(options)
    try {
      const run = await quiet(() => runAcceptance(argv(), w.deps))
      const artifacts = ['run.json', 'events.ndjson', 'full.log'].filter(file => existsSync(join(w.dir, file))).map(file => readFileSync(join(w.dir, file), 'utf8')).join('\n')
      assert.ok(!artifacts.includes(TOKEN), 'token leaked')
      assert.ok(!artifacts.includes('SYNTHETICKEY0123456789'), 'API key leaked')
      assert.match(artifacts, options.trackFails ? /"event":"track-failed"[^\n]*denied for Bearer \[redacted\]/ : /inventory failed/)
      if (options.cleanupFails) assert.equal(run.status, 'UNVERIFIED (cleanup)')
    } finally { w.cleanup() }
  })
}

test('a smoke-lock child that exited before its identity snapshot is never registered or killed (its pid may be foreign)', async () => {
  const w = world({ exitsBeforeSnapshot: true })
  try {
    const run = await quiet(() => runAcceptance(argv(), w.deps))
    assert.deepEqual(w.killed, [])
    assert.equal(run.root, undefined)
    assert.equal(run.status, 'UNVERIFIED (cleanup)')
    assert.match(run.reason, /exited before its identity was read/)
  } finally { w.cleanup() }
})

test('the same generation is never run twice', async () => {
  const w = world()
  try {
    await quiet(() => runAcceptance(argv(), w.deps))
    await assert.rejects(runAcceptance(argv(), w.deps), /no automatic retry/)
  } finally { w.cleanup() }
})
