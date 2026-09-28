import { createHash } from 'node:crypto'
import { CHANGE_CLASSES, type ChangeClass, type ControlId, type TargetFingerprint } from '../../shared/production'

/**
 * What exactly an audit tested (docs/production-agent.md section 6). The fingerprint names the
 * deployed commit and build plus content hashes over the environment's configuration files, the
 * fetched policy pages, the dependency lock files and the route list, and the profile and registry
 * versions the run used. Two runs with different fingerprints never share results, and a staging
 * fingerprint never satisfies a production environment.
 */

export interface FingerprintFile {
  /** Project-relative path (or a URL for policy pages); part of the hash, so a rename is a change. */
  path: string
  content: string
}

export interface FingerprintInputs {
  environmentId: string
  commit: string | null
  build: string | null
  /** The files `stack.infrastructureFiles` lists (server config, .htaccess, wp-config without secrets, CI). */
  configFiles: FingerprintFile[]
  /** Fetched privacy, terms and refund pages; whitespace is normalised before hashing. */
  policyPages: FingerprintFile[]
  /** Lock files and plugin/theme version manifests. */
  dependencyFiles: FingerprintFile[]
  /** The sitemap or route list; order does not matter. */
  routes: string[]
  profileVersion: number
  registryVersion: number
  now?: () => Date
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Collapses runs of whitespace (including non-breaking spaces) so a reflowed page is not a change. */
export const normalisePolicyText = (text: string): string => text.replace(/[\s ​]+/g, ' ').trim()

/** Order-independent: files are sorted by path, and each path is hashed with its content, so a
 *  moved file or an added empty file is still a change. Line endings are normalised to LF, because
 *  a checkout on Windows and the deployed copy on Linux are the same artefact. */
export function hashFiles(files: readonly FingerprintFile[], normalise: (content: string) => string = content => content.replace(/\r\n?/g, '\n')): string {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const hash = createHash('sha256')
  for (const file of sorted) {
    const content = normalise(file.content)
    hash.update(`${file.path.length}:${file.path}\n${content.length}:${content}\n`)
  }
  return hash.digest('hex')
}

export function hashRoutes(routes: readonly string[]): string {
  const unique = [...new Set(routes.map(route => route.trim()).filter(Boolean))].sort()
  return sha256(unique.join('\n'))
}

export function computeFingerprint(inputs: FingerprintInputs): TargetFingerprint {
  if (!inputs.environmentId) throw new Error('A fingerprint names the environment it was computed for')
  return {
    environmentId: inputs.environmentId,
    commit: inputs.commit?.trim() || null,
    build: inputs.build?.trim() || null,
    configHash: hashFiles(inputs.configFiles),
    policyHash: hashFiles(inputs.policyPages, normalisePolicyText),
    dependencyHash: hashFiles(inputs.dependencyFiles),
    routesHash: hashRoutes(inputs.routes),
    profileVersion: inputs.profileVersion,
    registryVersion: inputs.registryVersion,
    computedAt: (inputs.now ?? (() => new Date()))().toISOString()
  }
}

/** Which component of the fingerprint maps to which change class. */
const COMPONENT_CLASSES: ReadonlyArray<[keyof TargetFingerprint, ChangeClass]> = [
  ['commit', 'code'],
  ['build', 'deployment'],
  ['configHash', 'configuration'],
  ['policyHash', 'policy'],
  ['dependencyHash', 'dependency'],
  ['routesHash', 'content'],
  ['profileVersion', 'profile'],
  ['registryVersion', 'registry']
]

/**
 * The change classes between two fingerprints, in CHANGE_CLASSES order; empty when nothing that
 * matters moved (computedAt never counts). Fingerprints of different environments are never
 * comparable: every class is returned, so nothing carries across (a staging pass is not a
 * production pass). A missing `before` (never audited) is also every class.
 */
export function classifyChange(before: TargetFingerprint | null, after: TargetFingerprint): ChangeClass[] {
  if (!before || before.environmentId !== after.environmentId) return [...CHANGE_CLASSES]
  const changed = new Set<ChangeClass>()
  for (const [key, change] of COMPONENT_CLASSES) if (before[key] !== after[key]) changed.add(change)
  return CHANGE_CLASSES.filter(change => changed.has(change))
}

export const sameTarget = (a: TargetFingerprint | null, b: TargetFingerprint | null): boolean =>
  Boolean(a && b) && classifyChange(a, b!).length === 0

/**
 * The stable finding id: the same defect at the same place keeps its id across runs (and across
 * fingerprints), so history, tasks and waivers follow it. Fields are length-prefixed so no two
 * different tuples can hash alike by shifting a separator.
 */
export function findingId(parts: { projectId: string; environmentId: string; controlId: ControlId; checkId: string; key: string; route: string | null }): string {
  const fields = [parts.projectId, parts.environmentId, parts.controlId, parts.checkId, parts.key, parts.route ?? '']
  return `pf_${sha256(fields.map(field => `${field.length}:${field}`).join('|')).slice(0, 32)}`
}
