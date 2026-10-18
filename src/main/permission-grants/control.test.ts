import { describe, expect, it, vi } from 'vitest'
import { callPermissions } from './control'
import type { PermissionGrants } from './service'

// conductor-task:cross-project-cleanup-guardrails
describe('permissions.revoke and permissions.withdraw across projects', () => {
  const grants = () => ({ revoke: vi.fn(async () => true), withdrawRequest: vi.fn(() => ({ withdrawn: true })) })
  const answers = (id: string): boolean => id === 'coworker'

  it('lets a wizard name the conversations it answers for, and no other project\'s', async () => {
    const service = grants()
    const wizard = { agentSessionId: 'wizard', wizard: true, answers }
    await expect(callPermissions(service as unknown as PermissionGrants, wizard, 'permissions.revoke', { grantId: 'g1', agentSessionId: 'other-project-tab' })).rejects.toThrow(/its own project, or the owner/)
    await expect(callPermissions(service as unknown as PermissionGrants, wizard, 'permissions.withdraw', { requestId: 'r1', reason: 'stale', agentSessionId: 'other-project-tab' })).rejects.toThrow(/its own project, or the owner/)
    expect(service.revoke).not.toHaveBeenCalled()
    expect(service.withdrawRequest).not.toHaveBeenCalled()
    await expect(callPermissions(service as unknown as PermissionGrants, wizard, 'permissions.revoke', { grantId: 'g1', agentSessionId: 'coworker' })).resolves.toEqual({ revoked: true })
    await expect(callPermissions(service as unknown as PermissionGrants, wizard, 'permissions.revoke', { grantId: 'g2' })).resolves.toEqual({ revoked: true })
    expect(service.revoke).toHaveBeenCalledWith('coworker', 'g1')
  })

  it('lets the owner credential name any conversation', async () => {
    const service = grants()
    await expect(callPermissions(service as unknown as PermissionGrants, { agentSessionId: 'owner', owner: true, answers }, 'permissions.revoke', { grantId: 'g1', agentSessionId: 'other-project-tab' })).resolves.toEqual({ revoked: true })
    expect(service.revoke).toHaveBeenCalledWith('other-project-tab', 'g1')
  })
})
