import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID } from '../shared/remote-control'
import { PhoneAccessService } from './phone-access'
import { PhoneAccessServer } from './phone-access-server'
import { CAPABILITY_IDLE_MS, CAPABILITY_MAX_MS, PhoneFiles, SANDBOX_CSP, confined, pathSegments, phoneFileType } from './phone-files'
import { MemoryVault, type SecretKeyValueStore } from './secret-store'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A project folder shaped like the miron logo delivery, plus everything the phone must not see. */
function projectTree(): { root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-phone-files-')))
  cleanup.push(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'miron'), outside = join(base, 'secret')
  const concepts = join(root, 'output', 'haf-logo-concepts')
  mkdirSync(join(concepts, 'individual-assets'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(concepts, 'index.html'), '<!doctype html><img src="individual-assets/mark.svg"><script>document.title="x"</script>')
  writeFileSync(join(concepts, 'contact-sheet-color.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5, 6, 7]))
  writeFileSync(join(concepts, 'individual-assets', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  writeFileSync(join(concepts, 'haf-lettermarks-delivery.zip'), Buffer.alloc(1000, 7))
  writeFileSync(join(concepts, '.env'), 'TOKEN=1')
  writeFileSync(join(root, '.env.local'), 'TOKEN=2')
  writeFileSync(join(root, '.git', 'config'), '[core]')
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '1')
  writeFileSync(join(outside, 'passwords.txt'), 'hunter2')
  // A junction (Windows) or directory link that leaves the project, and one that stays inside.
  symlinkSync(outside, join(concepts, 'escape'), 'junction')
  symlinkSync(join(root, '.git'), join(concepts, 'gitlink'), 'junction')
  symlinkSync(join(concepts, 'individual-assets'), join(root, 'assets-link'), 'junction')
  return { root, outside }
}

describe('phone file confinement', () => {
  it('refuses absolute paths, drive letters, .., NUL, Windows stream and device names, and hidden segments before touching the disk', () => {
    for (const bad of ['/etc/passwd', '\\\\server\\share', 'C:/Windows', 'c:', '..', 'a/../..', 'a/./b', 'a\u0000b', 'a\nb', 'file.txt:stream', 'NUL', 'con.txt', 'trailing.', 'space ']) {
      expect(() => pathSegments(bad), bad).toThrow(/not valid|relative to the project/)
    }
    for (const hidden of ['.git', 'a/.env', '.env.local', 'node_modules/x', 'Node_Modules', 'a\\.ssh\\id']) {
      expect(() => pathSegments(hidden), hidden).toThrow(/not shared/)
    }
    expect(pathSegments('output/haf-logo-concepts/')).toEqual(['output', 'haf-logo-concepts'])
    expect(pathSegments('')).toEqual([])
    expect(pathSegments(undefined)).toEqual([])
    expect(() => pathSegments(7)).toThrow(/not valid/)
  })

  it('confines by real path, case-insensitively where the disk is', () => {
    const root = process.platform === 'win32' ? 'C:\\p\\proj' : '/p/proj'
    const sep = process.platform === 'win32' ? '\\' : '/'
    expect(confined(root, root)).toBe(true)
    expect(confined(root, root + sep + 'a')).toBe(true)
    expect(confined(root, root + '-sibling' + sep + 'a')).toBe(false)
    expect(confined(root, root + sep + '.git' + sep + 'config')).toBe(false)
    if (process.platform === 'win32') expect(confined(root, 'c:\\P\\PROJ\\a')).toBe(true)
  })

  it('lists only visible entries that stay inside the project, folders first', async () => {
    const { root } = projectTree()
    const files = new PhoneFiles()
    const listing = await files.list(root, 'output/haf-logo-concepts')
    expect(listing.path).toBe('output/haf-logo-concepts')
    expect(listing.parent).toBe('output')
    expect(listing.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual(['dir:individual-assets', 'file:contact-sheet-color.png', 'file:haf-lettermarks-delivery.zip', 'file:index.html'])
    expect(listing.entries.find(entry => entry.name === 'contact-sheet-color.png')).toMatchObject({ image: true, type: 'image/png', size: 16 })
    // A link inside the project is listed as what it points at.
    expect((await files.list(root, '')).entries.map(entry => entry.name)).toEqual(['assets-link', 'output'])
    expect((await files.list(root, 'assets-link')).entries.map(entry => entry.name)).toEqual(['mark.svg'])
    await expect(files.list(root, 'output/haf-logo-concepts/escape')).rejects.toThrow(/not shared/)
    await expect(files.list(root, 'output/haf-logo-concepts/gitlink')).rejects.toThrow(/not shared/)
    await expect(files.list(root, '../secret')).rejects.toThrow(/not valid/)
    await expect(files.list(root, 'missing')).rejects.toThrow(/does not exist/)
    await expect(files.list(root, 'output/haf-logo-concepts/index.html')).rejects.toThrow(/a file, not a folder/)
    await expect(files.list(join(root, 'gone'), '')).rejects.toThrow(/not on this computer/)
  })

  it('types files by extension', () => {
    expect(phoneFileType('index.HTML')).toBe('text/html; charset=utf-8')
    expect(phoneFileType('a.svg')).toBe('image/svg+xml')
    expect(phoneFileType('a.zip')).toBe('application/zip')
    expect(phoneFileType('a.unknown')).toBe('application/octet-stream')
  })
})

describe('phone file capabilities', () => {
  it('are unguessable, scoped to one owner, slide with use, and expire or revoke', async () => {
    const { root } = projectTree()
    let now = 1_000_000
    const files = new PhoneFiles({ now: () => now })
    const first = await files.grant(root, 'output/haf-logo-concepts', { deviceId: 'phone-a', unlockId: 'unlock-1' })
    const second = await files.grant(root, 'output', { deviceId: 'phone-a', unlockId: 'unlock-2' })
    const other = await files.grant(root, '', { deviceId: 'phone-b', unlockId: null })
    expect(first.url).toMatch(/^\/files\/[A-Za-z0-9_-]{43}\/$/)
    expect(new Set([first.url, second.url, other.url]).size).toBe(3)
    expect(Date.parse(first.expiresAt) - now).toBe(CAPABILITY_IDLE_MS)
    await expect(files.grant(root, '.git', { deviceId: 'phone-a', unlockId: null })).rejects.toThrow(/not shared/)
    expect(files.size()).toBe(3)
    // One session locks: its capability goes, the phone's other session keeps its own.
    files.revoke('phone-a', 'unlock-1')
    expect(files.size()).toBe(2)
    // Unpaired: every capability of that phone.
    files.revoke('phone-a', null)
    expect(files.size()).toBe(1)
    // A code set or changed: every capability.
    files.revoke(null, null)
    expect(files.size()).toBe(0)
    await files.grant(root, '', { deviceId: 'phone-a', unlockId: null })
    now += CAPABILITY_IDLE_MS + 1
    expect(files.size()).toBe(0)
    await files.grant(root, '', { deviceId: 'phone-a', unlockId: null })
    now += CAPABILITY_MAX_MS + 1
    expect(files.size()).toBe(0)
  })
})

interface Reply { status: number; headers: IncomingMessage['headers']; body: string; raw: Buffer }

function call(port: number, ca: string, path: string, options: { method?: string; token?: string; unlock?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...options.headers }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    if (options.unlock) headers['x-conductor-unlock'] = options.unlock
    const method = options.method ?? 'GET'
    if (method === 'POST') headers['content-type'] = 'application/json'
    const req = httpsRequest({ host: '127.0.0.1', port, path, method, ca, rejectUnauthorized: true, headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: raw.toString('utf8'), raw }) })
    })
    req.once('error', reject)
    if (method === 'POST') req.write(JSON.stringify(options.body ?? {}))
    req.end()
  })
}

