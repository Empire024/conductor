import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavingsRecord } from './contract.ts'
import { emptySavings, FileSavingsLedger } from './savings.ts'

const DAY = 86_400_000
const NOW = new Date('2026-09-24T12:00:00.000Z')
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString()
const entry = (at: string, over: Partial<SavingsRecord> = {}): SavingsRecord => ({
  at, tool: 'run_and_summarize', projectId: 'p1', agentSessionId: 's1', provider: 'claude',
  rawChars: 40_000, returnedChars: 2_000, localInputTokens: 10_000, localOutputTokens: 300, usedModel: true, model: 'local/qwen3.5-9b', ...over
})

const dirs: string[] = []
const ledgerFile = (): string => { const dir = mkdtempSync(join(tmpdir(), 'savings-')); dirs.push(dir); return join(dir, 'nested', 'savings.jsonl') }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('savings ledger', () => {
  it('records JSON lines (creating the directory) and sums the rolling window', () => {
    const file = ledgerFile()
    const ledger = new FileSavingsLedger(file)
    ledger.record(entry(ago(1)))
    ledger.record(entry(ago(3), { usedModel: false, rawChars: 8_000, returnedChars: 8_400, localInputTokens: 0, localOutputTokens: 0 }))
    ledger.record(entry(ago(8)))
    ledger.record(entry(new Date(NOW.getTime() + 60_000).toISOString()))
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4)
    expect(ledger.summary(7, NOW)).toEqual({
      since: ago(7), through: NOW.toISOString(), days: 7, calls: 2, modelCalls: 1,
      rawChars: 48_000, returnedChars: 10_400, localInputTokens: 10_000, localOutputTokens: 300,
      tokensSaved: 9_500 // (40000 - 2000) / 4; the fallback returned more than it read, so it saved nothing
    })
    expect(ledger.summary(30, NOW).calls).toBe(3)
  })

  it('stamps an entry without a time', () => {
    const ledger = new FileSavingsLedger(ledgerFile())
    const { at: _, ...rest } = entry(ago(0))
    ledger.record(rest)
    expect(ledger.summary(1).calls).toBe(1)
  })

  it('skips malformed lines and is zero for a missing ledger', () => {
    const file = ledgerFile()
    const ledger = new FileSavingsLedger(file)
    expect(ledger.summary(7, NOW)).toEqual(emptySavings(7, NOW))
    ledger.record(entry(ago(1)))
    appendFileSync(file, '{"at":"2026-09-2\n\nnot json\n{"at":"garbage","rawChars":1}\nnull\n')
    ledger.record(entry(ago(2), { rawChars: 'x' as unknown as number }))
    const summary = ledger.summary(7, NOW)
    expect(summary.calls).toBe(2)
    expect(summary.rawChars).toBe(40_000)
  })

  it('prunes to the last 30 days once the file passes the cap', () => {
    const file = ledgerFile()
    const ledger = new FileSavingsLedger(file, { maxBytes: 4_000 })
    ledger.record(entry(ago(61)))
    for (let i = 0; i < 40; i++) appendFileSync(file, JSON.stringify(entry(ago(62 + i))) + '\n')
    expect(statSync(file).size).toBeGreaterThan(4_000)
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try {
      ledger.record(entry(ago(2)))
      ledger.record(entry(ago(1)))
    } finally { vi.useRealTimers() }
    expect(statSync(file).size).toBeLessThan(4_000)
    expect(ledger.summary(365, NOW).calls).toBe(2)
  })

  it('drops the oldest recent lines when thirty days alone exceed the cap', () => {
    const file = ledgerFile()
    const ledger = new FileSavingsLedger(file, { maxBytes: 3_000 })
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try { for (let i = 20; i > 0; i--) ledger.record(entry(ago(i))) } finally { vi.useRealTimers() }
    expect(statSync(file).size).toBeLessThanOrEqual(3_000)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as SavingsRecord)
    expect(lines.at(-1)!.at).toBe(ago(1))
    expect(lines.length).toBeGreaterThan(1)
  })

  it('swallows a write failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'savings-')); dirs.push(dir)
    // The ledger path is a directory: the append fails.
    expect(() => new FileSavingsLedger(dir).record(entry(ago(0)))).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
