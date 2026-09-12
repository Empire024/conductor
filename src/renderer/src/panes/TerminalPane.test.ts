import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectRecord, SessionRecord } from '../../../shared/models'
import { activateArchivedRuntime, TerminalPane, type TerminalPaneProps } from './TerminalPane'

vi.mock('./RuntimeTerminal', () => ({ RuntimeTerminal: () => null }))

const at = '2026-09-12T12:00:00.000Z'
const project: ProjectRecord = { id: 'project', name: 'Project', path: 'C:\\project', createdAt: at, updatedAt: at }
const session: SessionRecord = { id: 'workspace', projectId: project.id, name: 'Workspace', layout: { version: 1, root: { type: 'group', id: 'group', activeTabId: '', tabs: [] } }, maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: at, updatedAt: at }
const props = (mode: 'agent' | 'terminal', machineId = 'local'): TerminalPaneProps => ({ mode, resourceId: mode + '-one', title: mode === 'agent' ? 'Saved agent' : 'Saved terminal', provider: mode === 'agent' ? 'codex' : undefined, project, session, archiveDormant: true, machineId })

describe('imported runtime activation', () => {
  it('renders a dormant terminal action without mounting the PTY runtime', () => {
    const html = renderToStaticMarkup(createElement(TerminalPane, props('terminal')))
    expect(html).toContain('Start fresh shell')
    expect(html).toContain('no command from the imported session will run automatically')
    expect(html).not.toContain('xterm')
  })

  it('keeps remote imported agents offline without a local resume action', () => {
    const html = renderToStaticMarkup(createElement(TerminalPane, props('agent', 'remote-machine')))
    expect(html).toContain('will never fall back to this machine')
    expect(html).not.toContain('Resume conversation')
  })

  it('reveals the runtime only after the main process accepts explicit activation', async () => {
    const activate = vi.fn(async () => {})
    const activated = vi.fn()
    await activateArchivedRuntime('terminal', 'terminal-one', activated, activate)
    expect(activate).toHaveBeenCalledWith('terminal', 'terminal-one')
    expect(activated).toHaveBeenCalledOnce()

    activate.mockRejectedValueOnce(new Error('still dormant'))
    await expect(activateArchivedRuntime('agent', 'agent-one', activated, activate)).rejects.toThrow('still dormant')
    expect(activated).toHaveBeenCalledOnce()
  })
})
