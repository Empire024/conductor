import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIT_BUDGET, type NetworkPolicy, type ProductionEnvironment, type SandboxWriteAuthorization } from '../../shared/production'
import { MutationRefused, NetworkGate, assertMutationAllowed, isPrivateHost, isStateChangingUrl, liveAuthorization, originOf, policyForEnvironment } from './netpolicy'

const environment = (patch: Partial<ProductionEnvironment> = {}): ProductionEnvironment => ({
  id: 'prod', kind: 'production', label: 'Production', baseUrl: 'https://shop.example/', allowedOrigins: ['https://shop.example', 'https://www.shop.example'],
  accounts: [], capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null, ...patch,
})
const authorization = (patch: Partial<SandboxWriteAuthorization> = {}): SandboxWriteAuthorization => ({
  id: 'auth-1', environmentId: 'staging', mutations: ['form-submit'], grantedBy: { kind: 'owner', agentSessionId: null },
  grantedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', note: '', ...patch,
})
const now = new Date('2026-09-29T12:00:00.000Z')

const policy = (patch: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  environmentId: 'prod', environmentKind: 'production', allowedOrigins: ['https://shop.example'], readOnly: true, writeAuthorization: null,
  maxRequests: 100, requestsPerSecondPerOrigin: 4, allowPrivateAddresses: false, ...patch,
})
const nav = (url: string, method = 'GET') => ({ url, method, resourceType: 'document', mainFrameNavigation: true, initiator: 'agent' as const })
const sub = (url: string, method = 'GET', resourceType = 'script') => ({ url, method, resourceType, mainFrameNavigation: false, initiator: 'page' as const })

describe('policyForEnvironment', () => {
  it('makes production read-only, refuses private addresses there and never attaches a write authorization', () => {
    const result = policyForEnvironment(environment(), { authorizations: [authorization({ environmentId: 'prod' })], budget: DEFAULT_AUDIT_BUDGET, now })
    expect(result).toMatchObject({ readOnly: true, writeAuthorization: null, allowPrivateAddresses: false, maxRequests: 2000, requestsPerSecondPerOrigin: 4 })
    expect(result.allowedOrigins).toEqual(['https://shop.example', 'https://www.shop.example'])
  })

  it('opens writes on a sandbox only with a live authorization for that environment', () => {
    const staging = environment({ id: 'staging', kind: 'staging' })
    expect(policyForEnvironment(staging, { authorizations: [], budget: DEFAULT_AUDIT_BUDGET, now }).readOnly).toBe(true)
    expect(policyForEnvironment(staging, { authorizations: [authorization({ expiresAt: '2026-09-01T00:00:00.000Z' })], budget: DEFAULT_AUDIT_BUDGET, now }).readOnly).toBe(true)
    expect(policyForEnvironment(staging, { authorizations: [authorization({ environmentId: 'other' })], budget: DEFAULT_AUDIT_BUDGET, now }).readOnly).toBe(true)
    const open = policyForEnvironment(staging, { authorizations: [authorization()], budget: DEFAULT_AUDIT_BUDGET, now })
    expect(open.readOnly).toBe(false)
    expect(open.writeAuthorization?.id).toBe('auth-1')
    expect(liveAuthorization([authorization({ environmentId: 'prod' })], environment(), now)).toBeNull()
  })

  it('allows private addresses only for local environments', () => {
    expect(policyForEnvironment(environment({ kind: 'local', baseUrl: 'http://127.0.0.1:8080/' }), { budget: DEFAULT_AUDIT_BUDGET }).allowPrivateAddresses).toBe(true)
    for (const kind of ['production', 'staging', 'sandbox'] as const) expect(policyForEnvironment(environment({ kind }), { budget: DEFAULT_AUDIT_BUDGET }).allowPrivateAddresses).toBe(false)
  })
})

describe('address and URL rules', () => {
  it('recognises private, loopback and link-local hosts', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', '[::1]', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isPrivateHost(host), host).toBe(true)
    }
    for (const host of ['shop.example', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:4860:4860::8888']) expect(isPrivateHost(host), host).toBe(false)
    // The URL parser normalises numeric forms before the rule sees them.
    expect(isPrivateHost(new URL('http://2130706433/').hostname)).toBe(true)
  })

  it('flags GETs that are mutations in disguise, not pages that merely talk about deletion', () => {
    for (const url of ['https://s.example/delete', 'https://s.example/delete?confirm=1', 'https://s.example/?add-to-cart=12', 'https://s.example/cart/?remove_item=ab',
      'https://s.example/my-account/customer-logout/?_wpnonce=1', 'https://s.example/wp-admin/post.php?action=delete&post=1', 'https://s.example/logout', 'https://s.example/newsletter/unsubscribe']) {
      expect(isStateChangingUrl(url), url).toBe(true)
    }
    for (const url of ['https://s.example/', 'https://s.example/my-account/delete-account/', 'https://s.example/privacy-policy/', 'https://s.example/blog/how-to-remove-stains/', 'https://s.example/?s=delete']) {
      expect(isStateChangingUrl(url), url).toBe(false)
    }
    expect(originOf('javascript:alert(1)')).toBeNull()
    expect(originOf('https://Shop.Example:443/a')).toBe('https://shop.example')
  })
})

