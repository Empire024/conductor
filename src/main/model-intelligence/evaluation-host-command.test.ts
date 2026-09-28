import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { ExecutionOutcome, ModelKey } from '../../shared/model-routing'
import { evaluate, type CommandRequest, type EvaluationPorts, type EvaluationSuite } from './evaluation'
import { hostCommandPort, NO_NETWORK_PRELOAD } from './evaluation-ports'
import { bundledSuites } from './index'

/** The host command runner (hostCommandPort) on this test's own Node: real processes, no mocks. */

const request = (files: Record<string, string>, extra: Partial<CommandRequest> = {}): CommandRequest => ({ cmd: 'node', args: ['check.mjs'], timeoutSec: 20, files, ...extra })

describe('hostCommandPort: a confined node check on the host', () => {
  it('runs node <script> in a throwaway folder: exit code and output tail back, the folder removed', async () => {
    const port = (await hostCommandPort())!
    expect(port).toBeTypeOf('function')
    const passed = await port(request({ 'check.mjs': "import { v } from './lib/v.mjs'\nif (v !== 2) process.exit(1)\nconsole.log(process.cwd())", 'lib/v.mjs': 'export const v = 2' }))
    expect(passed).toMatchObject({ exitCode: 0, timedOut: false })
    const folder = passed.output!.trim()
    expect(folder).toContain('conductor-eval-')
    expect(existsSync(folder)).toBe(false)
    const failed = await port(request({ 'check.mjs': "import assert from 'node:assert/strict'\nassert.equal(1, 2)" }))
    expect(failed.exitCode).toBe(1)
    expect(failed.output).toMatch(/AssertionError/)
  })
  it('allows no network, no reads outside its folder, no writes, no child processes, and no secrets from the environment', async () => {
    const port = (await hostCommandPort())!
    const probe = [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const results = {}, attempt = async (name, run) => { try { await run(); results[name] = 'ALLOWED' } catch (error) { results[name] = error.code ?? error.message } }",
      "await attempt('net', async () => (await import('node:net')).connect(80, '127.0.0.1'))",
      "await attempt('listen', async () => (await import('node:http')).createServer().listen(0))",
      "await attempt('dns', async () => (await import('node:dns/promises')).lookup('localhost'))",
      "await attempt('fetch', () => fetch('http://127.0.0.1:1/'))",
      "await attempt('restore fetch', () => { Object.defineProperty(globalThis, 'fetch', { value: 1 }) })",
      "await attempt('read outside', () => readFileSync(process.execPath))",
      "await attempt('write', () => writeFileSync('x.txt', 'x'))",
      "await attempt('child', async () => (await import('node:child_process')).execSync('echo hi'))",
      "await attempt('worker', async () => { const { Worker } = await import('node:worker_threads'); new Worker('1', { eval: true }) })",
      "await attempt('binding', () => process.binding('tcp_wrap'))",
      "console.log(JSON.stringify({ results, path: process.env.PATH ?? null, secret: process.env.CONDUCTOR_TEST_SECRET ?? null, options: process.env.NODE_OPTIONS ?? null }))",
    ].join('\n')
    process.env.CONDUCTOR_TEST_SECRET = 'do-not-leak'
    try {
      const run = await port(request({ 'check.mjs': probe }))
      expect(run.exitCode).toBe(0)
      const seen = JSON.parse(run.output!.trim().split('\n').at(-1)!)
      expect(Object.values(seen.results).filter(value => value === 'ALLOWED')).toEqual([])
      expect(seen.results).toMatchObject({ net: 'ERR_ACCESS_DENIED', listen: 'ERR_ACCESS_DENIED', dns: 'ERR_ACCESS_DENIED', fetch: 'ERR_ACCESS_DENIED', 'read outside': 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', child: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED', binding: 'ERR_ACCESS_DENIED' })
      expect(seen).toMatchObject({ path: '', secret: null, options: null })
    } finally { delete process.env.CONDUCTOR_TEST_SECRET }
  })
  it('kills a check at its timeout', async () => {
    const port = (await hostCommandPort())!
    const started = Date.now()
    const run = await port(request({ 'check.mjs': 'for (;;) {}' }, { timeoutSec: 1 }))
    expect(run).toMatchObject({ exitCode: null, timedOut: true })
    expect(Date.now() - started).toBeLessThan(15_000)
  })
  it('runs only `node <relative script>`: another program, or a Node option as the script, is refused before anything runs', async () => {
    const port = (await hostCommandPort())!
    await expect(port(request({ 'check.mjs': '' }, { cmd: 'python' }))).rejects.toThrow(/Only node checks run on the host/)
    await expect(port(request({ 'check.mjs': '' }, { args: ['--allow-child-process', 'check.mjs'] }))).rejects.toThrow(/relative path of its script/)
    await expect(port(request({ 'check.mjs': '' }, { args: ['../check.mjs'] }))).rejects.toThrow(/relative path of its script/)
    await expect(port(request({ '../escape.mjs': '' }))).rejects.toThrow(/leaves the job folder/)
  })
  it('runs confined on the Electron runtime the app uses (ELECTRON_RUN_AS_NODE)', async () => {
    const electron = createRequire(import.meta.url)('electron') as unknown as string
    if (typeof electron !== 'string' || !existsSync(electron)) return
    const port = (await hostCommandPort({ command: electron, env: { ELECTRON_RUN_AS_NODE: '1' } }))!
    expect(port).toBeTypeOf('function')
    const run = await port(request({ 'check.mjs': "let blocked = 0\nfor (const attempt of [() => fetch('http://127.0.0.1:1/'), async () => (await import('node:net')).connect(80, '127.0.0.1')]) { try { await attempt() } catch (error) { if (error.code === 'ERR_ACCESS_DENIED') blocked++ } }\nprocess.exit(blocked === 2 ? 0 : 5)" }))
    expect(run).toMatchObject({ exitCode: 0 })
  }, 30_000)
  it('is not offered where the runtime fails the permission probe', async () => {
    // A runtime that ignores --permission exits non-zero on the probe (here: a node that is not there).
    expect(await hostCommandPort({ command: 'C:\\no\\such\\node.exe', env: {} })).toBeNull()
    expect(NO_NETWORK_PRELOAD).toContain("'use strict'")
  })
})

