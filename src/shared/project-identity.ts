/**
 * Project identity, and the rule that decides whether a project on another machine is still the
 * one its owner confirmed.
 *
 * A machine's own database ids are private to that machine, so they can never be compared across
 * a pairing. Identity here belongs to the working copy instead: a key minted once inside the
 * project folder, the moment it was minted, and where the folder currently sits. Two machines
 * holding two checkouts of the same repository legitimately report different keys; what makes
 * placing work on one of them safe is that the owner confirmed, once, that this project here
 * corresponds to that project there — and that nothing about that project has changed since.
 */

/** Where a working copy records who it is, relative to the project folder. */
export const PROJECT_IDENTITY_PATH = '.conductor/project.json'

/** The whole contents of that file. Nothing machine-specific is in it, so it travels with the copy. */
export interface StoredProjectIdentity {
  key: string
  createdAt: string
}

/** A project as one machine currently sees it. */
export interface ProjectIdentity {
  key: string
  /** When the key was minted. A key that reappears with a different time is a different copy. */
  keyCreatedAt: string
  path: string
  name: string
}

/** A corrupt identity is surfaced rather than replaced; minting a new key would lose the project. */
export class ProjectIdentityError extends Error {}

export const isProjectKey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

export function parseStoredProjectIdentity(raw: string, where: string): StoredProjectIdentity {
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown }
  catch { throw new ProjectIdentityError(`${where} is not readable JSON. Conductor will not replace it, because that would give this working copy a new identity. Restore or delete the file.`) }
  const value = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Partial<StoredProjectIdentity>
  if (!isProjectKey(value.key)) throw new ProjectIdentityError(`${where} does not contain a usable project key. Conductor will not replace it; restore or delete the file.`)
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new ProjectIdentityError(`${where} does not record when its key was created. Conductor will not replace it; restore or delete the file.`)
  }
  return { key: value.key, createdAt: new Date(value.createdAt).toISOString() }
}

export const formatStoredProjectIdentity = (identity: StoredProjectIdentity): string =>
  JSON.stringify({ key: identity.key, createdAt: identity.createdAt }, null, 2) + '\n'

/**
 * Windows reports the same folder with either separator and with either case, and a rename that
 * only changes case is not a move. Anything else counts as a move the owner has to see.
 */
export const normalizeProjectPath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const samePath = (left: string, right: string): boolean => normalizeProjectPath(left) === normalizeProjectPath(right)

/** The same working copy, wherever it sits: both the key and the moment it was minted must match. */
export const sameWorkingCopy = (left: ProjectIdentity, right: ProjectIdentity): boolean =>
  left.key === right.key && left.keyCreatedAt === right.keyCreatedAt

/**
 * One owner-confirmed correspondence between a project on this machine and a project on a paired
 * machine. The remote side is recorded as a whole identity, not just an id, so a later answer from
 * that machine can be compared against what the owner actually approved.
 */
export interface RemoteProjectGrant {
  localProjectId: string
  local: ProjectIdentity
  /** The paired machine's own id for the project; what its calls have to name. */
  remoteProjectId: string
  remote: ProjectIdentity
  confirmedAt: string
}

export type ProjectPlacementRefusal =
  | 'not-mapped'
  | 'not-advertised'
  | 'different-project'
  | 'identity-recreated'
  | 'project-moved'
  | 'local-changed'

export type ProjectPlacement =
  | { ok: true; grant: RemoteProjectGrant | null }
  | { ok: false; reason: ProjectPlacementRefusal; message: string; recordedPath?: string; currentPath?: string }

/**
 * The whole rule, in one place. Every branch refuses; work is placed on another machine only when
 * the project it advertises today is byte-for-byte the identity the owner confirmed. A refusal
 * carries which rule refused so the owner can be shown what to do about it rather than a dead end.
 */
export function checkRemoteProjectPlacement(input: {
  grant: RemoteProjectGrant | null | undefined
  /** What the paired machine says about that project now; null when it has not said. */
  advertised: ProjectIdentity | null | undefined
  /** This machine's own project, when the caller has read it. */
  local?: ProjectIdentity | null
  machineName?: string
}): ProjectPlacement {
  const machine = input.machineName ? `“${input.machineName}”` : 'That machine'
  const { grant, advertised } = input
  if (!grant) {
    return { ok: false, reason: 'not-mapped', message: `${machine} has not been told which of its projects this one is. Confirm the pair of projects in Account & machines before placing work there.` }
  }
  if (!advertised) {
    return { ok: false, reason: 'not-advertised', message: `${machine} is not sharing the project this one was mapped to any more.` }
  }
  if (advertised.key !== grant.remote.key) {
    return { ok: false, reason: 'different-project', message: `${machine} is now sharing a different project under that mapping, so work was not placed there. Confirm the pair of projects again.` }
  }
  if (advertised.keyCreatedAt !== grant.remote.keyCreatedAt) {
    return {
      ok: false,
      reason: 'identity-recreated',
      message: `The project on ${machine} carries the confirmed key but says it was created at ${advertised.keyCreatedAt} instead of ${grant.remote.keyCreatedAt}. That is a copied or regenerated identity, not the project you confirmed.`
    }
  }
  if (!samePath(advertised.path, grant.remote.path)) {
    return {
      ok: false,
      reason: 'project-moved',
      message: `The project on ${machine} moved from ${grant.remote.path} to ${advertised.path}. Confirm the new location before work goes there.`,
      recordedPath: grant.remote.path,
      currentPath: advertised.path
    }
  }
  if (input.local && !sameWorkingCopy(input.local, grant.local)) {
    return { ok: false, reason: 'local-changed', message: `This project folder no longer holds the working copy that was mapped to ${machine}. Confirm the pair of projects again.` }
  }
  return { ok: true, grant }
}
