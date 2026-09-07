import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { get } from 'node:http'
import { LocalUpdateFeed, parseLocalBuild, type LocalBuild } from './local-update-feed'

const roots: string[] = []
const feeds: LocalUpdateFeed[] = []
const hash = (value: Buffer): string => createHash('sha512').update(value).digest('base64')
async function fixture(version = '0.1.5-local.20260907160000000', directory?: string) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'conductor-local-feed-'))
  if (!directory) roots.push(root)
  const bytes = Buffer.from('SYNTHETIC BYTES — not an executable')
  const map = Buffer.from('SYNTHETIC BLOCKMAP')
  const info: LocalBuild = { schemaVersion: 1, version, createdAt: '2026-09-07T16:00:00Z', commit: null,
    installer: 'Conductor-Setup-' + version + '.exe', blockmap: 'Conductor-Setup-' + version + '.exe.blockmap',
    sha512: hash(bytes), size: bytes.length, blockmapSha512: hash(map), blockmapSize: map.length }
  await writeFile(join(root, info.installer), bytes)
  await writeFile(join(root, info.blockmap), map)
  await writeFile(join(root, 'conductor-local-build.json'), JSON.stringify(info))
  const feed = new LocalUpdateFeed(root)
  feeds.push(feed)
  return { root, feed, info, bytes }
}
afterEach(async () => {
  feeds.splice(0).forEach(feed => feed.dispose())
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
describe('private local build feed — synthetic, no installer execution', () => {
  it('serves verified manifest, exact bytes, HEAD and bounded byte ranges on loopback', async () => {
    const f = await fixture()
    const offered = await f.feed.refresh()
    expect(offered?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/)
    const manifest = await fetch(offered!.url + 'latest.yml').then(r => r.text())
    expect(manifest).toContain('version: ' + f.info.version)
    expect(manifest).toContain(f.info.sha512)
    const bytes = await fetch(offered!.url + f.info.installer).then(r => r.arrayBuffer())
    expect(Buffer.from(bytes)).toEqual(f.bytes)
    const head = await fetch(offered!.url + f.info.installer, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe(String(f.bytes.length))
    expect(await head.text()).toBe('')
    const range = await fetch(offered!.url + f.info.installer, { headers: { Range: 'bytes=2-5' } })
    expect(range.status).toBe(206)
    expect(Buffer.from(await range.arrayBuffer())).toEqual(f.bytes.subarray(2, 6))
    expect((await fetch(offered!.url + f.info.installer, { headers: { Range: 'bytes=0-999999' } })).status).toBe(416)
  })
  it('rejects browser origins, writes, unknown names and traversal', async () => {
    const f = await fixture()
    const offered = await f.feed.refresh()
    for (const name of ['elsewhere', '%2e%2e%2fsecret', 'panel.mjs']) expect((await fetch(offered!.url + name)).status).toBe(404)
    expect((await fetch(offered!.url + 'latest.yml', { method: 'POST' })).status).toBe(403)
    expect((await fetch(offered!.url + 'latest.yml', { headers: { Origin: 'https://example.com' } })).status).toBe(403)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(offered!.url + 'latest.yml', { headers: { Host: 'example.com' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
    })
    expect(status).toBe(403)
  })
  it('rejects malformed, overlarge, nonlocal and traversing descriptors', async () => {
    const f = await fixture()
    for (const change of [{ version: '99.0.0' }, { installer: '../other.exe' }, { sha512: 'bogus' }, { size: 2 ** 40 }, { commit: 'not-a-commit' }]) {
      expect(() => parseLocalBuild({ ...f.info, ...change })).toThrow()
    }
    await writeFile(join(f.root, 'conductor-local-build.json'), ' '.repeat(17_000))
    await expect(f.feed.refresh()).rejects.toThrow('too large')
  })
  it('rejects changed bytes and redirects outside the private feed folder', async () => {
    const f = await fixture()
    await writeFile(join(f.root, f.info.installer), Buffer.alloc(f.info.size, 65))
    await expect(f.feed.refresh()).rejects.toThrow('checksum')
    const external = await fixture('0.1.6-local.20260907160000000')
    await symlink(external.root, join(f.root, 'redirected-feed'), 'junction')
    const redirected = new LocalUpdateFeed(join(f.root, 'redirected-feed'))
    feeds.push(redirected)
    await expect(redirected.refresh()).rejects.toThrow('redirected')
    await rm(join(f.root, f.info.installer))
    await expect(f.feed.refresh()).rejects.toThrow()
  })
  it('pins old version URLs, refuses overwrites, and returns null for a missing publication', async () => {
    const f = await fixture()
    const original = await f.feed.refresh()
    const second = await fixture('0.1.5-local.20260907160000001', f.root)
    const newer = await f.feed.refresh()
    expect(newer?.url).toBe(original?.url)
    expect(newer?.version).toBe(second.info.version)
    const originalBytes = await fetch(original!.url + f.info.installer).then(r => r.arrayBuffer())
    expect(Buffer.from(originalBytes)).toEqual(f.bytes)
    await writeFile(join(f.root, 'conductor-local-build.json'), JSON.stringify({ ...second.info, dirty: true }))
    await expect(f.feed.refresh()).rejects.toThrow('cannot be overwritten')
    await rm(join(f.root, 'conductor-local-build.json'))
    expect(await f.feed.refresh()).toBeNull()
  })
})
