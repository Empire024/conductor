import { describe, expect, it } from 'vitest'
import { defaultProfile, ownerFact } from '../profile'
import { checkLegalSources, sourcesFor } from './legal-sources'

const signal = new AbortController().signal

describe('legal sources step', () => {
  const profile = defaultProfile('p')
  profile.facts.targetCountries = ownerFact(['SK'], '2026-09-29T00:00:00.000Z')

  it('lists each primary-law and regulator source once, filtered to the project\'s jurisdictions', () => {
    const sources = sourcesFor(['C03', 'C07', 'C09'], profile)
    expect(sources.length).toBeGreaterThan(0)
    expect(new Set(sources.map(source => source.url)).size).toBe(sources.length)
    expect(sources.every(source => source.kind === 'primary-law' || source.kind === 'regulator-guidance')).toBe(true)
    expect(sources.some(source => source.jurisdiction === 'US-CA')).toBe(false)
  })

  it('records reachability and a content hash through the public reader, never a control status; skipped without one', async () => {
    const sources = sourcesFor(['C03'], profile).slice(0, 2)
    const read = async (url: string) => url === sources[0]!.url ? { status: 200, text: 'Article 5(3)   of the directive' } : { status: 404, text: '' }
    const checked = await checkLegalSources(sources, read, signal, () => new Date('2026-09-29T00:00:00.000Z'))
    expect(checked[0]).toMatchObject({ status: 'reachable', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), checkedAt: '2026-09-29T00:00:00.000Z' })
    expect(checked[1]).toMatchObject({ status: 'unreachable', sha256: null, detail: 'HTTP 404' })
    const again = await checkLegalSources(sources, async url => url === sources[0]!.url ? { status: 200, text: 'Article 5(3) of the directive' } : null, signal)
    expect(again[0]!.sha256).toBe(checked[0]!.sha256)
    expect((await checkLegalSources(sources, null, signal)).every(entry => entry.status === 'skipped')).toBe(true)
  })
})
