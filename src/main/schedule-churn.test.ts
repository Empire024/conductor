import { describe, expect, it, vi } from 'vitest'
import { createLocalChurn, fitInput, type LocalChurnDeps } from './schedule-churn'

const request = { model: 'local/qwen', system: 'Summarize.', input: 'diff', maxTokens: 500, signal: new AbortController().signal, holder: 'schedule:one' }
const deps = (patch: Partial<LocalChurnDeps> = {}) => {
  const release = vi.fn()
  const base: LocalChurnDeps = {
    models: () => [{ id: 'local/qwen', label: 'Qwen', contextTokens: 32_768 }, { id: 'local/ornith', label: 'Ornith', contextTokens: 32_768 }],
    apiKey: () => 'key',
    running: () => [],
    healthy: async () => true,
    ensure: vi.fn(async () => ({ ok: true as const, port: 51437 })),
    stop: vi.fn(async () => undefined),
    mayStop: () => true,
    acquire: vi.fn(async () => ({ release })),
    complete: vi.fn(async () => ({ content: '  - version moved to 1.1.0  ' })),
    ...patch
  }
  return { ...base, release }
}

describe('local churn', () => {
  it('uses a server that is already loaded, whatever model it holds, and never switches or stops it', async () => {
    const d = deps({ running: () => [{ model: 'local/ornith', port: 51435 }] })
    const result = await createLocalChurn(d).summarize(request)
    expect(result).toMatchObject({ ok: true, model: 'local/ornith', text: '- version moved to 1.1.0', note: expect.stringContaining('never switched') })
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.stop).not.toHaveBeenCalled()
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://127.0.0.1:51435', model: 'local/ornith', maxTokens: 500 }))
    expect(d.release).toHaveBeenCalledOnce()
  })

  it('starts the task model when no server runs, holds the generation gate, and stops only what it started', async () => {
    const d = deps()
    expect(await createLocalChurn(d).summarize(request)).toMatchObject({ ok: true, model: 'local/qwen' })
    expect(d.ensure).toHaveBeenCalledWith('local/qwen')
    expect(d.acquire).toHaveBeenCalledWith('schedule:one', request.signal)
    expect(d.stop).toHaveBeenCalledWith('local/qwen')
  })

  it('leaves a server it started running when someone began using it meanwhile', async () => {
    const d = deps({ mayStop: () => false })
    await createLocalChurn(d).summarize(request)
    expect(d.stop).not.toHaveBeenCalled()
  })

  it('reports why it could not summarize instead of downloading, switching or throwing', async () => {
    expect(await createLocalChurn(deps({ models: () => null })).summarize(request)).toMatchObject({ ok: false, note: expect.stringContaining('No local model is set up') })
    expect(await createLocalChurn(deps({ ensure: async () => ({ ok: false, message: 'Cannot start: local/ornith is busy' }) })).summarize(request)).toMatchObject({ ok: false, model: 'local/qwen', note: expect.stringContaining('local/ornith is busy') })
    const failing = deps({ complete: async () => { throw new Error('Local model request failed with HTTP 500') } })
    expect(await createLocalChurn(failing).summarize(request)).toMatchObject({ ok: false, note: expect.stringContaining('HTTP 500') })
    expect(failing.release).toHaveBeenCalledOnce()
    expect(await createLocalChurn(deps({ complete: async () => ({ content: ' ' }) })).summarize(request)).toMatchObject({ ok: false, note: expect.stringContaining('empty') })
  })

  it('keeps the head and tail of an input that does not fit', () => {
    const fitted = fitInput('a'.repeat(700) + 'b'.repeat(300), 500)
    expect(fitted.length).toBe(500)
    expect(fitted.startsWith('a'.repeat(350))).toBe(true)
    expect(fitted.endsWith('b'.repeat(50))).toBe(true)
  })
})
