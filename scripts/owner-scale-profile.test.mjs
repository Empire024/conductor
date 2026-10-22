import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SIZING, FILLED_TABLES, GENERATOR_VERSION, SMALL_SIZING, mulberry32, normalizeSchema, planConversationSizes, profileKey, summarizeProjection } from './owner-scale-profile.mjs'

test('conversation sizes reach the owner-scale total, with a few huge ones and a long tail', () => {
  const sizes = planConversationSizes(DEFAULT_SIZING)
  assert.equal(sizes.length, DEFAULT_SIZING.conversations)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  // More than the owner's 1.27 GB of projection JSON on 2026-10-22, within 3% of the plan.
  assert.ok(total > 1.3e9, `total ${total}`)
  assert.ok(Math.abs(total - DEFAULT_SIZING.projectionBytes) / DEFAULT_SIZING.projectionBytes < 0.03, `total ${total}`)
  assert.ok(Math.max(...sizes) <= DEFAULT_SIZING.hugeMax)
  assert.equal(sizes.filter(size => size >= DEFAULT_SIZING.hugeMin).length, DEFAULT_SIZING.huge)
  assert.ok(Math.min(...sizes) >= DEFAULT_SIZING.smallMin)
  const sorted = [...sizes].sort((a, b) => a - b)
  assert.ok(sorted[Math.floor(sorted.length / 2)] < total / sizes.length, 'the median is below the mean: a long tail, not a uniform spread')
  // Deterministic: the same sizing is the same profile.
  assert.deepEqual(planConversationSizes(DEFAULT_SIZING), sizes)
  assert.equal(planConversationSizes(SMALL_SIZING).length, SMALL_SIZING.conversations)
})

test('the cache key follows the generator version, the sizing and the schema of the filled tables only', () => {
  const rows = [
    { type: 'table', name: 'structured_sessions', tbl_name: 'structured_sessions', sql: 'CREATE TABLE structured_sessions (\n  id TEXT PRIMARY KEY, projection_json TEXT NOT NULL)' },
    { type: 'index', name: 'sqlite_autoindex_structured_sessions_1', tbl_name: 'structured_sessions', sql: null },
    { type: 'table', name: 'projects', tbl_name: 'projects', sql: 'CREATE TABLE projects (id TEXT PRIMARY KEY)' },
    { type: 'table', name: 'memories', tbl_name: 'memories', sql: 'CREATE TABLE memories (id TEXT)' }
  ]
  const schema = normalizeSchema(rows)
  assert.equal(schema, 'table projects: CREATE TABLE projects (id TEXT PRIMARY KEY)\ntable structured_sessions: CREATE TABLE structured_sessions ( id TEXT PRIMARY KEY, projection_json TEXT NOT NULL)')
  // Order and whitespace do not matter; an unrelated table does not regenerate gigabytes.
  assert.equal(normalizeSchema([...rows].reverse().map(row => row.sql ? { ...row, sql: row.sql.replace(/ /g, '  ') } : row)), schema)
  assert.equal(normalizeSchema([...rows, { type: 'table', name: 'loop_runs', tbl_name: 'loop_runs', sql: 'CREATE TABLE loop_runs (id TEXT)' }]), schema)
  const key = profileKey({ schema })
  assert.match(key, /^[0-9a-f]{16}$/)
  assert.equal(profileKey({ schema }), key)
  // A new column in a filled table (summary_json, 2026-10-22) is a new profile.
  const withSummary = normalizeSchema(rows.map(row => row.name === 'structured_sessions' ? { ...row, sql: row.sql.replace(')', ', summary_json TEXT)') } : row))
  assert.notEqual(profileKey({ schema: withSummary }), key)
  assert.notEqual(profileKey({ schema, version: GENERATOR_VERSION + 1 }), key)
  assert.notEqual(profileKey({ schema, sizing: SMALL_SIZING }), key)
  assert.ok(FILLED_TABLES.includes('structured_events') && FILLED_TABLES.includes('structured_sessions'))
})

test('the stored summary matches what a checkpoint writes', () => {
  const items = [
    { data: { type: 'text', role: 'user', text: 'first  question' } },
    { data: { type: 'text', role: 'assistant', text: '  the\nanswer ' + 'x'.repeat(300) } },
    { data: { type: 'tool', name: 'Bash', status: 'completed' } }
  ]
  const summary = summarizeProjection({ phase: 'completed', items, settings: { model: 'opus', permission: 'auto', plan: false } })
  assert.deepEqual(Object.keys(summary), ['phase', 'items', 'model', 'snippet', 'lastRole'])
  assert.equal(summary.items, 3)
  assert.equal(summary.lastRole, 'assistant')
  assert.equal(summary.snippet.length, 180)
  assert.ok(summary.snippet.startsWith('the answer x'))
  assert.deepEqual(summarizeProjection({ phase: 'idle', items: [], settings: { permission: 'auto', plan: false } }), { phase: 'idle', items: 0 })
})

test('the random source is seeded and uniform enough', () => {
  const a = mulberry32(7), b = mulberry32(7)
  const values = Array.from({ length: 10_000 }, () => a())
  assert.deepEqual(values.slice(0, 5), Array.from({ length: 5 }, () => b()))
  assert.ok(values.every(value => value >= 0 && value < 1))
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  assert.ok(Math.abs(mean - 0.5) < 0.02)
})