async function listener() {
  const { root } = projectTree()
  const project = { id: 'miron', name: 'miron', path: root, createdAt: 't', updatedAt: 't' }
  const remote = { id: 'mac-project', name: 'Haftheme', path: 'mac-mini:/Users/x/haftheme', createdAt: 't', updatedAt: 't', remote: { machineId: 'mac-mini', machineName: 'Mac mini', remoteProjectId: 'p', path: '/Users/x/haftheme' } }
  const audit = vi.fn(), log = vi.fn()
  const service = new PhoneAccessService({
    store: new MapStore(), vault: new MemoryVault(),
    database: { listProjects: () => [project, remote], getProject: id => [project, remote].find(entry => entry.id === id) ?? null, listSessions: () => [], listDetachedWindows: () => [], listProcesses: () => [], listAgentActivity: () => [], structured: { snapshot: () => null, spec: () => null, history: () => [], update: () => undefined } },
    sessions: { ensure: () => ({ id: 'x', available: false, status: 'unavailable', transcript: '' }), connectSession: async () => undefined, submit: async () => undefined, steer: async () => undefined, queue: async () => undefined, respond: async () => undefined, interrupt: async () => undefined, resume: async () => undefined },
    providers: () => [], machines: () => [{ id: LOCAL_MACHINE_ID, name: 'MAIN', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION }],
    machineName: () => 'MAIN', version: '0.1.3', ui: async () => ({}),
    metrics: async () => ({ sampledAt: 'now', cpuPercent: 1, cpuCores: 4, memoryUsedBytes: 1, memoryTotalBytes: 2, gpus: [], processes: [], localServers: [], unavailable: [] }),
    push: vi.fn(async () => ({ status: 201, gone: false, retryAfter: null, body: '' })), log, audit
  })
  service.updateSettings({ enabled: true, port: 0 })
  const server = new PhoneAccessServer({ service, localAddresses: () => ['127.0.0.1'], hostname: () => 'main-pc', assets: { 'index.html': '<!doctype html>', 'app.js': '1', 'app.css': '', 'sw.js': '', 'manifest.webmanifest': '{}', 'icon.svg': '<svg/>' }, log })
  cleanup.push(() => server.dispose())
  cleanup.push(() => service.dispose())
  const status = await server.apply()
  if (!status.listening) throw new Error('listener did not start: ' + status.message)
  const port = Number(new URL(status.endpoints[0]!).port)
  const ca = service.certificateAuthority().certificatePem
  const offer = service.createPairing()
  const paired = await call(port, ca, '/api/pair', { method: 'POST', body: { code: offer.code, name: 'iPhone' } })
  const { token, device } = JSON.parse(paired.body) as { token: string; device: { id: string } }
  return { service, server, port, ca, token, deviceId: device.id, audit, log }
}

