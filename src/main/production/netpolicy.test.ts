import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIT_BUDGET, type NetworkPolicy, type ProductionEnvironment, type SandboxWriteAuthorization } from '../../shared/production'
import { MutationRefused, NetworkGate, assertMutationAllowed, isPrivateHost, isStateChangingUrl, liveAuthorization, originOf, policyForEnvironment, redirectMethod, walkRedirects } from './netpolicy'

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

  it('spaces navigations and the audit\'s own requests per origin to the configured rate', () => {
    let clock = 1000
    const gate = new NetworkGate(policy({ requestsPerSecondPerOrigin: 4 }), { clock: () => clock })
    const delays = Array.from({ length: 5 }, (_, index) => (gate.decide(nav(`https://shop.example/${index}`)) as { delayMs: number }).delayMs)
    expect(delays).toEqual([0, 250, 500, 750, 1000])
    // An agent fetch shares the origin's schedule; another origin has its own.
    expect((gate.decide({ ...sub('https://shop.example/robots.txt'), initiator: 'agent' }) as { delayMs: number }).delayMs).toBe(1250)
    expect((gate.decide({ ...sub('https://cdn.example/a.js'), initiator: 'agent' }) as { delayMs: number }).delayMs).toBe(0)
    clock += 5000
    expect((gate.decide(nav('https://shop.example/b')) as { delayMs: number }).delayMs).toBe(0)
  })

  it('counts a page\'s own subresources against the budget without spacing them', () => {
    const gate = new NetworkGate(policy({ requestsPerSecondPerOrigin: 1 }), { clock: () => 1000 })
    gate.decide(nav('https://shop.example/'))
    const delays = Array.from({ length: 20 }, (_, index) => (gate.decide(sub(`https://shop.example/${index}.js`)) as { delayMs: number }).delayMs)
    expect(delays.every(delay => delay === 0)).toBe(true)
    expect(gate.requestCount).toBe(21)
    // The next navigation still waits for its slot.
    expect((gate.decide(nav('https://shop.example/next')) as { delayMs: number }).delayMs).toBe(1000)
  })
})

