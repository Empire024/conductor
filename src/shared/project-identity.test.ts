import { describe, expect, it } from 'vitest'
import {
  checkRemoteProjectPlacement,
  formatStoredProjectIdentity,
  parseStoredProjectIdentity,
  samePath,
  sameWorkingCopy,
  type ProjectIdentity,
  type RemoteProjectGrant
} from './project-identity'

const LOCAL: ProjectIdentity = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: 'C:/laptop/conductor', name: 'Conductor' }
const REMOTE: ProjectIdentity = { key: 'b'.repeat(32), keyCreatedAt: '2026-02-02T00:00:00.000Z', path: 'D:/renders/conductor', name: 'Conductor' }
const GRANT: RemoteProjectGrant = { localProjectId: 'project-a', local: LOCAL, remoteProjectId: 'remote-a', remote: REMOTE, confirmedAt: '2026-02-03T00:00:00.000Z' }

const check = (advertised: ProjectIdentity | null, local: ProjectIdentity | null = LOCAL, grant: RemoteProjectGrant | null = GRANT) =>
  checkRemoteProjectPlacement({ grant, advertised, local, machineName: 'Render Desktop' })

describe('reading a project identity file', () => {
  it('round-trips what it writes', () => {
    expect(parseStoredProjectIdentity(formatStoredProjectIdentity({ key: LOCAL.key, createdAt: LOCAL.keyCreatedAt }), 'project.json'))
      .toEqual({ key: LOCAL.key, createdAt: LOCAL.keyCreatedAt })
  })

  it('normalises the recorded time so two spellings of one moment still compare equal', () => {
    expect(parseStoredProjectIdentity(JSON.stringify({ key: LOCAL.key, createdAt: '2026-01-01T01:00:00.000+01:00' }), 'project.json').createdAt)
      .toBe('2026-01-01T00:00:00.000Z')
  })

  it('refuses a corrupt file instead of minting a replacement identity', () => {
    for (const raw of ['', 'not json', '[]', '{}', JSON.stringify({ key: 'too-short', createdAt: LOCAL.keyCreatedAt }),
      JSON.stringify({ key: LOCAL.key }), JSON.stringify({ key: LOCAL.key, createdAt: 'whenever' })]) {
      expect(() => parseStoredProjectIdentity(raw, 'C:/p/.conductor/project.json')).toThrow(/C:\/p\/\.conductor\/project\.json/)
    }
    expect(() => parseStoredProjectIdentity('{}', 'project.json')).toThrow(/will not replace it/)
  })
})

describe('comparing paths and working copies', () => {
  it('treats separators and case as the same folder, and anything else as a move', () => {
    expect(samePath('D:/renders/conductor', 'D:\\Renders\\Conductor')).toBe(true)
    expect(samePath('D:/renders/conductor/', 'D:/renders/conductor')).toBe(true)
    expect(samePath('D:/renders/conductor', 'D:/renders/conductor-2')).toBe(false)
  })

  it('needs the key and the moment it was minted to agree', () => {
    expect(sameWorkingCopy(REMOTE, { ...REMOTE, path: 'E:/elsewhere' })).toBe(true)
    expect(sameWorkingCopy(REMOTE, { ...REMOTE, key: 'c'.repeat(32) })).toBe(false)
    expect(sameWorkingCopy(REMOTE, { ...REMOTE, keyCreatedAt: '2026-02-02T00:00:01.000Z' })).toBe(false)
  })
})

/**
 * The rule the whole feature rests on. Two checkouts legitimately have different keys, so what is
 * checked is not "same key on both machines" but "still exactly what the owner confirmed".
 */
describe('placing work on a project the owner mapped to another machine', () => {
  it('allows the mapped project when that machine still advertises the confirmed identity', () => {
    expect(check(REMOTE)).toEqual({ ok: true, grant: GRANT })
  })

  it('allows it even though the two machines report different keys, which is the normal case', () => {
    expect(GRANT.local.key).not.toBe(GRANT.remote.key)
    expect(check(REMOTE).ok).toBe(true)
  })

  it('refuses a project that was never mapped, rather than guessing by name', () => {
    expect(check(REMOTE, LOCAL, null)).toMatchObject({ ok: false, reason: 'not-mapped' })
  })

  it('refuses when that machine no longer advertises the mapped project', () => {
    expect(check(null)).toMatchObject({ ok: false, reason: 'not-advertised' })
    expect(check(undefined as unknown as null)).toMatchObject({ ok: false, reason: 'not-advertised' })
  })

  it('refuses a different key: that machine is sharing a different project now', () => {
    const placement = check({ ...REMOTE, key: 'c'.repeat(32) })
    expect(placement).toMatchObject({ ok: false, reason: 'different-project' })
    expect(placement.ok === false && placement.message).toContain('now sharing a different project')
  })

  it('refuses the confirmed key with a different creation time, which is a copy of the project', () => {
    const placement = check({ ...REMOTE, keyCreatedAt: '2026-06-06T00:00:00.000Z' })
    expect(placement).toMatchObject({ ok: false, reason: 'identity-recreated' })
    expect(placement.ok === false && placement.message).toContain('copied or regenerated identity')
  })

  it('refuses a moved folder and hands back both paths so the owner can re-confirm', () => {
    const placement = check({ ...REMOTE, path: 'E:/renders/conductor' })
    expect(placement).toEqual({
      ok: false,
      reason: 'project-moved',
      message: expect.stringContaining('moved from D:/renders/conductor to E:/renders/conductor'),
      recordedPath: 'D:/renders/conductor',
      currentPath: 'E:/renders/conductor'
    })
  })

  it('checks the key before the path, so a swapped folder is never reported as a move', () => {
    expect(check({ ...REMOTE, key: 'c'.repeat(32), path: 'E:/renders/conductor' })).toMatchObject({ reason: 'different-project' })
  })

  it('refuses when this side is no longer the working copy that was mapped', () => {
    expect(check(REMOTE, { ...LOCAL, key: 'd'.repeat(32) })).toMatchObject({ ok: false, reason: 'local-changed' })
    expect(check(REMOTE, { ...LOCAL, keyCreatedAt: '2026-09-09T00:00:00.000Z' })).toMatchObject({ ok: false, reason: 'local-changed' })
    // A caller that has not read the local identity still gets the remote rules.
    expect(check(REMOTE, null).ok).toBe(true)
  })

  it('names the machine in every refusal so the owner knows which one to look at', () => {
    for (const advertised of [null, { ...REMOTE, key: 'c'.repeat(32) }, { ...REMOTE, keyCreatedAt: '2026-06-06T00:00:00.000Z' }, { ...REMOTE, path: 'E:/x' }]) {
      const placement = check(advertised)
      expect(placement.ok === false && placement.message).toContain('Render Desktop')
    }
  })
})
