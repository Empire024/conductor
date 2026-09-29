import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SYNTHETIC_PLACEHOLDER, boundText, createEvidenceSink, redactEvidenceText, redactHeaders } from './evidence'
import { createSyntheticFactory } from './synthetic'

const dirs: string[] = []
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'prod-evidence-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('evidence redaction', () => {
  it('masks a bearer token, credential headers and a synthetic marker', async () => {
    const factory = createSyntheticFactory()
    const email = factory.next('email')
    const dir = tempDir()
    const sink = createEvidenceSink(dir, () => factory.markers(), { now: () => new Date('2026-09-29T10:00:00.000Z') })
    const text = [
      'GET /api/orders HTTP/1.1',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload.signature',
      'Cookie: wordpress_logged_in=admin%7Csecret',
      `body: email=${encodeURIComponent(email.value)}&note=${email.marker.toUpperCase()}`,
      'api_key=sk-live-abcdefghijklmnopqrstuvwxyz',
    ].join('\n')
    const ref = await sink.writeText('requests', `requests for ${email.marker}`, text)
    const written = readFileSync(join(dir, ref.path), 'utf8')
    expect(written).not.toContain('secretpayload')
    expect(written).not.toContain('wordpress_logged_in')
    expect(written).not.toMatch(new RegExp(email.marker, 'i'))
    expect(written).toContain(SYNTHETIC_PLACEHOLDER)
    expect(written).toContain('[REDACTED]')
    expect(ref).toMatchObject({ kind: 'requests', redacted: true, capturedAt: '2026-09-29T10:00:00.000Z', path: 'evidence/0001-requests.txt' })
    expect(ref.description).not.toContain(email.marker)
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('redacts JSON by key and value and keeps it parseable', async () => {
    const factory = createSyntheticFactory()
    const marker = factory.next('marker').marker
    const dir = tempDir()
    const sink = createEvidenceSink(dir, () => factory.markers())
    const ref = await sink.writeJson('requests', 'observed', {
      requests: [{ url: `https://t.example/c?m=${marker}`, headers: { cookie: 'a=b', Authorization: 'Basic abc', accept: 'text/html' }, password: 'hunter2' }],
    })
    const parsed = JSON.parse(readFileSync(join(dir, ref.path), 'utf8'))
    expect(parsed.requests[0].url).toBe(`https://t.example/c?m=${SYNTHETIC_PLACEHOLDER}`)
    expect(parsed.requests[0].headers).toEqual({ cookie: '[REDACTED]', Authorization: '[REDACTED]', accept: 'text/html' })
    expect(parsed.requests[0].password).toBe('[REDACTED]')
    expect(ref.redacted).toBe(true)
    expect(redactHeaders({ 'Set-Cookie': 'x', Host: 'h' })).toEqual({ 'Set-Cookie': '[REDACTED]', Host: 'h' })
  })

  it('bounds text to the byte limit and indexes every ref in evidence.json', async () => {
    const dir = tempDir()
    const sink = createEvidenceSink(dir, [], { maxTextBytes: 1024 })
    const big = await sink.writeText('log', 'long log', 'é'.repeat(5000))
    const huge = await sink.writeJson('dom', 'huge', { text: 'x'.repeat(5000) })
    const binary = await sink.writeBinary('screenshot', 'shot', new Uint8Array([137, 80, 78, 71]), 'png')
    expect(Buffer.byteLength(readFileSync(join(dir, big.path), 'utf8'))).toBeLessThanOrEqual(1024)
    expect(readFileSync(join(dir, big.path), 'utf8')).toContain('[truncated: 10000 bytes')
    expect(JSON.parse(readFileSync(join(dir, huge.path), 'utf8'))).toMatchObject({ truncated: true })
    expect(binary).toMatchObject({ path: 'evidence/0003-screenshot.png', redacted: false })
    const index = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'))
    expect(index.map((ref: { id: string }) => ref.id)).toEqual([big.id, huge.id, binary.id])
    expect(sink.list()).toHaveLength(3)
    expect(boundText('short', 100)).toBe('short')
    expect(redactEvidenceText('no secrets here', ['zqshort'])).toBe('no secrets here')
  })
})
