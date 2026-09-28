import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { BACKGROUND_PRIORITY, NORMAL_PRIORITY, lowerPriority, restoreNormalPriority, wrappedCommand } from './lib/background-priority.mjs'
import { DEFAULT_TIMEOUT_MIN, WAITER_GIVE_UP_MIN, acquire, cleanupRun, createFinisher, ownsLock, parseArgs, parseHolderText, queuePosition, release, staleReason, ticketName, trackRun, waiterExpired } from './smoke-lock.mjs'
import * as kit from './verify-kit.mjs'

// ---- S-B1: run cleanup is identity-owned and bounded; no numeric tree kill on any ending.

const EXE = 'C:\\node\\node.exe'
const p = (pid, ppid, created, name = 'node.exe', executable = EXE) => ({ pid, ppid, name, commandLine: '', creationTime: String(created), executable })
const runRoot = p(4000, 300, 1000), runChild = p(4001, 4000, 1001, 'electron.exe', 'C:\\e\\electron.exe'), neighbour = p(9000, 1, 5, 'notepad.exe', 'C:\\Windows\\notepad.exe')

test('smoke-lock main() has no numeric tree kill: killTree and taskkill /T are gone from every ending', () => {
  const source = readFileSync(new URL('./smoke-lock.mjs', import.meta.url), 'utf8')
  const main = source.slice(source.indexOf('async function main()'))
  assert.doesNotMatch(main, /killTree\(|taskkill|'\/T'/)
  const cleanup = source.slice(source.indexOf('export async function trackRun'), source.indexOf('// --------------------------------------------------------------------- the waiting line'))
  assert.doesNotMatch(cleanup, /killTree\(|taskkill|process\.kill\(/)
})

/** A scripted machine for cleanupRun: `snapshots` answer each inventory in turn (the last repeats). */
async function scriptedRun({ registered = [runRoot, neighbour], snapshots, terminate = () => ({ state: 'exited' }) }) {
  const tracker = kit.newInstance({ name: 'smoke-lock-test' })
  await kit.registerRoot(tracker, 4000, { source: 'smoke-lock child', list: registered })
  const terminated = []
  let calls = 0, clock = 0
  const deps = {
    listProcesses: async () => { const answer = snapshots[Math.min(calls++, snapshots.length - 1)]; if (answer instanceof Error) throw answer; return { list: answer } },
    terminate: async identity => { terminated.push(identity.pid); return terminate(identity) },
    now: () => clock, sleep: async ms => { clock += ms }
  }
  const log = console.log; console.log = () => {}
  try { return { ...(await cleanupRun({ child: { pid: 4000, exitCode: 0, signalCode: null }, tracking: Promise.resolve(tracker), kit, deps })), terminated } }
  finally { console.log = log }
}

test('cleanupRun: normal exit with the root pid reused and a foreign descendant kills nothing and is not clean', async () => {
  const reusedRoot = p(4000, 7, 5000, 'node.exe'), foreignChild = p(4100, 4000, 5001, 'cmd.exe', 'C:\\Windows\\cmd.exe')
  const outcome = await scriptedRun({ snapshots: [[reusedRoot, foreignChild, neighbour]] })
  assert.deepEqual(outcome.terminated, [])
  assert.equal(outcome.clean, false)
  assert.ok(outcome.report.unresolved.some(entry => entry.pid === 4100), JSON.stringify(outcome.report.unresolved))
})

test('cleanupRun: timeout or parent loss with the run still alive stops exactly its tree, leaves first, by identity', async () => {
  const outcome = await scriptedRun({ registered: [runRoot, runChild, neighbour], snapshots: [[runRoot, runChild, neighbour], [runRoot, runChild, neighbour], [neighbour]] })
  assert.deepEqual(outcome.terminated, [4001, 4000])
  assert.equal(outcome.clean, true)
})

test('cleanupRun: a normal exit whose tree is already gone is clean with no kill', async () => {
  const outcome = await scriptedRun({ snapshots: [[neighbour]] })
  assert.deepEqual(outcome.terminated, [])
  assert.equal(outcome.clean, true)
})

test('cleanupRun: failed inventory at cleanup kills nothing and is not clean', async () => {
  const outcome = await scriptedRun({ snapshots: [new Error('Access denied')] })
  assert.deepEqual(outcome.terminated, [])
  assert.equal(outcome.clean, false)
})

test('cleanupRun: without a registered identity only the direct child is stopped, through its own handle', async () => {
  let handleKills = 0
  const child = { pid: 4000, exitCode: null, signalCode: null, kill: () => { handleKills++ } }
  const outcome = await cleanupRun({ child, tracking: Promise.resolve(null), kit: { ...kit, safeClose: () => { throw new Error('must not run') } } })
  assert.equal(handleKills, 1)
  assert.equal(outcome.clean, false)
  const exited = await cleanupRun({ child: { ...child, exitCode: 0 }, tracking: Promise.resolve(null), kit })
  assert.equal(handleKills, 1, 'an exited child is not killed again')
  assert.equal(exited.clean, false)
})

// ---- Correction review S-C1: a child that exits before its snapshot is never registered.
const US_1601 = ms => String((BigInt(ms) + 11_644_473_600_000n) * 1000n)

test('trackRun: a child that exited before its identity snapshot gives zero registration and zero kills', async () => {
  // The pid is already held by a foreign process by the time the inventory runs.
  const foreign = p(4000, 7, US_1601(Date.now()), 'node.exe')
  const child = { pid: 4000, exitCode: 0, signalCode: null, kill: () => { throw new Error('must not kill') } }
  const logs = []
  const tracker = await trackRun(child, { ...kit, listProcesses: async () => ({ list: [foreign, neighbour] }) }, { log: message => logs.push(message), spawnedAtMs: Date.now() - 1000 })
  assert.equal(tracker, null)
  assert.match(logs.join(' '), /exited before its identity was read/)
  const outcome = await cleanupRun({ child, tracking: Promise.resolve(tracker), kit: { ...kit, safeClose: () => { throw new Error('must not run') } } })
  assert.equal(outcome.clean, false)
})

test('trackRun: a live child created inside its spawn window registers (control); one created before it does not', async () => {
  const spawnedAtMs = Date.now() - 500
  const live = { pid: 4000, exitCode: null, signalCode: null }
  const own = p(4000, process.pid, US_1601(spawnedAtMs + 100))
  const fakeKit = { ...kit, listProcesses: async () => ({ list: [own, neighbour] }) }
  const tracker = await trackRun(live, fakeKit, { spawnedAtMs })
  try { assert.deepEqual(tracker.roots.map(entry => entry.pid), [4000]) } finally { kit.stopTracking(tracker) }
  const stale = p(4000, process.pid, US_1601(spawnedAtMs - 60_000))
  assert.equal(await trackRun(live, { ...kit, listProcesses: async () => ({ list: [stale] }) }, { spawnedAtMs }), null)
})

test('trackRun: an unreadable identity is reported, and yields no tracker', async () => {
  const logs = []
  const unreadable = { ...p(4000, process.pid, 1000), creationTime: null }
  const tracker = await trackRun({ pid: 4000, exitCode: null, signalCode: null }, { ...kit, listProcesses: async () => ({ list: [unreadable] }) }, { log: message => logs.push(message) })
  assert.equal(tracker, null)
  assert.match(logs[0], /could not register the run's identity/)
})

for (const [ending, code] of [['normal exit', 0], ['a failing run', 2], ['timeout', 124], ['a signal', 130], ['parent loss', 1]]) {
  test(`createFinisher: ${ending} cleans up once, releases the lock and exits ${code === 0 ? '0 when clean' : code}`, async () => {
    const calls = { cleanup: 0, release: 0, exit: [], cleared: 0 }
    const finish = createFinisher({ cleanup: async () => { calls.cleanup++; return { clean: true } }, release: () => { calls.release++ }, exit: value => calls.exit.push(value), clearTimers: () => { calls.cleared++ } })
    await Promise.all([finish(code), finish(99), finish(130)])
    assert.deepEqual(calls, { cleanup: 1, release: 1, exit: [code], cleared: 1 })
  })
}

test('createFinisher: a hung cleanup is abandoned at the deadline; the lock is still released and the run exits', async () => {
  const calls = { release: 0, exit: [] }
  const logs = []
  const started = Date.now()
  await createFinisher({ cleanup: () => new Promise(() => {}), release: () => { calls.release++ }, exit: value => calls.exit.push(value), deadlineMs: 50, log: message => logs.push(message) })(0)
  assert.ok(Date.now() - started < 2000)
  assert.deepEqual(calls, { release: 1, exit: [3] })
  assert.match(logs.join(' '), /did not finish within/)
})

test('createFinisher: an unclean or failing cleanup never lets a successful run exit 0', async () => {
  for (const cleanup of [async () => ({ clean: false }), async () => { throw new Error('boom') }]) {
    const exits = []
    let released = 0
    await createFinisher({ cleanup, release: () => { released++ }, exit: value => exits.push(value) })(0)
    assert.deepEqual(exits, [3])
    assert.equal(released, 1)
  }
  const exits = []
  await createFinisher({ cleanup: async () => ({ clean: false }), release: () => {}, exit: value => exits.push(value) })(124)
  assert.deepEqual(exits, [124], 'a failing code is kept')
})

test('parseArgs: default timeout with no flag', () => {
  assert.deepEqual(parseArgs(['--', 'node', 'scripts/smoke-foo.mjs']), { command: ['node', 'scripts/smoke-foo.mjs'], timeoutMin: DEFAULT_TIMEOUT_MIN, priority: 'background' })
})

test('parseArgs: --timeout-min N before the separator', () => {
  assert.deepEqual(parseArgs(['--timeout-min', '45', '--', 'node', 'scripts/smoke-foo.mjs']), { command: ['node', 'scripts/smoke-foo.mjs'], timeoutMin: 45, priority: 'background' })
})

test('parseArgs: --timeout-min=N form', () => {
  assert.deepEqual(parseArgs(['--timeout-min=1', '--', 'node', 'x.mjs']), { command: ['node', 'x.mjs'], timeoutMin: 1, priority: 'background' })
})

test('parseArgs: a non-numeric or non-positive timeout falls back to the default', () => {
  assert.equal(parseArgs(['--timeout-min', 'nope', '--', 'node', 'x.mjs']).timeoutMin, DEFAULT_TIMEOUT_MIN)
  assert.equal(parseArgs(['--timeout-min', '0', '--', 'node', 'x.mjs']).timeoutMin, DEFAULT_TIMEOUT_MIN)
  assert.equal(parseArgs(['--timeout-min', '-5', '--', 'node', 'x.mjs']).timeoutMin, DEFAULT_TIMEOUT_MIN)
})

test('parseArgs: no separator treats the whole argv as the command (old call shape)', () => {
  assert.deepEqual(parseArgs(['node', 'scripts/smoke-foo.mjs']), { command: ['node', 'scripts/smoke-foo.mjs'], timeoutMin: DEFAULT_TIMEOUT_MIN, priority: 'background' })
})

test('parseArgs: an empty argv is an empty command', () => {
  assert.deepEqual(parseArgs([]), { command: [], timeoutMin: DEFAULT_TIMEOUT_MIN, priority: 'background' })
})

// --------------------------------------------------------------------- staleReason

const holder = (overrides = {}) => ({ pid: 4242, startedAt: new Date().toISOString(), timeoutMin: 20, command: 'node x.mjs', ...overrides })
const alwaysAlive = () => true
const alwaysDead = () => false

test('staleReason: unreadable holder is stale', () => {
  assert.match(staleReason(null, Date.now()), /unreadable/)
  assert.match(staleReason({}, Date.now()), /unreadable/)
})

test('staleReason: a dead holder pid is stale regardless of age', () => {
  const reason = staleReason(holder({ startedAt: new Date().toISOString() }), Date.now(), alwaysDead)
  assert.match(reason, /is gone/)
})

test('staleReason: a live holder well within its timeout is not stale', () => {
  const now = Date.now()
  const startedAt = new Date(now - 5 * 60_000).toISOString() // 5 min ago, 20 min timeout
  assert.equal(staleReason(holder({ startedAt, timeoutMin: 20 }), now, alwaysAlive), null)
})

test('staleReason: a live holder just past its own timeout (but under 2x) is not stale', () => {
  const now = Date.now()
  const startedAt = new Date(now - 25 * 60_000).toISOString() // 25 min ago, 20 min timeout
  assert.equal(staleReason(holder({ startedAt, timeoutMin: 20 }), now, alwaysAlive), null)
})

test('staleReason: a live holder past 2x its timeout is stale', () => {
  const now = Date.now()
  const startedAt = new Date(now - 41 * 60_000).toISOString() // 41 min ago, 20 min timeout -> 2x is 40 min
  const reason = staleReason(holder({ startedAt, timeoutMin: 20 }), now, alwaysAlive)
  assert.match(reason, /more than 2x/)
})

// --------------------------------------------------------------------- parseHolderText

test('parseHolderText: parses the current JSON shape', () => {
  assert.deepEqual(parseHolderText('{"pid":42,"startedAt":"2026-09-25T00:00:00.000Z","timeoutMin":20,"command":"node x.mjs"}'),
    { pid: 42, startedAt: '2026-09-25T00:00:00.000Z', timeoutMin: 20, command: 'node x.mjs' })
})

test('parseHolderText: falls back to the pre-JSON "pid iso command" shape a running old smoke-lock still writes', () => {
  const holder = parseHolderText('42 2026-09-25T00:00:00.000Z node scripts/smoke-foo.mjs\n')
  assert.equal(holder.pid, 42)
  assert.equal(holder.startedAt, '2026-09-25T00:00:00.000Z')
  assert.equal(holder.command, 'node scripts/smoke-foo.mjs')
})

test('parseHolderText: a live legacy-format holder within its default timeout is not stale', () => {
  const now = Date.now()
  const startedAt = new Date(now - 5 * 60_000).toISOString()
  const holder = parseHolderText(`4242 ${startedAt} node x.mjs`)
  assert.equal(staleReason(holder, now, () => true), null)
})

test('parseHolderText: genuinely unparseable text is null, not a crash', () => {
  assert.equal(parseHolderText('not a holder at all'), null)
  assert.equal(parseHolderText(''), null)
})

// --------------------------------------------------------------------- ownsLock

test('ownsLock: true when holder.txt names this process', () => {
  assert.equal(ownsLock({ pid: 4242 }, 4242), true)
})

test('ownsLock: false once another process holds the lock now', () => {
  assert.equal(ownsLock({ pid: 9999 }, 4242), false)
})

test('ownsLock: true with no holder to protect (missing or already-gone lock)', () => {
  assert.equal(ownsLock(null, 4242), true)
})

// --------------------------------------------------------------------- waiterExpired

test('waiterExpired: false well before the default 60 min give-up', () => {
  const now = Date.now()
  assert.equal(waiterExpired(now - 5 * 60_000, now), false)
})

test('waiterExpired: false right at the boundary, true just past it', () => {
  const now = Date.now()
  assert.equal(waiterExpired(now - WAITER_GIVE_UP_MIN * 60_000, now), false)
  assert.equal(waiterExpired(now - (WAITER_GIVE_UP_MIN * 60_000 + 1), now), true)
})

test('waiterExpired: honors an explicit limit override', () => {
  const now = Date.now()
  assert.equal(waiterExpired(now - 10 * 60_000, now, 5), true)
  assert.equal(waiterExpired(now - 3 * 60_000, now, 5), false)
})

test('staleReason: a missing timeoutMin falls back to the default for the 2x check', () => {
  const now = Date.now()
  const startedAt = new Date(now - (DEFAULT_TIMEOUT_MIN * 2 + 1) * 60_000).toISOString()
  const reason = staleReason(holder({ startedAt, timeoutMin: undefined }), now, alwaysAlive)
  assert.match(reason, /more than 2x/)
})

// --------------------------------------------------------------------- FIFO line (smoke-lock-fifo)

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function lockSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'smoke-lock-test-'))
  const lockDir = join(root, 'lock'), queueDir = join(root, 'queue')
  const live = new Set()
  const logs = []
  const stop = new AbortController()
  const waiter = (pid, events) => {
    live.add(pid)
    return acquire(1, ['node', `smoke-${pid}.mjs`], { lockDir, queueDir, pid, alive: candidate => live.has(candidate), log: line => logs.push(`${pid} ${line}`), pollMs: 5, signal: stop.signal })
      .then(() => { events.push(`${pid} acquired`) })
  }
  const hold = pid => { live.add(pid); mkdirSync(lockDir); writeFileSync(join(lockDir, 'holder.txt'), JSON.stringify({ pid, startedAt: new Date().toISOString(), timeoutMin: 20, command: 'node held.mjs' })) }
  const until = async predicate => { for (let i = 0; i < 400 && !predicate(); i++) await pause(5); assert.ok(predicate(), 'timed out waiting for the simulated waiters') }
  return { root, lockDir, queueDir, live, logs, waiter, hold, until, cleanup: () => { stop.abort(); rmSync(root, { recursive: true, force: true }) } }
}

test('FIFO: two waiters take the lock in arrival order, and a runner chaining smokes back to back goes to the back of the line', async () => {
  const box = lockSandbox()
  try {
    const events = []
    box.hold(1)
    const first = box.waiter(300, events) // arrives first, with the higher pid: arrival wins, not pid
    await box.until(() => readdirSync(box.queueDir).length === 1)
    await pause(5)
    const second = box.waiter(200, events)
    await box.until(() => readdirSync(box.queueDir).length === 2)
    await pause(30)
    assert.deepEqual(events, [])
    assert.ok(box.logs.some(line => line.startsWith('200 ') && /position 2 of 2 in line, held by 1 \(node held\.mjs\)/.test(line)), box.logs.join('\n'))
    assert.ok(box.logs.some(line => line.startsWith('300 ') && /position 1 of 1 in line, held by 1/.test(line)))

    release(box.lockDir, 1) // the holder finishes ...
    await first
    assert.deepEqual(events, ['300 acquired'])
    // ... and at once comes back for another smoke, like VR3's chained runs: it queues behind 200.
    const again = box.waiter(1, events)
    await box.until(() => readdirSync(box.queueDir).length === 2)
    await pause(30)
    assert.deepEqual(events, ['300 acquired'])

    release(box.lockDir, 300)
    await second
    assert.deepEqual(events, ['300 acquired', '200 acquired'])
    release(box.lockDir, 200)
    await again
    assert.deepEqual(events, ['300 acquired', '200 acquired', '1 acquired'])
    assert.deepEqual(readdirSync(box.queueDir), [])
  } finally { box.cleanup() }
})

test('FIFO: a dead waiter\'s ticket is skipped and removed instead of blocking the line', async () => {
  const box = lockSandbox()
  try {
    mkdirSync(box.queueDir, { recursive: true })
    writeFileSync(join(box.queueDir, ticketName(999, Date.now() - 60_000)), '{}') // killed without leaving the line
    const events = []
    await box.waiter(400, events)
    assert.deepEqual(events, ['400 acquired'])
    assert.deepEqual(readdirSync(box.queueDir), [])
    assert.ok(box.logs.some(line => /skipping a dead waiter's ticket \(pid 999\)/.test(line)))
  } finally { box.cleanup() }
})

test('FIFO: the front waiter still breaks a stale holder, and a waiter that never held the lock cannot release it', async () => {
  const box = lockSandbox()
  try {
    box.hold(7)
    box.live.delete(7) // the holder died without releasing
    release(box.lockDir, 8) // not the holder: must not remove it
    assert.ok(existsSync(join(box.lockDir, 'holder.txt')))
    const events = []
    await box.waiter(500, events)
    assert.deepEqual(events, ['500 acquired'])
    assert.equal(JSON.parse(readFileSync(join(box.lockDir, 'holder.txt'), 'utf8')).pid, 500)
    assert.ok(box.logs.some(line => /breaking stale lock: holder process 7 is gone/.test(line)))
  } finally { box.cleanup() }
})

test('FIFO: ticket names sort by arrival, then pid', () => {
  assert.ok(ticketName(99999, 1000) < ticketName(1, 1001))
  assert.ok(ticketName(1, 1000) < ticketName(2, 1000))
  assert.equal(queuePosition(['a', 'b'], 'b'), 2)
  assert.equal(queuePosition(['a'], 'gone'), 0)
})

test('parseArgs: --priority normal keeps a measurement run at normal priority; anything else is background', () => {
  assert.equal(parseArgs(['--priority', 'normal', '--', 'node', 'x.mjs']).priority, 'normal')
  assert.equal(parseArgs(['--priority=normal', '--timeout-min', '60', '--', 'node', 'x.mjs']).priority, 'normal')
  assert.equal(parseArgs(['--priority=high', '--', 'node', 'x.mjs']).priority, 'background')
  // After the separator it belongs to the wrapped command.
  assert.deepEqual(parseArgs(['--', 'node', 'x.mjs', '--priority', 'normal']), { command: ['node', 'x.mjs', '--priority', 'normal'], timeoutMin: DEFAULT_TIMEOUT_MIN, priority: 'background' })
})

test('lowerPriority: below normal once, never raises an idle process, honours the opt-out, never throws', () => {
  const calls = []
  const set = (pid, value) => calls.push([pid, value])
  assert.equal(lowerPriority(0, { env: {}, get: () => NORMAL_PRIORITY, set }), 'lowered')
  assert.deepEqual(calls, [[0, BACKGROUND_PRIORITY]])
  assert.equal(lowerPriority(0, { env: {}, get: () => BACKGROUND_PRIORITY, set }), 'already')
  assert.equal(lowerPriority(0, { env: {}, get: () => 19, set }), 'already')
  assert.equal(lowerPriority(0, { env: { CONDUCTOR_BACKGROUND_PRIORITY: '0' }, get: () => NORMAL_PRIORITY, set }), 'skipped')
  assert.equal(calls.length, 1)
  assert.equal(lowerPriority(0, { env: {}, get: () => NORMAL_PRIORITY, set: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }), 'failed: EACCES')
  assert.equal(restoreNormalPriority(0, { get: () => BACKGROUND_PRIORITY, set }), 'restored')
  assert.equal(restoreNormalPriority(0, { get: () => NORMAL_PRIORITY, set }), 'already')
  assert.deepEqual(wrappedCommand(['--', 'npx', 'vitest']), ['npx', 'vitest'])
})

test('a child started by a lowered process inherits below-normal priority', () => {
  const script = "import { getPriority } from 'node:os'; process.stdout.write(String(getPriority()))"
  const run = spawnSync(process.execPath, [join(import.meta.dirname, 'lib', 'background-priority.mjs'), '--', process.execPath, '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, CONDUCTOR_BACKGROUND_PRIORITY: '' } })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(Number(run.stdout) >= BACKGROUND_PRIORITY, `child priority ${run.stdout}`)
})

// ---- the real entry: verify-kit imports smoke-lock, so a top-level await of main() deadlocked the
// lazy verify-kit import and Node exited 13 before spawning anything (fault-control 1790592490419).

/** Runs the real `node scripts/smoke-lock.mjs --timeout-min 1 -- node <args>` against a private temp
 *  folder, so its lock and queue never touch the owner's global conductor-smoke.lock. */
function runEntry(childArgs) {
  const temp = mkdtempSync(join(tmpdir(), 'smoke-lock-entry-'))
  try {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, 'smoke-lock.mjs'), '--timeout-min', '1', '--', process.execPath, ...childArgs], {
      encoding: 'utf8', timeout: 90_000, windowsHide: true,
      env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
    })
    return { run, lockHeld: existsSync(join(temp, 'conductor-smoke.lock')), privateLock: readdirSync(temp).includes('conductor-smoke.queue') }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

test('entry: a passing command exits 0 (or the documented unaccounted-cleanup 3), never 13, and leaves no lock held', { timeout: 120_000 }, () => {
  const { run, lockHeld, privateLock } = runEntry(['-e', '0'])
  assert.equal(run.error, undefined, String(run.error))
  assert.doesNotMatch(run.stderr, /unsettled top-level await/i)
  assert.notEqual(run.status, 13, run.stderr)
  assert.ok([0, 3].includes(run.status), `exit ${run.status}: ${run.stderr}`)
  assert.ok(privateLock, 'the run queued in the private temp folder, not the global one')
  assert.equal(lockHeld, false, 'the lock is released after the run')
})

test('entry: the command\'s own failing exit code propagates', { timeout: 120_000 }, () => {
  const { run, lockHeld } = runEntry(['-e', 'process.exit(7)'])
  assert.equal(run.error, undefined, String(run.error))
  assert.doesNotMatch(run.stderr, /unsettled top-level await/i)
  assert.equal(run.status, 7, run.stderr)
  assert.equal(lockHeld, false, 'the lock is released after the run')
})
