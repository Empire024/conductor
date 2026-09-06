import { describe, expect, it } from 'vitest'
import { buildIssueReport } from './debug-log'

describe('debug issue reports', () => {
  it('includes useful diagnostics without project paths', () => {
    const report = buildIssueReport(
      { appVersion: '0.1.0', electronVersion: '37', chromeVersion: '138', nodeVersion: '22', platform: 'win32', arch: 'x64' },
      {
        projectCount: 2,
        sessionCount: 3,
        activeSessionId: 'session-1',
        activeSessionName: 'Workspace 1',
        activeTabKinds: ['agent', 'terminal'],
        attentionCount: 1,
        theme: 'night-owl/night',
        zoomFactor: 1.1
      },
      [{ id: 1, createdAt: '2026-09-06T12:00:00.000Z', level: 'warn', scope: 'tabs', message: 'Close cancelled' }]
    )

    expect(report).toContain('Conductor: 0.1.0')
    expect(report).toContain('Active tab kinds: agent, terminal')
    expect(report).toContain('[tabs] Close cancelled')
    expect(report).not.toContain('C:\\')
  })

  it('includes local screenshot context and its optional description', () => {
    const report = buildIssueReport(
      { appVersion: '0.1.2', electronVersion: '37', chromeVersion: '138', nodeVersion: '22', platform: 'win32', arch: 'x64' },
      {
        projectCount: 1, sessionCount: 1, activeSessionId: null, activeSessionName: null,
        activeTabKinds: [], attentionCount: 0, theme: 'night-owl/night', zoomFactor: 1
      },
      [],
      { capturedAt: '2026-09-07T00:00:00.000Z', width: 1200, height: 800, description: 'The tab bar overlaps the editor.' }
    )
    expect(report).toContain('## Screenshot')
    expect(report).toContain('1200 × 800')
    expect(report).toContain('The tab bar overlaps the editor.')
  })
})
