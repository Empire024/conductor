import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EnvironmentKind, MutationKind, NetworkPolicy } from '../../../shared/production'
import { createCustomCommandAdapter } from './custom-command'

const SCRIPT = `
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  if (request.action === 'orders') console.log(JSON.stringify([{ id: 1, total: '23.40', currency: 'EUR', lines: [{ label: 'Vase', amount: '19.90' }], fees: [{ label: 'Courier', amount: '3.50' }], status: 'completed' }]))
  else if (request.action === 'subscriptions') console.log(JSON.stringify([{ id: 's1', status: 'active', nextPaymentAt: '2026-11-01', amount: '9.90', interval: '1 month', cancelledAt: null }]))
  else if (request.action === 'cancelSubscription') console.log(JSON.stringify({ id: request.id, status: 'cancelled', nextPaymentAt: null, amount: '9.90', interval: '1 month', cancelledAt: '2026-09-29' }))
  else if (request.action === 'requestRefund') console.log(JSON.stringify({ accepted: true, detail: 'recorded ' + request.orderId }))
  else if (request.action === 'records' && request.subject === 'echo') console.log(JSON.stringify([{ store: process.env.CONDUCTOR_PRODUCTION_ACTION, kind: process.env.CONDUCTOR_PRODUCTION_CREDENTIAL || 'none', id: process.argv.slice(2).join(' ') || 'no-args', retainedBecause: null }]))
  else if (request.action === 'records') console.log(JSON.stringify([{ store: 'db', kind: 'order', id: 'o1', retainedBecause: 'tax' }]))
  else process.exit(3)
})
`

let scratch: string
let command: string
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'prod-cmd-'))
  writeFileSync(join(scratch, 'shop.cjs'), SCRIPT)
  writeFileSync(join(scratch, 'slow.cjs'), 'setTimeout(() => {}, 10000)')
  command = `"${process.execPath}" "${join(scratch, 'shop.cjs')}"`
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const policy = (mutations: MutationKind[], kind: EnvironmentKind = 'sandbox'): NetworkPolicy => ({
  environmentId: 'env', environmentKind: kind, allowedOrigins: [], readOnly: kind === 'production' || mutations.length === 0, maxRequests: 10, requestsPerSecondPerOrigin: 0, allowPrivateAddresses: false,
  writeAuthorization: mutations.length ? { id: 'a', environmentId: 'env', mutations, grantedBy: { kind: 'owner', agentSessionId: null }, grantedAt: '2026-09-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', note: '' } : null,
})
const account = { id: 'acct', label: 'Test', role: 'subscriber' as const, usernameRef: { id: 'u', source: 'env' as const, key: 'U', purpose: '' }, passwordRef: { id: 'p', source: 'env' as const, key: 'P', purpose: '' } }

describe('custom-command adapter', () => {
  it('sends one JSON request on stdin and maps the printed JSON', async () => {
    const adapter = createCustomCommandAdapter({ command, policy: policy([]) })
    expect(await adapter.orders(null)).toEqual([{ id: '1', total: '23.40', currency: 'EUR', lines: [{ label: 'Vase', amount: '19.90' }], fees: [{ label: 'Courier', amount: '3.50' }], status: 'completed' }])
    expect(await adapter.subscriptions(account)).toEqual([{ id: 's1', status: 'active', nextPaymentAt: '2026-11-01', amount: '9.90', interval: '1 month', cancelledAt: null }])
    expect(await adapter.records('subject@example.com')).toEqual([{ store: 'db', kind: 'order', id: 'o1', retainedBecause: 'tax' }])
  })

  it('passes the action and the resolved credential in the environment, never on the command line', async () => {
    const adapter = createCustomCommandAdapter({ command, policy: policy([]), credentialRef: { id: 'c', source: 'env', key: 'SHOP_TOKEN', purpose: 'shop' }, resolveCredential: ref => ref.key === 'SHOP_TOKEN' ? 's3cret' : null })
    expect(await adapter.records('echo')).toEqual([{ store: 'records', kind: 's3cret', id: 'no-args', retainedBecause: null }])
  })

  it('checks the write authorization before starting the command for a mutation', async () => {
    const marker = join(scratch, 'ran.txt')
    const tattler = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], 'ran')" "${marker}"`
    const readOnly = createCustomCommandAdapter({ command: tattler, policy: policy([]) })
    await expect(readOnly.cancelSubscription('s1')).rejects.toThrow(/sandbox write authorization required for subscription-cancel/)
    await expect(readOnly.requestRefund('1', 'r')).rejects.toThrow(/sandbox write authorization required for refund-request/)
    const production = createCustomCommandAdapter({ command: tattler, policy: policy(['subscription-cancel', 'refund-request'], 'production') })
    await expect(production.cancelSubscription('s1')).rejects.toThrow(/production and read-only/)
    const cancelOnly = createCustomCommandAdapter({ command: tattler, policy: policy(['subscription-cancel']) })
    await expect(cancelOnly.requestRefund('1', 'r')).rejects.toThrow(/authorized: subscription-cancel/)
    expect(await import('node:fs').then(fs => fs.existsSync(marker))).toBe(false)

    expect(await createCustomCommandAdapter({ command, policy: policy(['subscription-cancel']) }).cancelSubscription('s1')).toMatchObject({ id: 's1', status: 'cancelled', nextPaymentAt: null })
    expect(await createCustomCommandAdapter({ command, policy: policy(['refund-request']) }).requestRefund('7', 'r')).toEqual({ accepted: true, detail: 'recorded 7' })
  })

  it('reports a non-zero exit with stderr, output that is not JSON, and a timeout', async () => {
    const bad = createCustomCommandAdapter({ command: `"${process.execPath}" -e "process.stderr.write('boom'); process.exit(2)"`, policy: policy([]) })
    await expect(bad.orders(null)).rejects.toThrow(/exited with 2: boom/)
    const text = createCustomCommandAdapter({ command: `"${process.execPath}" -e "console.log('hello')"`, policy: policy([]) })
    await expect(text.orders(null)).rejects.toThrow(/did not print JSON/)
    const slow = createCustomCommandAdapter({ command: `"${process.execPath}" "${join(scratch, 'slow.cjs')}"`, policy: policy([]), timeoutMs: 300 })
    await expect(slow.orders(null)).rejects.toThrow(/timed out after 300 ms/)
  })
})
