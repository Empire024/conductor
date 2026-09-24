import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentState, WorkspaceLayout, WorkspaceRecoveryCheckpoint } from '../../shared/models'
import { afterQuietIdle, checkpointChanged, workspaceDocumentsReader } from './recovery-autosave'

function storage(values: Map<string, string>) {
  return { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null }
}
const layout = (id: string): WorkspaceLayout => ({ root: { id, type: 'group', tabs: [], activeTabId: null } } as unknown as WorkspaceLayout)

describe('recovery autosave', () => {
  it('re-reads only the workspace documents whose stored text changed', () => {
    const values = new Map([['conductor.workspaceFiles.a', '{"files":[]}'], ['conductor.structured.draft.x', 'draft'], ['conductor.workspaceFiles.b', '{"files":[]}']])
    const load = vi.fn((workspaceId: string): WorkspaceDocumentState => ({ workspaceId, files: [], activeId: null }))
    const read = workspaceDocumentsReader(() => storage(values), load)
    const first = read()
    expect(first.map(document => document.workspaceId)).toEqual(['a', 'b'])
    expect(load).toHaveBeenCalledTimes(2)
    const second = read()
    expect(load).toHaveBeenCalledTimes(2)
    expect(second[0]).toBe(first[0])
    values.set('conductor.workspaceFiles.b', '{"files":[],"activeId":null}')
    values.delete('conductor.workspaceFiles.a')
    const third = read()
    expect(load).toHaveBeenCalledTimes(3)
    expect(third.map(document => document.workspaceId)).toEqual(['b'])
    expect(third[0]).not.toBe(first[1])
  })

  it('skips a checkpoint that would write what main already holds, and writes any real change', () => {
    const documents = [{ workspaceId: 'a', files: [], activeId: null }]
    const closedTabs: never[] = []
    const base: WorkspaceRecoveryCheckpoint = {
      activeProjectId: 'p', activeSessionId: 's', focusedGroupIds: { s: 'g' }, sessionIdsByProject: { p: 's' }, documents,
      sessions: [{ id: 's', layout: layout('g'), maximizedGroupId: null, closedTabs }]
    }
    const rebuilt = (change: Partial<WorkspaceRecoveryCheckpoint> = {}): WorkspaceRecoveryCheckpoint => ({
      ...base, focusedGroupIds: { ...base.focusedGroupIds }, sessionIdsByProject: { ...base.sessionIdsByProject }, documents: [...documents],
      sessions: base.sessions.map(session => ({ ...session })), ...change
    })
    expect(checkpointChanged(null, base)).toBe(true)
    expect(checkpointChanged(base, rebuilt())).toBe(false)
    expect(checkpointChanged(base, rebuilt({ activeSessionId: 't' }))).toBe(true)
    expect(checkpointChanged(base, rebuilt({ focusedGroupIds: { s: 'h' } }))).toBe(true)
    expect(checkpointChanged(base, rebuilt({ documents: [{ ...documents[0]! }] }))).toBe(true)
    expect(checkpointChanged(base, rebuilt({ sessions: [{ ...base.sessions[0]!, layout: layout('g') }] }))).toBe(true)
    expect(checkpointChanged(base, rebuilt({ sessions: [] }))).toBe(true)
  })

  it('waits for a quiet period and then idle time, and can be cancelled before either', () => {
    vi.useFakeTimers()
    try {
      const idle: Array<() => void> = []
      const host = {
        setTimeout: (run: () => void, ms: number) => setTimeout(run, ms) as unknown as number,
        clearTimeout: (handle: number) => clearTimeout(handle),
        requestIdleCallback: (run: () => void) => idle.push(run),
        cancelIdleCallback: (handle: number) => { idle[handle - 1] = () => {} }
      }
      const run = vi.fn()
      afterQuietIdle(run, 1_000, 1_000, host as never)
      vi.advanceTimersByTime(999)
      expect(idle).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(run).not.toHaveBeenCalled()
      idle.shift()!()
      expect(run).toHaveBeenCalledOnce()

      const cancelled = vi.fn()
      afterQuietIdle(cancelled, 1_000, 1_000, host as never)()
      vi.advanceTimersByTime(2_000)
      expect(idle).toHaveLength(0)
      const late = vi.fn()
      const cancel = afterQuietIdle(late, 1_000, 1_000, host as never)
      vi.advanceTimersByTime(1_000)
      cancel()
      idle.forEach(callback => callback())
      expect(late).not.toHaveBeenCalled()
      expect(cancelled).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
