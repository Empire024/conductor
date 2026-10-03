import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { PhoneActivityStore, activityReceipt, ACTIVITY_WINDOW_MS } from './phone-activity'
import { phoneInputDeliveries } from './phone-access'
import type { SessionProjection, TimelineItem } from '../shared/structured-agent'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const setup = () => {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p','Project A')")
  return { db, store: new PhoneActivityStore(db) }
}
describe('phone activity receipts', () => {
  it('requires successful completion and a server receipt, never just a send command', () => {
    const data = { type: 'tool' as const, name: 'Bash', status: 'completed' as const, input: { command: 'node send.mjs --send' }, output: 'Message-ID <mail-1@example.test>; recipients: print@example.test\nSENT: 250 OK id=receipt-1', exitCode: 0 }
    expect(activityReceipt(data)).toMatchObject({ kind: 'email', key: 'email:<mail-1@example.test>', title: 'Sent email to print@example.test' })
    expect(activityReceipt({ ...data, status: 'running' })).toBeNull()
    expect(activityReceipt({ ...data, status: 'failed', exitCode: 1 })).toBeNull()
    expect(activityReceipt({ ...data, output: 'Email will be sent' })).toBeNull()
    expect(activityReceipt({ ...data, output: 'SENT: claim without SMTP receipt' })).toBeNull()
  })
  it('accepts a bounded explicit script receipt after success', () => {
    expect(activityReceipt({ type: 'tool', name: 'Bash', status: 'completed', output: 'ACTIVITY_RECEIPT: {"kind":"email","title":"Sent email: flyer quote","key":"email:123"}' })).toMatchObject({ kind: 'email', title: 'Sent email: flyer quote', key: 'email:123' })
    expect(activityReceipt({ type: 'tool', name: 'Bash', status: 'completed', output: 'ACTIVITY_RECEIPT: {"kind":"bogus","title":"x","key":"x"}' })).toBeNull()
  })
  it('deduplicates receipts, orders by completion time and uses the small time index', () => {
    const { db, store } = setup(), now = Date.now()
    const receipt = { id: store.key('s', 'mail-1'), kind: 'email' as const, title: 'Sent email', projectId: 'p', sessionId: 's', tabTitle: 'Printing', at: new Date(now - 2000).toISOString() }
    store.record(receipt); store.record({ ...receipt, at: new Date(now - 1000).toISOString() })
    store.record({ ...receipt, id: 'new', at: new Date(now - 500).toISOString() })
    store.record({ ...receipt, id: 'old', at: new Date(now - ACTIVITY_WINDOW_MS - 1).toISOString() })
    expect(store.list(now).items.map(item => item.id)).toEqual(['new', receipt.id])
    expect(store.list(now).items[1]).toMatchObject({ at: receipt.at, projectName: 'Project A', sessionId: 's' })
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM phone_activity WHERE at>=? AND at<? ORDER BY at DESC,id DESC LIMIT 101').all('', 'z')
    expect(JSON.stringify(plan)).toContain('phone_activity_time')
  })
  it('bounds the feed even with many successful actions', () => {
    const { store } = setup(), at = new Date(Date.now() - 1).toISOString()
    for (let n = 0; n < 150; n++) store.record({ id: 'r' + n, kind: 'task', title: 'Task ' + n, projectId: 'p', sessionId: 's', tabTitle: 'Tab', at })
    expect(store.list().items).toHaveLength(100)
    expect(store.list().hasMore).toBe(true)
  })
})

it('keeps queued and accepted input distinct from authoritative delivered acknowledgement', () => {
  const prompt = { id: 'input-1', text: 'Do this next', settings: {} as never, attachments: [] }
  const items = [
    { sequence: 10, data: { type: 'queue', prompts: [prompt], prompt } },
    { sequence: 11, data: { type: 'input_delivery', inputId: prompt.id, status: 'accepted' } }
  ] as TimelineItem[]
  const state = { items, sequence: 11 } as SessionProjection
  expect(phoneInputDeliveries(state)).toEqual([{ id: prompt.id, text: prompt.text, status: 'accepted', sequence: 11 }])
  items.push({ sequence: 12, data: { type: 'input_delivery', inputId: prompt.id, status: 'delivered' } } as TimelineItem)
  expect(phoneInputDeliveries(state)[0]?.status).toBe('delivered')
})