describe('project files on the phone listener', () => {
  it('lists a folder and serves its files through a capability, with the right headers', { timeout: 30_000 }, async () => {
    const { port, ca, token, audit, log } = await listener()
    expect((await call(port, ca, '/api/projects/miron/files?path=output/haf-logo-concepts')).status).toBe(401)
    const listing = await call(port, ca, '/api/projects/miron/files?path=output%2Fhaf-logo-concepts', { token })
    expect(listing.status).toBe(200)
    expect(JSON.parse(listing.body).entries.map((entry: { name: string }) => entry.name)).toEqual(['individual-assets', 'contact-sheet-color.png', 'haf-lettermarks-delivery.zip', 'index.html'])
    expect((await call(port, ca, '/api/projects/miron/files?path=.git', { token })).status).toBe(403)
    expect((await call(port, ca, '/api/projects/miron/files?path=..', { token })).status).toBe(400)
    expect((await call(port, ca, '/api/projects/nope/files', { token })).status).toBe(404)
    const remote = await call(port, ca, '/api/projects/mac-project/files', { token })
    expect(remote.status).toBe(409)
    expect(JSON.parse(remote.body).error).toMatch(/lives on Mac mini/)
    expect((await call(port, ca, '/api/projects/mac-project/files/capability', { method: 'POST', token, body: { path: '' } })).status).toBe(409)

    const minted = await call(port, ca, '/api/projects/miron/files/capability', { method: 'POST', token, body: { path: 'output/haf-logo-concepts' } })
    expect(minted.status).toBe(200)
    const { url } = JSON.parse(minted.body) as { url: string }
    const capability = url.split('/')[2]!

    const html = await call(port, ca, url + 'index.html')
    expect(html.status).toBe(200)
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(html.headers['content-security-policy']).toBe(SANDBOX_CSP)
    expect(html.headers['content-security-policy']).not.toMatch(/allow-same-origin/)
    expect(html.headers['x-content-type-options']).toBe('nosniff')
    expect(html.headers['referrer-policy']).toBe('no-referrer')
    expect(html.headers['content-disposition']).toBeUndefined()
    // The page's relative asset resolves under the same capability; SVG is sandboxed too.
    const svg = await call(port, ca, url + 'individual-assets/mark.svg')
    expect(svg.status).toBe(200)
    expect(svg.headers['content-type']).toBe('image/svg+xml')
    expect(svg.headers['content-security-policy']).toBe(SANDBOX_CSP)
    const png = await call(port, ca, url + 'contact-sheet-color.png')
    expect(png.headers['content-type']).toBe('image/png')
    expect(png.raw.length).toBe(16)
    const zip = await call(port, ca, url + 'haf-lettermarks-delivery.zip?download=1')
    expect(zip.headers['content-type']).toBe('application/zip')
    expect(zip.headers['content-disposition']).toBe(`attachment; filename="haf-lettermarks-delivery.zip"; filename*=UTF-8''haf-lettermarks-delivery.zip`)
    const head = await call(port, ca, url + 'haf-lettermarks-delivery.zip', { method: 'HEAD' })
    expect(head.headers['content-length']).toBe('1000')
    expect(head.raw.length).toBe(0)
    // Range for big files.
    const part = await call(port, ca, url + 'haf-lettermarks-delivery.zip', { headers: { range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 10-19/1000')
    expect(part.raw.length).toBe(10)
    expect((await call(port, ca, url + 'haf-lettermarks-delivery.zip', { headers: { range: 'bytes=-5' } })).raw.length).toBe(5)
    const beyond = await call(port, ca, url + 'haf-lettermarks-delivery.zip', { headers: { range: 'bytes=5000-' } })
    expect(beyond.status).toBe(416)
    expect(beyond.headers['content-range']).toBe('bytes */1000')

    // No listing over the capability, no way out of its folder, no hidden files.
    for (const path of [url, url + 'individual-assets', url + 'individual-assets/', url + '.env', url + '%2e%2e/%2e%2e/.git/config', url + '..%2F..%2F.env.local', url + 'escape/passwords.txt', url + 'gitlink/config', url + '%00', url + 'C:%5CWindows%5Cwin.ini']) {
      const refused = await call(port, ca, path)
      expect({ path, status: refused.status >= 400 }).toEqual({ path, status: true })
      expect(refused.body).not.toMatch(/hunter2|TOKEN=|\[core\]/)
    }
    // A forged or truncated capability is a 404, and so is a POST to the file door.
    expect((await call(port, ca, '/files/' + 'A'.repeat(43) + '/index.html')).status).toBe(404)
    expect((await call(port, ca, '/files/' + capability.slice(1) + '/index.html')).status).toBe(404)
    expect((await call(port, ca, url + 'index.html', { method: 'POST' })).status).toBe(405)
    // The capability never reaches a log or the audit trail.
    const written = JSON.stringify([...audit.mock.calls, ...log.mock.calls])
    expect(written).not.toContain(capability)
  })

  it('stops serving a capability the moment its phone locks or is unpaired', { timeout: 30_000 }, async () => {
    const { service, port, ca, token, deviceId } = await listener()
    await service.lock.setCode('482915')
    expect((await call(port, ca, '/api/projects/miron/files', { token })).status).toBe(423)
    expect((await call(port, ca, '/api/projects/miron/files/capability', { method: 'POST', token, body: { path: '' } })).status).toBe(423)
    const { unlockToken } = await service.lock.unlock('482915', { id: deviceId })
    const mint = async (): Promise<string> => (JSON.parse((await call(port, ca, '/api/projects/miron/files/capability', { method: 'POST', token, unlock: unlockToken, body: { path: 'output/haf-logo-concepts' } })).body) as { url: string }).url
    let url = await mint()
    expect((await call(port, ca, url + 'index.html')).status).toBe(200)
    service.lock.lockAll()
    expect((await call(port, ca, url + 'index.html')).status).toBe(404)
    // A fresh unlock gets a fresh link; unpairing ends it.
    const again = await service.lock.unlock('482915', { id: deviceId })
    url = JSON.parse((await call(port, ca, '/api/projects/miron/files/capability', { method: 'POST', token, unlock: again.unlockToken, body: { path: '' } })).body).url
    expect((await call(port, ca, url + 'output/haf-logo-concepts/shortlist-missing.png')).status).toBe(404)
    expect((await call(port, ca, url + 'output/haf-logo-concepts/index.html')).status).toBe(200)
    service.revoke(deviceId)
    expect((await call(port, ca, url + 'output/haf-logo-concepts/index.html')).status).toBe(404)
  })

  it('ends every capability when a code is first set', { timeout: 30_000 }, async () => {
    const { service, port, ca, token } = await listener()
    const { url } = JSON.parse((await call(port, ca, '/api/projects/miron/files/capability', { method: 'POST', token, body: { path: 'output/haf-logo-concepts' } })).body) as { url: string }
    expect((await call(port, ca, url + 'contact-sheet-color.png')).status).toBe(200)
    await service.lock.setCode('482915')
    expect((await call(port, ca, url + 'contact-sheet-color.png')).status).toBe(404)
  })
})
