import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocalStopCard } from './LocalStopCard'
import { isConversationActivity } from './StructuredAgentRenderers'
import { localStopPayload, type LocalStopReport } from '../../../shared/local-stop'
import type { TimelineItem } from '../../../shared/structured-agent'

const report = (reason: LocalStopReport['reason'], extra: Partial<LocalStopReport> = {}): LocalStopReport => ({
  reason, detail: `Stopped for ${reason}.`, rounds: 16, hardLimit: 24,
  context: { usedTokens: 24_100, capacityTokens: 30_208, reserveTokens: 2560, windowTokens: 32_768, percent: 79.8, estimated: false },
  compactions: 1, recoveredTokens: 8000, loopWarnings: 0, filesChanged: ['public/text-diff.js'], commandsRun: 2, excludedOutputChars: 5000, timeline: [], ...extra
})

const item = (value: LocalStopReport): TimelineItem => ({ id: 'n1', runtimeId: 'r', sequence: 1, timestamp: '2026-09-23T00:00:00.000Z', data: { type: 'notice', message: 'stop', payload: localStopPayload(value) } } as TimelineItem)

describe('local stop card', () => {
  it('names context exhaustion and tool-round exhaustion differently, with the figures', () => {
    const context = renderToStaticMarkup(LocalStopCard({ report: report('context_limit') }))
    expect(context).toContain('<strong>Context limit reached</strong>')
    expect(context).toContain('16 / 24 tool rounds')
    expect(context).toContain('24,100 / 30,208 tokens (80%)')
    expect(context).toContain('2,560 reserved for the answer of a 32,768-token window')
    expect(context).toContain('role="alert"')
    expect(context).toContain('data-stop-reason="context_limit"')
    const rounds = renderToStaticMarkup(LocalStopCard({ report: report('round_limit') }))
    expect(rounds).toContain('<strong>Tool-round limit reached</strong>')
    expect(rounds).not.toContain('Context limit reached')
    const claim = renderToStaticMarkup(LocalStopCard({ report: report('unverified_claim', { unverified: 'no write ran', filesChanged: [] }) }))
    expect(claim).toContain('Unverified completion claim')
    expect(claim).toContain('no write ran')
    expect(claim).toContain('<dd>none</dd>')
    const done = renderToStaticMarkup(LocalStopCard({ report: report('completed', { acceptance: { command: 'node --test', passed: true, exitCode: 0 } }) }))
    expect(done).toContain('role="status"')
    expect(done).toContain('passed: <code>node --test</code>')
  })

  it('shows in the conversation for every stop but an ordinary completion', () => {
    expect(isConversationActivity(item(report('completed')))).toBe(false)
    expect(isConversationActivity(item(report('round_limit')))).toBe(true)
    expect(isConversationActivity(item(report('context_limit')))).toBe(true)
  })
})
