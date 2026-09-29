import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveEngine } from '../browser'
import { createFixtureServer, type FixtureServer } from '../fixtures/server'
import { MARKER_PATTERN } from '../synthetic'
import { createReplayCheck } from './replay'
import { createTechnicalContext, type TechnicalContext } from './technical-testkit'

const engine = await resolveEngine()
const check = createReplayCheck({ settleMs: 500 })

let server: FixtureServer
let scratch: string
const contexts: TechnicalContext[] = []
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-replay-'))
  server = await createFixtureServer({ sites: ['replay-masked', 'replay-leaks', 'consent-essential-only'] })
})
afterAll(async () => {
  await Promise.all(contexts.map(context => context.close()))
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

const run = async (site: string, sessionReplay: boolean | undefined, routes = ['/checkout/', '/']) => {
  const technical = createTechnicalContext({ server, site, controlId: 'C06', scratch, routes, facts: sessionReplay === undefined ? {} : { sessionReplay } })
  contexts.push(technical)
  return { technical, result: await check.run(technical.context) }
}
const keys = (result: { findings: Array<{ key: string }> }) => result.findings.map(finding => finding.key).sort()
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)])

describe.skipIf(!engine.available)('C06 session replay', { timeout: 30_000 }, () => {
  it('passes a declared recorder that masks every input', async () => {
    server.reset()
    const { result } = await run('replay-masked', true)
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.observations).toContain('Recorders: LogRocket (request http://localhost:' + server.site('replay-masked').port + '/sdk/logrocket.min.js).')
    // The recorder really sent data: masking was exercised, not skipped.
    expect(server.collected('replay-masked').length).toBeGreaterThan(0)
    expect(server.collected('replay-masked').some(item => item.body.includes('****'))).toBe(true)
  })

  it('fails a recorder that sends typed passwords, cards, emails and messages, and keeps the markers out of evidence', async () => {
    const { result, technical } = await run('replay-leaks', true)
    expect(result.status).toBe('FAIL')
    expect(keys(result)).toEqual(['captures-card:logrocket', 'captures-email:logrocket', 'captures-message:logrocket', 'captures-password:logrocket'])
    expect(result.findings.find(finding => finding.key === 'captures-password:logrocket')).toMatchObject({ severity: 'critical', confidence: 'confirmed', category: 'legal', route: '/checkout/' })
    expect(result.findings.find(finding => finding.key === 'captures-email:logrocket')?.severity).toBe('high')
    for (const file of files(technical.evidence.dir)) expect(readFileSync(file, 'utf8').match(MARKER_PATTERN), file).toBeNull()
  })

  it('fails a recorder the profile does not declare, even when it masks', async () => {
    const { result } = await run('replay-masked', false)
    expect(keys(result)).toEqual(['undeclared-replay:logrocket'])
    expect(result.status).toBe('FAIL')
  })

  it('passes a site without any recorder when none is declared', async () => {
    const { result } = await run('consent-essential-only', false, ['/'])
    expect(result.status).toBe('PASS')
    expect(result.observations).toContain('No session recorder detected.')
    expect(result.coverage.unobservable).toContain('No password, email, card or message fields on the tested routes: masking was not exercised.')
  })

  it('is UNVERIFIED while session replay is unknown', async () => {
    const { result } = await run('replay-masked', undefined)
    expect(result.status).toBe('UNVERIFIED')
  })
})
