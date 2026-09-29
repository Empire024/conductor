import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_AUDIT_BUDGET, navigationOutcomeText, type NetworkPolicy, type OpenPageOptions, type ProductionEnvironment } from '../../shared/production'
import { createCertificateAuthority, issueServerCertificate } from '../remote-tls'
import { createAuditBrowser, failureDetail, resolveEngine, type ProductionAuditBrowser } from './browser'
import { discoverStack } from './discovery'
import { policyForEnvironment, tlsPolicyOf } from './netpolicy'
import { applyProfileUpdate, defaultProfile } from './profile'
import { createTlsTrust } from './tls-trust'

const engine = await resolveEngine()
const desktop: OpenPageOptions = { device: 'desktop', locale: 'en-US', auth: null, consent: 'clean', regionSelection: 'none' }

let scratch: string
let server: Server
let origin: string
let caPath: string
let otherCaPath: string
const browsers: ProductionAuditBrowser[] = []

const environment = (patch: Partial<ProductionEnvironment> = {}): ProductionEnvironment => ({
  id: 'staging', kind: 'local', label: 'Private-CA staging', baseUrl: `${origin}/`, allowedOrigins: [origin], accounts: [], capturedMail: null, commerce: null,
  storage: null, buildInfoCommand: null, smokeCommand: null, ...patch,
})
const policyOf = (patch: Partial<ProductionEnvironment> = {}): NetworkPolicy => ({ ...policyForEnvironment(environment(patch), { budget: DEFAULT_AUDIT_BUDGET }), requestsPerSecondPerOrigin: 0 })

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-tls-'))
  const authority = createCertificateAuthority('Test Staging Local CA')
  const other = createCertificateAuthority('Some Other CA')
  caPath = join(scratch, 'staging-ca.pem')
  otherCaPath = join(scratch, 'other-ca.pem')
  writeFileSync(caPath, authority.certificatePem)
  writeFileSync(otherCaPath, other.certificatePem)
  const leaf = issueServerCertificate(authority, 'staging.test', ['127.0.0.1'])
  server = createServer({ key: leaf.privateKeyPem, cert: leaf.certificatePem }, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Shop - Private CA</title><a href="/about">About</a>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await Promise.all(browsers.map(browser => browser.close()))
  await new Promise(done => server?.close(done))
  rmSync(scratch, { recursive: true, force: true })
})

