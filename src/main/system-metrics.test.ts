import { describe, expect, it } from 'vitest'
import { cpuPercentBetween, parseComputeApps, parseGpuQuery, parseProcessList, selectNotableProcesses, SystemMetricsSampler } from './system-metrics.ts'
import { performanceChipVisible, performanceLevel, formatBytes, type SystemMetricsSnapshot } from '../shared/system-metrics.ts'

const snapshot = (overrides: Partial<SystemMetricsSnapshot> = {}): SystemMetricsSnapshot => ({
  sampledAt: new Date().toISOString(),
  cpuPercent: 5,
  cpuCores: 16,
  memoryUsedBytes: 8 * 1024 ** 3,
  memoryTotalBytes: 64 * 1024 ** 3,
  gpus: [],
  processes: [],
  localServers: [],
  unavailable: [],
  ...overrides
})

describe('host sampling', () => {
  it('reads nvidia-smi rows in the units it reports them', () => {
    const gpus = parseGpuQuery('0, NVIDIA GeForce RTX 5070, 88, 10240, 12282, 71\n')
    expect(gpus).toHaveLength(1)
    expect(gpus[0]).toMatchObject({ index: 0, name: 'NVIDIA GeForce RTX 5070', utilizationPercent: 88, temperatureC: 71 })
    expect(gpus[0]!.memoryTotalBytes).toBe(12282 * 1024 ** 2)
  })

  it('sums the VRAM a process holds across GPUs', () => {
    const byPid = parseComputeApps('4120, 5120\n4120, 1024\n9001, 256\n')
    expect(byPid.get(4120)).toBe(6144 * 1024 ** 2)
    expect(byPid.get(9001)).toBe(256 * 1024 ** 2)
  })

  it('omits per-process VRAM a Windows driver will not report, rather than calling it zero', () => {
    // This is what the RTX 5070 answers in WDDM mode: a row per process, no figure in any of them.
    const byPid = parseComputeApps('2312, [N/A]\n41440, [N/A]\n')
    expect(byPid.size).toBe(0)
  })

  it('accepts the single-object shape ConvertTo-Json produces for one match', () => {
    expect(parseProcessList('{"Id":10,"ProcessName":"llama-server","WorkingSet64":2048,"CPU":9.5}')).toEqual([
      { pid: 10, name: 'llama-server', memoryBytes: 2048, cpuSeconds: 9.5 }
    ])
    // A process whose CPU the session may not read is listed, not dropped.
    expect(parseProcessList('[{"Id":11,"ProcessName":"System","WorkingSet64":4096,"CPU":null}]')[0]!.cpuSeconds).toBe(0)
    expect(parseProcessList('not json')).toEqual([])
  })

  it('reports busy share of the whole machine, and never divides by an unmoved clock', () => {
    expect(cpuPercentBetween({ idle: 1000, total: 2000 }, { idle: 1500, total: 3000 })).toBe(50)
    expect(cpuPercentBetween({ idle: 1000, total: 2000 }, { idle: 1000, total: 2000 })).toBe(0)
  })

  it('always lists the named processes and only the expensive strangers', () => {
    const rows = selectNotableProcesses([
      { pid: 1, name: 'llama-server', kind: 'local-model', label: 'Qwen3.6 35B-A3B (local)', cpuPercent: 0, memoryBytes: 0 },
      { pid: 2, name: 'Conductor', kind: 'conductor', label: 'Conductor', cpuPercent: 1, memoryBytes: 0 },
      { pid: 3, name: 'blender', kind: 'other', label: 'blender', cpuPercent: 71, memoryBytes: 3 * 1024 ** 3 },
      { pid: 4, name: 'notepad', kind: 'other', label: 'notepad', cpuPercent: 0.1, memoryBytes: 4 * 1024 ** 2 }
    ])
    expect(rows.map(row => row.pid)).toEqual([2, 1, 3])
  })

  it('serves a repeated read from the last sample instead of spawning again', async () => {
    let calls = 0
    const sampler = new SystemMetricsSampler({
      platform: 'win32',
      localServers: () => [],
      exec: async () => { calls++; return '' }
    })
    await sampler.sample()
    const spawned = calls
    await sampler.sample()
    expect(calls).toBe(spawned)
  })

  it('reports what it could not measure rather than a confident zero', async () => {
    const sampler = new SystemMetricsSampler({
      platform: 'win32',
      localServers: () => [],
      exec: async () => { throw new Error('nvidia-smi missing') }
    })
    const result = await sampler.sample()
    expect(result.gpus).toEqual([])
    expect(result.unavailable.join(' ')).toContain('nvidia-smi')
  })
})

describe('performance chip presentation', () => {
  it('stays hidden on an idle machine and appears once a local model is resident', () => {
    expect(performanceChipVisible(snapshot())).toBe(false)
    expect(performanceChipVisible(snapshot({
      localServers: [{ model: 'local/qwen3.6-35b-a3b', label: 'Qwen', port: 51436, pid: 10, running: true, cpuPercent: 4, memoryBytes: 0 }]
    }))).toBe(true)
  })

  it('appears for load that has nothing to do with Conductor', () => {
    expect(performanceChipVisible(snapshot({ cpuPercent: 74 }))).toBe(true)
    expect(performanceChipVisible(snapshot({ memoryUsedBytes: 60 * 1024 ** 3 }))).toBe(true)
  })

  it('calls a machine hot when the resources that cannot be oversubscribed run out', () => {
    expect(performanceLevel(snapshot())).toBe('calm')
    expect(performanceLevel(snapshot({ cpuPercent: 70 }))).toBe('busy')
    expect(performanceLevel(snapshot({ memoryUsedBytes: 60 * 1024 ** 3 }))).toBe('hot')
    expect(performanceLevel(snapshot({ gpus: [{ index: 0, name: 'RTX 5070', utilizationPercent: 20, memoryUsedBytes: 12_000 * 1024 ** 2, memoryTotalBytes: 12_282 * 1024 ** 2 }] }))).toBe('hot')
  })

  it('formats sizes at the scale the owner reads them', () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
    expect(formatBytes(6.4 * 1024 ** 3)).toBe('6.4 GB')
    expect(formatBytes(64 * 1024 ** 3)).toBe('64 GB')
  })
})
