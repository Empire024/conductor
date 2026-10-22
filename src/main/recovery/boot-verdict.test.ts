import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BootRecord } from '../boot-diagnostics'
import { bootVerdict, readBootVerdict } from './boot-verdict'

interface Case { name: string; input: Record<string, unknown> & { record: string | null; now: number }; nowIso?: string; expect: Record<string, unknown> }
const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../scripts/meta-wizard/boot-verdict-cases.json'), 'utf8')) as { records: Record<string, BootRecord>; cases: Case[] }

describe('boot verdict: the shared cases (scripts/meta-wizard/boot.mjs passes the same)', () => {
  for (const entry of fixture.cases) {
    it(entry.name, () => {
      const record = entry.input.record ? fixture.records[entry.input.record]! : null
      const now = entry.nowIso ? Date.parse(entry.nowIso) : entry.input.now
      const verdict = bootVerdict({ ...entry.input, record, now } as Parameters<typeof bootVerdict>[0])
      expect({ state: verdict.state, stage: verdict.stage, cause: verdict.cause, signature: verdict.signature, line: verdict.line }).toEqual(entry.expect)
    })
  }
})

describe('readBootVerdict: which record belongs to the launch asked about', () => {
  let userData = ''
  afterEach(() => { if (userData) rmSync(userData, { recursive: true, force: true }) })
  const setup = (): string => {
    userData = mkdtempSync(join(tmpdir(), 'boot-verdict-'))
    mkdirSync(join(userData, 'diagnostics'))
    return join(userData, 'diagnostics')
  }

  it('reads boot.json when it is that launch, and the filed failure or the history line when a later launch replaced it', () => {
    const directory = setup()
    const failed = fixture.records.oomStore!
    writeFileSync(join(directory, 'boot.json'), JSON.stringify(fixture.records.ready))
    writeFileSync(join(directory, 'boot-last-failure.json'), JSON.stringify({ ...failed, lastSample: { schema: 1, pid: failed.pid, at: failed.stageAt, ms: 4100, rssMb: 4300, heapMb: 3905, mainBeatAgoMs: 3000, stage: 'structured-store' } }))
    writeFileSync(join(directory, 'boot-history.jsonl'), `${JSON.stringify({ pid: 42, version: '0.1.57', startedAt: '2026-10-22T08:00:00.000Z', outcome: 'died', stage: 'db-migrations', ms: 900, peakHeapMb: 3950, cause: 'oom' })}\n`)

    expect(readBootVerdict(userData, { pid: 800, alive: true }).state).toBe('ready')
    expect(readBootVerdict(userData, { pid: null, alive: true }).state).toBe('ready')
    expect(readBootVerdict(userData, { pid: failed.pid, alive: false }).line).toMatch(/^died in stage structured-store 4\.1 s after start: V8 heap out of memory \(heap 3\.8 GB/)
    expect(readBootVerdict(userData, { pid: 42, alive: false })).toMatchObject({ state: 'died', stage: 'db-migrations', cause: 'oom', signature: 'died:db-migrations:oom' })
    expect(readBootVerdict(userData, { pid: 43, alive: false, exitCode: 70 }).line).toBe('died before writing boot diagnostics (before the single-instance lock, or a build without them): exited with exit code 70')
  })

  it('a profile with no diagnostics at all is unknown, never an exception', () => {
    userData = mkdtempSync(join(tmpdir(), 'boot-verdict-'))
    expect(readBootVerdict(userData, { pid: 5, alive: false })).toMatchObject({ state: 'unknown', cause: null })
  })
})