describe('walkRedirects', () => {
  const response = (status: number, location?: string) => ({ status: () => status, headers: () => (location ? { location } : {}) as Record<string, string> })
  /** A fake server: a map from URL to the response it gives, recording what was fetched. */
  const serve = (routes: Record<string, ReturnType<typeof response>>) => {
    const fetched: string[] = []
    return { fetched, fetchHop: async (hop: { url: string; method: string }) => { fetched.push(`${hop.method} ${hop.url}`); return routes[hop.url] ?? response(200) } }
  }
  const gateFor = (patch: Partial<NetworkPolicy> = {}) => {
    const gate = new NetworkGate(policy({ requestsPerSecondPerOrigin: 0, ...patch }), { resolve: async host => host === 'intranet.example' ? ['10.0.0.9'] : ['93.184.216.34'] })
    return async (url: string, method: string) => {
      const decision = gate.decide({ url, method, resourceType: 'image', mainFrameNavigation: false, initiator: 'page' })
      if (decision.action === 'allow' && await gate.refusesHost(new URL(url).hostname)) return { action: 'block' as const, party: decision.party, outcome: 'blocked-by-policy' as const, reason: 'private address' }
      return decision
    }
  }

  it('follows allowed hops and returns the final response', async () => {
    const server = serve({ 'https://cdn.example/a': response(302, '/b'), 'https://cdn.example/b': response(301, 'https://img.example/c') })
    const walk = await walkRedirects({ url: 'https://cdn.example/a', method: 'GET' }, server.fetchHop, gateFor())
    expect(walk.blocked).toBeNull()
    expect(walk.response?.status()).toBe(200)
    expect(server.fetched).toEqual(['GET https://cdn.example/a', 'GET https://cdn.example/b', 'GET https://img.example/c'])
    expect(walk.hops.map(hop => [hop.url, hop.status])).toEqual([['https://cdn.example/b', 301], ['https://img.example/c', 200]])
  })

  it('refuses a hop to a private address, literal or resolved, before fetching it', async () => {
    for (const target of ['http://127.0.0.1:8080/admin', 'http://192.168.1.1/', 'https://intranet.example/']) {
      const server = serve({ 'https://cdn.example/a': response(302, target) })
      const walk = await walkRedirects({ url: 'https://cdn.example/a', method: 'GET' }, server.fetchHop, gateFor())
      expect(walk.response, target).toBeNull()
      expect(walk.blocked?.reason, target).toMatch(/private address/)
      expect(server.fetched, target).toEqual(['GET https://cdn.example/a'])
    }
  })

  it('treats a 307 that carries a third-party POST to the first party as a first-party POST under read-only', async () => {
    const server = serve({ 'https://tracker.example/r': response(307, 'https://shop.example/api/orders') })
    const walk = await walkRedirects({ url: 'https://tracker.example/r', method: 'POST' }, server.fetchHop, gateFor())
    expect(walk.blocked).toMatchObject({ url: 'https://shop.example/api/orders', outcome: 'blocked-by-policy', reason: expect.stringMatching(/read-only: POST/) })
    expect(walk.hops).toEqual([{ url: 'https://shop.example/api/orders', method: 'POST', blocked: expect.any(String), status: null }])
    expect(server.fetched).toEqual(['POST https://tracker.example/r'])
  })

  it('turns POST into GET on 301/302/303, refuses a state-changing GET hop, and caps the chain', async () => {
    expect(redirectMethod(303, 'PUT')).toBe('GET')
    expect(redirectMethod(303, 'HEAD')).toBe('HEAD')
    expect(redirectMethod(302, 'POST')).toBe('GET')
    expect(redirectMethod(308, 'POST')).toBe('POST')
    const converted = serve({ 'https://tracker.example/r': response(303, 'https://shop.example/thanks') })
    expect((await walkRedirects({ url: 'https://tracker.example/r', method: 'POST' }, converted.fetchHop, gateFor())).blocked).toBeNull()
    expect(converted.fetched).toEqual(['POST https://tracker.example/r', 'GET https://shop.example/thanks'])

    const trap = serve({ 'https://img.example/pixel': response(302, 'https://shop.example/delete?confirm=1') })
    expect((await walkRedirects({ url: 'https://img.example/pixel', method: 'GET' }, trap.fetchHop, gateFor())).blocked?.reason).toMatch(/state-changing/)

    const loop = serve({ 'https://cdn.example/x': response(302, 'https://cdn.example/x') })
    const walk = await walkRedirects({ url: 'https://cdn.example/x', method: 'GET' }, loop.fetchHop, gateFor(), { maxHops: 3 })
    expect(walk.blocked?.reason).toMatch(/more than 3 redirects/)
    expect(loop.fetched).toHaveLength(4)
  })

  it('spaces hops by the gate rate and counts them against the budget', async () => {
    const waits: number[] = []
    let clock = 0
    const gate = new NetworkGate(policy({ requestsPerSecondPerOrigin: 2, maxRequests: 3 }), { clock: () => clock })
    const decide = async (url: string, method: string) => gate.decide({ url, method, resourceType: 'image', mainFrameNavigation: false, initiator: 'agent' })
    gate.decide({ ...sub('https://cdn.example/a'), initiator: 'agent' })
    const server = serve({ 'https://cdn.example/a': response(302, '/b'), 'https://cdn.example/b': response(302, '/c'), 'https://cdn.example/c': response(302, '/d') })
    const walk = await walkRedirects({ url: 'https://cdn.example/a', method: 'GET' }, server.fetchHop, decide, { sleep: async ms => { waits.push(ms) } })
    expect(waits).toEqual([500, 1000])
    expect(walk.blocked?.reason).toMatch(/budget of 3/)
  })
})
