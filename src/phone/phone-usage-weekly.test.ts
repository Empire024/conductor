import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The Usage screen's Weekly section (GET /api/usage/weekly, an AllowanceWeekReport from
// src/shared/usage-weeks.ts) rendered by the real app.js in a minimal fake DOM. Layout (320 px
// overflow) is not measurable here; scripts/smoke-phone-shell.mjs checks it in a real window.
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')

class Node {
  className = ''; tagName: string; hidden = false; disabled = false; value = ''; dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}; children: Node[] = []; parentNode: Node | null = null; text = ''
  listeners: Record<string, Array<() => unknown>> = {}; style: Record<string, unknown> = { setProperty: () => undefined }
  constructor(tag: string) { this.tagName = tag.toUpperCase() }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(' ') }
  set textContent(value: string) { this.text = String(value); this.children = [] }
  get firstChild(): Node | null { return this.children[0] || null }
  get childNodes() { return this.children }
  get classList() { return {
    add: (name: string) => { this.className += ' ' + name },
    toggle: (name: string, on: boolean) => { this.className = this.className.split(' ').filter(entry => entry !== name).concat(on ? [name] : []).join(' ') }
  } }
  appendChild(node: Node) { if (node.parentNode) node.parentNode.removeChild(node); this.children.push(node); node.parentNode = this; return node }
  insertBefore(node: Node, before: Node | null) { if (!before) return this.appendChild(node); if (node.parentNode) node.parentNode.removeChild(node); this.children.splice(this.children.indexOf(before), 0, node); node.parentNode = this; return node }
  removeChild(node: Node) { this.children = this.children.filter(entry => entry !== node); node.parentNode = null; return node }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
  addEventListener(name: string, fn: () => unknown) { (this.listeners[name] ||= []).push(fn) }
  all(): Node[] { return this.children.flatMap(node => [node, ...node.all()]) }
  querySelectorAll(selector: string) { return this.all().filter(node => node.className.split(' ').includes(selector.slice(1))) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null }
}

const harness = (respond: (path: string) => unknown) => {
  const root = new Node('div'), documentElement = new Node('html')
  const location = { pathname: '/', search: '', origin: 'https://phone.test', hash: '#/usage' }
  const history = { state: null, replaceState: () => undefined, pushState: () => undefined, back: () => undefined, go: () => undefined }
  const document = { documentElement, createElement: (tag: string) => new Node(tag), createElementNS: (_: string, tag: string) => new Node(tag), activeElement: null, visibilityState: 'visible' }
  const fetch = async (path: string) => {
    const data = await respond(path)
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  }
  const window: any = { location, history, navigator: {}, localStorage: { getItem: () => null, setItem: () => undefined }, ConductorBoot: {}, document }
  const instrumented = source.replace(/  if \(document.readyState === 'loading'\)[\s\S]*?\n\}\)\(\)\s*$/, `
    window.test = { state, usageScreen, init: () => { appRoot = window.root; tabBar = buildTabBar(); state.token = 'paired' } };
  })()`)
  window.root = root
  runInNewContext(instrumented, { window, document, navigator: window.navigator, fetch, setTimeout: () => 0, clearTimeout: () => undefined, AbortController, Intl })
  window.test.init()
  return window.test
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

const DAY = 86_400_000
const at = (offset: number) => new Date(Date.now() + offset).toISOString()
const base = { scope: 'provider', windowMinutes: 10_080, readings: 20, firstReadingAt: at(-20 * DAY), unusedPercent: null, coverage: 'complete', notes: [] as string[], usedUp: false, usedUpAt: null }
const tokens = (costUsd: number | null) => ({ models: [{ model: 'claude-opus-5-5', processedTokens: 1_250_000, conversations: 4, estimated: true }], processedTokens: 1_250_000, totalTokens: 1_300_000, costUsd, costEstimated: true, complete: true, notes: [] })
const report = {
  generatedAt: at(0),
  recordedSince: at(-40 * DAY),
  unknown: ['Grok reports no weekly allowance.'],
  weeks: [
    { ...base, provider: 'claude', bucket: 'seven_day', label: 'Weekly', status: 'current', startsAt: at(-3 * DAY), endsAt: at(4 * DAY), lastReadingAt: at(-3_600_000), peakPercent: 42, finalPercent: 42, projection: { percentAtReset: 98, usedUpAt: null, basis: '42% in 3 d' }, tokens: tokens(14.2) },
    { ...base, provider: 'claude', bucket: 'seven_day', label: 'Weekly', status: 'closed', startsAt: at(-10 * DAY), endsAt: at(-3 * DAY), lastReadingAt: at(-3.2 * DAY), peakPercent: 100, finalPercent: 100, usedUp: true, usedUpAt: at(-4 * DAY), unusedPercent: 0, tokens: tokens(31.5) },
    { ...base, provider: 'claude', bucket: 'seven_day', label: 'Weekly', status: 'closed', startsAt: at(-17 * DAY), endsAt: at(-10 * DAY), lastReadingAt: at(-11 * DAY), peakPercent: 69, finalPercent: 69, unusedPercent: 31, coverage: 'partial', notes: ['Last reading 1 d 0 h before the reset; use after it is not known.'] },
    { ...base, provider: 'claude', bucket: 'seven_day', label: 'Weekly', status: 'no-data', startsAt: at(-24 * DAY), endsAt: at(-17 * DAY), readings: 0, firstReadingAt: null, lastReadingAt: null, peakPercent: null, finalPercent: null, coverage: 'none', notes: ['No readings from 2026-09-01T00:00:00.000Z to 2026-09-08T00:00:00.000Z; use in this stretch is unknown.'] },
    { ...base, provider: 'claude', bucket: 'fable', label: 'Fable weekly', scope: 'model', models: ['fable'], status: 'current', startsAt: at(-5 * DAY), endsAt: at(2 * DAY), lastReadingAt: at(-60_000), peakPercent: 80, finalPercent: 80, projection: { percentAtReset: 112, usedUpAt: at(DAY), basis: '80% in 5 d' } },
    { ...base, provider: 'codex', bucket: 'codex:primary', label: 'Weekly', status: 'closed', startsAt: at(-9 * DAY), endsAt: at(-2 * DAY), lastReadingAt: at(-2.1 * DAY), peakPercent: 88, finalPercent: 88, unusedPercent: 12 }
  ]
}
const usage = { providers: [{ provider: 'claude', windows: [], unknown: [] }], allowance: [] }

