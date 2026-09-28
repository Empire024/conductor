import { describe, expect, it } from 'vitest'
import type { SessionSettings } from './structured-agent'
import { permissionParity } from './permission-parity'

const settings: SessionSettings = { permission: 'auto', plan: false }
const capabilities = (mode: string) => ({ provider: 'claude' as const, effectiveSettings: { permissionMode: mode } })
describe('visible configured/native permission parity', () => {
  it('shows the observed auto/default mismatch', () => expect(permissionParity(settings, capabilities('default'))).toContain('configured auto; native default'))
  it('identifies classifier-backed native auto as guarded', () => expect(permissionParity(settings, capabilities('auto'))).toContain('Guarded Auto'))
  it('normalizes equivalent native ask names', () => expect(permissionParity({ ...settings, permission: 'default' }, capabilities('default'))).toBeUndefined())
  it('identifies Guarded Auto with stronger review routing too', () => expect(permissionParity(settings, { ...capabilities('auto'), approvalRouting: 'stronger-review' })).toContain('Guarded Auto'))
  it('still reports a reviewed worker whose native mode is not the configured one', () => expect(permissionParity(settings, { ...capabilities('manual'), approvalRouting: 'stronger-review' })).toContain('configured auto; native manual'))
  it('does not invent an unreported native permission', () => expect(permissionParity(settings, { provider: 'claude' })).toBeUndefined())
  it('only reports Full Auto active after runtime confirmation', () => {
    const effective = { claudeFullAutoAuthorized: true, requestedPermissionMode: 'bypassPermissions', permissionMode: 'bypassPermissions' }
    expect(permissionParity(settings, { provider: 'claude', effectiveSettings: effective })).not.toContain('Full Auto active')
    expect(permissionParity(settings, { provider: 'claude', effectiveSettings: { ...effective, permissionModeStatus: 'confirmed' } })).toContain('Full Auto active')
    expect(permissionParity(settings, { provider: 'claude', effectiveSettings: { ...effective, permissionModeStatus: 'blocked', permissionModeError: 'Managed policy refuses bypass' } })).toContain('Managed policy refuses bypass')
  })
  it('shows both the requested and confirmed modes during a deferred restart', () => {
    expect(permissionParity(settings, { provider: 'claude', effectiveSettings: { requestedPermissionMode: 'bypassPermissions', permissionMode: 'auto', permissionModeStatus: 'restart-pending' } })).toContain('requested bypassPermissions; confirmed auto')
  })
})
