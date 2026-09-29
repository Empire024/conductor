import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FindingDraft, ObservedRequest } from '../../../shared/production'
import { createFixtureServer } from '../fixtures/server'
import { createDocumentContext } from './document-testkit'
import {
  companyNames, documentDate, entityName, fold, namesEntity, placeholdersIn, planRoutes, registrationNumbers, statusOf, trackerRequests,
} from './document-support'

const finding = (severity: FindingDraft['severity']): FindingDraft => ({ severity } as FindingDraft)

describe('document text rules', () => {
  it('finds a version or date statement in English, Slovak and Czech', () => {
    expect(documentDate('Privacy policy. Last updated: 1 March 2026. We process')).toBe('Last updated: 1 March 2026')
    expect(documentDate('Obchodné podmienky platné od 1. 3. 2026')).toBe('platné od 1. 3. 2026')
    expect(documentDate('Tyto podmínky jsou účinné od 15. března 2026.')).toBe('účinné od 15. března 2026')
    expect(documentDate('Effective from 2026-03-01.')).toBe('Effective from 2026-03-01')
    expect(documentDate('Terms, version 3.1')).toBe('version 3.1')
    expect(documentDate('We opened in 2019 and love flowers.')).toBeNull()
  })

  it('finds template placeholders and leaves ordinary text alone', () => {
    expect(placeholdersIn('[Company Name] respects your privacy. Lorem ipsum dolor. TODO: retention. Contact [email].').map(item => item.id))
      .toEqual(['lorem-ipsum', 'bracket-field', 'todo'])
    expect(placeholdersIn('Dopľňte názov spoločnosti').map(item => item.id)).toEqual(['sk-cz-placeholder'])
    expect(placeholdersIn('We deliver flowers to the company address you give us, today.')).toEqual([])
  })

  it('compares entity names with legal forms folded and accents removed', () => {
    expect(entityName('Hash and Flowers s.r.o., Hlavná 12, Bratislava')).toBe('Hash and Flowers s.r.o.')
    expect(namesEntity('Prevádzkovateľ: HASH AND FLOWERS, s. r. o., IČO 12345678', 'Hash and Flowers s.r.o.')).toBe(true)
    expect(namesEntity('Seller: Example Trading Ltd.', 'Hash and Flowers s.r.o.')).toBe(false)
    expect(fold('Květiny Praha, a.s.')).toBe('kvetiny praha a s')
    expect(companyNames('These terms govern purchases from Example Trading Ltd., 1 Market Street.')).toEqual(['Example Trading Ltd.'])
    expect(companyNames('Prevádzkovateľ: Flower Trading s.r.o., IČO: 87654321')).toEqual(['Flower Trading s.r.o.'])
    expect(registrationNumbers('IČO: 12 345 678, DIČ 2023456789, Company No. 09876543')).toEqual(['12345678', '09876543'])
  })

  it('rolls findings and unconcluded parts into a status: FAIL over UNVERIFIED over WARN, PASS only when clean', () => {
    expect(statusOf([], [])).toBe('PASS')
    expect(statusOf([finding('medium')], [])).toBe('WARN')
    expect(statusOf([finding('medium')], ['entity unknown'])).toBe('UNVERIFIED')
    expect(statusOf([finding('high')], ['entity unknown'])).toBe('FAIL')
    expect(statusOf([finding('critical')], [])).toBe('FAIL')
  })
})

describe('routes and observed requests', () => {
  it('plans full routes, one per sampled group and lists exclusions, bounded', async () => {
    const server = await createFixtureServer({ sites: ['policies-good'] })
    const scratch = mkdtempSync(join(tmpdir(), 'prod-routes-'))
    try {
      const harness = createDocumentContext({
        server, scratch, controlId: 'C01', site: 'policies-good',
        routes: [
          '/', { path: '/p/a/', source: 'sitemap', tags: ['product'], coverage: 'sampled' }, { path: '/p/b/', source: 'sitemap', tags: ['product'], coverage: 'sampled' },
          { path: '/admin/', source: 'owner', tags: [], coverage: 'excluded', excludedReason: 'owner only' }, ...Array.from({ length: 14 }, (_, index) => `/r${index}/`),
        ],
      })
      const plan = planRoutes(harness.context)
      expect(plan.routes).toHaveLength(12)
      expect(plan.routes[0]!.path).toBe('/')
      expect(plan.coverage.excluded[0]).toEqual({ path: '/admin/', reason: 'owner only' })
      expect(plan.coverage.excluded.filter(entry => /12-route bound/.test(entry.reason)).map(entry => entry.path)).toEqual(['/r11/', '/r12/', '/r13/', '/p/a/'])
      const empty = createDocumentContext({ server, scratch, controlId: 'C01', site: 'policies-good' })
      expect(planRoutes(empty.context)).toMatchObject({ routes: [{ path: '/' }], coverage: { unobservable: [expect.stringMatching(/only the home page/)] } })

      const request = (url: string): ObservedRequest => ({ url, method: 'GET', resourceType: 'image', party: 'third-party', initiator: 'page', blocked: null, status: 200, excerpt: '', at: '' })
      const own = server.site('policies-good').url('/collect')
      const seen = trackerRequests(harness.context, [
        request('https://www.google-analytics.com/g/collect?v=2'), request('https://cdn.example.net/fonts/a.woff2'), request('https://stats.example.org/__collect?e=1'),
        request(own), request('https://connect.facebook.net/en_US/fbevents.js'),
      ]).map(item => item.url)
      expect(seen).toEqual(['https://www.google-analytics.com/g/collect?v=2', 'https://stats.example.org/__collect?e=1', 'https://connect.facebook.net/en_US/fbevents.js'])
      await Promise.all([harness.close(), empty.close()])
    } finally { await server.close(); rmSync(scratch, { recursive: true, force: true }) }
  })
})
