import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CheckOutcome, RouteEntry } from '../../../shared/production'
import { createCustomCommandAdapter } from '../adapters/custom-command'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createCommerceContext, evidenceText, type CommerceContextOptions, type JournalEntry } from './commerce-testkit'
import { createDataRightsCheck } from './data-rights'

const engine = await resolveEngine()
const check = createDataRightsCheck({ traceWaitMs: 1_500, pollMs: 200 })

/**
 * The project's records command as the custom-command adapter runs it: every subject starts with a
 * customer, a newsletter subscription and an order; once the site's mutation log holds a deletion
 * request for the subject, the backend in `mode` answers what remains.
 */
const RECORDS_COMMAND = `
const [mode, origin] = process.argv.slice(2)
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', async () => {
  const request = JSON.parse(input)
  if (request.action !== 'records') { console.log(JSON.stringify([])); return }
  const log = await (await fetch(origin + '/__mutations')).json()
  const requested = log.some(item => [...new URLSearchParams(item.body).values()].includes(request.subject))
  const all = [
    { store: 'woocommerce', kind: 'customer', id: 'c-1', retainedBecause: null },
    { store: 'mailchimp', kind: 'subscriber', id: 's-1', retainedBecause: null },
    { store: 'woocommerce', kind: 'order', id: 'o-1', retainedBecause: null },
  ]
  const after = !requested || mode === 'unhandled' ? all
    : mode === 'undocumented' ? [{ ...all[2], retainedBecause: 'accounting: invoices kept 10 years' }, { store: 'analytics', kind: 'event-log', id: 'e-1', retainedBecause: 'fraud prevention' }]
    : [{ ...all[2], retainedBecause: 'accounting: invoices kept 10 years (tax law)' }]
  console.log(JSON.stringify(after))
})
`