describe('the bundled suite\'s command jobs through one batched cloud turn and the host runner', () => {
  const suite = Object.values(bundledSuites())[0]!
  const commandJobs: EvaluationSuite = { name: suite.name, jobs: suite.jobs.filter(job => job.grader.kind === 'command') }
  const CLOUD: ModelKey = { provider: 'claude', model: 'sonnet' }
  const orders = JSON.parse(commandJobs.jobs.find(job => job.id === 'orders-report')!.files!['orders.json']!) as Array<{ customer: string; date: string; quantity: number; unitPrice: number; status: string }>
  const paid = orders.filter(order => order.status === 'paid'), value = (order: typeof paid[number]) => order.quantity * order.unitPrice
  const byCustomer: Record<string, number> = {}, months: Record<string, number> = {}
  for (const order of paid) { byCustomer[order.customer] = (byCustomer[order.customer] ?? 0) + value(order); months[order.date.slice(0, 7)] = (months[order.date.slice(0, 7)] ?? 0) + value(order) }
  const top = Object.entries(byCustomer).sort((a, b) => Math.round(b[1] * 100) - Math.round(a[1] * 100) || a[0].localeCompare(b[0]))[0]![0]
  const report = { totalRevenue: paid.reduce((sum, order) => sum + value(order), 0), topCustomer: top, monthlyTotals: months }
  /** What a correct model would answer, one section per job. */
  const reference: Record<string, string> = {
    slugify: "```js\nexport function slugify(text) { return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-') }\n```",
    'lru-cache': '```js\nexport class LRUCache {\n  constructor(capacity) { this.capacity = capacity; this.map = new Map() }\n  get size() { return this.map.size }\n  get(key) { if (!this.map.has(key)) return undefined; const value = this.map.get(key); this.map.delete(key); this.map.set(key, value); return value }\n  put(key, value) { this.map.delete(key); this.map.set(key, value); if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value) }\n}\n```',
    'merge-intervals': '```js\nexport function mergeIntervals(intervals) {\n  const sorted = intervals.map(pair => [...pair]).sort((a, b) => a[0] - b[0]), out = []\n  for (const [start, end] of sorted) { const last = out[out.length - 1]; if (last && start <= last[1]) last[1] = Math.max(last[1], end); else out.push([start, end]) }\n  return out\n}\n```',
    'leap-year-bug': '```dates.mjs\n/** month is 1..12 */\nexport function daysInMonth(year, month) {\n  return new Date(year, month, 0).getDate()\n}\nexport function isLeapYear(year) {\n  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)\n}\n```',
    'pagination-bug': '```paginate.mjs\nexport function page(items, pageNumber, pageSize) {\n  const start = (pageNumber - 1) * pageSize\n  return items.slice(start, start + pageSize)\n}\nexport function pageCount(total, pageSize) {\n  return Math.ceil(total / pageSize)\n}\n```',
    'add-clamp-feature': "```src/math.mjs\nexport const add = (a, b) => a + b\nexport const sub = (a, b) => a - b\nexport const clamp = (value, min, max) => Math.min(max, Math.max(min, value))\n```\n```src/index.mjs\nexport { add, sub, clamp } from './math.mjs'\n```\n```CHANGELOG.md\n# Changelog\n\n## Unreleased\n- clamp(value, min, max)\n\n## 1.0.0\n- add, sub\n```\ndone",
    'orders-report': "```report.mjs\nconst paid = orders => orders.filter(order => order.status === 'paid'), value = order => order.quantity * order.unitPrice\nexport const totalRevenue = orders => paid(orders).reduce((sum, order) => sum + value(order), 0)\nexport function topCustomer(orders) { const totals = {}; for (const order of paid(orders)) totals[order.customer] = (totals[order.customer] ?? 0) + value(order); return Object.entries(totals).sort((a, b) => Math.round(b[1] * 100) - Math.round(a[1] * 100) || a[0].localeCompare(b[0]))[0][0] }\nexport function monthlyTotals(orders) { const months = {}; for (const order of paid(orders)) months[order.date.slice(0, 7)] = (months[order.date.slice(0, 7)] ?? 0) + value(order); return months }\n```\n```out/report.json\n" + JSON.stringify(report) + '\n```\ndone',
  }
  const run = async (sections: Record<string, string>) => {
    const recorded: ExecutionOutcome[] = [], turns: string[] = []
    const command = (await hostCommandPort())!
    const ports: EvaluationPorts = {
      run: async (_key, batch) => { turns.push(batch.prompt); return { answer: Object.entries(sections).map(([id, body]) => `### JOB ${id}\n${body}`).join('\n\n'), tokens: 30_000 } },
      command, recordOutcome: row => { recorded.push(row) }, setStatus: () => {}, reputation: () => null, alternatives: () => [], writeReport: () => {}, now: () => new Date('2026-09-28T12:00:00Z'), fixedOverheadTokens: () => 7_000,
    }
    return { result: await evaluate(CLOUD, commandJobs, ports, { maxTokens: 60_000 }), recorded, turns }
  }

  it('grades all 7 correct answers as successes in one turn', async () => {
    expect(commandJobs.jobs.map(job => job.id)).toEqual(Object.keys(reference))
    const { result, recorded, turns } = await run(reference)
    expect(turns).toHaveLength(1)
    expect(result.jobs.map(job => [job.id, job.result, job.detail])).toEqual(commandJobs.jobs.map(job => [job.id, 'success', 'node exited 0']))
    expect(recorded.map(row => row.verifier)).toEqual(Array(7).fill('pass'))
  }, 60_000)
  it('fails wrong answers (the bugs left in, a missing file) on their checks, never as not-gradable', async () => {
    const wrong = { ...reference,
      'leap-year-bug': '```dates.mjs\nexport const daysInMonth = (y, m) => new Date(y, m, 0).getDate()\nexport const isLeapYear = y => y % 4 === 0 && y % 100 !== 0\n```',
      'orders-report': reference['orders-report']!.replace(/```out\/report\.json[\s\S]*?```/, ''),
      slugify: '```js\nexport const slugify = text => text\n```',
    }
    const { result } = await run(wrong)
    const byId = Object.fromEntries(result.jobs.map(job => [job.id, job]))
    for (const id of ['leap-year-bug', 'orders-report', 'slugify']) {
      expect(byId[id]!.result, id).toBe('failure')
      expect(byId[id]!.detail, id).toMatch(/^node exited 1, expected 0/)
    }
    expect(byId['lru-cache']!.result).toBe('success')
  }, 60_000)
})
