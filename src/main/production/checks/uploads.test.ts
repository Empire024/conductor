import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CheckOutcome } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createDocumentContext, type DocumentContextOptions } from './document-testkit'
import { requiredUploadElements, uploadsCheck } from './uploads'

const engine = await resolveEngine()
const facts = { userUploads: true, targetCountries: ['US', 'SK'], safeHarborReliance: true }

let server: FixtureServer
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-uploads-'))
  server = await createFixtureServer({ sites: ['uploads-na', 'uploads-missing-dmca', 'uploads-good'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

async function run(options: Omit<DocumentContextOptions, 'server' | 'scratch' | 'controlId'>): Promise<CheckOutcome> {
  const harness = createDocumentContext({ server, scratch, controlId: 'C15', ...options })
  try { return await uploadsCheck.run(harness.context) } finally { await harness.close() }
}

describe('C15 applicability and duties', () => {
  it('is NOT_APPLICABLE without user uploads and opens nothing (negative control)', async () => {
    const before = server.requests('uploads-na').length
    const result = await run({ site: 'uploads-na', facts: { userUploads: false } })
    expect(result).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'No user-generated content is hosted.', findings: [] })
    expect(server.requests('uploads-na').length).toBe(before)
  })

  it('is UNVERIFIED while userUploads is unknown', async () => {
    const result = await run({ site: 'uploads-na', facts: {} })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/userUploads/)
  })

  it('derives the duties from the target countries and safe-harbor reliance', () => {
    const duties = (patch: Record<string, unknown>) => {
      const harness = createDocumentContext({ server, scratch, controlId: 'C15', site: 'uploads-na', facts: { userUploads: true, ...patch } })
      void harness.close()
      return requiredUploadElements(harness.context)
    }
    expect([...duties({ targetCountries: ['SK'], safeHarborReliance: false }).required.keys()]).toEqual(['rights-notice', 'report-route'])
    expect(duties({ targetCountries: ['SK'], safeHarborReliance: false }).required.get('report-route')).toMatch(/DSA\) Art\. 16/)
    expect([...duties(facts).required.keys()]).toEqual(['rights-notice', 'report-route', 'counter-notice', 'designated-agent', 'repeat-infringer'])
    expect(duties({ targetCountries: ['US'] }).unknown).toEqual([expect.stringMatching(/safe-harbor reliance unknown/)])
    expect(duties({}).unknown).toEqual([expect.stringMatching(/target countries unknown/)])
  })
})

describe.skipIf(!engine.available)('C15 uploads check', { timeout: 60_000 }, () => {
  it('passes a site with a copyright policy, a report route, a counter-notice, a repeat-infringer policy and a designated agent (known-good)', async () => {
    const result = await run({ site: 'uploads-good', facts, routes: ['/'] })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.humanReview.map(item => item.id)).toEqual(['C15:dmca-directory-listing', 'C15:legal-adequacy'])
    expect(result.humanReview[0]!.question).toMatch(/Copyright Office DMCA Designated Agent Directory entry.*agent named on \/copyright\//)
    expect(result.humanReview[0]!.why).toMatch(/never fetches registration data/)
    expect(result.observations).toEqual(expect.arrayContaining([expect.stringMatching(/designated agent on the site \(\/copyright\/\): Designated DMCA agent: Jane Doe/)]))
  })

  it('finds the missing DMCA duties on a gallery that relies on the safe harbor (broken)', async () => {
    const result = await run({ site: 'uploads-missing-dmca', facts, routes: ['/'] })
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key).sort()).toEqual(['missing:counter-notice', 'missing:designated-agent', 'missing:repeat-infringer'])
    expect(result.findings.find(finding => finding.key === 'missing:designated-agent')!.expected).toContain('512(c)(2)')
    expect(result.humanReview[0]!.question).toMatch(/matched with the site/)
    expect(result.coverage.tested.map(entry => entry.path).sort()).toEqual(['/', '/report/', '/terms/'])
    expect(server.mutations()).toEqual([])
  })

  it('needs only a rights notice and a report route for an EU-only project without the safe harbor', async () => {
    const result = await run({ site: 'uploads-missing-dmca', facts: { userUploads: true, targetCountries: ['SK'], safeHarborReliance: false }, routes: ['/'] })
    expect(result.findings).toEqual([])
    expect(result.humanReview.map(item => item.id)).toEqual(['C15:legal-adequacy'])
  })
})
