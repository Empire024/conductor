import { describe, expect, it } from 'vitest'
import { cleanupVerdict, foreignClaim, ownerApprovalMessage } from './cleanup-guard'

// conductor-task:cross-project-cleanup-guardrails
const miron = { projectId: 'p-miron', projectName: 'miron' }
const haf = { projectId: 'p-haf', projectName: 'haf-stuff' }
const request = { label: 'Qwen 3.5 9B (pid 35800)', action: 'stop', call: 'local.stop({pid:35800})' }
const owned = { owner: miron }
const guarded = { owner: miron, protection: { ...miron, reason: 'miron standing instructions: keep it up' } }

describe('cross-project cleanup guard', () => {
  it('lets the owning project act on its own target, and anyone act on an unclaimed one', () => {
    expect(cleanupVerdict(owned, { projectId: miron.projectId, owner: false }, request)).toEqual({ allowed: true, by: 'same-project' })
    expect(cleanupVerdict({}, { projectId: haf.projectId, owner: false }, request)).toEqual({ allowed: true, by: 'unclaimed' })
  })

  it('refuses another project, naming the owner or protector and how to ask it', () => {
    const owner = cleanupVerdict(owned, { projectId: haf.projectId, owner: false }, request)
    expect(owner).toMatchObject({ allowed: false, kind: 'other-project', project: miron })
    if (owner.allowed) return
    expect(owner.message).toContain('belongs to project miron (p-miron)')
    expect(owner.message).toContain('send_message({projectId:"p-miron", text})')
    expect(owner.message).toContain('local.stop({pid:35800}) with ownerApproval:true')
    expect(owner.message).toContain('A wizard tab of another project is not the owner')
    const protectedVerdict = cleanupVerdict(guarded, { projectId: haf.projectId, owner: false }, request)
    expect(protectedVerdict).toMatchObject({ allowed: false, kind: 'other-project' })
    if (!protectedVerdict.allowed) expect(protectedVerdict.message).toContain('is protected by project miron (p-miron): miron standing instructions: keep it up')
    // Force is not a way past another project's claim.
    expect(cleanupVerdict(guarded, { projectId: haf.projectId, owner: false }, { ...request, force: true, reason: 'release my GPUs' }).allowed).toBe(false)
  })

  it('lets the owner credential through, and the owner\'s approval of the exact call', () => {
    expect(cleanupVerdict(guarded, { projectId: haf.projectId, owner: true }, request)).toEqual({ allowed: true, by: 'owner', overrodeProtection: true })
    expect(cleanupVerdict(owned, { projectId: haf.projectId, owner: false, approved: true }, request)).toEqual({ allowed: true, by: 'approval' })
    expect(cleanupVerdict(guarded, { projectId: haf.projectId, owner: false, approved: true }, request)).toEqual({ allowed: true, by: 'approval', overrodeProtection: true })
  })

  it('makes the owning project pass force:true and a reason to stop what it protected itself', () => {
    const self = { projectId: miron.projectId, owner: false }
    expect(cleanupVerdict(guarded, self, request)).toMatchObject({ allowed: false, kind: 'protected-self', message: expect.stringContaining('force:true with a reason') })
    expect(cleanupVerdict(guarded, self, { ...request, force: true }).allowed).toBe(false)
    expect(cleanupVerdict(guarded, self, { ...request, reason: 'switching models' }).allowed).toBe(false)
    expect(cleanupVerdict(guarded, self, { ...request, force: true, reason: 'switching models' })).toEqual({ allowed: true, by: 'same-project', overrodeProtection: true })
  })

  it('reads a protection by another project over an owner of the caller\'s own, and names everything in the dialog', () => {
    const claims = { owner: haf, protection: { ...miron, reason: 'eval running' } }
    expect(foreignClaim(claims, haf.projectId)).toEqual({ project: claims.protection, reason: 'eval running' })
    expect(foreignClaim(claims, miron.projectId)).toEqual({ project: haf })
    expect(ownerApprovalMessage(guarded, { ...request, reason: 'release my GPUs' }, 'haf wizard')).toBe('haf wizard wants to stop Qwen 3.5 9B (pid 35800), which belongs to another project. Started by project miron (p-miron). Protected by project miron (p-miron): miron standing instructions: keep it up. Reason given: release my GPUs')
  })
})
