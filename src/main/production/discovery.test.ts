import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_AUDIT_BUDGET, type ProductionEnvironment, type SourceTree } from '../../shared/production'
import { createAuditBrowser, resolveEngine, type ProductionAuditBrowser } from './browser'
import { createFsSourceTree, discoverStack, globToRegExp, routeKey, tagsForPath } from './discovery'
import { createFixtureServer, type FixtureServer } from './fixtures/server'
import { policyForEnvironment } from './netpolicy'

const engine = await resolveEngine()

/** An in-memory project tree with the same glob rules as the filesystem one. */
function memoryTree(files: Record<string, string | null>): SourceTree {
  const paths = Object.keys(files)
  return {
    root: '/memory',
    read: async path => path in files ? files[path] ?? null : null,
    list: async (glob, limit = 500) => paths.filter(path => globToRegExp(glob).test(path)).slice(0, limit),
    exists: async path => paths.some(file => file === path || file.startsWith(`${path}/`)),
  }
}

const environmentFor = (origin: string, patch: Partial<ProductionEnvironment> = {}): ProductionEnvironment => ({
  id: 'local', kind: 'local', label: 'Fixture', baseUrl: `${origin}/`, allowedOrigins: [origin], accounts: [], capturedMail: null, commerce: null,
  storage: null, buildInfoCommand: null, smokeCommand: null, ...patch,
})

describe('globToRegExp and route helpers', () => {
  it('matches globstar, single segments and alternatives', () => {
    expect(globToRegExp('wp-content/plugins/*/*.php').test('wp-content/plugins/woocommerce/woocommerce.php')).toBe(true)
    expect(globToRegExp('wp-content/plugins/*/*.php').test('wp-content/plugins/woocommerce/includes/a.php')).toBe(false)
    expect(globToRegExp('**/emails/**/*.{php,mjml}').test('woocommerce/emails/customer-note.php')).toBe(true)
    expect(globToRegExp('**/emails/**/*.{php,mjml}').test('src/emails/welcome/body.mjml')).toBe(true)
    expect(globToRegExp('**/*.mjml').test('welcome.mjml')).toBe(true)
    expect(globToRegExp('*.php').test('inc/a.php')).toBe(false)
  })

  it('keys routes by path and query without fragments or tracking parameters, on allowed origins only', () => {
    const allowed = ['https://shop.example']
    expect(routeKey('https://shop.example/p/?utm_source=x&id=2#top', allowed)).toBe('/p/?id=2')
    expect(routeKey('https://evil.example/p/', allowed)).toBeNull()
    expect(tagsForPath('/')).toEqual(['home'])
    expect(tagsForPath('/privacy-policy/')).toEqual(expect.arrayContaining(['policy', 'privacy']))
    expect(tagsForPath('/obchodne-podmienky/')).toEqual(expect.arrayContaining(['policy', 'terms']))
    expect(tagsForPath('/product/alpha/')).toContain('product')
  })
})

