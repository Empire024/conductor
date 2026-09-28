import { createHash } from 'node:crypto'
import type { GrantCallIdentity } from '../../shared/permission-grants'

/** JSON object key order is transport-dependent; hash the complete arguments in canonical order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

export interface NativeGrantCall {
  runtimeId: string
  nativeSessionId: string
  toolUseId: string
  tool: string
  input: unknown
  requestId?: string
}

export function grantCallIdentity(call: NativeGrantCall): GrantCallIdentity {
  for (const field of ['runtimeId', 'nativeSessionId', 'toolUseId', 'tool'] as const)
    if (!call[field]) throw new Error(`Native permission call has no ${field}`)
  return {
    runtimeId: call.runtimeId, nativeSessionId: call.nativeSessionId,
    toolUseId: call.toolUseId, tool: call.tool,
    argsDigest: createHash('sha256').update(canonical(call.input)).digest('hex'),
    ...(call.requestId ? { requestId: call.requestId } : {})
  }
}

/** Same work within one native session, even if the provider assigns a new tool-use id on retry. */
export function grantWorkKey(call: GrantCallIdentity, scope: 'once' | 'session'): string {
  return [call.runtimeId, call.nativeSessionId, call.tool, call.argsDigest, scope].join('\n')
}

/** A native reply must name the very request the owner saw, including its current tool-use id. */
export function sameNativeCall(a: GrantCallIdentity, b: GrantCallIdentity): boolean {
  return sameToolAttempt(a, b) && a.requestId === b.requestId
}

export function sameToolAttempt(a: GrantCallIdentity, b: GrantCallIdentity): boolean {
  return a.runtimeId === b.runtimeId && a.nativeSessionId === b.nativeSessionId &&
    a.toolUseId === b.toolUseId && a.tool === b.tool && a.argsDigest === b.argsDigest
}
