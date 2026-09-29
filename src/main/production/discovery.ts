import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { AuditPage, ProductionEnvironment, RouteEntry, SourceTree, StackDiscovery } from '../../shared/production'
import { isStateChangingUrl, originOf } from './netpolicy'

/**
 * Stack discovery and the route matrix (docs/production-agent.md sections 2 and 11, module M2).
 *
 * From the source tree: WordPress (wp-config, wp-content, a theme `style.css` header, `functions.php`),
 * WooCommerce (the plugin, template overrides, theme support), plugins, custom apps from
 * `package.json`/`composer.json`, email templates and infrastructure files. From the site: the
 * generator tag and asset paths, the sitemap (robots.txt, then the usual locations, sitemap
 * indexes one level deep) and a crawl to depth 2, all through the audit page and so through the
 * network policy. Routes are bounded to 200; a group of similar routes (product pages) keeps one
 * `sampled` representative and lists the rest as `excluded`; a state-changing link is listed as
 * `excluded` and never visited. Links and forms present on most crawled pages become shared
 * `component` entries, so a footer defect is one finding, not one per page.
 */

export const MAX_ROUTES = 200
export const MAX_DEPTH = 2
const SAMPLE_GROUP_MIN = 4
const SHARED_SHARE = 0.8
const MAX_READ = 256 * 1024
const MAX_SITEMAPS = 10
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|pdf|zip|gz|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|otf|eot|xml|txt|json|csv|xlsx?|docx?)$/i
const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref)$/i

export interface DiscoveryOptions {
  maxRoutes?: number
  maxDepth?: number
  now?: () => Date
}

export interface DiscoveryResult {
  stack: StackDiscovery
  routes: RouteEntry[]
  /** Pages the crawl actually visited, with depth. */
  visited: Array<{ path: string; depth: number; outcome: string }>
}