describe('assertMutationAllowed', () => {
  it('refuses every mutation on production whatever the authorization says', () => {
    expect(() => assertMutationAllowed(policy({ readOnly: false, writeAuthorization: authorization({ environmentId: 'prod', mutations: ['form-submit'] }) }), 'form-submit', now)).toThrow(MutationRefused)
  })

  it('needs a live authorization naming the kind', () => {
    const staging = policy({ environmentId: 'staging', environmentKind: 'staging', readOnly: false, writeAuthorization: authorization() })
    expect(() => assertMutationAllowed(staging, 'form-submit', now)).not.toThrow()
    expect(() => assertMutationAllowed(staging, 'checkout', now)).toThrow(/sandbox write authorization required for checkout/)
    expect(() => assertMutationAllowed({ ...staging, writeAuthorization: authorization({ expiresAt: '2026-01-01T00:00:00.000Z' }) }, 'form-submit', now)).toThrow(/expired/)
    expect(() => assertMutationAllowed({ ...staging, readOnly: true, writeAuthorization: null }, 'form-submit', now)).toThrow(/sandbox write authorization required/)
  })
})

describe('NetworkGate', () => {
  it('stops top-level navigation off the allowlist but lets third-party subresources through', () => {
    const gate = new NetworkGate(policy())
    expect(gate.decide(nav('https://evil.example/'))).toMatchObject({ action: 'block', outcome: 'off-allowlist' })
    expect(gate.decide(sub('https://fonts.googleapis.com/css'))).toMatchObject({ action: 'allow', party: 'third-party' })
    expect(gate.decide(sub('https://tracker.example/collect', 'POST', 'ping'))).toMatchObject({ action: 'allow', party: 'third-party' })
    expect(gate.decide(nav('https://shop.example/about'))).toMatchObject({ action: 'allow', party: 'first-party' })
  })

  it('refuses non-http navigations', () => {
    const gate = new NetworkGate(policy())
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank']) {
      expect(gate.decide(nav(url)), url).toMatchObject({ action: 'block', outcome: 'blocked-by-policy' })
    }
  })

  it('blocks first-party mutations under read-only and state-changing GETs', () => {
    const gate = new NetworkGate(policy())
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(gate.decide(sub('https://shop.example/api', method, 'fetch'))).toMatchObject({ action: 'block', outcome: 'blocked-by-policy' })
    expect(gate.decide(nav('https://shop.example/delete?confirm=1'))).toMatchObject({ action: 'block', reason: expect.stringMatching(/state-changing/) })
    expect(gate.decide(sub('https://shop.example/', 'HEAD'))).toMatchObject({ action: 'allow' })
    expect(() => gate.arm('form-submit')).toThrow(MutationRefused)
  })

  it('lets a first-party mutation through on a sandbox only while an authorized kind is armed', () => {
    const gate = new NetworkGate(policy({ environmentId: 'staging', environmentKind: 'staging', readOnly: false, writeAuthorization: authorization() }))
    expect(gate.decide(sub('https://shop.example/form', 'POST', 'document'))).toMatchObject({ action: 'block', reason: expect.stringMatching(/no authorized mutation/) })
    expect(() => gate.arm('checkout')).toThrow(MutationRefused)
    const disarm = gate.arm('form-submit')
    expect(gate.decide(sub('https://shop.example/form', 'POST', 'document'))).toMatchObject({ action: 'allow' })
    disarm()
    expect(gate.decide(sub('https://shop.example/form', 'POST', 'document'))).toMatchObject({ action: 'block' })
  })

  it('refuses private addresses unless the policy allows them, including names that resolve privately', async () => {
    const strict = new NetworkGate(policy({ allowedOrigins: ['http://127.0.0.1:8080'] }), { resolve: async host => host === 'intranet.example' ? ['10.0.0.5'] : ['93.184.216.34'] })
    expect(strict.decide(nav('http://127.0.0.1:8080/'))).toMatchObject({ action: 'block', reason: expect.stringMatching(/private address/) })
    expect(await strict.refusesHost('intranet.example')).toBe(true)
    expect(await strict.refusesHost('shop.example')).toBe(false)
    const local = new NetworkGate(policy({ environmentKind: 'local', allowedOrigins: ['http://127.0.0.1:8080'], allowPrivateAddresses: true }))
    expect(local.decide(nav('http://127.0.0.1:8080/'))).toMatchObject({ action: 'allow' })
    expect(await local.refusesHost('intranet.example')).toBe(false)
  })

  it('enforces maxRequests and marks the budget exhausted', () => {
    const gate = new NetworkGate(policy({ maxRequests: 3, requestsPerSecondPerOrigin: 0 }))
    for (let index = 0; index < 3; index++) expect(gate.decide(sub(`https://shop.example/${index}.js`)).action).toBe('allow')
    expect(gate.decide(sub('https://shop.example/4.js'))).toMatchObject({ action: 'block', reason: expect.stringMatching(/budget of 3/) })
    expect(gate.exhausted).toBe(true)
    expect(gate.requestCount).toBe(3)
    // A pre-check does not spend budget.
    expect(new NetworkGate(policy({ maxRequests: 1 })).decide(nav('https://shop.example/'), false)).toMatchObject({ action: 'allow' })
  })

  it('spaces requests per origin to the configured rate', () => {
    let clock = 1000
    const gate = new NetworkGate(policy({ requestsPerSecondPerOrigin: 4 }), { clock: () => clock })
    const delays = Array.from({ length: 5 }, () => (gate.decide(sub('https://shop.example/a.js')) as { delayMs: number }).delayMs)
    expect(delays).toEqual([0, 250, 500, 750, 1000])
    // Another origin has its own schedule.
    expect((gate.decide(sub('https://cdn.example/a.js')) as { delayMs: number }).delayMs).toBe(0)
    clock += 5000
    expect((gate.decide(sub('https://shop.example/b.js')) as { delayMs: number }).delayMs).toBe(0)
  })
})
