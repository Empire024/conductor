import { describe, expect, it } from 'vitest'
import { aggregateToolTimings, maskToolText, percentile, summarizeToolArgs, summarizeToolError, toolCategory, type ToolTimingRecord } from './tool-timings'

let n = 0
const record = (overrides: Partial<ToolTimingRecord> = {}): ToolTimingRecord => ({
  key: `k${++n}`, agentSessionId: 's1', projectId: 'p1', provider: 'codex', runtimeId: 'r', itemId: `i${n}`, tool: 'Bash', category: 'shell', args: 'npm test',
  startedAt: '2026-10-29T10:00:00.000Z', endedAt: `2026-10-29T10:00:${String(n % 60).padStart(2, '0')}.000Z`,
  elapsedMs: 1000, elapsedSource: 'host-monotonic', waitMs: null, waitSource: 'unavailable', execMs: 900, execSource: 'provider', prepareMs: null, outcome: 'completed', concurrent: 0, ...overrides
})
const context = { observedAt: '2026-10-29T11:00:00.000Z', inFlight: 0, storage: { records: 0, capacity: 5000, retentionDays: 14, recordedSince: null, deduplicated: 0, droppedOnLoad: 0, parseErrors: 0 } }

describe('summarizeToolArgs', () => {
  it('keeps the first command line, a path or a pattern, bounded', () => {
    expect(summarizeToolArgs('Bash', { command: 'git status\ngit diff', description: 'x' })).toBe('git status')
    expect(summarizeToolArgs('Read', { file_path: '/repo/src/a.ts', limit: 10 })).toBe('/repo/src/a.ts')
    expect(summarizeToolArgs('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO in src')
    expect(summarizeToolArgs('File change', [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }])).toBe('a, b, c +1')
    expect(summarizeToolArgs('Bash', { command: 'x'.repeat(10_000) })).toHaveLength(160)
    expect(summarizeToolArgs('mcp__x__y', { query: undefined, apiKey: 'v', mode: 1 })).toBe('{query, apiKey=[REDACTED], mode}')
    expect(summarizeToolArgs('Bash', undefined)).toBe('')
  })

  it('masks credentials in every form an agent passes them', () => {
    const masked = summarizeToolArgs('Bash', { command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx curl -H "Bearer sk-ant-abcdefghijklmnopqrst" https://bob:pa55@host/x --password hunter2 AKIAABCDEFGHIJKLMNOP' }, text => text.replace(/(Bearer\s+)\S+/g, '$1[REDACTED]'))
    for (const secret of ['ghp_abcdefghijklmnopqrstuvwx', 'sk-ant-abcdefghijklmnopqrst', 'pa55', 'hunter2', 'AKIAABCDEFGHIJKLMNOP']) expect(masked).not.toContain(secret)
    expect(masked).toContain('curl')
    expect(maskToolText('DB_PASSWORD="a b" npm start')).toBe('DB_PASSWORD=[REDACTED] npm start')
    expect(maskToolText('xoxb-123456789012-abc')).toBe('[REDACTED]')
  })

  it('names the meaningful line of a failure', () => {
    expect(summarizeToolError('compiling\nError: Cannot find module x\n  at y', undefined)).toBe('Error: Cannot find module x')
    expect(summarizeToolError('done', 'warning\nfatal: permission denied')).toBe('fatal: permission denied')
    expect(summarizeToolError('', undefined)).toBeUndefined()
  })
})

describe('aggregation', () => {
  it('uses nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 20 }, (_, index) => index + 1)
    expect(percentile(sorted, 0.5)).toBe(10)
    expect(percentile(sorted, 0.95)).toBe(19)
    expect(percentile([], 0.5)).toBeNull()
  })

  it('counts a missing measurement as unavailable, never as zero', () => {
    const report = aggregateToolTimings([record({ elapsedMs: 100 }), record({ elapsedMs: 300 }), record({ elapsedMs: null, elapsedSource: 'unavailable' })], {}, context)
    expect(report.tools[0]!.elapsed).toEqual({ measured: 2, unavailable: 1, p50: 100, p95: 300, max: 300, totalMs: 400 })
    expect(report.tools[0]!.wait).toMatchObject({ measured: 0, unavailable: 3, p50: null })
    expect(report.coverage).toMatchObject({ elapsed: 0.667, wait: 0, exec: 1 })
  })

  it('categorizes provider tool names', () => {
    expect(['Bash', 'PowerShell', 'Read', 'Edit', 'File change', 'Grep', 'WebFetch', 'Task', 'mcp__conductor__tabs', 'conductor-local/run_and_summarize', 'TodoWrite'].map(toolCategory))
      .toEqual(['shell', 'shell', 'file-read', 'file-write', 'file-write', 'search', 'web', 'agent', 'mcp', 'mcp', 'other'])
  })

  it('filters by project, conversation, provider, tool and time, and keeps detached work out by default', () => {
    const all = [record({ projectId: 'p2' }), record({ agentSessionId: 's9' }), record({ provider: 'claude' }), record({ tool: 'Read' }), record({ detached: true }), record({ endedAt: '2026-10-01T00:00:00.000Z' })]
    expect(aggregateToolTimings(all, { projectId: 'p1' }, context).totals.calls).toBe(4)
    expect(aggregateToolTimings(all, { agentSessionId: 's9' }, context).totals.calls).toBe(1)
    expect(aggregateToolTimings(all, { provider: 'claude' }, context).totals.calls).toBe(1)
    expect(aggregateToolTimings(all, { tool: 'read' }, context).totals.calls).toBe(1)
    expect(aggregateToolTimings(all, { since: '2026-10-29T00:00:00.000Z' }, context).totals).toMatchObject({ calls: 4, detached: 1 })
    expect(aggregateToolTimings(all, { includeDetached: true }, context).totals.calls).toBe(6)
  })

  it('bounds every list', () => {
    const many = Array.from({ length: 300 }, (_, index) => record({ tool: `tool-${index}`, outcome: 'failed', error: `e${index}` }))
    const report = aggregateToolTimings(many, { limit: 50, recent: 1000 }, context)
    expect([report.tools.length, report.slowest.length, report.failures.length, report.recent.length]).toEqual([50, 50, 50, 100])
    expect(report.offenders.length).toBeLessThanOrEqual(50)
  })
})

describe('offenders', () => {
  it('ties each suggestion to its evidence', () => {
    const records = [
      ...Array.from({ length: 6 }, (_, index) => record({ args: `pwsh -c test ${index}`, outcome: index < 4 ? 'failed' : 'completed', exitCode: index < 4 ? 1 : 0, error: index < 4 ? 'Failed to create unified exec process: helper_unknown_error' : undefined })),
      ...Array.from({ length: 3 }, () => record({ provider: 'claude', tool: 'Write', category: 'file-write', waitMs: 45_000, waitSource: 'observed-approval', execMs: 50, args: 'src/a.ts' })),
      ...Array.from({ length: 4 }, (_, index) => record({ provider: 'claude', tool: 'Bash', elapsedMs: 120_000 + index, execMs: null, execSource: 'unavailable', args: 'npm run build' })),
      ...Array.from({ length: 5 }, () => record({ provider: 'grok', tool: 'Read', category: 'file-read', args: 'README.md', elapsedMs: 5 }))
    ]
    const offenders = aggregateToolTimings(records, {}, context).offenders
    const failing = offenders.find(offender => offender.kind === 'failure-rate')!
    expect(failing).toMatchObject({ tool: 'Bash', provider: 'codex', severity: 'high', evidence: { calls: 6, failures: 4 } })
    expect(failing.suggestion).toMatch(/sandbox/)
    expect(offenders.find(offender => offender.kind === 'approval-wait')).toMatchObject({ tool: 'Write', evidence: { p50Ms: 45_000 } })
    expect(offenders.find(offender => offender.kind === 'slow')).toMatchObject({ tool: 'Bash', provider: 'claude', evidence: { examples: ['npm run build'] } })
    expect(offenders.find(offender => offender.kind === 'repeated')).toMatchObject({ tool: 'Read', evidence: { calls: 5, examples: ['README.md'] } })
  })

  it('says when a provider measured nothing rather than calling it fast', () => {
    const records = Array.from({ length: 12 }, () => record({ provider: 'claude', elapsedMs: null, elapsedSource: 'unavailable', execMs: null, execSource: 'unavailable' }))
    const coverage = aggregateToolTimings(records, {}, context).offenders.find(offender => offender.kind === 'coverage')
    expect(coverage).toMatchObject({ provider: 'claude', summary: '12 of 12 claude calls have no measured time' })
    expect(aggregateToolTimings(records, {}, context).slowest).toEqual([])
  })
})