const PATH_TAGS: Array<[RegExp, string[]]> = [
  [/privacy|gdpr|ochrana-osobnych-udajov|ochrana-osobnich-udaju|datenschutz|zasady-ochrany/i, ['policy', 'privacy']],
  [/terms|conditions|obchodne-podmienky|obchodni-podminky|\bvop\b|\bagb\b/i, ['policy', 'terms']],
  [/cookie/i, ['policy', 'cookies']],
  [/refund|returns?\b|withdrawal|reklamac|odstupenie|vratenie|vraceni/i, ['policy', 'refunds']],
  [/shipping|delivery|doprava|doruc/i, ['policy', 'shipping']],
  [/impressum|imprint|legal-notice|about-us|o-nas/i, ['identity']],
  [/\/(product|produkt|p)\//i, ['product']],
  [/\/(category|product-category|kategoria|kategorie|shop)\b/i, ['category']],
  [/\/(cart|basket|kosik)\b/i, ['cart']],
  [/\/(checkout|pokladna|objednavka)\b/i, ['checkout']],
  [/\/(my-account|account|login|register|moj-ucet|prihlasenie)\b/i, ['account']],
  [/\/(contact|kontakt)\b/i, ['contact']],
  [/\/(blog|news|novinky|clanky)\b|\/\d{4}\/\d{2}\//i, ['blog']],
]

const INTEGRATIONS: Array<[RegExp, string]> = [
  [/googletagmanager\.com|google-analytics\.com|\bgtag\b|analytics\.js/i, 'google-analytics'],
  [/hotjar/i, 'hotjar'], [/clarity\.ms/i, 'microsoft-clarity'], [/connect\.facebook\.net|fbevents/i, 'meta-pixel'],
  [/fullstory/i, 'fullstory'], [/logrocket/i, 'logrocket'], [/mouseflow/i, 'mouseflow'], [/smartlook/i, 'smartlook'],
  [/posthog/i, 'posthog'], [/mixpanel/i, 'mixpanel'], [/segment\.(com|io)|analytics-next/i, 'segment'], [/@sentry|sentry\.io/i, 'sentry'],
  [/stripe/i, 'stripe'], [/paypal/i, 'paypal'], [/gopay/i, 'gopay'], [/comgate/i, 'comgate'], [/besteron/i, 'besteron'],
  [/mailchimp/i, 'mailchimp'], [/sendgrid/i, 'sendgrid'], [/mailgun/i, 'mailgun'], [/postmark/i, 'postmark'], [/\bresend\b/i, 'resend'],
  [/nodemailer/i, 'nodemailer'], [/ecomail/i, 'ecomail'], [/klaviyo/i, 'klaviyo'], [/smartemailing/i, 'smartemailing'],
  [/fonts\.googleapis\.com|fonts\.gstatic\.com|google-fonts/i, 'google-fonts'], [/typekit|use\.typekit/i, 'adobe-fonts'],
  [/cookiebot/i, 'cookiebot'], [/onetrust|cookielaw/i, 'onetrust'], [/complianz/i, 'complianz'], [/cookieyes/i, 'cookieyes'],
  [/openai/i, 'openai'], [/@anthropic-ai|anthropic/i, 'anthropic'], [/intercom/i, 'intercom'], [/tawk\.to/i, 'tawk'], [/crisp\.chat/i, 'crisp'],
  [/amazonaws|@aws-sdk|aws-sdk/i, 'aws'], [/cloudinary/i, 'cloudinary'], [/firebase/i, 'firebase'], [/supabase/i, 'supabase'],
  [/youtube\.com|ytimg/i, 'youtube'], [/vimeo/i, 'vimeo'], [/recaptcha/i, 'recaptcha'], [/hcaptcha/i, 'hcaptcha'],
  [/heureka/i, 'heureka'], [/packeta|zasilkovna/i, 'packeta'],
]

const FRONTEND_DEPS = ['react', 'vue', 'next', 'nuxt', 'svelte', '@sveltejs/kit', '@angular/core', 'astro', 'solid-js', 'preact', 'remix', '@remix-run/react', 'vite', 'gatsby', 'jquery', 'alpinejs', 'htmx.org', 'tailwindcss']
const BACKEND_DEPS = ['express', 'fastify', 'koa', '@nestjs/core', 'hono', 'next', 'nuxt', '@remix-run/node', 'prisma', '@prisma/client', 'drizzle-orm', 'mongoose', 'pg', 'mysql2', 'better-sqlite3', 'electron']
const COMPOSER_BACKEND: Array<[RegExp, string]> = [[/^laravel\/framework$/, 'laravel'], [/^symfony\/(framework-bundle|symfony)$/, 'symfony'], [/^slim\/slim$/, 'slim'], [/^cakephp\/cakephp$/, 'cakephp'], [/^roots\/(bedrock|wordpress)$/, 'wordpress'], [/^johnpbloch\/wordpress/, 'wordpress']]

const INFRASTRUCTURE_FILES = [
  '.htaccess', 'nginx.conf', 'web.config', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'vercel.json',
  'netlify.toml', 'fly.toml', 'wrangler.toml', 'render.yaml', 'app.yaml', 'Procfile', '.env.example', 'next.config.js', 'next.config.mjs',
  'next.config.ts', 'nuxt.config.ts', 'vite.config.ts', 'vite.config.js', 'astro.config.mjs', 'wp-cli.yml', 'robots.txt', '.user.ini', 'php.ini',
  '.github/workflows', 'serverless.yml', 'firebase.json', 'supabase/config.toml',
]

const EMAIL_TEMPLATE_GLOBS = [
  'woocommerce/emails/**/*.php', 'wp-content/themes/*/woocommerce/emails/**/*.php', '**/emails/**/*.{php,html,hbs,mjml,tsx,jsx,twig,blade.php}',
  '**/email-templates/**/*', '**/mail/**/*.{php,html,hbs,mjml,twig,blade.php}', '**/*.mjml',
]

/** A glob with `**` (any directories), `*` and `?` within one segment, and `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '*' && glob[index + 1] === '*') {
      index++
      if (glob[index + 1] === '/') { index++; pattern += '(?:.*/)?' } else pattern += '.*'
    } else if (char === '*') pattern += '[^/]*'
    else if (char === '?') pattern += '[^/]'
    else if (char === '{') {
      const end = glob.indexOf('}', index)
      if (end < 0) { pattern += '\\{'; continue }
      pattern += `(?:${glob.slice(index + 1, end).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`
      index = end
    } else pattern += char.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`, 'i')
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'vendor', 'dist', 'out', 'build', '.next', '.nuxt', 'release', '.conductor-scratch', 'uploads', 'cache'])

/** A bounded, read-only view of a project directory; paths outside the root are refused. */
export function createFsSourceTree(root: string, options: { maxEntries?: number } = {}): SourceTree {
  const base = resolve(root)
  const maxEntries = options.maxEntries ?? 20_000
  const inside = (relativePath: string): string | null => {
    const target = resolve(base, relativePath)
    return target === base || target.startsWith(base + sep) ? target : null
  }
  let files: string[] | null = null
  const allFiles = (): string[] => {
    if (files) return files
    const found: string[] = []
    const walk = (directory: string): void => {
      if (found.length >= maxEntries) return
      let entries
      try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (found.length >= maxEntries) return
        const full = `${directory}${sep}${entry.name}`
        if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full) }
        else if (entry.isFile()) found.push(relative(base, full).split(sep).join('/'))
      }
    }
    walk(base)
    return files = found
  }
  return {
    root: base,
    async read(relativePath, maxBytes = MAX_READ) {
      const target = inside(relativePath)
      if (!target) return null
      try {
        if (!statSync(target).isFile()) return null
        const buffer = readFileSync(target)
        return buffer.subarray(0, maxBytes).toString('utf8')
      } catch {
        return null
      }
    },
    async list(glob, limit = 500) {
      const pattern = globToRegExp(glob)
      return allFiles().filter(path => pattern.test(path)).slice(0, limit)
    },
    async exists(relativePath) {
      const target = inside(relativePath)
      return !!target && existsSync(target)
    },
  }
}

/** Drops the fragment and tracking parameters; returns path + search, or null off the allowed origins. */
export function routeKey(url: string, allowedOrigins: readonly string[]): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  const origin = originOf(parsed.href)
  if (!origin || !allowedOrigins.includes(origin)) return null
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key)
  return parsed.pathname + parsed.search
}

export function tagsForPath(path: string): string[] {
  const tags = new Set<string>()
  if (path === '/' || path === '') tags.add('home')
  for (const [pattern, names] of PATH_TAGS) if (pattern.test(path)) names.forEach(name => tags.add(name))
  return [...tags]
}

async function readJson(source: SourceTree, path: string, unread: string[]): Promise<Record<string, unknown> | null> {
  if (!await source.exists(path)) return null
  const text = await source.read(path, MAX_READ)
  if (text === null) { unread.push(path); return null }
  try { return JSON.parse(text) as Record<string, unknown> } catch { unread.push(`${path} (not valid JSON)`); return null }
}

const themeHeader = (css: string | null): string | null => css ? /^[ \t/*#@]*Theme Name:\s*(.+)$/im.exec(css)?.[1]?.trim() ?? null : null
const pluginHeader = (php: string | null): string | null => php ? /^[ \t/*#@]*Plugin Name:\s*(.+)$/im.exec(php)?.[1]?.trim() ?? null : null

async function discoverSource(source: SourceTree, stack: StackDiscovery): Promise<void> {
  const add = (list: string[], value: string) => { if (value && !list.includes(value)) list.push(value) }
  const has = (path: string) => source.exists(path)

  // WordPress: a full install, or a theme or plugin repository.
  const themes = await source.list('wp-content/themes/*/style.css', 50)
  const rootStyle = await has('style.css') ? await source.read('style.css', 8192) : null
  const rootTheme = themeHeader(rootStyle)
  const functions = await has('functions.php') ? await source.read('functions.php') : null
  const isWordPress = await has('wp-config.php') || await has('wp-includes') || await has('wp-content') || themes.length > 0 || rootTheme !== null
  if (isWordPress) {
    stack.platform = 'wordpress'
    if (rootTheme) add(stack.frontend, `wordpress-theme:${rootTheme}`)
    for (const theme of themes) {
      const name = themeHeader(await source.read(theme, 8192))
      if (name) add(stack.frontend, `wordpress-theme:${name}`)
    }
    for (const file of await source.list('wp-content/plugins/*/*.php', 2000)) {
      const folder = file.split('/')[2]!
      add(stack.plugins, folder)
    }
    for (const file of await source.list('*.php', 50)) {
      const name = pluginHeader(await source.read(file, 8192))
      if (name) add(stack.plugins, name.toLowerCase().replace(/\s+/g, '-'))
    }
    add(stack.backend, 'php')
  }
  const woo = stack.plugins.some(plugin => /^woocommerce$/i.test(plugin)) || await has('woocommerce') ||
    (await source.list('wp-content/themes/*/woocommerce/**/*.php', 1)).length > 0 ||
    (functions !== null && /add_theme_support\(\s*['"]woocommerce['"]|\bWC\(\)|\bwoocommerce_[a-z_]+/i.test(functions))
  if (woo) { stack.platform = 'woocommerce'; add(stack.integrations, 'woocommerce') }
  if (functions === null && await has('functions.php')) stack.unread.push('functions.php')

  // Custom apps.
  const packageJson = await readJson(source, 'package.json', stack.unread)
  if (packageJson) {
    const deps = { ...(packageJson.dependencies as Record<string, string> | undefined), ...(packageJson.devDependencies as Record<string, string> | undefined) }
    for (const name of Object.keys(deps)) {
      if (FRONTEND_DEPS.includes(name)) add(stack.frontend, name)
      if (BACKEND_DEPS.includes(name)) add(stack.backend, name)
      for (const [pattern, integration] of INTEGRATIONS) if (pattern.test(name)) add(stack.integrations, integration)
    }
    if (stack.platform === 'unknown') stack.platform = 'custom'
  }
  const composer = await readJson(source, 'composer.json', stack.unread)
  if (composer) {
    for (const name of Object.keys((composer.require as Record<string, string> | undefined) ?? {})) {
      for (const [pattern, backend] of COMPOSER_BACKEND) if (pattern.test(name)) add(stack.backend, backend)
      if (/^wpackagist-plugin\//.test(name)) add(stack.plugins, name.split('/')[1]!)
      for (const [pattern, integration] of INTEGRATIONS) if (pattern.test(name)) add(stack.integrations, integration)
    }
    if (stack.platform === 'unknown') stack.platform = stack.backend.includes('wordpress') ? 'wordpress' : 'custom'
    if (stack.plugins.includes('woocommerce')) stack.platform = 'woocommerce'
    add(stack.backend, 'php')
  }
  for (const plugin of stack.plugins) for (const [pattern, integration] of INTEGRATIONS) if (pattern.test(plugin)) add(stack.integrations, integration)

  for (const glob of EMAIL_TEMPLATE_GLOBS) {
    for (const file of await source.list(glob, 100)) if (stack.emailTemplates.length < 200) add(stack.emailTemplates, file)
  }
  for (const file of INFRASTRUCTURE_FILES) if (await has(file)) add(stack.infrastructureFiles, file)
  if (await has('wp-config.php')) add(stack.infrastructureFiles, 'wp-config.php')
}

/** Fetches text through the page (so through the network policy), bounded; null when it is not there. */
async function fetchText(page: AuditPage, url: string): Promise<string | null> {
  const expression = `fetch(${JSON.stringify(url)}, { credentials: 'same-origin', redirect: 'manual' }).then(response => response.ok ? response.text().then(text => text.slice(0, ${MAX_READ})) : null).catch(() => null)`
  try { return await page.evaluate<string | null>(expression) } catch { return null }
}

const locs = (xml: string): string[] => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(match => match[1]!.replace(/&amp;/g, '&'))

async function readSitemap(page: AuditPage, environment: ProductionEnvironment, allowed: string[], stack: StackDiscovery): Promise<string[]> {
  const base = new URL(environment.baseUrl)
  const candidates: string[] = []
  const robots = await fetchText(page, new URL('/robots.txt', base).href)
  if (robots) for (const match of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.push(match[1]!)
  candidates.push(...['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'].map(path => new URL(path, base).href))
  for (const candidate of [...new Set(candidates)]) {
    if (!routeKey(candidate, allowed)) continue
    const xml = await fetchText(page, candidate)
    if (!xml || !/<(urlset|sitemapindex)\b/i.test(xml)) continue
    stack.sitemapUrl = candidate
    if (!/<sitemapindex\b/i.test(xml)) return locs(xml)
    const urls: string[] = []
    for (const child of locs(xml).slice(0, MAX_SITEMAPS)) {
      if (!routeKey(child, allowed)) continue
      const childXml = await fetchText(page, child)
      if (childXml) urls.push(...locs(childXml)); else stack.unread.push(child)
    }
    return urls
  }
  return []
}

export async function discoverStack(source: SourceTree | null, environment: ProductionEnvironment, page: AuditPage | null, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const now = options.now ?? (() => new Date())
  const maxRoutes = options.maxRoutes ?? MAX_ROUTES
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const stack: StackDiscovery = {
    platform: 'unknown', frontend: [], backend: [], plugins: [], integrations: [], emailTemplates: [], infrastructureFiles: [],
    sitemapUrl: null, discoveredAt: now().toISOString(), unread: [],
  }
  if (source) await discoverSource(source, stack)

  const allowed = [...new Set([environment.baseUrl, ...environment.allowedOrigins].map(originOf).filter((origin): origin is string => !!origin))]
  const routes = new Map<string, RouteEntry>()
  const visited: DiscoveryResult['visited'] = []
  const addRoute = (path: string, from: RouteEntry['source'], url: string): RouteEntry | null => {
    const existing = routes.get(path)
    if (existing) return existing
    if (routes.size >= maxRoutes) return null
    const entry: RouteEntry = isStateChangingUrl(url)
      ? { path, source: from, tags: tagsForPath(path), coverage: 'excluded', excludedReason: 'state-changing link: never visited by the audit' }
      : { path, source: from, tags: tagsForPath(path), coverage: 'full' }
    routes.set(path, entry)
    return entry
  }
  const basePath = routeKey(environment.baseUrl, allowed) ?? '/'
  addRoute(basePath, 'crawl', environment.baseUrl)

  if (page) {
    const pageLinks = new Map<string, Set<string>>()
    const pageForms = new Map<string, Set<string>>()
    const queue: Array<{ path: string; depth: number }> = [{ path: basePath, depth: 0 }]
    const seen = new Set([basePath])
    let first = true
    while (queue.length) {
      const { path, depth } = queue.shift()!
      const url = new URL(path, environment.baseUrl).href
      const navigation = await page.goto(url)
      visited.push({ path, depth, outcome: navigation.outcome })
      if (navigation.outcome !== 'ok') {
        const entry = routes.get(path)
        if (entry && entry.coverage !== 'excluded') { entry.coverage = 'excluded'; entry.excludedReason = `navigation ${navigation.outcome}` }
        if (first) stack.unread.push(`${url}: ${navigation.outcome}`)
        first = false
        continue
      }
      if (first) {
        first = false
        const markers = await page.evaluate<{ generator: string | null; assets: string[]; bodyClass: string }>(
          `({ generator: document.querySelector('meta[name="generator"]')?.content ?? null, assets: [...document.querySelectorAll('script[src], link[href]')].map(node => node.src || node.href).slice(0, 300), bodyClass: document.body?.className ?? '' })`,
        ).catch(() => ({ generator: null, assets: [], bodyClass: '' }))
        const assets = markers.assets.join('\n')
        if (/wordpress/i.test(markers.generator ?? '') || /\/wp-content\/|\/wp-includes\//.test(assets)) {
          if (stack.platform === 'unknown' || stack.platform === 'custom') stack.platform = 'wordpress'
        }
        for (const match of assets.matchAll(/\/wp-content\/plugins\/([^/]+)\//g)) if (!stack.plugins.includes(match[1]!)) stack.plugins.push(match[1]!)
        if (stack.plugins.includes('woocommerce') || /\bwoocommerce\b/.test(markers.bodyClass)) stack.platform = 'woocommerce'
        for (const [pattern, integration] of INTEGRATIONS) if (pattern.test(assets) && !stack.integrations.includes(integration)) stack.integrations.push(integration)
        for (const url of await readSitemap(page, environment, allowed, stack)) {
          const key = routeKey(url, allowed)
          if (key) addRoute(key, 'sitemap', url)
        }
      }
      const snapshot = await page.snapshot().catch(() => null)
      if (!snapshot) continue
      const links = new Set<string>()
      for (const link of snapshot.links) {
        const key = routeKey(link.href, allowed)
        if (!key) continue
        links.add(key)
        if (ASSET.test(key.split('?')[0]!)) continue
        const entry = addRoute(key, 'crawl', link.href)
        if (!entry || entry.coverage === 'excluded' || seen.has(key) || depth + 1 > maxDepth) continue
        seen.add(key)
        queue.push({ path: key, depth: depth + 1 })
      }
      pageLinks.set(path, links)
      const forms = new Set(snapshot.forms.map(form => `${form.method} ${form.action ? routeKey(form.action, allowed) ?? form.action : '(none)'} ${form.fields.map(field => field.name).sort().join(',')}`))
      pageForms.set(path, forms)
      const entry = routes.get(path)
      if (entry && snapshot.forms.length) {
        if (!entry.tags.includes('form')) entry.tags.push('form')
        if (snapshot.forms.some(form => form.method !== 'get') && !entry.tags.includes('form:post')) entry.tags.push('form:post')
      }
    }
    sampleGroups(routes)
    addComponents(routes, pageLinks, pageForms, maxRoutes)
  }
  return { stack, routes: [...routes.values()], visited }
}

/** A directory with SAMPLE_GROUP_MIN or more sibling routes keeps its first one as `sampled`; the rest are listed as `excluded`. */
function sampleGroups(routes: Map<string, RouteEntry>): void {
  const groups = new Map<string, RouteEntry[]>()
  for (const entry of routes.values()) {
    if (entry.coverage === 'excluded' || entry.source === 'component' || entry.path.includes('?')) continue
    if (entry.tags.some(tag => tag === 'home' || tag === 'policy' || tag === 'identity' || tag === 'cart' || tag === 'checkout' || tag === 'account' || tag === 'contact')) continue
    const segments = entry.path.split('/').filter(Boolean)
    if (segments.length < 2) continue
    const group = `/${segments.slice(0, -1).join('/')}/*${entry.path.endsWith('/') ? '/' : ''}`
    const members = groups.get(group) ?? []
    members.push(entry)
    groups.set(group, members)
  }
  for (const [group, members] of groups) {
    if (members.length < SAMPLE_GROUP_MIN) continue
    members.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const [sample, ...rest] = members
    sample!.coverage = 'sampled'
    sample!.tags.push(`group:${group}`)
    for (const entry of rest) {
      entry.coverage = 'excluded'
      entry.excludedReason = `represented by sampled ${sample!.path} (group ${group}, ${members.length} routes)`
      entry.tags.push(`group:${group}`)
    }
  }
}

/** Links and forms on at least SHARED_SHARE of the crawled pages are one shared component each. */
function addComponents(routes: Map<string, RouteEntry>, pageLinks: Map<string, Set<string>>, pageForms: Map<string, Set<string>>, maxRoutes: number): void {
  const pages = [...pageLinks.keys()]
  if (pages.length < 2) return
  const shared = <T>(sets: Map<string, Set<T>>): T[] => {
    const counts = new Map<T, number>()
    for (const set of sets.values()) for (const item of set) counts.set(item, (counts.get(item) ?? 0) + 1)
    return [...counts].filter(([, count]) => count / sets.size >= SHARED_SHARE).map(([item]) => item)
  }
  const host = pages[0]!
  const sharedLinks = shared(pageLinks)
  const components: Array<[string, string[]]> = []
  if (sharedLinks.length) components.push(['shared-links', sharedLinks.sort().slice(0, 50).map(link => `link:${link}`)])
  for (const [index, form] of shared(pageForms).entries()) components.push([`shared-form-${index + 1}`, [`form:${form}`]])
  for (const [name, detail] of components) {
    const key = `${host}#component:${name}`
    if (routes.size >= maxRoutes) return
    routes.set(key, { path: host, source: 'component', tags: ['component', `component:${name}`, ...detail], coverage: 'sampled' })
  }
}