describe('stack discovery from the source tree', () => {
  it('recognises a WooCommerce theme repository, its email templates, integrations and infrastructure', async () => {
    const tree = memoryTree({
      'style.css': '/*\nTheme Name: Haft\nVersion: 2.1\n*/',
      'functions.php': "<?php\nadd_action('after_setup_theme', function () { add_theme_support( 'woocommerce' ); });",
      'woocommerce/emails/customer-completed-order.php': '<?php // template',
      'woocommerce/single-product.php': '<?php',
      'package.json': JSON.stringify({ devDependencies: { vite: '^5', tailwindcss: '^3' } }),
      'composer.json': JSON.stringify({ require: { 'stripe/stripe-php': '^10', 'wpackagist-plugin/complianz-gdpr': '*' } }),
      '.htaccess': 'RewriteEngine On',
      'broken.json': null,
    })
    const { stack, routes, visited } = await discoverStack(tree, environmentFor('https://shop.example'), null, { now: () => new Date('2026-09-29T00:00:00.000Z') })
    expect(stack.platform).toBe('woocommerce')
    expect(stack.frontend).toEqual(expect.arrayContaining(['wordpress-theme:Haft', 'vite', 'tailwindcss']))
    expect(stack.backend).toContain('php')
    expect(stack.plugins).toContain('complianz-gdpr')
    expect(stack.integrations).toEqual(expect.arrayContaining(['woocommerce', 'stripe', 'complianz']))
    expect(stack.emailTemplates).toContain('woocommerce/emails/customer-completed-order.php')
    expect(stack.infrastructureFiles).toEqual(['.htaccess'])
    expect(stack.discoveredAt).toBe('2026-09-29T00:00:00.000Z')
    expect(routes).toEqual([{ path: '/', source: 'crawl', tags: ['home'], coverage: 'full' }])
    expect(visited).toEqual([])
  })

  it('reads a custom app from disk, bounded to the project root, and lists what it could not read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-discovery-'))
    try {
      const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
      write('package.json', JSON.stringify({ dependencies: { react: '^19', express: '^5', '@sentry/node': '^8', stripe: '^16', openai: '^5' } }))
      write('composer.json', '{ not json')
      write('src/emails/welcome.mjml', '<mjml></mjml>')
      write('Dockerfile', 'FROM node:22')
      write('node_modules/left-pad/package.json', '{}')
      const tree = createFsSourceTree(root)
      expect(await tree.read('../outside.txt')).toBeNull()
      expect(await tree.exists('../')).toBe(false)
      expect(await tree.list('**/package.json')).toEqual(['package.json'])
      const { stack } = await discoverStack(tree, environmentFor('https://app.example'), null)
      expect(stack.platform).toBe('custom')
      expect(stack.frontend).toContain('react')
      expect(stack.backend).toContain('express')
      expect(stack.integrations).toEqual(expect.arrayContaining(['sentry', 'stripe', 'openai']))
      expect(stack.emailTemplates).toContain('src/emails/welcome.mjml')
      expect(stack.infrastructureFiles).toContain('Dockerfile')
      expect(stack.unread).toContain('composer.json (not valid JSON)')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!engine.available)('route matrix from the live site', { timeout: 30_000 }, () => {
  let server: FixtureServer
  let scratch: string
  const browsers: ProductionAuditBrowser[] = []
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'prod-crawl-'))
    server = await createFixtureServer({ sites: ['baseline'] })
  })
  afterAll(async () => {
    await Promise.all(browsers.map(browser => browser.close()))
    await server?.close()
    rmSync(scratch, { recursive: true, force: true })
  })
  const openPage = async (name: string) => {
    const site = server.site('baseline')
    const environment = environmentFor(site.origin)
    const browser = createAuditBrowser(policyForEnvironment(environment, { budget: { ...DEFAULT_AUDIT_BUDGET, requestsPerSecondPerOrigin: 0 } }), { userDataDir: join(scratch, name) })
    browsers.push(browser)
    return { environment, page: await browser.open({ device: 'desktop', locale: 'en', auth: null, consent: 'clean', regionSelection: 'none' }) }
  }

  it('reads the sitemap, crawls to depth 2, samples groups, excludes state-changing links and finds shared components', async () => {
    const { environment, page } = await openPage('crawl')
    server.reset()
    const { stack, routes, visited } = await discoverStack(null, environment, page)
    const route = (path: string) => routes.find(entry => entry.path === path && entry.source !== 'component')

    expect(stack.platform).toBe('woocommerce')
    expect(stack.plugins).toContain('woocommerce')
    expect(stack.sitemapUrl).toBe(server.site('baseline').url('/sitemap.xml'))

    expect(route('/shop/')).toMatchObject({ source: 'sitemap', coverage: 'full' })
    expect(route('/privacy-policy/')).toMatchObject({ coverage: 'full', tags: expect.arrayContaining(['policy', 'privacy']) })
    expect(route('/contact/')).toMatchObject({ tags: expect.arrayContaining(['contact', 'form', 'form:post']) })
    expect(route('/checkout/')).toMatchObject({ source: 'crawl', tags: expect.arrayContaining(['checkout']) })

    const products = routes.filter(entry => entry.path.startsWith('/product/'))
    expect(products).toHaveLength(6)
    expect(products.filter(entry => entry.coverage === 'sampled').map(entry => entry.path)).toEqual(['/product/alpha/'])
    expect(products.filter(entry => entry.coverage === 'excluded').every(entry => /represented by sampled \/product\/alpha\//.test(entry.excludedReason ?? ''))).toBe(true)

    for (const path of ['/?add-to-cart=1', '/cart/?remove_item=abc123', '/my-account/customer-logout/?_wpnonce=abc']) {
      expect(route(path), path).toMatchObject({ coverage: 'excluded', excludedReason: expect.stringMatching(/state-changing/) })
      expect(visited.map(item => item.path)).not.toContain(path)
    }
    expect(server.mutations('baseline')).toEqual([])
    expect(server.requests('baseline').some(item => /add-to-cart|remove_item|_wpnonce/.test(item.path))).toBe(false)

    expect(Math.max(...visited.map(item => item.depth))).toBeLessThanOrEqual(2)
    expect(visited.every(item => item.outcome === 'ok')).toBe(true)

    const shared = routes.find(entry => entry.source === 'component' && entry.tags.includes('component:shared-links'))
    expect(shared).toMatchObject({ path: '/', coverage: 'sampled' })
    expect(shared?.tags).toEqual(expect.arrayContaining(['link:/privacy-policy/', 'link:/terms/']))
    await page.close()
  })

  it('stays within the route bound', async () => {
    const { environment, page } = await openPage('bounded')
    const { routes } = await discoverStack(null, environment, page, { maxRoutes: 5, maxDepth: 1 })
    expect(routes.length).toBeLessThanOrEqual(5)
    await page.close()
  })
})