describe('phone Usage weekly allowance report', () => {
  it('renders one card per provider bucket with verdicts, bars, tokens and cost', async () => {
    const api = harness(path => path === '/api/usage/weekly' ? report : usage)
    const view = api.usageScreen(); await settle()
    const cards = view.root.querySelectorAll('.weekly-card')
    expect(cards.map((card: Node) => card.querySelector('.card-title')!.textContent)).toEqual(['Claude · Weekly', 'Claude · Fable weekly', 'Codex · Weekly'])
    const [claude, fable, codex] = cards
    const verdicts = claude.querySelectorAll('.weekly-verdict').map((row: Node) => row.textContent)
    expect(verdicts[0]).toBe('42% so far · on pace for 98% at reset')
    expect(verdicts[1]).toMatch(/^Used up on /)
    expect(verdicts[2]).toMatch(/^31% left unused \(last reading .+\)$/)
    expect(verdicts[3]).toMatch(/^No readings from .+; use in this stretch is unknown\.$/)
    expect(verdicts[3]).not.toContain('T00:00:00')
    const rows = claude.querySelectorAll('.weekly-row')
    expect(rows[0].textContent).toContain('This week')
    expect(rows[3].querySelector('.weekly-status')!.textContent).toBe('No readings')
    expect(rows[3].querySelector('.weekly-bar')!.className).toContain('weekly-bar-empty')
    expect(rows[1].querySelector('.bar-fill')!.className).toContain('hot')
    expect(rows[0].querySelector('.bar-fill')!.style.width).toBe('42%')
    expect(rows[2].querySelectorAll('.weekly-note').map((row: Node) => row.textContent)).toEqual(['Last reading 1 d 0 h before the reset; use after it is not known.'])
    expect(rows[0].querySelector('.weekly-tokens')!.textContent).toMatch(/1\.3M tokens · ≈ \$14\.20 · claude-opus-5-5/)
    expect(claude.textContent).toContain('Cost is the provider CLI’s API-price estimate, not a charge.')
    expect(fable.querySelector('.weekly-verdict')!.textContent).toMatch(/^80% so far · on pace to run out /)
    expect(fable.textContent).not.toContain('Cost is the provider')
    expect(codex.querySelector('.weekly-verdict')!.textContent).toBe('12% left unused')
    expect(view.root.textContent).toContain('Grok reports no weekly allowance.')
    expect(view.root.textContent).toContain('Recorded since ')
  })

  it('says too early to project when a current week has no projection', async () => {
    const week = { ...report.weeks[0], projection: null, tokens: null }
    const api = harness(path => path === '/api/usage/weekly' ? { ...report, weeks: [week] } : usage)
    const view = api.usageScreen(); await settle()
    expect(view.root.querySelector('.weekly-verdict')!.textContent).toBe('42% so far · too early to project')
    expect(view.root.querySelector('.weekly-tokens')).toBeNull()
  })

  it('keeps the provider cards when the weekly report fails', async () => {
    const api = harness(path => { if (path === '/api/usage/weekly') throw new Error('Weekly broke'); return usage })
    const view = api.usageScreen(); await settle()
    expect(view.root.textContent).toContain('Allowance unknown')
    expect(view.root.querySelector('.weekly-problem')!.textContent).toBe('Weekly report unavailable: Weekly broke')
    expect(view.root.querySelectorAll('.weekly-card')).toHaveLength(0)
  })
})
