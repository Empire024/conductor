import { describe, expect, it, vi } from 'vitest'
import type { LocalModelConfig } from './config'
import { localModelId, listLocalServers, stopLocalServer, type LocalServerSources } from './servers'

/* conductor-task:local-server-stop-control. One call lists the running model servers and one stops
   a Conductor-started server, refusing while a turn uses it unless forced. */
const model = (id: string, port: number) => ({ id, port } as unknown as LocalModelConfig)
const sources = (overrides: Partial<LocalServerSources> = {}): LocalServerSources => ({
  models: () => [model('local/dolphin-x1-8b', 51438), model('local/qwen3.5-9b', 51439)],
  record: config => config.id === 'local/dolphin-x1-8b' ? { pid: 62380, port: 51438, model: 'local/dolphin-x1-8b', file: 'dolphin.gguf', startedAt: '2026-09-24T17:00:00.000Z' } : null,
  alive: pid => pid === 62380,
  inventory: () => [{ pid: 62380, model: 'local/dolphin-x1-8b', port: 51438 }, { pid: 700, model: 'foreign-model', port: 8080 }],
  ...overrides
})

describe('local model servers', () => {
  it('lists Conductor-started servers and other llama-servers without duplicates', () => {
    expect(listLocalServers(sources())).toEqual([
      { model: 'local/dolphin-x1-8b', label: expect.any(String), pid: 62380, port: 51438, startedAt: '2026-09-24T17:00:00.000Z', startedByConductor: true },
      { model: 'foreign-model', label: expect.any(String), pid: 700, port: 8080, startedAt: null, startedByConductor: false }
    ])
    // A dead pid is not a running server, and an unreadable process list is not an error.
    expect(listLocalServers(sources({ alive: () => false, inventory: () => { throw new Error('no inventory') } }))).toEqual([])
  })

  it('stops an idle Conductor-started server by model or pid', async () => {
    const servers = listLocalServers(sources())
    const ports = { busy: vi.fn(async () => 'idle' as const), stop: vi.fn(async () => 'stopped (pid 62380)') }
    expect(await stopLocalServer(servers, { model: 'local/dolphin-x1-8b' }, ports)).toMatchObject({ stopped: true, model: 'local/dolphin-x1-8b', pid: 62380, forced: false })
    expect(await stopLocalServer(servers, { pid: 62380 }, ports)).toMatchObject({ stopped: true, model: 'local/dolphin-x1-8b' })
    expect(ports.stop).toHaveBeenCalledWith('local/dolphin-x1-8b')
    expect(ports.busy).toHaveBeenCalledWith({ model: 'local/dolphin-x1-8b', port: 51438, pid: 62380, ours: true })
  })

  it('refuses a busy server unless forced, and never stops a server it did not start', async () => {
    const servers = listLocalServers(sources())
    const ports = { busy: vi.fn(async () => '1 conversation is mid-turn on it in this Conductor'), stop: vi.fn(async () => 'stopped') }
    await expect(stopLocalServer(servers, { model: 'local/dolphin-x1-8b' }, ports)).rejects.toThrow(/busy: 1 conversation is mid-turn.*force:true/)
    expect(ports.stop).not.toHaveBeenCalled()
    expect(await stopLocalServer(servers, { model: 'local/dolphin-x1-8b', force: true }, ports)).toMatchObject({ stopped: true, forced: true, interrupted: '1 conversation is mid-turn on it in this Conductor' })
    await expect(stopLocalServer(servers, { pid: 700 }, ports)).rejects.toThrow(/not started by this Conductor/)
    await expect(stopLocalServer(servers, { model: 'local/qwen3.5-9b' }, ports)).rejects.toThrow(/No running local model server matches local\/qwen3.5-9b.*dolphin-x1-8b \(pid 62380\)/)
    await expect(stopLocalServer(servers, {}, ports)).rejects.toThrow(/Several servers match/)
    // The 'local/' prefix is optional for a caller.
    expect(localModelId('qwen3.5-9b')).toBe('local/qwen3.5-9b')
    expect(localModelId('local/qwen3.5-9b')).toBe('local/qwen3.5-9b')
    expect(await stopLocalServer(servers, { model: 'dolphin-x1-8b', force: true }, ports)).toMatchObject({ model: 'local/dolphin-x1-8b' })
  })
})
