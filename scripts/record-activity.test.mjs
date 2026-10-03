import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordActivity } from './record-activity.mjs'

test('records a completed action as a durable tool receipt without needing a credential', async () => {
  const old = console.log, lines = []
  console.log = value => lines.push(value)
  try {
    assert.deepEqual(await recordActivity({ kind: 'email', title: 'Sent email: quote', key: 'email:receipt-1' }), { recorded: 'tool-receipt' })
    assert.deepEqual(JSON.parse(lines[0].slice('ACTIVITY_RECEIPT: '.length)), { kind: 'email', title: 'Sent email: quote', key: 'email:receipt-1' })
  } finally { console.log = old }
})

test('never turns unavailable recording into an outward-action retry or exposes the control token', async () => {
  const old = console.log, lines = []
  console.log = value => lines.push(value)
  try {
    assert.deepEqual(await recordActivity({ kind: 'deployment', title: 'Deployed shop', key: 'deploy:1' }, { endpoint: 'https://example.invalid/control', token: 'test-secret' }), { recorded: 'tool-receipt' })
    assert.ok(!lines.join('\n').includes('test-secret'))
  } finally { console.log = old }
})

test('rejects incomplete receipts before recording', async () => {
  await assert.rejects(recordActivity({ kind: 'email', title: 'x' }), /stable receipt key/)
})
