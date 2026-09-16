import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_QWEN_35B } from '../../../shared/local-models'
import type { ProjectRecord } from '../../../shared/models'
import type { MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import {
  checkProjectPlacement, closePlacedTab, createPlacedTab, defaultPlacement, reattachPlacedTerminal,
  requiredMachineId, tabRemoteTerminalId, travels
} from './machine-placement'
import { machinePlacementOptions } from '../panes/LauncherPane'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) }
    },
    conductor: { remote: { openTab: vi.fn(), closeTab: vi.fn(), terminals: { open: vi.fn(), attach: vi.fn(), list: vi.fn() } } }
  })
})

const machine = (overrides: Partial<MachineDescriptor> = {}): MachineDescriptor => ({
  id: 'desktop', name: 'Render desktop', kind: 'peer', status: 'online', accountLogin: 'owner', connection: LOCAL_CONNECTION,
  projects: [{
    grant: { localProjectId: 'project', remote: { key: 'working-copy', keyCreatedAt: '2026-09-12T00:00:00.000Z', path: 'C:/remote/project' } } as never,
    observed: { key: 'working-copy', keyCreatedAt: '2026-09-12T00:00:00.000Z', path: 'C:/remote/project' } as never
  }], ...overrides
})

const at = '2026-09-16T00:00:00.000Z'
const localProject: ProjectRecord = { id: 'project', name: 'Project', path: 'C:/local/project', createdAt: at, updatedAt: at }
const remoteProject: ProjectRecord = {
  id: 'remote-project', name: 'Project', path: 'C:/remote/project', createdAt: at, updatedAt: at,
  remote: { machineId: 'desktop', machineName: 'MAIN', remoteProjectId: 'project_9', path: 'C:/remote/project' }
}

