import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { NetworkPolicy, StorageConfig } from '../../../shared/production'
import {
  WORDPRESS_PRIVATE_KEYS, createStorageAdapter, isPublicKey, keyUrl, presignS3Url, resolveS3Location, uriEncode, type StorageEntry,
} from './storage'

const policy = (patch: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  environmentId: 'env-test', environmentKind: 'local', allowedOrigins: [], readOnly: true, writeAuthorization: null,
  maxRequests: 1000, requestsPerSecondPerOrigin: 0, allowPrivateAddresses: true, ...patch,
})

interface Seen { method: string; url: string; headers: IncomingMessage['headers'] }

/** A loopback HTTP server that records every request and answers through `handler`. */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ origin: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server: Server = createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers })
    handler(request, response)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, seen, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }) }
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

let scratch: string
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-storage-adapter-'))
  const file = (path: string, text = 'x'): void => { mkdirSync(join(scratch, ...path.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(scratch, ...path.split('/')), text) }
  file('uploads/2026/09/a.jpg', 'jpg')
  file('uploads/2026/09/b.jpg', 'jpg')
  file('uploads/private/invoices/inv-1.pdf', 'pdf')
  file('uploads/private/.htaccess', 'deny')
  file('.env', 'SECRET=1')
  file('uploads/backups/db.sql', 'sql')
  for (let index = 0; index < 30; index++) file(`uploads/bulk/f${String(index).padStart(2, '0')}.txt`)
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const localDir = (patch: Partial<StorageConfig> = {}): StorageConfig => ({ kind: 'local-dir', location: scratch, credentialRef: null, publicPrefixes: ['uploads/2026/'], publicBaseUrl: null, ...patch })

describe('local-dir inventory', () => {
  it('walks the directory breadth first, bounded, skipping dotfiles, with forward-slash keys and public classification', async () => {
    const adapter = createStorageAdapter(localDir(), { policy: policy() })
    const all = await adapter.inventory(null, 1000) as StorageEntry[]
    const keys = all.map(entry => entry.key)
    expect(keys).toContain('uploads/2026/09/a.jpg')
    expect(keys).toContain('uploads/private/invoices/inv-1.pdf')
    expect(keys).toContain('uploads/private/')
    expect(keys.some(key => key.includes('\\'))).toBe(false)
    expect(keys.some(key => key.split('/').some(segment => segment.startsWith('.')))).toBe(false)
    expect(all.find(entry => entry.key === 'uploads/2026/09/a.jpg')).toMatchObject({ public: true, bytes: 3, source: 'disk' })
    expect(all.find(entry => entry.key === 'uploads/backups/db.sql')).toMatchObject({ public: false, bytes: 3 })

    const bounded = await adapter.inventory(null, 5)
    expect(bounded).toHaveLength(5)
    // Breadth first: the shallow directories come before anything deep.
    expect(bounded.map(entry => entry.key)).toEqual(['uploads/', 'uploads/2026/', 'uploads/backups/', 'uploads/bulk/', 'uploads/private/'])

    const underPrefix = await adapter.inventory('uploads/private/', 100)
    expect(underPrefix.map(entry => entry.key)).toEqual(['uploads/private/invoices/', 'uploads/private/invoices/inv-1.pdf'])
    await expect(adapter.inventory('../', 10)).rejects.toThrow(/leaves the storage root/)
  })

  it('throws a clear error for a missing directory and for probes without publicBaseUrl', async () => {
    await expect(createStorageAdapter(localDir({ location: join(scratch, 'missing') }), { policy: policy() }).inventory(null, 10)).rejects.toThrow(/not a readable directory/)
    await expect(createStorageAdapter(localDir(), { policy: policy() }).probeAnonymous('uploads/backups/db.sql')).rejects.toThrow(/needs publicBaseUrl/)
  })

  it('classifies keys against the public prefixes and builds encoded URLs', () => {
    expect(isPublicKey('uploads/2026/09/a.jpg', ['uploads/2026/'])).toBe(true)
    expect(isPublicKey('/uploads/2026/09/a.jpg', ['uploads/2026/'])).toBe(true)
    expect(isPublicKey('uploads/private/x', ['uploads/2026/'])).toBe(false)
    expect(isPublicKey('anything', [''])).toBe(false)
    expect(keyUrl('http://h/base', 'a b/c!.pdf')).toBe('http://h/base/a%20b/c%21.pdf')
    expect(keyUrl('http://h/base/', '')).toBe('http://h/base/')
    expect(uriEncode('a/b c~', true)).toBe('a/b%20c~')
  })
})

describe('anonymous probes', () => {
  it('send no cookie or authorization, use GET only, do not follow redirects and report the status', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/files/moved.pdf') { response.writeHead(302, { location: '/files/target.pdf', 'set-cookie': 'sid=1' }); response.end(); return }
      if (request.url === '/files/secret.pdf') { response.writeHead(403); response.end('denied'); return }
      response.writeHead(200, { 'content-type': 'application/pdf' }); response.end('%PDF-1.4 body that must not be kept')
    })
    closers.push(server.close)
    const adapter = createStorageAdapter(localDir({ publicBaseUrl: `${server.origin}/files/` }), { policy: policy() })
    expect(await adapter.probeAnonymous('open.pdf')).toEqual({ status: 200, listing: false })
    expect(await adapter.probeAnonymous('secret.pdf')).toEqual({ status: 403, listing: false })
    expect(await adapter.probeAnonymous('moved.pdf')).toEqual({ status: 302, listing: false })
    expect(await adapter.probeAnonymous('moved.pdf')).toEqual({ status: 302, listing: false })
    expect(server.seen.map(request => request.url)).toEqual(['/files/open.pdf', '/files/secret.pdf', '/files/moved.pdf', '/files/moved.pdf'])
    for (const request of server.seen) {
      expect(['GET', 'HEAD']).toContain(request.method)
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBeUndefined()
    }
  })

  it('refuses a private or loopback host when the policy does not allow private addresses, before any request', async () => {
    const server = await serve((_request, response) => { response.writeHead(200); response.end() })
    closers.push(server.close)
    for (const base of [`${server.origin}/`, `http://localhost:${new URL(server.origin).port}/`, 'http://10.0.0.8/', 'http://192.168.1.5/']) {
      const adapter = createStorageAdapter(localDir({ publicBaseUrl: base }), { policy: policy({ environmentKind: 'production', allowPrivateAddresses: false }) })
      await expect(adapter.probeAnonymous('uploads/backups/db.sql')).rejects.toThrow(/private address .* refused for a production environment/)
    }
    expect(server.seen).toHaveLength(0)
  })

  it('detects a directory listing only on directory keys, and reads no body for objects', async () => {
    const index = '<html><head><title>Index of /files/backups/</title></head><body><h1>Index of /files/backups/</h1><a href="db.sql">db.sql</a></body></html>'
    const server = await serve((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(request.url === '/files/plain/' ? '<html><title>Shop</title></html>' : index)
    })
    closers.push(server.close)
    const adapter = createStorageAdapter(localDir({ publicBaseUrl: `${server.origin}/files/` }), { policy: policy() })
    expect(await adapter.probeAnonymous('backups/')).toEqual({ status: 200, listing: true })
    expect(await adapter.probeAnonymous('plain/')).toEqual({ status: 200, listing: false })
    expect(await adapter.probeAnonymous('backups/index.html')).toEqual({ status: 200, listing: false })
    expect(await adapter.probeAnonymous('')).toEqual({ status: 200, listing: true })
  })

  it('spaces requests to one host at 1000 / requestsPerSecondPerOrigin ms', async () => {
    const server = await serve((_request, response) => { response.writeHead(404); response.end() })
    closers.push(server.close)
    const adapter = createStorageAdapter(localDir({ publicBaseUrl: `${server.origin}/` }), { policy: policy({ requestsPerSecondPerOrigin: 20 }) })
    const started = Date.now()
    for (const key of ['a', 'b', 'c', 'd']) await adapter.probeAnonymous(key)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })
})

