import { describe, expect, it, vi } from 'vitest'
import type { AgentActivityPhase, AppUpdateState } from '../../shared/models'
import { UpdateStore } from './use-app-updates'

const base: AppUpdateState = { phase: 'idle', currentVersion: '0.1.0', configured: true }
const available: AppUpdateState = { ...base, phase: 'available', availableVersion: '0.2.0', source: 'release' }
const ready: AppUpdateState = { ...available, phase: 'ready', progress: 100 }

function fakeBridge(initial: AppUpdateState) {
  let onStateCallback: ((state: AppUpdateState) => void) | null = null
  const bridge = {
    openLocalFolder: vi.fn(async () => {}),
    getState: vi.fn(async () => initial),
    check: vi.fn(async () => available),
    download: vi.fn(async () => ready),
    install: vi.fn(async () => {}),
    acknowledgePrepare: vi.fn(),
    onState: vi.fn((callback: (state: AppUpdateState) => void) => { onStateCallback = callback; return () => { onStateCallback = null } }),
    onPrepareInstall: vi.fn(() => () => {})
  }
  return { bridge, emit: (state: AppUpdateState) => onStateCallback?.(state) }
}

function fakeActivity() {
  let listener: ((id: string, phase: AgentActivityPhase) => void) | null = null
  const subscribe = (next: (id: string, phase: AgentActivityPhase) => void): (() => void) => { listener = next; return () => { listener = null } }
  return { subscribe, set: (id: string, phase: AgentActivityPhase) => listener?.(id, phase) }
}

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

async function startedStore(initial: AppUpdateState, lookupTitle: (id: string) => Promise<string | undefined> = async () => undefined) {
  const { bridge, emit } = fakeBridge(initial)
  const activity = fakeActivity()
  const store = new UpdateStore(bridge, lookupTitle, fakeStorage(), activity.subscribe)
  const unsubscribe = store.subscribe(() => {})
  await vi.waitFor(() => expect(store.getSnapshot().state.phase).toBe(initial.phase))
  return { store, bridge, emit, activity, unsubscribe }
}

describe('one-click restart, gated only by work still in progress', () => {
  it('cascades all the way from available to installed with a single call when nothing is running', async () => {
    const { store, bridge } = await startedStore(available)
    await store.runUpdateAction()
    expect(bridge.download).toHaveBeenCalledOnce()
    expect(bridge.install).toHaveBeenCalledOnce()
    expect(store.getSnapshot().pendingQuitConfirm).toBeNull()
  })

  it('installs immediately from an already-downloaded update with no extra click', async () => {
    const { store, bridge } = await startedStore(ready)
    await store.runUpdateAction()
    expect(bridge.download).not.toHaveBeenCalled()
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('asks in-app before quitting while a tab is still working, and names it instead of a generic warning', async () => {
    const { store, bridge, activity } = await startedStore(ready, async (id) => (id === 'agent-1' ? 'Fix the flaky test' : undefined))
    activity.set('agent-1', 'working')
    await store.runUpdateAction()
    expect(bridge.install).not.toHaveBeenCalled()
    expect(store.getSnapshot().pendingQuitConfirm).toEqual([{ id: 'agent-1', title: 'Fix the flaky test' }])
    expect(store.getSnapshot().state.phase).toBe('ready')
  })

  it('treats a tab waiting on the user as still running, but not one that already stopped or finished', async () => {
    const { store, activity } = await startedStore(ready)
    activity.set('waiting-agent', 'waiting_input')
    activity.set('stopped-agent', 'stopped')
    activity.set('done-agent', 'complete')
    await store.runUpdateAction()
    expect(store.getSnapshot().pendingQuitConfirm?.map((tab) => tab.id)).toEqual(['waiting-agent'])
  })

  it('quits anyway once the user confirms through the in-app prompt, never a native dialog', async () => {
    const { store, bridge, activity } = await startedStore(ready)
    activity.set('agent-1', 'working')
    await store.runUpdateAction()
    expect(store.getSnapshot().pendingQuitConfirm).not.toBeNull()
    await store.confirmQuitAndInstall()
    expect(bridge.install).toHaveBeenCalledOnce()
    expect(store.getSnapshot().pendingQuitConfirm).toBeNull()
  })

  it('backs out without installing when the user declines, leaving the update ready to retry', async () => {
    const { store, bridge, activity } = await startedStore(ready)
    activity.set('agent-1', 'working')
    await store.runUpdateAction()
    store.cancelQuitConfirm()
    expect(bridge.install).not.toHaveBeenCalled()
    expect(store.getSnapshot().pendingQuitConfirm).toBeNull()
    expect(store.getSnapshot().state.phase).toBe('ready')
  })

  it('ignores a repeated click while the confirmation is already pending', async () => {
    const { store, bridge, activity } = await startedStore(ready)
    activity.set('agent-1', 'working')
    await store.runUpdateAction()
    await store.runUpdateAction()
    expect(bridge.install).not.toHaveBeenCalled()
    expect(store.getSnapshot().pendingQuitConfirm).toHaveLength(1)
  })
})
