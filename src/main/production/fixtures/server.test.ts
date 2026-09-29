import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixtureServer, type FixtureServer } from './server'

let server: FixtureServer
beforeAll(async () => { server = await createFixtureServer({ sites: ['baseline', 'injection'], record: true }) })
afterAll(async () => { await server.close() })

describe('fixture server', () => {
  it('serves each site on its own loopback origin with placeholders filled', async () => {
    const baseline = server.site('baseline')
    const injection = server.site('injection')
    expect(baseline.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(baseline.origin).not.toBe(injection.origin)
    const sitemap = await (await fetch(baseline.url('/sitemap.xml'))).text()
    expect(sitemap).toContain(`<loc>${baseline.origin}/product/alpha/</loc>`)
    const consent = await (await fetch(baseline.url('/js/consent.js'))).text()
    expect(consent).toContain(`${baseline.aliasOrigin}/__collect`)
    const page = await fetch(baseline.url('/shop/'))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect((await fetch(baseline.url('/missing'))).status).toBe(404)
    expect((await fetch(baseline.url('/../../server.ts'))).status).toBe(404)
    expect((await fetch(baseline.url('/site.json'))).status).toBe(404)
  })

  it('applies Set-Cookie, header and delay directives from site.json', async () => {
    const baseline = server.site('baseline')
    const home = await fetch(baseline.url('/'))
    expect(home.headers.get('set-cookie')).toContain('baseline_session=abc123')
    expect((await fetch(baseline.url('/csp.html'))).headers.get('content-security-policy')).toContain("script-src 'self'")
    const started = Date.now()
    await (await fetch(baseline.url('/js/late.js'))).text()
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
  })

  it('records mutations, redirects and collects', async () => {
    server.reset()
    const injection = server.site('injection')
    const posted = await fetch(injection.url('/contact/send'), { method: 'POST', body: 'name=x' })
    expect(await posted.json()).toMatchObject({ recorded: true, method: 'POST' })
    await fetch(injection.url('/delete?confirm=1'))
    await fetch(injection.url('/__collect'), { method: 'POST', body: 'event=pageview' })
    const redirect = await fetch(injection.url(`/__redirect?to=${encodeURIComponent('{{alias:injection}}/stolen')}&status=307`), { redirect: 'manual' })
    expect(redirect.status).toBe(307)
    expect(redirect.headers.get('location')).toBe(`${injection.aliasOrigin}/stolen`)
    expect(server.mutations('injection').map(item => `${item.method} ${item.path}`)).toEqual(['POST /contact/send', 'GET /delete?confirm=1'])
    expect(server.collected('injection')).toHaveLength(1)
    const readBack = await (await fetch(injection.url('/__mutations'))).json() as Array<{ path: string }>
    expect(readBack.map(item => item.path)).toEqual(['/contact/send', '/delete?confirm=1'])
    expect(server.mutations('baseline')).toEqual([])
  })
})