describe('wordpress-uploads', () => {
  it('lists the known private locations, a served uploads listing and the public media from the REST API', async () => {
    let origin = ''
    const server = await serve((request, response) => {
      if (request.url === '/wp-content/uploads/') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<title>Index of /wp-content/uploads</title><a href="/">Parent</a><a href="backup-2025-12/">backup-2025-12/</a><a href="2026/">2026/</a><a href="?C=N;O=D">Name</a>')
        return
      }
      if (request.url === '/wp-json/wp/v2/media?per_page=100') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify([
          { source_url: `${origin}/wp-content/uploads/2026/09/hero.jpg`, media_details: { filesize: 1234 }, modified_gmt: '2026-09-01T10:00:00' },
          { source_url: 'https://cdn.example.invalid/elsewhere.jpg' },
        ]))
        return
      }
      response.writeHead(403); response.end()
    })
    closers.push(server.close)
    origin = server.origin
    const config: StorageConfig = { kind: 'wordpress-uploads', location: server.origin, credentialRef: null, publicPrefixes: ['2026/'] }
    const adapter = createStorageAdapter(config, { policy: policy() })
    const entries = await adapter.inventory(null, 100) as StorageEntry[]
    for (const key of WORDPRESS_PRIVATE_KEYS) expect(entries.find(entry => entry.key === key)).toMatchObject({ source: 'known-private-location', public: false })
    expect(entries.find(entry => entry.key === 'backup-2025-12/')).toMatchObject({ source: 'uploads-listing', public: false })
    expect(entries.find(entry => entry.key === '2026/')).toMatchObject({ source: 'uploads-listing', public: true })
    expect(entries.find(entry => entry.key === '2026/09/hero.jpg')).toMatchObject({ source: 'rest-media', public: true, bytes: 1234, lastModified: '2026-09-01T10:00:00.000Z' })
    expect(entries.some(entry => entry.key.includes('elsewhere'))).toBe(false)
    expect(await adapter.inventory(null, 3)).toHaveLength(3)

    expect(await adapter.probeAnonymous('woocommerce_uploads/')).toEqual({ status: 403, listing: false })
    expect(await adapter.probeAnonymous('')).toEqual({ status: 200, listing: true })
    expect(server.seen.at(-2)?.url).toBe('/wp-content/uploads/woocommerce_uploads/')
  })
})

