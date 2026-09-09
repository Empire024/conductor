import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  formatStoredProjectIdentity,
  parseStoredProjectIdentity,
  PROJECT_IDENTITY_PATH,
  ProjectIdentityError,
  type ProjectIdentity,
  type StoredProjectIdentity
} from '../shared/project-identity'
import type { RemoteProjectSummary } from '../shared/remote-control'

/**
 * The disk half of project identity. The key belongs to the working copy, so it lives in a file
 * inside the project folder rather than in this machine's database: open the same folder from
 * anywhere and it reports the same key, and a second checkout of the same repository mints its own.
 */

/** An identity never changes once it exists, so a successful read is worth keeping for the session. */
const cache = new Map<string, StoredProjectIdentity>()

const identityFile = (projectPath: string): string => join(resolve(projectPath), ...PROJECT_IDENTITY_PATH.split('/'))

/** Short 8.3 names and junctions would otherwise read as a moved folder on the next comparison. */
const canonicalPath = (value: string): string => {
  try { return realpathSync.native(value) } catch { return resolve(value) }
}

function readIdentityFile(file: string): StoredProjectIdentity | null {
  let raw: string
  try { raw = readFileSync(file, 'utf8') }
  catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ProjectIdentityError(`Conductor could not read ${file}: ${reason instanceof Error ? reason.message : String(reason)}`)
  }
  return parseStoredProjectIdentity(raw, file)
}

/**
 * Writes the identity only if the folder does not have one yet. The content is complete before the
 * file has its final name, so a reader never sees half an identity, and the hard link refuses to
 * replace an existing one, so a race cannot overwrite a key that another copy of the app just wrote.
 */
function createIdentityFile(target: string, content: string): void {
  const temporary = join(dirname(target), '.project-identity-' + randomUUID() + '.tmp')
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx')
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try { linkSync(temporary, target) }
    catch (reason) {
      // Filesystems without hard links still must not clobber, so the rename is guarded.
      if ((reason as NodeJS.ErrnoException).code !== 'EEXIST' && !existsSync(target)) renameSync(temporary, target)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/**
 * The identity must not travel through git: a clone is a different working copy and has to mint
 * its own key, or two checkouts would claim to be the same one. Only the identity file is ignored,
 * so nothing else the owner keeps under .conductor is affected.
 */
function ignoreIdentityFile(directory: string): void {
  const ignore = join(directory, '.gitignore')
  try {
    const current = readFileSync(ignore, 'utf8')
    if (!current.split(/\r?\n/).some(line => line.trim() === '/project.json' || line.trim() === 'project.json' || line.trim() === '*')) {
      appendFileSync(ignore, (current.endsWith('\n') || !current ? '' : '\n') + '/project.json\n')
    }
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') return
    try { writeFileSync(ignore, '/project.json\n', { flag: 'wx' }) } catch { /* another window won the race */ }
  }
}

/** Reads the project's identity, creating it the first time. An existing key is never replaced. */
export function readProjectIdentity(projectPath: string): StoredProjectIdentity {
  const file = identityFile(projectPath)
  const cached = cache.get(file)
  if (cached) return cached
  const existing = readIdentityFile(file)
  if (existing) { cache.set(file, existing); return existing }
  // A missing project folder is reported, never rebuilt: recreating it here would put an identity
  // — and the folder itself — back for a project the owner deleted or a drive that is not mounted.
  let folder: Stats
  try { folder = statSync(resolve(projectPath)) }
  catch (reason) { throw new ProjectIdentityError(`Conductor cannot reach the project folder ${projectPath}: ${reason instanceof Error ? reason.message : String(reason)}`) }
  if (!folder.isDirectory()) throw new ProjectIdentityError(`${projectPath} is not a folder, so it cannot hold a project identity.`)
  mkdirSync(dirname(file), { recursive: true })
  ignoreIdentityFile(dirname(file))
  createIdentityFile(file, formatStoredProjectIdentity({ key: randomBytes(16).toString('hex'), createdAt: new Date().toISOString() }))
  // Another writer may have won the link; whatever is on disk now is this copy's identity.
  const settled = readIdentityFile(file)
  if (!settled) throw new ProjectIdentityError(`Conductor could not create ${PROJECT_IDENTITY_PATH} in ${projectPath}.`)
  cache.set(file, settled)
  return settled
}

export function projectIdentity(project: { name: string; path: string }): ProjectIdentity {
  const stored = readProjectIdentity(project.path)
  return { key: stored.key, keyCreatedAt: stored.createdAt, path: canonicalPath(project.path), name: project.name }
}

/**
 * What a machine advertises about one project it shares. A project whose identity cannot be read
 * is still listed, carrying the reason, so the owner sees why it cannot be paired instead of the
 * project quietly disappearing or quietly getting a new key.
 */
export function projectSummary(project: { id: string; name: string; path: string }): RemoteProjectSummary {
  try {
    const identity = projectIdentity(project)
    return { id: project.id, name: project.name, path: identity.path, identity, identityError: null }
  } catch (reason) {
    return {
      id: project.id,
      name: project.name,
      path: canonicalPath(project.path),
      identity: null,
      identityError: reason instanceof Error ? reason.message : String(reason)
    }
  }
}

/** Tests and a removed project drop the memo; the file on disk stays authoritative. */
export function forgetProjectIdentity(projectPath?: string): void {
  if (projectPath === undefined) cache.clear()
  else cache.delete(identityFile(projectPath))
}