describe('createTlsTrust', () => {
  it('has nothing to add without tls, and never on production', () => {
    expect(createTlsTrust(policyOf())).toBeNull()
    expect(createTlsTrust({ environmentId: 'prod', environmentKind: 'production', tls: { allowSystemTrust: true, trustedCaPaths: [caPath] } })).toBeNull()
    expect(tlsPolicyOf({ kind: 'production', tls: { allowSystemTrust: true } })).toBeNull()
    expect(tlsPolicyOf({ kind: 'staging', tls: { allowSystemTrust: true } })).toEqual({ allowSystemTrust: true, trustedCaPaths: [] })
  })

  it('verifies a private-CA origin against the listed CA and refuses one it does not chain to', async () => {
    const trusted = createTlsTrust(policyOf({ tls: { trustedCaPaths: [caPath] } }))!
    expect(await trusted.verify(`${origin}/`)).toBeNull()
    expect(await trusted.verify('http://127.0.0.1:1/')).toBeNull()
    const wrong = createTlsTrust(policyOf({ tls: { trustedCaPaths: [otherCaPath] } }))!
    expect(await wrong.verify(`${origin}/`)).toMatch(/certificate of 127\.0\.0\.1 did not verify against .*other-ca\.pem and the public roots \(.*(self-signed|unable to verify|issuer)/i)
    const unreadable = createTlsTrust(policyOf({ tls: { trustedCaPaths: [join(scratch, 'missing.pem')] } }))!
    expect(await unreadable.verify(`${origin}/`)).toMatch(/TLS trust of staging is unusable: the trusted CA file .*missing\.pem could not be read/)
  })

  it('adds the system store when allowSystemTrust is set', async () => {
    const trust = createTlsTrust(policyOf({ tls: { allowSystemTrust: true } }), { systemCertificates: () => [createCertificateAuthority('Unrelated').certificatePem] })!
    expect(trust.description).toMatch(/public roots plus the system certificate store/)
    expect(await trust.verify(`${origin}/`)).toMatch(/did not verify against the system certificate store/)
  })
})

describe('failureDetail', () => {
  it('keeps the first line only, drops the API prefix and masks login-state values', () => {
    const error = new Error('route.fetch: self-signed certificate in certificate chain\nCall log:\n  - cookie: gate=secret-cookie-value-123')
    expect(failureDetail(error, ['secret-cookie-value-123'])).toBe('self-signed certificate in certificate chain')
    expect(failureDetail('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/ gate=secret-cookie-value-123', ['secret-cookie-value-123'])).toBe('net::ERR_NAME_NOT_RESOLVED at https://x.test/ gate=[REDACTED]')
    expect(failureDetail(null)).toBeNull()
    expect(navigationOutcomeText({ outcome: 'error', detail: 'self-signed certificate in certificate chain' })).toBe('error: self-signed certificate in certificate chain')
    expect(navigationOutcomeText({ outcome: 'ok' })).toBe('ok')
  })
})

describe('environment tls in the profile', () => {
  const update = (patch: Partial<ProductionEnvironment>, source: 'owner' | 'wizard' | 'assumption' = 'wizard', profile = defaultProfile('p')) =>
    applyProfileUpdate(profile, { environments: [environment({ kind: 'staging', ...patch })] }, { by: 'wizard:agent_x (Haftheme)', source })

  it('is refused on production and must name what it trusts', () => {
    expect(() => update({ kind: 'production', tls: { allowSystemTrust: true } })).toThrow(/production: its certificates are always checked against the public roots/)
    expect(() => update({ tls: {} })).toThrow(/tls needs allowSystemTrust: true or at least one trustedCaPaths entry/)
    expect(() => update({ tls: { trustedCaPaths: ['relative/ca.pem'] } })).toThrow(/absolute paths to PEM files/)
  })

  it('is stamped with who set it, kept when unchanged, and refused from an ordinary agent', () => {
    const set = update({ tls: { allowSystemTrust: true } })
    const tls = set.environments[0]!.tls!
    expect(tls).toMatchObject({ allowSystemTrust: true, trustedCaPaths: [], setBy: { source: 'wizard', by: 'wizard:agent_x (Haftheme)' } })
    const again = applyProfileUpdate(set, { environments: [environment({ kind: 'staging', tls: { allowSystemTrust: true } })] }, { by: 'agent', source: 'assumption' })
    expect(again.environments[0]!.tls!.setBy).toEqual(tls.setBy)
    expect(() => update({ tls: { allowSystemTrust: true } }, 'assumption')).toThrow(/only the owner or a wizard tab may set or change it/)
    expect(policyForEnvironment(set.environments[0]!, { budget: DEFAULT_AUDIT_BUDGET }).tls).toEqual({ allowSystemTrust: true, trustedCaPaths: [] })
  })
})

describe.skipIf(!engine.available)('audit browser on a private-CA site', { timeout: 60_000 }, () => {
  const open = async (policy: NetworkPolicy, name: string) => {
    const browser = createAuditBrowser(policy, { userDataDir: join(scratch, name), navigationTimeoutMs: 10_000 })
    browsers.push(browser)
    return browser.open(desktop)
  }

  it('fails with the TLS error as detail when the CA is not trusted (the staging symptom), never a bare error', async () => {
    const page = await open(policyOf(), 'untrusted')
    const navigation = await page.goto(`${origin}/`)
    expect(navigation.outcome).toBe('error')
    expect(navigation.detail).toMatch(/self-signed|unable to verify|certificate/i)
    const found = await discoverStack(null, environment(), await open(policyOf(), 'untrusted-discovery'))
    expect(found.visited[0]).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/certificate/i) })
    expect(found.stack.unread[0]).toMatch(new RegExp(`^${origin.replace(/[.]/g, '\\.')}/: error: .*certificate`, 'i'))
  })

  it('reads the page when the environment trusts its CA, and blocks with the reason when it trusts another', async () => {
    const page = await open(policyOf({ tls: { trustedCaPaths: [caPath] } }), 'trusted')
    const navigation = await page.goto(`${origin}/`)
    expect(navigation).toMatchObject({ outcome: 'ok', status: 200 })
    expect(navigation.detail).toBeUndefined()
    expect(await page.evaluate<string>('document.title')).toBe('Shop - Private CA')

    const wrong = await open(policyOf({ tls: { trustedCaPaths: [otherCaPath] } }), 'wrong-ca')
    const refused = await wrong.goto(`${origin}/`)
    expect(refused.outcome).toBe('blocked-by-policy')
    expect(navigationOutcomeText(refused)).toMatch(/^blocked-by-policy: TLS: the certificate of 127\.0\.0\.1 did not verify/)
  })

  it('keeps strict checking on production even if a tls setting reached the policy', async () => {
    const production: NetworkPolicy = { ...policyOf({ kind: 'production' }), allowPrivateAddresses: true, tls: { allowSystemTrust: true, trustedCaPaths: [caPath] } }
    const navigation = await (await open(production, 'production')).goto(`${origin}/`)
    expect(navigation.outcome).toBe('error')
    expect(navigation.detail).toMatch(/certificate/i)
  })
})
