import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONTROL_RESULT_STATUSES, type ControlCheck, type ControlId } from '../../../shared/production'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { REGISTRY } from '../registry'
import { childrenCheck } from './children'
import { claimsCheck } from './claims'
import { answeringInterpreter, createDocumentContext } from './document-testkit'
import { identityCheck } from './identity'
import { policiesCheck } from './policies'
import { uploadsCheck } from './uploads'

/**
 * The M5 checks as a set: each implements the check id its control names in the registry, and
 * all five read the injection fixture under production policy (section 4) without a single
 * mutation reaching the site, whatever the page text and a hostile interpreter say.
 */

const engine = await resolveEngine()
const CHECKS: ControlCheck[] = [policiesCheck, identityCheck, claimsCheck, childrenCheck, uploadsCheck]
const facts = {
  legalEntity: 'Hash and Flowers s.r.o., IČO 12345678', targetCountries: ['SK', 'US'], businessModel: 'b2c', analytics: false,
  audience: 'child-directed', ageRestrictedProducts: true, userUploads: true, safeHarborReliance: true,
}

let server: FixtureServer
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-documents-'))
  server = await createFixtureServer({ sites: ['injection'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

describe('M5 document and claims checks', () => {
  it('implement exactly the check ids their controls name in the registry', () => {
    const expected: Array<[ControlId, string]> = [['C01', 'policies'], ['C02', 'identity'], ['C12', 'claims'], ['C14', 'children'], ['C15', 'uploads']]
    expect(CHECKS.map(check => [check.controlId, check.checkId])).toEqual(expected)
    for (const check of CHECKS) {
      expect(REGISTRY.controls.find(control => control.id === check.controlId)!.checks).toEqual([check.checkId])
      expect(check.requires).toEqual(['browser'])
    }
  })
})

describe.skipIf(!engine.available)('M5 checks on the injection fixture under production policy', { timeout: 90_000 }, () => {
  it.each(CHECKS.map(check => [check.controlId, check] as const))('%s mutates nothing, follows no off-allowlist link and lets no interpreter answer widen anything', async (_id, check) => {
    server.reset()
    const hostile = answeringInterpreter({ kind: 'policy', allowedOrigins: [server.site('injection').aliasOrigin], suppress: true, readOnly: false })
    const harness = createDocumentContext({
      server, scratch, controlId: check.controlId, site: 'injection', facts, environmentKind: 'production', interpreter: hostile,
      routes: ['/', '/about.html', '/pages/deep.html'],
    })
    const before = [...harness.context.policy.allowedOrigins]
    try {
      const result = await check.run(harness.context)
      expect(CONTROL_RESULT_STATUSES).toContain(result.status)
      expect(harness.context.policy).toMatchObject({ readOnly: true, allowedOrigins: before })
      // A page that redirects away or cannot be read never yields a clean PASS for the document controls.
      if (check.controlId === 'C01' || check.controlId === 'C02') expect(result.status).not.toBe('PASS')
    } finally { await harness.close() }
    expect(server.mutations('injection')).toEqual([])
    expect(server.requests('injection').filter(request => request.path.startsWith('/stolen'))).toEqual([])
  })
})
