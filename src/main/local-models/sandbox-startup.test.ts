import { afterEach, describe, expect, it, vi } from 'vitest'
import { dockerDesktopCandidates, ensureDockerAvailable, resetDockerDesktopStartupForTests, type DockerAvailability, type DockerStartupDependencies } from './sandbox.ts'

afterEach(() => resetDockerDesktopStartupForTests())

describe('lazy Docker Desktop startup', () => {
  it('finds installed desktop paths without launching anything', () => {
    expect(dockerDesktopCandidates({ ProgramFiles: 'C:\\Programs', LOCALAPPDATA: 'C:\\User' })).toEqual([
      'C:\\Programs\\Docker\\Docker\\Docker Desktop.exe',
      'C:\\User\\Docker\\Docker Desktop.exe'
    ])
  })

  it('starts one hidden desktop launch for concurrent sandbox demand and waits for readiness', async () => {
    let checks = 0
    const launch = vi.fn(async () => true)
    const dependencies: DockerStartupDependencies = {
      platform: 'win32',
      check: async (): Promise<DockerAvailability> => ++checks < 3
        ? { available: false, kind: 'engine-stopped', reason: 'stopped' }
        : { available: true, version: 'fixture' },
      exists: () => true,
      launch,
      wait: async () => undefined,
      candidates: () => ['C:\\Docker Desktop.exe']
    }
    const [first, second] = await Promise.all([
      ensureDockerAvailable({ timeoutMs: 5_000, pollMs: 1 }, dependencies),
      ensureDockerAvailable({ timeoutMs: 5_000, pollMs: 1 }, dependencies)
    ])
    expect(first.available).toBe(true)
    expect(second.available).toBe(true)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('does not attempt a desktop launch when the CLI itself is missing', async () => {
    const launch = vi.fn(async () => true)
    const dependencies: DockerStartupDependencies = {
      platform: 'win32',
      check: async () => ({ available: false, kind: 'cli-missing', reason: 'install Docker Desktop' }),
      exists: () => true,
      launch,
      wait: async () => undefined,
      candidates: () => ['C:\\Docker Desktop.exe']
    }
    expect(await ensureDockerAvailable({}, dependencies)).toMatchObject({ available: false, kind: 'cli-missing' })
    expect(launch).not.toHaveBeenCalled()
  })
})
