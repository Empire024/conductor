import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { vendorOf } from './technical-support'
import { createVendorsCheck } from './vendors'
import { createTechnicalContext, type TechnicalContext } from './technical-testkit'

const engine = await resolveEngine()
const check = createVendorsCheck({ settleMs: 300 })

let server: FixtureServer
let scratch: string
const contexts: TechnicalContext[] = []
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-vendors-'))
  server = await createFixtureServer({ sites: ['vendors-good', 'vendors-unapproved'] })
})
afterAll(async () => {
  await Promise.all(contexts.map(context => context.close()))
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

const run = async (site: string, facts: Record<string, unknown>) => {
  const technical = createTechnicalContext({ server, site, controlId: 'C05', scratch, routes: ['/'], facts })
  contexts.push(technical)
  return await check.run(technical.context)
}
const keys = (result: { findings: Array<{ key: string }> }) => result.findings.map(finding => finding.key).sort()

describe('vendor signatures', () => {
  it('names known vendors by host or URL and keys the rest by host', () => {
    expect(vendorOf('https://www.google-analytics.com/g/collect?v=2')).toMatchObject({ name: 'Google Analytics', category: 'analytics', consent: true, generic: false })
    expect(vendorOf('https://fonts.gstatic.com/s/roboto.woff2')).toMatchObject({ name: 'Google Fonts', category: 'fonts', consent: false })
    expect(vendorOf('https://static.hotjar.com/c/hotjar-1.js')).toMatchObject({ category: 'replay' })
    expect(vendorOf('https://cdn.example.net/sdk/logrocket.min.js')).toMatchObject({ name: 'LogRocket' })
    expect(vendorOf('https://stats.example.org/collect?x=1')).toMatchObject({ key: 'host-stats.example.org', consent: true, generic: true })
    expect(vendorOf('https://cdn.example.org/app.js')).toMatchObject({ key: 'host-cdn.example.org', consent: false, generic: true })
  })
})

describe.skipIf(!engine.available)('C05 vendors', { timeout: 30_000 }, () => {
  it('passes when every vendor is named in the notice, fonts are self-hosted and AI is disclosed', async () => {
    const result = await run('vendors-good', { processors: ['Hosting provider'], aiRuntime: true })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.observations.join('\n')).toMatch(/localhost .*disclosed: notice/)
    expect(result.observations.join('\n')).toMatch(/AI disclosure text found on \//)
    expect(result.humanReview.map(item => item.id)).toEqual(['C05:ai-disclosure-placement'])
  })

  it('warns on an undisclosed analytics vendor, a remote font and a missing AI disclosure', async () => {
    const result = await run('vendors-unapproved', { processors: ['Hosting provider'], aiRuntime: true })
    expect(keys(result)).toEqual(['ai-disclosure-missing', 'remote-font:host-localhost', 'undisclosed-vendor:host-localhost'])
    expect(result.findings.find(finding => finding.key === 'remote-font:host-localhost')).toMatchObject({ category: 'internal-quality', severity: 'low' })
    expect(result.findings.find(finding => finding.key === 'undisclosed-vendor:host-localhost')).toMatchObject({ category: 'legal', severity: 'medium', confidence: 'likely' })
    expect(result.status).toBe('WARN')
  })

  it('reconciles a vendor named only in the profile processors', async () => {
    const result = await run('vendors-unapproved', { processors: ['localhost analytics'], aiRuntime: false })
    expect(keys(result)).toEqual(['remote-font:host-localhost'])
  })

  it('is UNVERIFIED while processors are unknown', async () => {
    const result = await run('vendors-good', { aiRuntime: false })
    expect(result.status).toBe('UNVERIFIED')
  })
})
