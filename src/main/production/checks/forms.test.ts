import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EnvironmentKind, MutationKind } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createFormsCheck } from './forms'
import { createTechnicalContext, type TechnicalContext } from './technical-testkit'

const engine = await resolveEngine()
const check = createFormsCheck({ settleMs: 400 })

let server: FixtureServer
let scratch: string
const contexts: TechnicalContext[] = []
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-forms-'))
  server = await createFixtureServer({ sites: ['forms-good', 'forms-excessive'] })
})
afterAll(async () => {
  await Promise.all(contexts.map(context => context.close()))
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

const run = async (site: string, routes: string[], patch: { environmentKind?: EnvironmentKind; authorize?: MutationKind[]; dataCategories?: string[] | null } = {}) => {
  const technical = createTechnicalContext({
    server, site, controlId: 'C04', scratch, routes, environmentKind: patch.environmentKind, authorize: patch.authorize,
    facts: patch.dataCategories === null ? {} : { dataCategories: patch.dataCategories ?? ['contact', 'email', 'name'] },
  })
  contexts.push(technical)
  return { technical, result: await check.run(technical.context) }
}
const keys = (result: { findings: Array<{ key: string }> }) => result.findings.map(finding => finding.key).sort()

describe.skipIf(!engine.available)('C04 forms', { timeout: 30_000 }, () => {
  it('passes proportionate forms with unticked consent boxes, and declares submission unobservable without authorization', async () => {
    server.reset()
    const { result } = await run('forms-good', ['/', '/contact/'])
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.coverage.unobservable).toContain('Form submission not tested: sandbox write authorization required for form-submit.')
    expect(result.observations).toContain('2 form(s) found on 2 route(s).')
    expect(server.mutations('forms-good')).toEqual([])
  })

  it('fails pre-ticked consent, personal data in a GET form, undeclared sensitive fields, and typed data leaving the page', async () => {
    server.reset()
    const { result, technical } = await run('forms-excessive', ['/', '/newsletter/'], { environmentKind: 'production' })
    expect(result.status).toBe('FAIL')
    expect(keys(result)).toEqual(expect.arrayContaining([
      'prechecked-consent:post:/newsletter/subscribe:marketing_partners',
      'personal-data-in-get-form:get:/orders/',
      'sensitive-field:post:/newsletter/subscribe:date_of_birth',
      'sensitive-field:post:/newsletter/subscribe:gender',
      'sensitive-field:post:/newsletter/subscribe:rodne_cislo',
      'marker-leak-typing:host-localhost',
      'marker-in-storage:localStorage',
    ]))
    const leak = result.findings.find(finding => finding.key === 'marker-leak-typing:host-localhost')!
    expect(leak).toMatchObject({ severity: 'high', confidence: 'confirmed', category: 'legal', route: '/newsletter/' })
    expect(result.coverage.unobservable).toContain('Form submission is not tested on production: the audit never submits there.')
    expect(technical.operations).toEqual([])
    expect(server.mutations('forms-excessive')).toEqual([])
    // Evidence is written through the sink, so the markers never reach the disk.
    expect(result.evidence.length).toBeGreaterThanOrEqual(2)
  })

  it('accepts a declared data category', async () => {
    const { result } = await run('forms-excessive', ['/newsletter/'], { dataCategories: ['email', 'date-of-birth', 'gender', 'national-id'], environmentKind: 'production' })
    expect(keys(result).filter(key => key.startsWith('sensitive-field'))).toEqual([])
  })

  it('submits only through an authorized form-submit operation on a sandbox', async () => {
    server.reset()
    const { result, technical } = await run('forms-good', ['/contact/'], { environmentKind: 'sandbox', authorize: ['form-submit'] })
    expect(technical.operations).toEqual(['form-submit /contact/ #contact'])
    expect(server.mutations('forms-good').map(item => `${item.method} ${item.path}`)).toEqual(['POST /contact/send'])
    expect(result.status).toBe('PASS')
    expect(result.observations).toContain('Submitted #contact on /contact/ under the sandbox write authorization.')
  })

  it('is UNVERIFIED while the data categories are unknown', async () => {
    const { result } = await run('forms-good', ['/'], { dataCategories: null })
    expect(result.status).toBe('UNVERIFIED')
  })
})
