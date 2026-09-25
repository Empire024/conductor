import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TIMEOUT_MIN, WAITER_GIVE_UP_MIN, ownsLock, parseArgs, parseHolderText, staleReason, waiterExpired } from './smoke-lock.mjs'

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