describe('choosing which machine runs a new tab', () => {
  it('runs a project’s work on the project’s own machine, with nothing remembered to override it', () => {
    expect(defaultPlacement(localProject)).toBe(LOCAL_MACHINE_ID)
    expect(defaultPlacement(remoteProject)).toBe('desktop')
    expect(defaultPlacement(null)).toBe(LOCAL_MACHINE_ID)
  })

  it('lets a terminal travel now that a host can own the shell behind it', () => {
    expect(travels('agent')).toBe(true)
    expect(travels('terminal')).toBe(true)
    expect(travels('code')).toBe(false)
    expect(travels('diff')).toBe(false)
  })

  it('keeps a project of this computer on this computer, whatever the other machines say', () => {
    const options = machinePlacementOptions([
      machine({ id: LOCAL_MACHINE_ID, name: 'This laptop', kind: 'local', projects: [] }),
      machine(),
      machine({ id: 'offline-box', name: 'Old tower', status: 'offline' }),
      machine({ id: 'unpaired', name: 'Studio PC', projects: [] }),
      machine({ id: 'gone', name: 'Revoked box', status: 'revoked' })
    ], 'project')
    expect(options.map(option => option.machine.id)).toEqual([LOCAL_MACHINE_ID, 'desktop', 'offline-box', 'unpaired'])
    expect(options.find(option => option.machine.id === LOCAL_MACHINE_ID)!.reason).toBe('')
    // A peer that once had this project "mapped" to one of its own is no longer a place this
    // project can run: the two are separate projects on separate computers, and the refusal says
    // where work meant for that machine belongs instead.
    for (const id of ['desktop', 'offline-box', 'unpaired']) {
      expect(options.find(option => option.machine.id === id)!.reason).toMatch(/is on this computer/)
    }
    expect(options.find(option => option.machine.id === 'desktop')!.reason).toMatch(/Render desktop's own projects/)
  })

  it('builds an ordinary local tab without asking any machine when placement is here', async () => {
    const tab = await createPlacedTab({ kind: 'agent', provider: 'claude', machineId: LOCAL_MACHINE_ID, projectId: 'project', sessionId: 'workspace' })
    expect(tab).toMatchObject({ kind: 'agent', state: { provider: 'claude' } })
    expect(tab.state?.machineId).toBeUndefined()
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

describe('a terminal placed on a host', () => {
  const binding = { localTerminalId: 'terminal_local_1', remoteTerminalId: 'term-9', machineId: 'desktop', machineName: 'Render desktop' }

  it('opens the shell on that machine and drives it through the local id it was given', async () => {
    vi.mocked(window.conductor.remote.terminals.open).mockResolvedValue(binding)
    const tab = await createPlacedTab({ kind: 'terminal', machineId: 'desktop', projectId: 'project', sessionId: 'workspace', cols: 120, rows: 40 })
    expect(window.conductor.remote.terminals.open).toHaveBeenCalledWith({ machineId: 'desktop', projectId: 'project', sessionId: 'workspace', cols: 120, rows: 40 })
    expect(tab.resourceId).toBe('terminal_local_1')
    expect(tab.state).toMatchObject({ machineId: 'desktop', remoteTerminalId: 'term-9' })
    expect(tab.title).toBe('Terminal · Render desktop')
  })

  it('gives the shell a shape even when the pane has not measured itself yet', async () => {
    vi.mocked(window.conductor.remote.terminals.open).mockResolvedValue(binding)
    await createPlacedTab({ kind: 'terminal', machineId: 'desktop', projectId: 'project', sessionId: 'workspace' })
    expect(window.conductor.remote.terminals.open).toHaveBeenCalledWith(expect.objectContaining({ cols: 80, rows: 24 }))
  })

  it('attaches to a shell already running there instead of starting a second one', async () => {
    vi.mocked(window.conductor.remote.terminals.attach).mockResolvedValue(binding)
    const tab = await createPlacedTab({ kind: 'terminal', machineId: 'desktop', projectId: 'project', sessionId: 'workspace', remoteTerminalId: 'term-9' })
    expect(window.conductor.remote.terminals.attach).toHaveBeenCalledWith({ machineId: 'desktop', projectId: 'project', sessionId: 'workspace', remoteTerminalId: 'term-9' })
    expect(window.conductor.remote.terminals.open).not.toHaveBeenCalled()
    expect(tab.resourceId).toBe('terminal_local_1')
  })

  it('re-attaches a reopened tab rather than leaving its shell orphaned behind a new one', async () => {
    vi.mocked(window.conductor.remote.terminals.attach).mockResolvedValue({ ...binding, localTerminalId: 'terminal_local_2' })
    const saved = { id: 'pane', kind: 'terminal' as const, title: 'Terminal · Render desktop', resourceId: 'terminal_local_1', state: { machineId: 'desktop', remoteTerminalId: 'term-9' } }
    const tab = await reattachPlacedTerminal(saved, 'project', 'workspace')
    expect(window.conductor.remote.terminals.attach).toHaveBeenCalledWith({ machineId: 'desktop', projectId: 'project', sessionId: 'workspace', remoteTerminalId: 'term-9' })
    expect(window.conductor.remote.terminals.open).not.toHaveBeenCalled()
    expect(tab.resourceId).toBe('terminal_local_2')
    expect(tabRemoteTerminalId(tab)).toBe('term-9')
  })

  it('leaves a terminal that runs on this machine entirely alone', async () => {
    const local = await createPlacedTab({ kind: 'terminal', machineId: LOCAL_MACHINE_ID, projectId: 'project', sessionId: 'workspace' })
    expect(local.state?.machineId).toBeUndefined()
    expect(window.conductor.remote.terminals.open).not.toHaveBeenCalled()
    const saved = { id: 'pane', kind: 'terminal' as const, title: 'PowerShell', resourceId: 'terminal_1', state: { shell: 'powershell' } }
    expect(await reattachPlacedTerminal(saved, 'project', 'workspace')).toBe(saved)
    expect(window.conductor.remote.terminals.attach).not.toHaveBeenCalled()
  })

  it('is not closed on the host when its tab is closed, because closing a view is not stopping a shell', () => {
    const tab = { id: 'pane', kind: 'terminal' as const, title: 'Terminal · Render desktop', resourceId: 'terminal_local_1', state: { machineId: 'desktop' } }
    closePlacedTab(tab, () => {})
    expect(window.conductor.remote.closeTab).not.toHaveBeenCalled()
  })
})

describe('a project that lives on another machine', () => {
  it('has exactly one place its work can run, and it is not here', () => {
    expect(requiredMachineId(remoteProject)).toBe('desktop')
    expect(requiredMachineId(localProject)).toBeNull()
    expect(requiredMachineId(null)).toBeNull()
    expect(checkProjectPlacement(remoteProject, 'desktop')).toEqual({ ok: true, message: '' })
  })

  it('refuses this computer with a reason that names the host, rather than quietly running here', () => {
    const refusal = checkProjectPlacement(remoteProject, LOCAL_MACHINE_ID)
    expect(refusal.ok).toBe(false)
    expect(refusal.message).toBe('This project lives on MAIN. Its work runs there; this computer has no copy of it.')
  })

  it('refuses a third machine too: the host is the only answer, not merely the preferred one', () => {
    const refusal = checkProjectPlacement(remoteProject, 'studio')
    expect(refusal.ok).toBe(false)
    expect(refusal.message).toMatch(/cannot be run on another machine from here/)
  })

  it('starts on its host, and a local workspace can never be started anywhere but here', () => {
    expect(defaultPlacement(remoteProject)).toBe('desktop')
    expect(defaultPlacement(localProject)).toBe(LOCAL_MACHINE_ID)
  })

  it('leaves every local placement option disabled in the launcher, with the reason on it', () => {
    const options = machinePlacementOptions([
      machine({ id: LOCAL_MACHINE_ID, name: 'This laptop', kind: 'local', projects: [] }),
      machine(),
      machine({ id: 'studio', name: 'Studio PC' })
    ], 'project', remoteProject)
    expect(options.find(option => option.machine.id === LOCAL_MACHINE_ID)!.reason).toMatch(/lives on MAIN/)
    expect(options.find(option => option.machine.id === 'studio')!.reason).toMatch(/lives on MAIN/)
    expect(options.find(option => option.machine.id === 'desktop')!.reason).toBe('')
  })

  it('stops work going to its host when that host stopped sharing it', () => {
    const options = machinePlacementOptions([machine({ projects: [] })], 'remote-project', remoteProject)
    expect(options[0]!.reason).toMatch(/not one of .*'s|not sharing/)
  })

  it('says the host is offline rather than blaming the project', () => {
    const options = machinePlacementOptions([machine({ status: 'offline' })], 'project', remoteProject)
    expect(options[0]!.reason).toMatch(/offline/)
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
