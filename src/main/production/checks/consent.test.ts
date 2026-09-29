import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConsentState } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createConsentCheck } from './consent'
import { createTechnicalContext, type TechnicalContext } from './technical-testkit'

const engine = await resolveEngine()
const check = createConsentCheck({ maxRoutes: 1, settleMs: 700, maxTabs: 20 })

let server: FixtureServer
let scratch: string
const contexts: TechnicalContext[] = []
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-consent-'))
  server = await createFixtureServer({ sites: ['consent-good', 'consent-tracker-before', 'consent-reject-still-tracks', 'consent-essential-only'] })
})
afterAll(async () => {
  await Promise.all(contexts.map(context => context.close()))
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

const run = async (site: string, analytics: boolean | undefined, consentStates: ConsentState[]) => {
  const technical = createTechnicalContext({
    server, site, controlId: 'C03', scratch, facts: analytics === undefined ? {} : { analytics },
    routes: ['/', '/about/'], scope: { devices: ['desktop'], consentStates },
  })
  contexts.push(technical)
  return { technical, result: await check.run(technical.context) }
}
const keys = (result: { findings: Array<{ key: string }> }) => result.findings.map(finding => finding.key)

describe.skipIf(!engine.available)('C03 consent', { timeout: 30_000 }, () => {
  it('passes a site that tracks only after consent, keeps the choice and lets the visitor withdraw', async () => {
    const { result } = await run('consent-good', true, ['clean', 'rejected', 'withdrawn'])
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.coverage.tested[0]?.consentStates).toEqual(['clean', 'rejected', 'withdrawn'])
    expect(result.evidence.length).toBeGreaterThanOrEqual(3)
    expect(result.observations.join('\n')).toMatch(/withdrawn .*choice applied via .*open.*reject/)
  })

  it('shows the positive control: acceptance makes the tracker run, and the granular choice keeps it off', async () => {
    const { result } = await run('consent-good', true, ['no-interaction', 'selected', 'accepted'])
    expect(result.status).toBe('PASS')
    const accepted = result.observations.find(line => line.startsWith('accepted'))
    expect(accepted).toMatch(/after choice: \d+ request\(s\) to tracker at localhost/)
    expect(accepted).toMatch(/cookie _ga/)
    expect(result.observations.find(line => line.startsWith('selected'))).toMatch(/nothing consent-requiring after the choice/)
  })

  it('fails a tracker that loads before any choice, including one that starts late', async () => {
    const { result } = await run('consent-tracker-before', true, ['clean'])
    expect(result.status).toBe('FAIL')
    expect(keys(result)).toEqual(expect.arrayContaining(['tracker-before-consent:host-localhost', 'tracker-before-consent:cookie-_ga']))
    const finding = result.findings.find(item => item.key === 'tracker-before-consent:host-localhost')!
    expect(finding).toMatchObject({ controlId: 'C03', checkId: 'consent', category: 'legal', severity: 'high', confidence: 'confirmed', route: '/' })
    expect(finding.observed).toMatch(/\/collect\?v=2/)
    expect(finding.legal?.sources.length).toBeGreaterThan(0)
    expect(finding.evidence.length).toBe(1)
  })

  it('fails a site that still tracks after the visitor rejects', async () => {
    const { result } = await run('consent-reject-still-tracks', true, ['clean', 'rejected'])
    expect(result.status).toBe('FAIL')
    expect(keys(result)).toContain('tracker-after-reject:host-localhost')
    expect(keys(result).some(key => key.startsWith('tracker-before-consent'))).toBe(false)
    expect(result.findings.find(item => item.key === 'tracker-after-reject:host-localhost')?.severity).toBe('critical')
  })

  it('passes the essential-only negative control without a banner when no analytics is declared', async () => {
    const { result } = await run('consent-essential-only', false, ['clean', 'no-interaction', 'rejected', 'accepted'])
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.observations).toContain('Essential-only: no consent-requiring requests, cookies or storage in any tested consent state; no banner is required for that.')
  })

  it('fails a site that tracks after acceptance when the profile declares no analytics', async () => {
    const { result } = await run('consent-good', false, ['accepted'])
    expect(keys(result)).toContain('tracker-after-acceptance:host-localhost')
    expect(result.status).toBe('FAIL')
  })

  it('is UNVERIFIED while the analytics fact is unknown, never PASS', async () => {
    const { result } = await run('consent-good', undefined, ['clean'])
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/applicability unknown/)
  })
})
