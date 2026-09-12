import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changeWorkspacePath, loadWorkspaceFiles, openWorkspaceFile, workspaceFileKey } from './workspace-files-state'

describe('remote workspace file identity', () => {
  const records = new Map<string, string>()
  beforeEach(() => {
    records.clear()
    Object.assign(globalThis, {
      localStorage: {
        get length() { return records.size },
        key: (index: number) => [...records.keys()][index] ?? null,
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => records.set(key, value)
      },
      window: { dispatchEvent: vi.fn() }
    })
  })

  it('keeps same-named local and host files as different tabs', () => {
    expect(workspaceFileKey({ machineId: 'local', projectId: 'p', path: 'same.txt' }))
      .not.toBe(workspaceFileKey({ machineId: 'host-a', projectId: 'p', path: 'same.txt' }))
    openWorkspaceFile('p', 'same.txt', 'editor', 3, false, 'host-a')
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ machineId: 'host-a' }) }))
  })

  it('migrates legacy tabs to local and never remaps a host tab on a local rename', () => {
    records.set('conductor.workspaceFiles.w', JSON.stringify({ files: [
      { id: 'old', projectId: 'p', path: 'same.txt', mode: 'editor' },
      { id: 'remote', machineId: 'host-a', projectId: 'p', path: 'same.txt', mode: 'editor' }
    ], activeId: 'remote' }))
    expect(loadWorkspaceFiles('w').files[0]?.machineId).toBe('local')
    changeWorkspacePath('p', 'same.txt', 'renamed.txt', 'file')
    const files = loadWorkspaceFiles('w').files
    expect(files.find(file => file.id === 'old')?.path).toBe('renamed.txt')
    expect(files.find(file => file.id === 'remote')?.path).toBe('same.txt')
  })
})
