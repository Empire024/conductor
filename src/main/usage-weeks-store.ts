import type { DatabaseSync } from 'node:sqlite'
import type { StructuredProvider } from '../shared/structured-agent'
import type { AccountLimitsReport } from '../shared/usage-accounting'
import { allowanceReadings, type AllowanceReading, type AllowanceWeek, type WeekTokens } from '../shared/usage-weeks'

const DAY_MS = 86_400_000
/** Readings older than this are pruned; closed weeks keep their summary in `usage_weeks`. */
export const READING_RETENTION_MS = 400 * DAY_MS
/** Closed weeks kept per bucket (at least 26 weeks are promised; two years cost a few kilobytes). */
export const WEEK_RETENTION = 104
/** An unchanged reading is still written this often, so the last reading before a reset is recent. */
const HEARTBEAT_MS = 60 * 60_000

/**
 * The weekly allowance history: every weekly reading a provider reported (deduplicated: a new row
 * only when the use or the reset moved, or an hour passed), and each closed window's summary with
 * the tokens Conductor recorded in it. Two small tables beside the journal; no query here touches
 * `structured_events`.
 */
export class UsageWeeksStore {
  private last = new Map<string, AllowanceReading>()
  private pruned = 0
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS allowance_readings (
        provider TEXT NOT NULL, bucket TEXT NOT NULL, at INTEGER NOT NULL, used_percent REAL NOT NULL,
        resets_at INTEGER, window_minutes INTEGER, label TEXT NOT NULL, scope TEXT NOT NULL, models_json TEXT,
        PRIMARY KEY(provider, bucket, at)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS allowance_readings_time ON allowance_readings(at);
      CREATE TABLE IF NOT EXISTS usage_weeks (
        provider TEXT NOT NULL, bucket TEXT NOT NULL, ends_at TEXT NOT NULL, starts_at TEXT,
        summary_json TEXT NOT NULL, tokens_json TEXT, written_at TEXT NOT NULL,
        PRIMARY KEY(provider, bucket, ends_at)
      );
      CREATE TABLE IF NOT EXISTS usage_weeks_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  /** Records the weekly windows of one provider's newest report. Returns how many rows it wrote. */
  record(report: AccountLimitsReport, now = Date.now()): number {
    let written = 0
    for (const reading of allowanceReadings(report)) if (this.add(reading)) written++
    if (written && now - this.pruned > DAY_MS) this.prune(now)
    return written
  }

  /** Adds one reading unless it repeats the bucket's previous one. */
  add(reading: AllowanceReading, previous = this.previous(reading.provider, reading.bucket)): boolean {
    if (!Number.isFinite(reading.at) || !Number.isFinite(reading.usedPercent)) return false
    if (previous && reading.at <= previous.at) return false
    if (previous && previous.usedPercent === reading.usedPercent && previous.resetsAt === reading.resetsAt && previous.label === reading.label && reading.at - previous.at < HEARTBEAT_MS) return false
    this.db.prepare(`INSERT OR IGNORE INTO allowance_readings(provider,bucket,at,used_percent,resets_at,window_minutes,label,scope,models_json) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(reading.provider, reading.bucket, Math.round(reading.at), reading.usedPercent, reading.resetsAt, reading.windowMinutes, reading.label, reading.scope, reading.models?.length ? JSON.stringify(reading.models) : null)
    this.last.set(reading.provider + '\0' + reading.bucket, reading)
    return true
  }

  private previous(provider: StructuredProvider, bucket: string): AllowanceReading | undefined {
    const key = provider + '\0' + bucket
    if (!this.last.has(key)) {
      const row = this.db.prepare('SELECT * FROM allowance_readings WHERE provider=? AND bucket=? ORDER BY at DESC LIMIT 1').get(provider, bucket) as Record<string, unknown> | undefined
      if (row) this.last.set(key, readingRow(row))
    }
    return this.last.get(key)
  }

  /** Readings since `sinceMs`, oldest first. */
  readings(provider?: StructuredProvider, sinceMs = 0): AllowanceReading[] {
    const rows = (provider
      ? this.db.prepare('SELECT * FROM allowance_readings WHERE at>=? AND provider=? ORDER BY at').all(sinceMs, provider)
      : this.db.prepare('SELECT * FROM allowance_readings WHERE at>=? ORDER BY at').all(sinceMs)) as Array<Record<string, unknown>>
    return rows.map(readingRow)
  }

  earliestReading(): number | null {
    const row = this.db.prepare('SELECT MIN(at) AS at FROM allowance_readings').get() as { at: number | null } | undefined
    return row?.at ?? null
  }

  /** A closed week as it was last written, with its tokens if they were measured. */
  closedWeek(provider: StructuredProvider, bucket: string, endsAt: string): { week: AllowanceWeek; tokens: WeekTokens | null } | null {
    const row = this.db.prepare('SELECT summary_json,tokens_json FROM usage_weeks WHERE provider=? AND bucket=? AND ends_at=?').get(provider, bucket, endsAt) as { summary_json: string; tokens_json: string | null } | undefined
    if (!row) return null
    try { return { week: JSON.parse(row.summary_json) as AllowanceWeek, tokens: row.tokens_json ? JSON.parse(row.tokens_json) as WeekTokens : null } }
    catch { return null }
  }

  closedWeeks(provider?: StructuredProvider): AllowanceWeek[] {
    const rows = (provider
      ? this.db.prepare('SELECT summary_json,tokens_json FROM usage_weeks WHERE provider=? ORDER BY ends_at DESC').all(provider)
      : this.db.prepare('SELECT summary_json,tokens_json FROM usage_weeks ORDER BY ends_at DESC').all()) as Array<{ summary_json: string; tokens_json: string | null }>
    return rows.flatMap(row => {
      try { return [{ ...JSON.parse(row.summary_json) as AllowanceWeek, tokens: row.tokens_json ? JSON.parse(row.tokens_json) as WeekTokens : null }] }
      catch { return [] }
    })
  }

  /** Writes a closed week's summary (and tokens, once measured). */
  writeClosedWeek(week: AllowanceWeek, tokens: WeekTokens | null, now = Date.now()): void {
    if (week.status !== 'closed' || !week.endsAt) return
    const { tokens: _ignored, ...summary } = week
    this.db.prepare(`INSERT INTO usage_weeks(provider,bucket,ends_at,starts_at,summary_json,tokens_json,written_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(provider,bucket,ends_at) DO UPDATE SET starts_at=excluded.starts_at, summary_json=excluded.summary_json,
        tokens_json=COALESCE(excluded.tokens_json, usage_weeks.tokens_json), written_at=excluded.written_at`)
      .run(week.provider, week.bucket, week.endsAt, week.startsAt, JSON.stringify(summary), tokens ? JSON.stringify(tokens) : null, new Date(now).toISOString())
  }

  prune(now = Date.now()): void {
    this.pruned = now
    this.db.prepare('DELETE FROM allowance_readings WHERE at<?').run(now - READING_RETENTION_MS)
    this.db.prepare(`DELETE FROM usage_weeks WHERE rowid IN (SELECT rowid FROM (
      SELECT rowid, ROW_NUMBER() OVER (PARTITION BY provider,bucket ORDER BY ends_at DESC) AS n FROM usage_weeks) WHERE n>?)`).run(WEEK_RETENTION)
  }

  meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM usage_weeks_meta WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO usage_weeks_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }
}

function readingRow(row: Record<string, unknown>): AllowanceReading {
  let models: string[] | undefined
  if (typeof row.models_json === 'string') try { models = JSON.parse(row.models_json) as string[] } catch { /* a malformed list names no models */ }
  return {
    provider: row.provider as StructuredProvider, bucket: String(row.bucket), label: String(row.label), scope: row.scope === 'model' ? 'model' : 'provider',
    ...(models?.length ? { models } : {}), at: Number(row.at), usedPercent: Number(row.used_percent),
    resetsAt: row.resets_at === null || row.resets_at === undefined ? null : Number(row.resets_at),
    windowMinutes: row.window_minutes === null || row.window_minutes === undefined ? null : Number(row.window_minutes)
  }
}
