import { spawn } from 'node:child_process'
import type {
  CommerceOrder, CommerceSandboxAdapter, CommerceSubscription, CredentialRef, DataRecordsAdapter, MutationKind, NetworkPolicy, TestAccountRef,
} from '../../../shared/production'
import type { DataRecord } from '../checks/commerce-support'
import { REFUND_MUTATION } from '../checks/commerce-support'
import { assertMutationAllowed } from '../netpolicy'

/**
 * Commerce sandbox and data-records adapter over a project's own command (docs/production-agent.md
 * M6, `CommerceSandboxConfig.kind = 'custom-command'`). The command line runs through the shell in
 * the project directory with one JSON request on stdin, `{"action": "...", ...}`, and prints one
 * JSON value on stdout:
 *
 * - `{"action":"orders","since":<iso|null>}` → `CommerceOrder[]`
 * - `{"action":"subscriptions","account":{"id","label","role"}}` → `CommerceSubscription[]`
 * - `{"action":"cancelSubscription","id"}` → `CommerceSubscription`
 * - `{"action":"requestRefund","orderId","reason"}` → `{"accepted":boolean,"detail":string}`
 * - `{"action":"records","subject"}` → `[{"store","kind","id","retainedBecause"}]`, the records the
 *   system still holds for a data subject (for tracing a deletion request)
 *
 * The action is also in `CONDUCTOR_PRODUCTION_ACTION`, and the resolved credential (if any) in
 * `CONDUCTOR_PRODUCTION_CREDENTIAL`; the credential never appears on the command line. The two
 * mutations check the network policy's write authorization before the command is started.
 */

export const COMMAND_TIMEOUT_MS = 30_000
export const MAX_COMMAND_OUTPUT = 1024 * 1024

export interface CustomCommandOptions {
  command: string
  cwd?: string
  policy: NetworkPolicy
  credentialRef?: CredentialRef | null
  resolveCredential?: (ref: CredentialRef) => string | null
  timeoutMs?: number
  signal?: AbortSignal
}

export type CustomCommandAdapter = CommerceSandboxAdapter & DataRecordsAdapter

export class CommandFailed extends Error {
  constructor(message: string) { super(message); this.name = 'CommandFailed' }
}

export function createCustomCommandAdapter(options: CustomCommandOptions): CustomCommandAdapter {
  const call = async (action: string, args: Record<string, unknown>): Promise<unknown> => {
    const credential = options.credentialRef ? options.resolveCredential?.(options.credentialRef) ?? null : null
    const output = await runCommand(options.command, JSON.stringify({ action, ...args }), {
      cwd: options.cwd, timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS, signal: options.signal,
      env: { CONDUCTOR_PRODUCTION_ACTION: action, ...(credential ? { CONDUCTOR_PRODUCTION_CREDENTIAL: credential } : {}) },
    })
    try { return JSON.parse(output) } catch { throw new CommandFailed(`${action}: the command did not print JSON (${output.slice(0, 200)})`) }
  }
  const guard = (mutation: MutationKind): void => { assertMutationAllowed(options.policy, mutation) }
  return {
    async orders(since) { return list(await call('orders', { since }), 'orders').map(order) },
    async subscriptions(account: TestAccountRef) {
      return list(await call('subscriptions', { account: { id: account.id, label: account.label, role: account.role } }), 'subscriptions').map(subscription)
    },
    async cancelSubscription(id) {
      guard('subscription-cancel')
      return subscription(await call('cancelSubscription', { id }))
    },
    async requestRefund(orderId, reason) {
      guard(REFUND_MUTATION)
      const value = object(await call('requestRefund', { orderId, reason }), 'requestRefund')
      return { accepted: value.accepted === true, detail: String(value.detail ?? '').slice(0, 2000) }
    },
    async records(subject) { return list(await call('records', { subject }), 'records').map(record) },
  }
}

/** Runs a command line with stdin, bounded in time and output; rejects on a non-zero exit with the tail of stderr. */
export function runCommand(command: string, stdin: string, options: { cwd?: string; timeoutMs: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: options.cwd, shell: true, windowsHide: true, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    let settled = false
    const finish = (error: Error | null, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error); else resolve(value ?? '')
    }
    const kill = (): void => { try { child.kill() } catch { /* already gone */ } }
    const onAbort = (): void => { kill(); finish(new CommandFailed('cancelled')) }
    const timer = setTimeout(() => { kill(); finish(new CommandFailed(`timed out after ${options.timeoutMs} ms`)) }, options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_COMMAND_OUTPUT) { kill(); finish(new CommandFailed(`printed more than ${MAX_COMMAND_OUTPUT} bytes`)); return }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString('utf8')).slice(-2000) })
    child.on('error', error => finish(new CommandFailed(error.message)))
    child.on('close', code => {
      if (code === 0) finish(null, Buffer.concat(out).toString('utf8'))
      else finish(new CommandFailed(`exited with ${code}${err.trim() ? `: ${err.trim().slice(-500)}` : ''}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(stdin)
  })
}

function list(value: unknown, action: string): unknown[] {
  if (!Array.isArray(value)) throw new CommandFailed(`${action}: expected a JSON array`)
  return value.slice(0, 1000)
}

function object(value: unknown, action: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommandFailed(`${action}: expected a JSON object`)
  return value as Record<string, unknown>
}

const text = (value: unknown): string => value === null || value === undefined ? '' : String(value)
const nullable = (value: unknown): string | null => value === null || value === undefined || value === '' ? null : String(value)
const amounts = (value: unknown): Array<{ label: string; amount: string }> => Array.isArray(value)
  ? value.slice(0, 200).map(item => ({ label: text((item as Record<string, unknown>)?.label), amount: text((item as Record<string, unknown>)?.amount) }))
  : []

function order(value: unknown): CommerceOrder {
  const item = object(value, 'orders')
  return { id: text(item.id), total: text(item.total), currency: text(item.currency), lines: amounts(item.lines), fees: amounts(item.fees), status: text(item.status) }
}

function subscription(value: unknown): CommerceSubscription {
  const item = object(value, 'subscription')
  return { id: text(item.id), status: text(item.status), nextPaymentAt: nullable(item.nextPaymentAt), amount: text(item.amount), interval: text(item.interval), cancelledAt: nullable(item.cancelledAt) }
}

function record(value: unknown): DataRecord {
  const item = object(value, 'records')
  return { store: text(item.store), kind: text(item.kind), id: text(item.id), retainedBecause: nullable(item.retainedBecause) }
}
