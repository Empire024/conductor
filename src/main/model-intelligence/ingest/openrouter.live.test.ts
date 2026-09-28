import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '../registry'
import { ModelIntelligenceStore } from '../store'
import { refreshAll } from './index'

/** The one real-source check (docs/model-routing.md, Verification): MODEL_INTEL_LIVE=1 only. */
describe.skipIf(process.env.MODEL_INTEL_LIVE !== '1')('OpenRouter live', () => {
  it('fetches the public model list into a temp-file registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-intel-live-'))
    try {
      const store = new ModelIntelligenceStore(join(dir, 'conductor.db'))
      const registry = new ModelRegistry(store)
      const { results } = await refreshAll(registry, { openrouter: {} }, ['openrouter'])
      expect(results[0]).toMatchObject({ source: 'openrouter', status: 'ok', errors: [] })
      const records = registry.list({ provider: 'openrouter' })
      expect(records.length).toBeGreaterThan(50)
      const priced = records.filter(record => record.pricing?.inputPerMTok !== null && record.contextTokens)
      expect(priced.length).toBeGreaterThan(20)
      const sample = records.find(record => record.family?.startsWith('claude-')) ?? priced[0]!
      console.log(`[openrouter live] ${records.length} models; sample ${JSON.stringify(sample)}`)
      store.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 20_000)
})
