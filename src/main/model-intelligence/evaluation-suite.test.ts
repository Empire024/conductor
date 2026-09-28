import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grade, validateSuite, type CommandRequest, type CommandResult, type EvaluationRun } from './evaluation'
import defaultSuite from './suites/default.json'

/** The default suite's checks are real programs: each must pass a correct answer and fail a wrong one.
 *  This test stands in for module E's sandboxed command port with a plain temp folder and node. */
const command = async (request: CommandRequest): Promise<CommandResult> => {
  const folder = mkdtempSync(join(tmpdir(), 'conductor-eval-'))
  try {
    for (const [path, content] of Object.entries(request.files)) { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), content) }
    const result = spawnSync(request.cmd === 'node' ? process.execPath : request.cmd, request.args, { cwd: folder, timeout: request.timeoutSec * 1000, encoding: 'utf8' })
    return { exitCode: result.status, timedOut: result.error?.message.includes('ETIMEDOUT') ?? false, output: `${result.stdout}${result.stderr}`.slice(-400) }
  } finally { rmSync(folder, { recursive: true, force: true }) }
}

const REPORT = `import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
const value = order => order.quantity * order.unitPrice
const paid = orders => orders.filter(order => order.status === 'paid')
export const totalRevenue = orders => paid(orders).reduce((sum, order) => sum + value(order), 0)
export function topCustomer(orders) {
  const totals = {}
  for (const order of paid(orders)) totals[order.customer] = (totals[order.customer] ?? 0) + value(order)
  return Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
}
export function monthlyTotals(orders) {
  const months = {}
  for (const order of paid(orders)) months[order.date.slice(0, 7)] = (months[order.date.slice(0, 7)] ?? 0) + value(order)
  return months
}
`
const reportJson = () => {
  const orders = JSON.parse(validateSuite(defaultSuite).jobs.find(job => job.id === 'orders-report')!.files!['orders.json']!) as Array<{ customer: string; date: string; quantity: number; unitPrice: number; status: string }>
  const paid = orders.filter(order => order.status === 'paid'), totals: Record<string, number> = {}, months: Record<string, number> = {}
  for (const order of paid) { totals[order.customer] = (totals[order.customer] ?? 0) + order.quantity * order.unitPrice; months[order.date.slice(0, 7)] = (months[order.date.slice(0, 7)] ?? 0) + order.quantity * order.unitPrice }
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
  return JSON.stringify({ totalRevenue: paid.reduce((sum, order) => sum + order.quantity * order.unitPrice, 0), topCustomer: top, monthlyTotals: months })
}

const GOOD: Record<string, EvaluationRun> = {
  slugify: { answer: '```js\nexport function slugify(text) {\n  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(\'-\')\n}\n```' },
  'lru-cache': { answer: 'export class LRUCache {\n  #map = new Map()\n  constructor(capacity) { this.capacity = capacity }\n  get size() { return this.#map.size }\n  get(key) { if (!this.#map.has(key)) return undefined; const value = this.#map.get(key); this.#map.delete(key); this.#map.set(key, value); return value }\n  put(key, value) { this.#map.delete(key); this.#map.set(key, value); if (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value) }\n}' },
  'merge-intervals': { answer: 'export function mergeIntervals(intervals) {\n  const sorted = intervals.map(pair => [...pair]).sort((a, b) => a[0] - b[0]), out = []\n  for (const pair of sorted) { const last = out[out.length - 1]; if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]); else out.push(pair) }\n  return out\n}' },
  'leap-year-bug': { answer: 'export function daysInMonth(year, month) {\n  return new Date(year, month, 0).getDate()\n}\nexport function isLeapYear(year) {\n  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)\n}' },
  'pagination-bug': { answer: 'export function page(items, pageNumber, pageSize) {\n  const start = (pageNumber - 1) * pageSize\n  return items.slice(start, start + pageSize)\n}\nexport function pageCount(total, pageSize) {\n  return Math.ceil(total / pageSize)\n}' },
  'add-clamp-feature': { answer: 'done', files: {
    'src/math.mjs': 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b\nexport const clamp = (value, min, max) => Math.min(max, Math.max(min, value))\n',
    'src/index.mjs': "export { add, sub, clamp } from './math.mjs'\n",
    'CHANGELOG.md': '# Changelog\n\n## Unreleased\n- clamp(value, min, max)\n\n## 1.0.0\n- add, sub\n',
  } },
  'orders-report': { answer: 'done', files: { 'report.mjs': REPORT, 'out/report.json': reportJson() } },
  'predict-output': { answer: '4+6' },
  'find-definition': { answer: '`src/billing/rates.js`' },
  'count-paid-rows': { answer: 'done', files: { 'out/summary.json': '{"paid": 4}\n' } },
  'log-timeouts': { answer: '3' },
  'reconcile-sources': { answer: '100; notes/blog-post.md' },
  'extract-meeting': { answer: '{"title": "Quarterly planning", "date": "2026-10-14", "attendees": ["Chen", "Maria", "Ola"], "durationMinutes": 90}' },
  'classify-lines': { answer: '[{"line":1,"level":"warn"},{"line":2,"level":"info"},{"line":3,"level":"error"}]' },
}
const BAD: Record<string, EvaluationRun> = {
  slugify: { answer: 'export const slugify = text => text.toLowerCase().replace(/\\s+/g, \'-\')' },
  'lru-cache': { answer: 'export class LRUCache { constructor() { this.map = new Map() } get size() { return this.map.size } get(key) { return this.map.get(key) } put(key, value) { this.map.set(key, value) } }' },
  'merge-intervals': { answer: 'export const mergeIntervals = intervals => intervals.sort((a, b) => a[0] - b[0])' },
  'add-clamp-feature': { answer: 'done', files: { 'src/math.mjs': 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b\nexport const clamp = (value, min, max) => Math.min(max, Math.max(min, value))\n', 'src/index.mjs': "export { add, sub, clamp } from './math.mjs'\n" } },
  'orders-report': { answer: 'done', files: { 'report.mjs': REPORT.replace("order.status === 'paid'", "order.status !== 'refunded'"), 'out/report.json': reportJson() } },
  'predict-output': { answer: '2+4+6' },
  'find-definition': { answer: 'src/billing/shipping.js' },
  'count-paid-rows': { answer: 'done', files: { 'out/summary.json': '{"paid": 5}' } },
  'log-timeouts': { answer: '4' },
  'reconcile-sources': { answer: '60; notes/changelog.md' },
  'extract-meeting': { answer: '{"title": "Quarterly planning", "date": "2026-10-14", "attendees": ["Maria", "Chen", "Ola"], "durationMinutes": 90}' },
  'classify-lines': { answer: '[{"line":1,"level":"error"},{"line":2,"level":"info"},{"line":3,"level":"error"}]' },
}

describe('default suite checks', () => {
  const suite = validateSuite(defaultSuite)
  it('every job has a reference answer here', () => expect(Object.keys(GOOD).sort()).toEqual(suite.jobs.map(job => job.id).sort()))
  for (const job of suite.jobs) {
    it(`${job.id}: a correct answer passes and a wrong one fails`, async () => {
      expect(await grade(job, GOOD[job.id]!, command), 'correct answer').toMatchObject({ pass: true })
      // The unmodified fixture is the wrong answer to a bug-fixing job.
      const bad = BAD[job.id] ?? { answer: Object.values(job.files ?? {})[0] ?? 'wrong' }
      expect(await grade(job, bad, command), 'wrong answer').toMatchObject({ pass: false })
    }, 30_000)
  }
})
