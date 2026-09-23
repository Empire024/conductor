import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModelConfig, DOLPHIN_X1_8B, ORNITH_9B, QWEN_9B, QWEN_35B } from './config.ts'
import { admissionRefusal, assertResourceHeadroom, resourceRequirements, withAdmissionLock } from './resource-guard.ts'

const GiB = 1024 ** 3
describe('local model admission resources', () => {
  it('budgets total MoE weights, KV context and reserves rather than active parameters', () => {
    const small = defaultModelConfig(QWEN_9B)
    const large = defaultModelConfig(QWEN_35B)
    expect(resourceRequirements(large).ramBytes).toBeGreaterThan(29 * GiB)
    expect(resourceRequirements(small).ramBytes).toBeGreaterThan(16 * GiB)
    expect(resourceRequirements({ ...small, contextTokens: 65536 }).vramBytes - resourceRequirements(small).vramBytes).toBe(GiB)
    expect(() => assertResourceHeadroom(small, { ramFreeBytes: 32 * GiB, vramFreeBytes: 4 * GiB })).toThrow('Not enough memory')
    expect(() => assertResourceHeadroom(small, { ramFreeBytes: 32 * GiB, vramFreeBytes: 12 * GiB })).not.toThrow()
  })
  it('admits pinned Ornith at the measured 32k machine budget but refuses excessive context or changed weights', () => {
    const model = defaultModelConfig(ORNITH_9B)
    const available = { ramFreeBytes: 30 * GiB, vramFreeBytes: 10 * GiB }
    expect(() => assertResourceHeadroom(model, available)).not.toThrow()
    expect(() => assertResourceHeadroom({ ...model, contextTokens: 131072 }, available)).toThrow('Not enough memory')
    expect(() => assertResourceHeadroom({ ...model, sizeBytes: model.sizeBytes + 1 }, available)).toThrow('No reviewed memory envelope')
    expect(resourceRequirements(model).vramBytes).toBeGreaterThan(8 * GiB)
  })
  it('budgets Dolphin X1 8B with full-attention Llama geometry, not the hybrid 9B cache', () => {
    const model = defaultModelConfig(DOLPHIN_X1_8B)
    expect(model).toMatchObject({ port: 51438, gpuLayers: 999, quant: 'Q4_K_M', contextTokens: 32768, kvCacheType: 'q8_0' })
    const f16 = { ...model, kvCacheType: undefined }
    // 32 cached layers × 8 KV heads × 128 × K+V × fp16 is 128 KiB per token: 4 GiB at 32k.
    expect(resourceRequirements({ ...f16, contextTokens: 65536 }).vramBytes - resourceRequirements(f16).vramBytes).toBe(4 * GiB)
    expect(resourceRequirements(f16).vramBytes).toBe(model.sizeBytes + 4 * GiB + 1.75 * GiB)
    expect(() => assertResourceHeadroom(f16, { ramFreeBytes: 30 * GiB, vramFreeBytes: 10 * GiB })).toThrow('Not enough memory')
    // The default q8_0 cache fits the 9.8 GiB a 12 GB card has free beside the desktop.
    expect(resourceRequirements(model).vramBytes).toBeLessThan(8.5 * GiB)
    expect(() => assertResourceHeadroom(model, { ramFreeBytes: 30 * GiB, vramFreeBytes: 9.8 * GiB })).not.toThrow()
    expect(() => assertResourceHeadroom({ ...model, file: 'Dolphin-X1-8B-Q5_K_M.gguf', sizeBytes: 5732991968 }, { ramFreeBytes: 30 * GiB, vramFreeBytes: 12 * GiB })).toThrow('No reviewed memory envelope')
  })
  it('fails closed for unreadable telemetry and unreviewed runtime flags', () => {
    const model = defaultModelConfig(QWEN_9B)
    for (const value of [null, NaN, 0]) expect(() => assertResourceHeadroom(model, { ramFreeBytes: 32 * GiB, vramFreeBytes: value })).toThrow('Cannot verify')
    expect(() => resourceRequirements({ ...model, extraArgs: ['--ctx-size', '262144'] })).toThrow('No reviewed memory envelope')
    expect(() => assertResourceHeadroom(model, { ramFreeBytes: 8 * GiB, vramFreeBytes: 12 * GiB })).toThrow('Not enough memory')
  })
  it('names the running model and never offers automatic eviction', () => {
    expect(admissionRefusal(QWEN_35B, QWEN_9B).message).toContain(`${QWEN_9B} is already running`)
    expect(admissionRefusal(QWEN_35B, QWEN_9B).message).toContain('Conductor has not stopped it')
  })
})

describe('machine-wide startup serialization', () => {
  it('serializes two simultaneous process starts so only one can publish residency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-admission-race-'))
    const record = join(root, 'resident.json')
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const moduleUrl = new URL('./resource-guard.ts', import.meta.url).href
    const run = (model: string): Promise<string> => new Promise((resolve, reject) => {
      const code = `import {withAdmissionLock,admissionRefusal} from ${JSON.stringify(moduleUrl)}; import {existsSync,readFileSync,writeFileSync} from 'node:fs'; const path=${JSON.stringify(record)}; await withAdmissionLock(async()=>{if(existsSync(path)){process.stdout.write(admissionRefusal(${JSON.stringify(model)},readFileSync(path,'utf8')).message);return} await new Promise(r=>setTimeout(r,150));writeFileSync(path,${JSON.stringify(model)});process.stdout.write('STARTED')},2000,${port})`
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true })
      let text = ''
      child.stdout.on('data', chunk => { text += chunk })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve(text) : reject(new Error(`Race child exited ${code}`)))
    })
    try {
      const results = await Promise.all([run(QWEN_9B), run(QWEN_35B)])
      expect(results.filter(result => result === 'STARTED')).toHaveLength(1)
      expect(results.find(result => result !== 'STARTED')).toContain(`${readFileSync(record, 'utf8')} is already running`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('excludes a second OS process, then releases the lock even on failure', async () => {
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const moduleUrl = new URL('./resource-guard.ts', import.meta.url).href
    await withAdmissionLock(async () => {
      const code = `import { withAdmissionLock } from ${JSON.stringify(moduleUrl)}; try { await withAdmissionLock(async()=>{process.stdout.write('ADMITTED')},100,${port}) } catch {process.stdout.write('REFUSED')}`
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true })
        let text = ''
        child.stdout.on('data', chunk => { text += chunk })
        child.on('error', reject)
        child.on('close', () => resolve(text))
      })
      expect(output).toBe('REFUSED')
    }, 1000, port)
    await expect(withAdmissionLock(async () => { throw new Error('startup failed') }, 1000, port)).rejects.toThrow('startup failed')
    await expect(withAdmissionLock(async () => 'admitted', 1000, port)).resolves.toBe('admitted')
  })
})
