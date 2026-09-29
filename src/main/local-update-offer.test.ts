import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localUpdateGate, readLocalUpdateOffer, writeLocalUpdateOffer } from './local-update-offer'
const offer = { version: '1.0.0-local.1', builder: 'agent-builder', verified: true, offered: true }
describe('local update invitation', () => {
  it('requires both verification and an explicit owner offer', () => {
    expect(localUpdateGate(null, 0).promptAllowed).toBe(false)
    expect(localUpdateGate({ ...offer, verified: false }, 0).promptAllowed).toBe(false)
    expect(localUpdateGate({ ...offer, offered: false }, 0).promptAllowed).toBe(false)
    expect(localUpdateGate(offer, 0)).toEqual({ promptAllowed: true })
  })
  it('stays quiet for work, surfaces at idle, and closes again if work starts', () => {
    expect(localUpdateGate(offer, 3)).toMatchObject({ promptAllowed: false, quietReason: expect.stringContaining('3 tabs are working') })
    expect(localUpdateGate(offer, 0).promptAllowed).toBe(true)
    expect(localUpdateGate(offer, 1).promptAllowed).toBe(false)
  })
  it('persists intent for exactly one version, without blessing a later build', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-offer-'))
    try {
      writeLocalUpdateOffer(root, offer)
      expect(readLocalUpdateOffer(root, offer.version)).toEqual(offer)
      expect(readLocalUpdateOffer(root, '1.0.0-local.2')).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
