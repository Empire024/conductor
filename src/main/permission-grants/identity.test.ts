import { describe, expect, it } from 'vitest'
import { grantCallIdentity, grantWorkKey, sameNativeCall, sameToolAttempt } from './identity'

describe('native permission identity', () => {
  it('hashes all arguments independent of object key order and binds the request reply to one tool use', () => {
    const base = { runtimeId: 'runtime-1', nativeSessionId: 'session-1', toolUseId: 'tool-1', tool: 'Bash', requestId: 'request-1' }
    const first = grantCallIdentity({ ...base, input: { command: 'echo one', timeout: 20 } })
    const reordered = grantCallIdentity({ ...base, input: { timeout: 20, command: 'echo one' } })
    const changed = grantCallIdentity({ ...base, input: { command: 'echo two', timeout: 20 } })
    expect(sameNativeCall(first, reordered)).toBe(true)
    expect(sameNativeCall(first, changed)).toBe(false)
    expect(sameNativeCall(first, { ...first, requestId: 'request-2' })).toBe(false)
    expect(sameToolAttempt(first, { ...first, requestId: undefined })).toBe(true)
    expect(grantWorkKey(first, 'once')).not.toBe(grantWorkKey(first, 'session'))
    expect(grantWorkKey(first, 'once')).not.toBe(grantWorkKey(changed, 'once'))
  })
})
