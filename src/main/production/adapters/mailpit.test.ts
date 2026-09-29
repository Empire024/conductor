import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMailpitFake } from '../fixtures/mailpit-fake'
import { createCapturedMailAdapter } from './mailpit'

let scratch: string
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'prod-mail-')) })
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('captured mail adapter', () => {
  it('reads Mailpit messages with headers, oldest first, and honours since', async () => {
    const fake = await createMailpitFake()
    try {
      const first = fake.deliver({ from: 'Shop <news@shop.test>', to: ['a@x.test'], subject: 'One', text: 'first', headers: { 'List-Unsubscribe': '<https://x.test/u>' } })
      fake.deliver({ from: 'orders@shop.test', to: ['b@x.test', 'c@x.test'], subject: 'Two', text: 'second', html: '<p>second</p>' })
      const adapter = createCapturedMailAdapter({ kind: 'mailpit', location: `${fake.origin}/` })
      const all = await adapter.list(null)
      expect(all.map(message => message.subject)).toEqual(['One', 'Two'])
      expect(all[0]).toMatchObject({ from: 'Shop <news@shop.test>', to: ['a@x.test'], text: 'first', html: null })
      expect(all[0]!.headers['list-unsubscribe']).toBe('<https://x.test/u>')
      expect(all[1]).toMatchObject({ from: 'orders@shop.test', to: ['b@x.test', 'c@x.test'], html: '<p>second</p>' })
      const later = await adapter.list(new Date(Date.parse(first.created) + 1).toISOString())
      expect(later.map(message => message.subject)).toEqual(['Two'])
    } finally { await fake.close() }
  })

  it('reads a maildir (new and cur) with dates from the Date header or the file time', async () => {
    const dir = join(scratch, 'maildir')
    mkdirSync(join(dir, 'new'), { recursive: true })
    mkdirSync(join(dir, 'cur'), { recursive: true })
    writeFileSync(join(dir, 'cur', '1.eml'), 'From: Shop <news@shop.test>\nTo: a@x.test\nSubject: Old\nDate: Mon, 01 Sep 2026 10:00:00 +0000\n\nold body\n')
    const fresh = join(dir, 'new', '2.eml')
    writeFileSync(fresh, 'From: orders@shop.test\nTo: b@x.test, c@x.test\nSubject: New\nContent-Type: text/html\n\n<p>Order <b>#5</b></p>\n')
    utimesSync(fresh, new Date('2026-09-20T10:00:00Z'), new Date('2026-09-20T10:00:00Z'))
    const adapter = createCapturedMailAdapter({ kind: 'maildir', location: dir })
    const all = await adapter.list(null)
    expect(all.map(message => `${message.subject}@${message.receivedAt}`)).toEqual(['Old@2026-09-01T10:00:00.000Z', 'New@2026-09-20T10:00:00.000Z'])
    expect(all[1]).toMatchObject({ to: ['b@x.test', 'c@x.test'], html: '<p>Order <b>#5</b></p>\n' })
    expect(all[1]!.text).toMatch(/Order\s+#5/)
    expect((await adapter.list('2026-09-10T00:00:00Z')).map(message => message.subject)).toEqual(['New'])
  })

  it('refuses a location that is not http(s)', () => {
    expect(() => createCapturedMailAdapter({ kind: 'mailpit', location: 'ftp://mail.test' })).toThrow(/must be http/)
  })
})