describe('s3', () => {
  it('reproduces the AWS SigV4 presigned-URL example', () => {
    const url = presignS3Url({
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
      region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'), expiresSeconds: 86400,
    })
    expect(url).toBe('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
  })

  it('parses s3://, virtual-hosted, path-style and custom endpoints', () => {
    expect(resolveS3Location('s3://shop-media/uploads/', 'eu-central-1')).toMatchObject({ bucket: 'shop-media', prefix: 'uploads/', region: 'eu-central-1', bucketUrl: 'https://shop-media.s3.eu-central-1.amazonaws.com/' })
    expect(resolveS3Location('s3://shop-media/uploads/', null).objectUrl('a b.pdf')).toBe('https://shop-media.s3.us-east-1.amazonaws.com/a%20b.pdf')
    expect(resolveS3Location('https://shop-media.s3.eu-west-1.amazonaws.com/private/', null)).toMatchObject({ bucket: 'shop-media', prefix: 'private/', region: 'eu-west-1' })
    expect(resolveS3Location('https://s3.eu-west-1.amazonaws.com/shop-media', null)).toMatchObject({ bucket: 'shop-media', prefix: '', region: 'eu-west-1', bucketUrl: 'https://s3.eu-west-1.amazonaws.com/shop-media' })
    const custom = resolveS3Location('http://127.0.0.1:9000/bucket/p/', 'auto')
    expect(custom.objectUrl('p/x.csv')).toBe('http://127.0.0.1:9000/bucket/p/x.csv')
    expect(() => resolveS3Location('ftp://nowhere', null)).toThrow(/neither s3/)
  })

  it('inventories with a signed ListObjectsV2 (paginated) and probes anonymously, including the listing probe and signed-link expiry', async () => {
    let clock = Date.parse('2026-09-29T08:00:00Z')
    const server = await serve((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fake')
      if (url.pathname === '/examplebucket' && url.searchParams.get('list-type') === '2') {
        response.writeHead(200, { 'content-type': 'application/xml' })
        if (request.headers.authorization) {
          const page2 = url.searchParams.get('continuation-token') === 'next&1'
          response.end(`<?xml version="1.0"?><ListBucketResult><Name>examplebucket</Name>${page2
            ? '<Contents><Key>uploads/private/orders.csv</Key><Size>77</Size><LastModified>2026-09-01T00:00:00.000Z</LastModified></Contents><IsTruncated>false</IsTruncated>'
            : '<Contents><Key>uploads/public/a&amp;b.jpg</Key><Size>10</Size><LastModified>2026-09-01T00:00:00.000Z</LastModified></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;1</NextContinuationToken>'}</ListBucketResult>`)
        } else {
          // Anonymous listing is open on this fake bucket.
          response.end('<?xml version="1.0"?><ListBucketResult><Name>examplebucket</Name><KeyCount>1</KeyCount></ListBucketResult>')
        }
        return
      }
      if (url.searchParams.has('X-Amz-Signature')) {
        const minted = Date.parse(url.searchParams.get('X-Amz-Date')!.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'))
        const expired = clock > minted + Number(url.searchParams.get('X-Amz-Expires')) * 1000
        response.writeHead(expired ? 403 : 200); response.end(expired ? '<Error><Code>AccessDenied</Code></Error>' : 'content')
        return
      }
      response.writeHead(403); response.end('<Error><Code>AccessDenied</Code></Error>')
    })
    closers.push(server.close)
    const config: StorageConfig = {
      kind: 's3', location: `${server.origin}/examplebucket/uploads/`, publicPrefixes: ['uploads/public/'],
      credentialRef: { id: 'cred-s3', source: 'env', key: 'S3_AUDIT', purpose: 'storage inventory' },
    }
    const adapter = createStorageAdapter(config, {
      policy: policy(), resolveCredential: ref => ref.id === 'cred-s3' ? 'AKIDEXAMPLE:secret/key:eu-central-1' : null,
      now: () => new Date(clock), sleep: async ms => { clock += ms },
    })
    const entries = await adapter.inventory(null, 100)
    expect(entries).toEqual([
      { key: 'uploads/public/a&b.jpg', bytes: 10, public: true, lastModified: '2026-09-01T00:00:00.000Z', source: 'list-objects' },
      { key: 'uploads/private/orders.csv', bytes: 77, public: false, lastModified: '2026-09-01T00:00:00.000Z', source: 'list-objects' },
    ])
    const lists = server.seen.filter(request => request.headers.authorization)
    expect(lists).toHaveLength(2)
    for (const request of lists) {
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260929\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
      expect(new URL(request.url, 'http://fake').searchParams.get('prefix')).toBe('uploads/')
    }
    expect(new URL(lists[1]!.url, 'http://fake').searchParams.get('continuation-token')).toBe('next&1')

    server.seen.length = 0
    expect(await adapter.probeAnonymous('uploads/private/orders.csv')).toEqual({ status: 403, listing: false })
    expect(await adapter.probeAnonymous('uploads/private/')).toEqual({ status: 200, listing: true })
    expect(await adapter.signedLinkExpiry!('uploads/private/orders.csv', 5)).toEqual({ beforeStatus: 200, afterStatus: 403 })
    expect(clock).toBe(Date.parse('2026-09-29T08:00:07Z'))
    expect(server.seen.map(request => new URL(request.url, 'http://fake').pathname)).toEqual([
      '/examplebucket/uploads/private/orders.csv', '/examplebucket', '/examplebucket/uploads/private/orders.csv', '/examplebucket/uploads/private/orders.csv',
    ])
    for (const request of server.seen) {
      expect(request.method).toBe('GET')
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers.cookie).toBeUndefined()
    }
  })

  it('refuses the inventory without a credential and never names the secret', async () => {
    const config: StorageConfig = { kind: 's3', location: 's3://b/p/', publicPrefixes: [], credentialRef: { id: 'c1', source: 'env', key: 'S3_KEY', purpose: 'x' } }
    await expect(createStorageAdapter(config, { policy: policy(), resolveCredential: () => null }).inventory(null, 10)).rejects.toThrow(/credential c1 \(env S3_KEY\) did not resolve/)
    const bad = createStorageAdapter(config, { policy: policy(), resolveCredential: () => 'onlyonepart' })
    await expect(bad.inventory(null, 10)).rejects.toThrow(/ACCESS_KEY_ID:SECRET\[:REGION\]$/)
  })
})

describe('custom-command', () => {
  it('runs the injected command, maps objects and probes each object URL', async () => {
    const server = await serve((request, response) => { response.writeHead(request.url === '/media/exports/customers.csv' ? 200 : 404); response.end() })
    closers.push(server.close)
    const commands: string[] = []
    const config: StorageConfig = { kind: 'custom-command', location: 'node scripts/list-storage.mjs', credentialRef: null, publicPrefixes: ['public/'] }
    const adapter = createStorageAdapter(config, {
      policy: policy(),
      runCommand: async command => {
        commands.push(command)
        return JSON.stringify({ objects: [
          { key: 'public/logo.png', bytes: 5, public: true, lastModified: null, url: `${server.origin}/media/public/logo.png` },
          { key: 'exports/customers.csv', bytes: 9, public: false, lastModified: '2026-09-01T00:00:00Z', url: `${server.origin}/media/exports/customers.csv` },
          { bytes: 1 },
        ] })
      },
    })
    const entries = await adapter.inventory(null, 10)
    expect(commands).toEqual(['node scripts/list-storage.mjs'])
    expect(entries).toEqual([
      { key: 'public/logo.png', bytes: 5, public: true, lastModified: null, source: 'command' },
      { key: 'exports/customers.csv', bytes: 9, public: false, lastModified: '2026-09-01T00:00:00Z', source: 'command' },
    ])
    expect(await adapter.probeAnonymous('exports/customers.csv')).toEqual({ status: 200, listing: false })
    expect(await adapter.probeAnonymous('exports/')).toEqual({ status: 404, listing: false })
    expect(server.seen.map(request => request.url)).toEqual(['/media/exports/customers.csv', '/media/exports/'])
  })

  it('throws a clear error without a runner, or when the output is not the expected JSON', async () => {
    const config: StorageConfig = { kind: 'custom-command', location: 'list', credentialRef: null, publicPrefixes: [] }
    await expect(createStorageAdapter(config, { policy: policy() }).inventory(null, 10)).rejects.toThrow(/needs a command runner/)
    await expect(createStorageAdapter(config, { policy: policy(), runCommand: async () => 'not json' }).inventory(null, 10)).rejects.toThrow(/did not print JSON/)
    await expect(createStorageAdapter(config, { policy: policy(), runCommand: async () => '{"items":[]}' }).inventory(null, 10)).rejects.toThrow(/must print \{"objects"/)
    await expect(createStorageAdapter(config, { policy: policy(), runCommand: async () => '{"objects":[]}' }).probeAnonymous('x')).rejects.toThrow(/no URL is known/)
  })

  it('an unknown kind throws a clear error', async () => {
    const adapter = createStorageAdapter({ kind: 'ftp' as StorageConfig['kind'], location: 'x', credentialRef: null, publicPrefixes: [] }, { policy: policy() })
    await expect(adapter.inventory(null, 1)).rejects.toThrow(/storage kind ftp is not supported/)
  })
})
