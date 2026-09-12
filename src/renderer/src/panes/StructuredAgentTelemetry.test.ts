import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SubagentSummary } from './usage-summary'
import { SubagentExplorer, subagentStatusTitle } from './StructuredAgentTelemetry'

describe('subagent roster presentation', () => {
  it('shows one useful status marker and no Activity (0) or redundant identity dot', () => {
    const agent: SubagentSummary = { id: 'child', name: 'Researcher', runtimeId: 'runtime', startedAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z', parentIds: [], activity: [], status: 'running', detached: false, sequence: 1 }
    const html = renderToStaticMarkup(createElement(SubagentExplorer, {
      agents: [agent], runtimeId: 'runtime', detail: { sessionId: 'session', cwd: 'C:/project', interactive: false, onOpenFile: () => {}, onDiff: () => {}, onRespond: async () => {} }
    }))
    expect(html).toContain('the provider reports this agent is active')
    expect(html).not.toContain('sa-subagent-identity')
    expect(html).not.toContain('Activity (0)')
    expect(html).not.toContain('0 tools')
  })

  it('explains unavailable status instead of presenting an unlabeled dot', () => {
    expect(subagentStatusTitle('unknown')).toContain('connection ended before a final agent status')
  })
})
