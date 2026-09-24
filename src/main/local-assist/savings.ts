import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { savedTokens, type SavingsLedger, type SavingsRecord, type SavingsSummary } from './contract.ts'

/**
 * The local-assist savings ledger: one JSON line per tool call, appended synchronously so a crash
 * loses at most the line being written. Read back as a rolling window; a malformed line (a torn
 * write, a hand edit) is skipped rather than failing the summary. Past `maxBytes` the file is
 * rewritten with only the last KEEP_DAYS days, so it never grows without bound.
 */

const DAY_MS = 86_400_000
const KEEP_DAYS = 30
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export const emptySavings = (days: number, now: Date): SavingsSummary => ({
  since: new Date(now.getTime() - days * DAY_MS).toISOString(), through: now.toISOString(), days,
  calls: 0, modelCalls: 0, rawChars: 0, returnedChars: 0, localInputTokens: 0, localOutputTokens: 0, tokensSaved: 0
})

const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const parse = (line: string): { record: SavingsRecord; time: number } | null => {
  if (!line.trim()) return null
  try {
    const record = JSON.parse(line) as SavingsRecord
    const time = typeof record?.at === 'string' ? Date.parse(record.at) : NaN
    return Number.isFinite(time) ? { record, time } : null
  } catch { return null }
}

export class FileSavingsLedger implements SavingsLedger {
  private readonly file: string
  private readonly maxBytes: number

  constructor(file: string, options: { maxBytes?: number } = {}) {
    this.file = file
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  record(entry: Omit<SavingsRecord, 'at'> & { at?: string }): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() }) + '\n')
      if (statSync(this.file).size > this.maxBytes) this.prune(new Date())
    } catch (error) { console.warn(`[local-assist] savings ledger write failed: ${error instanceof Error ? error.message : String(error)}`) }
  }

  summary(days = 7, now = new Date()): SavingsSummary {
    const summary = emptySavings(days, now)
    const from = now.getTime() - days * DAY_MS, through = now.getTime()
    for (const { record, time } of this.read()) {
      if (time < from || time > through) continue
      const raw = num(record.rawChars), returned = num(record.returnedChars)
      summary.calls++
      if (record.usedModel === true) summary.modelCalls++
      summary.rawChars += raw
      summary.returnedChars += returned
      summary.localInputTokens += num(record.localInputTokens)
      summary.localOutputTokens += num(record.localOutputTokens)
      summary.tokensSaved += savedTokens(raw, returned)
    }
    return summary
  }

  private read(): Array<{ record: SavingsRecord; time: number; line: string }> {
    try {
      if (!existsSync(this.file)) return []
      return readFileSync(this.file, 'utf8').split(/\r?\n/).flatMap(line => { const parsed = parse(line); return parsed ? [{ ...parsed, line }] : [] })
    } catch { return [] }
  }

  /** Keep the last KEEP_DAYS days; if that alone is still over the cap, keep the newest half of it,
   *  so a busy month does not make every later record rewrite the file. */
  private prune(now: Date): void {
    const from = now.getTime() - KEEP_DAYS * DAY_MS
    let kept = this.read().filter(entry => entry.time >= from).map(entry => entry.line)
    let bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    if (bytes > this.maxBytes) {
      let first = 0
      while (first < kept.length && bytes > this.maxBytes / 2) bytes -= Buffer.byteLength(kept[first++]!) + 1
      kept = kept.slice(first)
    }
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, kept.map(line => line + '\n').join(''))
    renameSync(temp, this.file)
  }
}
