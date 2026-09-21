import { describe, expect, it } from 'vitest'
import { baseMachineFacts, describeMachine, detectMachine, parseGpuInventory } from './machine-policy'

describe('machine limits, stated once per runtime', () => {
  it('reads the GPU inventory nvidia-smi prints and rounds VRAM to whole gigabytes', () => {
    expect(parseGpuInventory('NVIDIA GeForce RTX 5070, 12227\r\n')).toEqual([{ name: 'NVIDIA GeForce RTX 5070', vramGb: 12 }])
    expect(parseGpuInventory('A, 8192\nB, 24576\n')).toEqual([{ name: 'A', vramGb: 8 }, { name: 'B', vramGb: 24 }])
    expect(parseGpuInventory('')).toEqual([])
    expect(parseGpuInventory('garbage\nNoMemory, x\n')).toEqual([])
  })

  it('describes the machine in one static sentence with the rules that keep it responsive', () => {
    const line = describeMachine({ threads: 24, ramGb: 63, gpus: [{ name: 'NVIDIA GeForce RTX 5070', vramGb: 12 }] })
    expect(line).toContain('24 CPU threads, 63 GB RAM, NVIDIA GeForce RTX 5070 with 12 GB VRAM')
    expect(line).toContain('One local model server at a time')
    expect(line).toContain('never download model files')
    expect(line.split('\n')).toHaveLength(1)
    expect(describeMachine({ threads: 8, ramGb: 16, gpus: [] })).toContain('no NVIDIA GPU detected')
  })

  it('falls back to CPU and RAM alone when nvidia-smi is missing', async () => {
    const facts = await detectMachine(() => Promise.reject(new Error('ENOENT')))
    expect(facts).toEqual({ ...baseMachineFacts(), gpus: [] })
    expect(facts.threads).toBeGreaterThan(0)
    expect(facts.ramGb).toBeGreaterThan(0)
    const detected = await detectMachine(() => Promise.resolve('NVIDIA GeForce RTX 5070, 12227\n'))
    expect(detected.gpus).toEqual([{ name: 'NVIDIA GeForce RTX 5070', vramGb: 12 }])
  })
})
