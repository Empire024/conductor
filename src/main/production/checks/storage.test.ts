import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CheckOutcome, StorageAdapter, StorageConfig } from '../../../shared/production'
import { createStorageAdapter } from '../adapters/storage'
import { FIXTURE_SITES_DIR, createFixtureServer, type FixtureServer } from '../fixtures/server'
import { createStorageCheck, groupOf, publicRoot, storageCheck } from './storage'
import { createTechnicalContext, type TechnicalContext } from './technical-testkit'

let server: FixtureServer
let scratch: string
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-storage-check-'))
  server = await createFixtureServer({ sites: ['storage-public-ok', 'storage-private-exposed'] })
})
afterAll(async () => {
  await server?.close()
  rmSync(scratch, { recursive: true, force: true })
})

const PUBLIC_PREFIXES = ['wp-content/uploads/2026/']

/** A local-dir config over the fixture site on disk, probed through the fixture server. */
const siteConfig = (site: string): StorageConfig => ({
  kind: 'local-dir', location: join(FIXTURE_SITES_DIR, site), credentialRef: null, publicPrefixes: PUBLIC_PREFIXES, publicBaseUrl: `${server.site(site).origin}/`,
})

async function run(site: string | null, storage: { config: StorageConfig; adapter: StorageAdapter | null } | undefined, check = storageCheck): Promise<{ result: CheckOutcome; harness: TechnicalContext }> {
  const harness = createTechnicalContext({ server: site ? server : null, site, controlId: 'C16', scratch, storage })
  try { return { result: await check.run(harness.context), harness } } finally { await harness.close() }
}

async function runSite(site: string): Promise<{ result: CheckOutcome; harness: TechnicalContext }> {
  const config = siteConfig(site)
  const probe = createTechnicalContext({ server, site, controlId: 'C16', scratch })
  const adapter = createStorageAdapter(config, { policy: probe.policy })
  await probe.close()
  return run(site, { config, adapter })
}

const evidenceJson = (harness: TechnicalContext, result: CheckOutcome): { objects: Array<{ key: string; public: boolean }>; probes: Array<{ key: string; purpose: string; status: number | null; listing: boolean }> } => {
  const ref = harness.evidence.list().find(item => item.id === result.evidence[0])!
  return JSON.parse(readFileSync(join(harness.evidence.dir, ref.path), 'utf8'))
}

describe('C16 grouping', () => {
  it('groups keys two segments below the public area parent, else by their first two segments', () => {
    const root = publicRoot(PUBLIC_PREFIXES)
    expect(root).toEqual(['wp-content', 'uploads'])
    expect(groupOf('wp-content/uploads/backups/db.sql', root)).toBe('wp-content/uploads/backups/')
    expect(groupOf('wp-content/uploads/woocommerce_uploads/2026/x/invoice.pdf', root)).toBe('wp-content/uploads/woocommerce_uploads/2026/')
    expect(groupOf('wp-content/uploads/db.sql', root)).toBe('wp-content/uploads/')
    expect(groupOf('site.json', root)).toBe('')
    expect(groupOf('exports/2026/09/orders.csv', [])).toBe('exports/2026/')
  })
})

describe('C16 storage check on fixture sites', () => {
  it('passes storage-public-ok: private paths refused, negative control readable, signed links unobservable (known-good)', async () => {
    const { result, harness } = await runSite('storage-public-ok')
    expect(result.status).toBe('PASS')
    expect(result.findings).toEqual([])
    expect(result.reason).toBeNull()
    expect(result.observations.join('\n')).toMatch(/negative control: public wp-content\/uploads\/2026\/09\/product-1\.jpg answered HTTP 200/)
    expect(result.coverage.unobservable).toEqual(expect.arrayContaining([
      expect.stringMatching(/^signed-link expiry not tested: the local-dir storage adapter has no signed links/),
      expect.stringMatching(/storage-probe-write/),
    ]))
    const evidence = evidenceJson(harness, result)
    expect(evidence.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'wp-content/uploads/woocommerce_uploads/', purpose: 'listing', status: 403, listing: false }),
      expect.objectContaining({ key: 'wp-content/uploads/2026/09/product-1.jpg', purpose: 'negative-control', status: 200 }),
    ]))
    expect(evidence.objects.find(object => object.key === 'wp-content/uploads/2026/09/product-2.jpg')).toMatchObject({ public: true })
    // Status only: nothing the store served is in the evidence.
    expect(JSON.stringify(evidence)).not.toMatch(/fixture product image/)
    for (const request of server.requests('storage-public-ok')) {
      expect(['GET', 'HEAD']).toContain(request.method)
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBeUndefined()
    }
    expect(server.mutations('storage-public-ok')).toEqual([])
  })

  it('fails storage-private-exposed with the private-exposed and listing findings (known-bad)', async () => {
    const { result, harness } = await runSite('storage-private-exposed')
    expect(result.status).toBe('FAIL')
    const byKey = Object.fromEntries(result.findings.map(finding => [finding.key, finding]))
    expect(Object.keys(byKey).sort()).toEqual([
      'listing:wp-content/uploads/backups',
      'private-exposed:wp-content/uploads/backups',
      'private-exposed:wp-content/uploads/woocommerce_uploads',
    ])
    expect(byKey['private-exposed:wp-content/uploads/backups']).toMatchObject({ severity: 'critical', confidence: 'confirmed', controlId: 'C16', checkId: 'storage', category: 'technical', owner: 'engineering' })
    expect(byKey['private-exposed:wp-content/uploads/backups']!.observed).toMatch(/wp-content\/uploads\/backups\/db\.sql \(HTTP 200\)/)
    expect(byKey['private-exposed:wp-content/uploads/woocommerce_uploads']).toMatchObject({ severity: 'critical' })
    expect(byKey['private-exposed:wp-content/uploads/woocommerce_uploads']!.observed).toMatch(/invoice-2026-0042\.pdf \(HTTP 200\)/)
    expect(byKey['listing:wp-content/uploads/backups']).toMatchObject({ severity: 'high', confidence: 'confirmed' })
    for (const finding of result.findings) expect(finding.evidence).toEqual(result.evidence)
    const evidence = JSON.stringify(evidenceJson(harness, result))
    expect(evidence).not.toMatch(/CREATE TABLE|fixture@example|Synthetic fixture/)
    expect(server.mutations('storage-private-exposed')).toEqual([])
  })
})

