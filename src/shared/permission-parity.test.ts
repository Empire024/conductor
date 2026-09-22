import { describe, expect, it } from 'vitest'
import type { SessionSettings } from './structured-agent'
import { permissionParity } from './permission-parity'

const settings: SessionSettings = { permission: 'auto', plan: false }
const capabilities = (mode: string) => ({ provider: 'claude' as const, effectiveSettings: { permissionMode: mode } })
describe('visible configured/native permission parity', () => {
  it('shows the observed auto/default mismatch', () => expect(permissionParity(settings, capabilities('default'))).toContain('configured auto; native default'))
  it('does not warn for native auto', () => expect(permissionParity(settings, capabilities('auto'))).toBeUndefined())
  it('normalizes equivalent native ask names', () => expect(permissionParity({ ...settings, permission: 'default' }, capabilities('default'))).toBeUndefined())
  it('explains explicit stronger review routing instead of claiming native Auto', () => expect(permissionParity(settings, { ...capabilities('manual'), approvalRouting: 'stronger-review' })).toContain('stronger-model review'))
  it('does not invent an unreported native permission', () => expect(permissionParity(settings, { provider: 'claude' })).toBeUndefined())
})
