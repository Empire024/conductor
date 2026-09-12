import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMachineFile, statMachineFile, writeMachineFile } from './remote-files'

describe('machine-scoped renderer files', () => {
  const local = { stat: vi.fn(), readForEditor: vi.fn(), write: vi.fn() }
  const remote = { stat: vi.fn(), read: vi.fn(), write: vi.fn() }
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(globalThis, { window: { conductor: { files: local, remote: { files: remote } } } })
  })

  it('uses only the remote bridge for a remote identity', async () => {
    remote.stat.mockResolvedValue({ file: {}, size: 4, isFile: true, modifiedAt: 'now' })
    remote.read.mockResolvedValue({ file: {}, content: 'host' })
    remote.write.mockResolvedValue({ file: {}, result: { status: 'saved' } })
    await expect(statMachineFile('host-a', 'controller-project', 'same.txt')).resolves.toMatchObject({ size: 4 })
    await expect(readMachineFile('host-a', 'controller-project', 'same.txt')).resolves.toBe('host')
    await expect(writeMachineFile('host-a', 'controller-project', 'same.txt', 'changed', 'host')).resolves.toEqual({ status: 'saved' })
    expect(remote.read).toHaveBeenCalledWith({ machineId: 'host-a', projectId: 'controller-project', path: 'same.txt' })
    expect(remote.write).toHaveBeenCalledWith({ machineId: 'host-a', projectId: 'controller-project', path: 'same.txt', content: 'changed', expectedContent: 'host' })
    expect(local.readForEditor).not.toHaveBeenCalled()
    expect(local.write).not.toHaveBeenCalled()
  })

  it('never falls back locally when the remote route is unavailable', async () => {
    remote.read.mockRejectedValue(new Error('Remote project access changed'))
    await expect(readMachineFile('host-a', 'controller-project', 'same.txt')).rejects.toThrow('Remote project access changed')
    expect(local.readForEditor).not.toHaveBeenCalled()
  })
})
