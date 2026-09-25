import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TIMEOUT_MIN, WAITER_GIVE_UP_MIN, acquire, ownsLock, parseArgs, parseHolderText, queuePosition, release, staleReason, ticketName, waiterExpired } from './smoke-lock.mjs'

test('parseArgs: default timeout with no flag', () => {
  assert.deepEqual(parseArgs(['--', 'node', 'scripts/smoke-foo.mjs']), { command: ['node', 'scripts/smoke-foo.mjs'], timeoutMin: DEFAULT_TIMEOUT_MIN })
})

test('parseArgs: --timeout-min N before the separator', () => {
  assert.deepEqual(parseArgs(['--timeout-min', '45', '--', 'node', 'scripts/smoke-foo.mjs']), { command: ['node', 'scripts/smoke-foo.mjs'], timeoutMin: 45 })
})

test('parseArgs: --timeout-min=N form', () => {
  assert.deepEqual(parseArgs(['--timeout-min=1', '--', 'node', 'x.mjs']), { command: ['node', 'x.mjs'], timeoutMin: 1 })
})

test('parseArgs: a non-numeric or non-positive timeout falls back to the default', () => {
  assert.equal(parseArgs(['--timeout-min', 'nope', '--', 'node', 'x.mjs']).timeoutMin, DEFAULT_TIMEOUT_MIN)
  assert.equal(parseArgs(['--timeout-min', '0', '--', 'node', 'x.mjs']).timeoutMin, DEFAULT_TIMEOUT_MIN)
  assert.equal(parseArgs(['--timeout-min', '-5', '--', 'node', 'x.mjs']).timeoutMin, DEFAULT_TIMEOUT_MIN)
})

test('parseArgs: no separator treats the whole argv as the command (old call shape)', () => {
  assert.deepEqual(parseArgs(['node', 'scripts/smoke-foo.mjs']), { command: ['node', 'scripts/smoke-foo.mjs'], timeoutMin: DEFAULT_TIMEOUT_MIN })
})

test('parseArgs: an empty argv is an empty command', () => {
  assert.deepEqual(parseArgs([]), { command: [], timeoutMin: DEFAULT_TIMEOUT_MIN })
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