let server: FixtureServer
let scratch: string
let script: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-rights-'))
  script = join(scratch, 'records.cjs')
  writeFileSync(script, RECORDS_COMMAND)
  server = await createFixtureServer({ sites: ['rights-good', 'rights-unhandled'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => server.reset())

const PRIVACY: RouteEntry = { path: '/privacy-policy/', source: 'sitemap', tags: ['policy', 'privacy'], coverage: 'full' }
const FACTS = { targetCountries: ['SK'], dataCategories: ['contact', 'orders'] }

async function run(options: Partial<CommerceContextOptions> & { site: string; mode?: string }): Promise<{ result: CheckOutcome; operations: JournalEntry[]; evidence: string; markers: string[] }> {
  const origin = server.site(options.site).origin
  const harness = createCommerceContext({
    server, scratch, controlId: 'C07', facts: FACTS, routes: [PRIVACY],
    adapters: policy => ({ commerce: createCustomCommandAdapter({ command: `"${process.execPath}" "${script}" ${options.mode ?? 'good'} ${origin}`, policy }) }),
    ...options,
  })
  try {
    const result = await check.run(harness.context)
    return { result, operations: harness.operations, evidence: evidenceText(harness.artifactsDir), markers: harness.synthetic.markers() }
  } finally { await harness.close() }
}

describe('C07 applicability', () => {
  it('is UNVERIFIED while the target countries or data categories are unknown', async () => {
    const { result } = await run({ site: 'rights-good', facts: { targetCountries: ['SK'] } })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/until the owner answers: dataCategories/)
    expect(server.requests('rights-good')).toEqual([])
  })

  it('is NOT_APPLICABLE when the owner disabled it, with the reason (negative control)', async () => {
    const harness = createCommerceContext({ server, scratch, controlId: 'C07', site: 'rights-good', facts: FACTS })
    harness.context.profile.scope.disabledControls = [{ controlId: 'C07', reason: 'static brochure site, no personal data' }]
    try {
      const result = await check.run(harness.context)
      expect(result).toMatchObject({ status: 'NOT_APPLICABLE', findings: [] })
      expect(result.reason).toMatch(/static brochure site/)
    } finally { await harness.close() }
  })
})

describe.skipIf(!engine.available)('C07 data rights check', { timeout: 60_000 }, () => {
  it('passes: rights described, request form reachable, email verification, deletion traced and the kept invoice reconciled (known-good)', async () => {
    const { result, operations, evidence, markers } = await run({ site: 'rights-good', authorize: ['deletion-request'] })
    expect(result.reason).toBeNull()
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(operations.map(entry => `${entry.mutation}:${entry.status}`)).toEqual(['deletion-request:done'])
    expect(server.mutations('rights-good').map(item => `${item.method} ${item.path}`)).toEqual(['POST /privacy-request/submit'])
    const observed = result.observations.join('\n')
    expect(observed).toMatch(/Documented retention exceptions: accounting, backups/)
    expect(observed).toMatch(/Identity verification on \/privacy-request\/: .*confirmation link/)
    expect(observed).toMatch(/Deletion request traced: 3 record\(s\) before, 1 after \(woocommerce\/order kept: accounting/)
    expect(observed).toMatch(/Reconciled: woocommerce:order kept for accounting/)
    // The synthetic subject's marker never reaches the evidence, though the record trace was written.
    expect(evidence).toMatch(/woocommerce/)
    expect(markers.length).toBeGreaterThan(0)
    for (const marker of markers) expect(evidence).not.toContain(marker)
    expect(result.coverage.tested.map(item => item.path)).toEqual(['/privacy-policy/', '/privacy-request/'])
  })

  it('finds records that remain after the deletion request', async () => {
    const { result } = await run({ site: 'rights-good', authorize: ['deletion-request'], mode: 'unhandled' })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['records-remain:mailchimp:subscriber', 'records-remain:woocommerce:customer', 'records-remain:woocommerce:order'])
    expect(result.findings[0]).toMatchObject({ severity: 'high', confidence: 'confirmed', scope: 'journey', route: '/privacy-request/' })
  })

  it('finds a retention reason the notice does not document', async () => {
    const { result } = await run({ site: 'rights-good', authorize: ['deletion-request'], mode: 'undocumented' })
    expect(result.status).toBe('WARN')
    expect(result.findings.map(finding => finding.key)).toEqual(['retention-not-documented:analytics:event-log'])
    expect(result.findings[0]!.observed).toMatch(/because "fraud prevention"; the notice documents accounting, backups/)
  })

  it('finds no erasure right and no request route in the notice (broken)', async () => {
    const { result, operations } = await run({ site: 'rights-unhandled', authorize: ['deletion-request'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['no-deletion-right-described', 'no-request-route'])
    expect(operations).toEqual([])
    expect(result.reason).toMatch(/no request form on the site/)
  })

  it('finds a request form that demands identity documents, and does not submit what it cannot fill (broken)', async () => {
    const deletion: RouteEntry = { path: '/account-deletion/', source: 'owner', tags: ['data-rights'], coverage: 'full' }
    const { result, operations } = await run({ site: 'rights-unhandled', routes: [PRIVACY, deletion], authorize: ['deletion-request'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['disproportionate-identity-check', 'no-deletion-right-described'])
    expect(result.findings.find(finding => finding.key === 'disproportionate-identity-check')!.observed).toMatch(/Birth number \(text\).*passport or ID card \(file\)/)
    expect(result.reason).toMatch(/requires fields a synthetic request cannot provide/)
    expect(operations).toEqual([])
    expect(server.mutations('rights-unhandled')).toEqual([])
  })

  it('stops before the deletion request without a write authorization: UNVERIFIED with the reason, nothing submitted', async () => {
    const { result, operations } = await run({ site: 'rights-good' })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.findings).toEqual([])
    expect(result.reason).toMatch(/sandbox write authorization required for deletion-request/)
    expect(operations).toEqual([])
    expect(server.mutations('rights-good')).toEqual([])
  })

  it('never submits a deletion request on production, even with a stray authorization', async () => {
    const { result, operations } = await run({ site: 'rights-good', environmentKind: 'production', authorize: ['deletion-request'] })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/sandbox write authorization required for deletion-request: .*production/)
    expect(operations).toEqual([])
    expect(server.mutations('rights-good')).toEqual([])
  })
})