const stubConfig: StorageConfig = { kind: 's3', location: 's3://shop/uploads/', credentialRef: null, publicPrefixes: ['uploads/public/'] }
const stubAdapter = (patch: Partial<StorageAdapter> = {}): StorageAdapter => ({
  async inventory() {
    return [
      { key: 'uploads/public/logo.png', bytes: 1, public: true, lastModified: null },
      { key: 'uploads/private/orders.csv', bytes: 1, public: false, lastModified: null },
    ]
  },
  async probeAnonymous(key) { return { status: key.startsWith('uploads/public/') ? 200 : 403, listing: false } },
  ...patch,
})

describe('C16 without a store to probe', () => {
  it('is UNVERIFIED without a storage config, naming what to declare', async () => {
    const { result } = await run(null, undefined)
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/no storage is declared .* declare environment\.storage/)
  })

  it('is UNVERIFIED when the storage is declared but no adapter was built', async () => {
    const { result } = await run(null, { config: stubConfig, adapter: null })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/no storage adapter could be built/)
  })

  it('is UNVERIFIED when the adapter throws', async () => {
    const { result } = await run(null, { config: stubConfig, adapter: stubAdapter({ async inventory() { throw new Error('ListObjectsV2 answered HTTP 403 (AccessDenied)') } }) })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/storage inventory failed: ListObjectsV2 answered HTTP 403/)
    expect(result.findings).toEqual([])
  })

  it('is UNVERIFIED when probes fail, never PASS', async () => {
    const { result } = await run(null, { config: stubConfig, adapter: stubAdapter({ async probeAnonymous() { throw new Error('connect ECONNREFUSED') } }) })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/anonymous probe\(s\) failed.*ECONNREFUSED/)
  })

  it('is UNVERIFIED for an empty inventory', async () => {
    const { result } = await run(null, { config: stubConfig, adapter: stubAdapter({ async inventory() { return [] } }) })
    expect(result.status).toBe('UNVERIFIED')
    expect(result.reason).toMatch(/returned no objects/)
  })
})

describe('C16 signed links', () => {
  it('reports a signed link that still works after expiry', async () => {
    const calls: Array<[string, number]> = []
    const adapter = stubAdapter({ async signedLinkExpiry(key, ttl) { calls.push([key, ttl]); return { beforeStatus: 200, afterStatus: 200 } } })
    const { result } = await run(null, { config: stubConfig, adapter }, createStorageCheck({ signedLinkTtlSeconds: 3 }))
    expect(calls).toEqual([['uploads/private/orders.csv', 3]])
    expect(result.status).toBe('FAIL')
    expect(result.findings.map(finding => finding.key)).toEqual(['signed-link-no-expiry'])
    expect(result.findings[0]).toMatchObject({ severity: 'high', confidence: 'confirmed', component: 'uploads/private/orders.csv' })
  })

  it('passes an expiring link, records a refused fresh link as an observation, and a null answer as unobservable', async () => {
    const good = await run(null, { config: stubConfig, adapter: stubAdapter({ async signedLinkExpiry() { return { beforeStatus: 200, afterStatus: 403 } } }) })
    expect(good.result.status).toBe('PASS')
    expect(good.result.observations.join('\n')).toMatch(/HTTP 200 before expiry, HTTP 403/)

    const refused = await run(null, { config: stubConfig, adapter: stubAdapter({ async signedLinkExpiry() { return { beforeStatus: 403, afterStatus: 403 } } }) })
    expect(refused.result.findings).toEqual([])
    expect(refused.result.observations.join('\n')).toMatch(/answered HTTP 403 before expiry/)
    expect(refused.result.coverage.unobservable.join('\n')).toMatch(/signed-link expiry not shown/)

    const none = await run(null, { config: stubConfig, adapter: stubAdapter({ async signedLinkExpiry() { return null } }) })
    expect(none.result.coverage.unobservable.join('\n')).toMatch(/signed-link expiry not tested: the store minted no signed link/)

    const broken = await run(null, { config: stubConfig, adapter: stubAdapter({ async signedLinkExpiry() { throw new Error('credential did not resolve') } }) })
    expect(broken.result.status).toBe('UNVERIFIED')
    expect(broken.result.reason).toMatch(/signed-link expiry test failed: credential did not resolve/)
  })

  it('an unreadable negative control is an observation, never a finding', async () => {
    const { result } = await run(null, { config: stubConfig, adapter: stubAdapter({ async probeAnonymous() { return { status: 404, listing: false } } }) })
    expect(result.findings).toEqual([])
    expect(result.status).toBe('PASS')
    expect(result.observations.join('\n')).toMatch(/negative control: public uploads\/public\/logo\.png was not readable \(HTTP 404\)/)
  })
})
