import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_QWEN_35B } from '../../../shared/local-models'
import type { MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { closePlacedTab, createPlacedTab, readPlacement, travels, writePlacement } from './machine-placement'
import { machinePlacementOptions } from '../panes/LauncherPane'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) }
    },
    conductor: { remote: { openTab: vi.fn(), closeTab: vi.fn() } }
  })
})

const machine = (overrides: Partial<MachineDescriptor> = {}): MachineDescriptor => ({
  id: 'desktop', name: 'Render desktop', kind: 'peer', status: 'online', accountLogin: 'owner',
  projects: [{
    grant: { localProjectId: 'project', remote: { key: 'working-copy', keyCreatedAt: '2026-09-12T00:00:00.000Z', path: 'C:/remote/project' } } as never,
    observed: { key: 'working-copy', keyCreatedAt: '2026-09-12T00:00:00.000Z', path: 'C:/remote/project' } as never
  }], ...overrides
})

describe('choosing which machine runs a new tab', () => {
  it('defaults to this machine and remembers a choice per workspace', () => {
    expect(readPlacement('workspace-1')).toBe(LOCAL_MACHINE_ID)
    writePlacement('workspace-1', 'desktop')
    expect(readPlacement('workspace-1')).toBe('desktop')
    // A second workspace keeps its own placement rather than inheriting the first one's.
    expect(readPlacement('workspace-2')).toBe(LOCAL_MACHINE_ID)
  })

  it('falls back to this machine when the stored choice is unreadable', () => {
    store.set('conductor.machine-placement', 'not json')
    expect(readPlacement('workspace-1')).toBe(LOCAL_MACHINE_ID)
  })

  it('only lets agent tabs travel, because a terminal is a process on its own machine', () => {
    expect(travels('agent')).toBe(true)
    expect(travels('terminal')).toBe(false)
  })

  it('explains why an unusable machine cannot take work instead of hiding it', () => {
    const options = machinePlacementOptions([
      machine({ id: LOCAL_MACHINE_ID, name: 'This laptop', kind: 'local', projects: [] }),
      machine(),
      machine({ id: 'offline-box', name: 'Old tower', status: 'offline' }),
      machine({ id: 'unpaired', name: 'Studio PC', projects: [] }),
      machine({ id: 'gone', name: 'Revoked box', status: 'revoked' })
    ], 'project')
    expect(options.map(option => option.machine.id)).toEqual([LOCAL_MACHINE_ID, 'desktop', 'offline-box', 'unpaired'])
    expect(options.find(option => option.machine.id === LOCAL_MACHINE_ID)!.reason).toBe('')
    expect(options.find(option => option.machine.id === 'desktop')!.reason).toBe('')
    expect(options.find(option => option.machine.id === 'offline-box')!.reason).toMatch(/offline/)
    expect(options.find(option => option.machine.id === 'unpaired')!.reason).toMatch(/has not been told/)
  })

  it('does not offer a peer that is mapped only to a different local project', () => {
    const options = machinePlacementOptions([machine()], 'another-project')
    expect(options[0]!.reason).toMatch(/has not been told which of its projects this one is/)
  })

  it('builds an ordinary local tab without asking any machine when placement is here', async () => {
    const tab = await createPlacedTab({ kind: 'agent', provider: 'claude', machineId: LOCAL_MACHINE_ID, projectId: 'project', sessionId: 'workspace' })
    expect(tab).toMatchObject({ kind: 'agent', state: { provider: 'claude' } })
    expect(tab.state?.machineId).toBeUndefined()
    expect(window.conductor.remote.openTab).not.toHaveBeenCalled()
  })

  it('keeps a terminal on this machine even when the workspace is placed elsewhere', async () => {
    const tab = await createPlacedTab({ kind: 'terminal', machineId: 'desktop', projectId: 'project', sessionId: 'workspace' })
    expect(tab.kind).toBe('terminal')
    expect(window.conductor.remote.openTab).not.toHaveBeenCalled()
  })

  it('binds a placed tab to the mirrored session the other machine opened', async () => {
    vi.mocked(window.conductor.remote.openTab).mockResolvedValue({ localSessionId: 'agent_mirror', machineId: 'desktop', machineName: 'Render desktop' })
    const tab = await createPlacedTab({ kind: 'agent', provider: 'claude', machineId: 'desktop', projectId: 'project', sessionId: 'workspace' })
    expect(window.conductor.remote.openTab).toHaveBeenCalledWith({ machineId: 'desktop', projectId: 'project', sessionId: 'workspace', provider: 'claude' })
    // The tab reads from the local mirror, and says where the work is actually happening.
    expect(tab.resourceId).toBe('agent_mirror')
    expect(tab.state?.machineId).toBe('desktop')
    expect(tab.title).toContain('Render desktop')
  })

  it('places a local model on the machine that has the stack, asking for that exact model', async () => {
    vi.mocked(window.conductor.remote.openTab).mockResolvedValue({ localSessionId: 'agent_mirror', machineId: 'desktop', machineName: 'Render desktop' })
    const tab = await createPlacedTab({ kind: 'agent', provider: 'local', model: LOCAL_QWEN_35B, machineId: 'desktop', projectId: 'project', sessionId: 'workspace' })
    expect(window.conductor.remote.openTab).toHaveBeenCalledWith({ machineId: 'desktop', projectId: 'project', sessionId: 'workspace', provider: 'local', model: LOCAL_QWEN_35B })
    expect(tab.state).toMatchObject({ provider: 'local', model: LOCAL_QWEN_35B, machineId: 'desktop' })
    expect(tab.title).toBe('Qwen 3.6 35B-A3B · Render desktop')
  })

  it('opens no tab at all when the other machine refuses the placement', async () => {
    vi.mocked(window.conductor.remote.openTab).mockRejectedValue(new Error('Studio PC is not sharing that project.'))
    await expect(createPlacedTab({ kind: 'agent', provider: 'claude', machineId: 'desktop', projectId: 'project', sessionId: 'workspace' }))
      .rejects.toThrow(/not sharing that project/)
  })
})

describe('closing a tab that runs on another machine', () => {
  const tab = (state?: Record<string, unknown>): never => ({ id: 'pane', kind: 'agent', title: 'Codex · Render desktop', resourceId: 'agent_mirror', state }) as never

  it('closes the real tab on the machine that runs it', () => {
    vi.mocked(window.conductor.remote.closeTab).mockResolvedValue({ closed: true })
    const reported: string[] = []
    closePlacedTab(tab({ machineId: 'desktop' }), message => reported.push(message))
    expect(window.conductor.remote.closeTab).toHaveBeenCalledWith('agent_mirror')
    expect(reported).toEqual([])
  })

  it('leaves a tab that runs here alone', () => {
    closePlacedTab(tab({ provider: 'codex' }), () => {})
    closePlacedTab(tab({ machineId: LOCAL_MACHINE_ID }), () => {})
    expect(window.conductor.remote.closeTab).not.toHaveBeenCalled()
  })

  it('says so when the other machine could not be told, rather than failing silently', async () => {
    vi.mocked(window.conductor.remote.closeTab).mockResolvedValue({ closed: false, message: 'Render desktop is offline.' })
    const reported: string[] = []
    closePlacedTab(tab({ machineId: 'desktop' }), message => reported.push(message))
    await vi.waitFor(() => expect(reported).toHaveLength(1))
    expect(reported[0]).toMatch(/Render desktop is offline/)
  })
})
