import type { CheckContext, ControlCheck, FindingDraft, StorageObject } from '../../../shared/production'
import { isDirectoryKey, isPublicKey } from '../adapters/storage'
import { FindingSet, applicabilityGuard, draft, emptyCoverage, notRun, outcome, throwIfAborted } from './technical-support'

/**
 * C16 Storage exposure (docs/production-agent.md module M4): does the store behind the site hand
 * private objects to a stranger?
 *
 * - Inventory through the storage adapter (bounded). A key under one of the owner's declared public
 *   prefixes is public; every other key is private.
 * - Private objects are probed anonymously, grouped by the first two path segments below the public
 *   area's parent (so `uploads/backups/` and `uploads/woocommerce_uploads/` are separate groups),
 *   round-robin across groups with the riskiest names first. A 2xx is a confirmed exposure of the
 *   group; personal data and backups make it critical.
 * - Private directories (and the root) are asked for a listing; a served listing is a finding.
 * - One public object is the negative control: it should be readable. When it is not, the probes
 *   may not reach the store the way a visitor does, which is recorded, never a finding.
 * - A store with signed links mints one with a short TTL and probes it after expiry; a link that
 *   still works is a finding. A store without signed links says so in coverage, never as a pass.
 *
 * Only statuses are recorded, never object contents. Write access (`storage-probe-write`) is out of
 * scope and declared unobservable. An adapter error is a reason the check could not conclude.
 */

export interface StorageCheckOptions {
  maxObjects?: number
  /** Bound on the private-object probes, and separately on the listing probes. */
  maxProbes?: number
  signedLinkTtlSeconds?: number
}

const CHECK_ID = 'storage'

/** Weighted name patterns: backups and dumps first, then personal data, then archive/export formats, then logs. */
const RISK: ReadonlyArray<readonly [RegExp, number]> = [
  [/\.(sql|bak|dump)(\.(gz|zip|bz2))?$|backup|dump|updraft|ai1wm|wp-migrate-db/i, 8],
  [/invoice|order|customer|user|account|export|personal|gdpr|passport|payment|woocommerce_uploads|wpforms|gravity_forms|(^|\/)edd\//i, 6],
  [/\.(csv|xlsx?|zip|tar|tgz|gz|7z|rar|pdf|json)$/i, 3],
  [/log/i, 2],
]
/** Names that make an exposure critical: personal data or a backup of the site. */
const SENSITIVE = /invoice|order|customer|user|account|export|personal|gdpr|passport|payment|backup|dump|updraft|ai1wm|wp-migrate-db|woocommerce_uploads|wpforms|gravity_forms|\.(sql|bak|csv|xlsx?|zip|tar|tgz|gz|7z)$/i

export const riskOf = (key: string): number => RISK.reduce((sum, [pattern, weight]) => sum + (pattern.test(key) ? weight : 0), 0)

/** Common leading segments of the public prefixes' parents: `wp-content/uploads/2026/` gives `wp-content/uploads`. */
export function publicRoot(publicPrefixes: readonly string[]): string[] {
  const parents = publicPrefixes.map(prefix => prefix.replace(/^\/+/, '').split('/').filter(Boolean).slice(0, -1))
  if (!parents.length) return []
  const first = parents[0]!
  let shared = 0
  while (shared < first.length && parents.every(parent => parent[shared] === first[shared])) shared++
  return first.slice(0, shared)
}

/** The directory prefix a key is grouped under: two segments below the public root when the key lies under it, else the first two. `''` is the root. */
export function groupOf(key: string, root: readonly string[]): string {
  const directories = key.replace(/^\/+/, '').split('/').slice(0, -1)
  const shared = root.length > 0 && root.every((segment, index) => directories[index] === segment) ? root.length : 0
  const kept = directories.slice(0, shared + 2)
  return kept.length ? `${kept.join('/')}/` : ''
}

const label = (prefix: string): string => prefix ? prefix.replace(/\/+$/, '') : '/'
const isSuccess = (status: number | null): boolean => status !== null && status >= 200 && status < 300
const byRisk = (a: string, b: string): number => riskOf(b) - riskOf(a) || (a < b ? -1 : a > b ? 1 : 0)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500)

interface ProbeRecord {
  key: string
  purpose: 'private' | 'listing' | 'negative-control'
  group: string | null
  status: number | null
  listing: boolean
  error: string | null
}

export function createStorageCheck(options: StorageCheckOptions = {}): ControlCheck {
  const maxObjects = options.maxObjects ?? 500
  const maxProbes = options.maxProbes ?? 24
  const ttl = options.signedLinkTtlSeconds ?? 5
  return {
    controlId: 'C16',
    checkId: CHECK_ID,
    title: 'Private storage, listings and signed links are not readable anonymously',
    requires: ['storage-config'],
    async run(context: CheckContext) {
      const guard = applicabilityGuard(context, CHECK_ID)
      if (guard) return guard
      const config = context.environment.storage
      if (!config) {
        return notRun(CHECK_ID, 'UNVERIFIED', `no storage is declared for environment ${context.environment.label}: declare environment.storage (kind s3, wordpress-uploads, local-dir or custom-command, its location, the intentionally public prefixes, and a credential for s3) so C16 can inventory and probe it`)
      }
      const adapter = context.adapters.storage
      if (!adapter) {
        return notRun(CHECK_ID, 'UNVERIFIED', `storage ${config.kind} at ${config.location} is declared but no storage adapter could be built for it: check the kind, location, publicBaseUrl and credential of environment ${context.environment.label}`)
      }

      const findings = new FindingSet()
      const unconcluded: string[] = []
      const observations: string[] = []
      const coverage = emptyCoverage()
      const probes: ProbeRecord[] = []
      coverage.unobservable.push('write access not probed: an anonymous upload or overwrite (mutation storage-probe-write) is out of scope for C16')

      const probe = async (key: string, purpose: ProbeRecord['purpose'], group: string | null): Promise<ProbeRecord> => {
        throwIfAborted(context)
        let record: ProbeRecord
        try {
          const result = await adapter.probeAnonymous(key)
          record = { key, purpose, group, status: result.status, listing: result.listing === true, error: null }
        } catch (error) {
          record = { key, purpose, group, status: null, listing: false, error: message(error) }
        }
        probes.push(record)
        return record
      }

      let objects: StorageObject[] = []
      try { objects = (await adapter.inventory(null, maxObjects)).slice(0, maxObjects) } catch (error) { unconcluded.push(`storage inventory failed: ${message(error)}`) }
      throwIfAborted(context)
      const classified = objects.map(object => ({ object, public: isPublicKey(object.key, config.publicPrefixes) }))
      const root = publicRoot(config.publicPrefixes)
      const privateFiles = classified.filter(entry => !entry.public && !isDirectoryKey(entry.object.key)).map(entry => entry.object.key)
      const publicFiles = classified.filter(entry => entry.public && !isDirectoryKey(entry.object.key)).map(entry => entry.object.key)
      let signedLink: { key: string; ttlSeconds: number; beforeStatus: number | null; afterStatus: number | null } | null = null
      let privatePlan: string[] = []

      if (!unconcluded.length && !objects.length) unconcluded.push(`the ${config.kind} inventory at ${config.location} returned no objects, so nothing could be classified or probed`)
      if (!unconcluded.length) {
        if (objects.length >= maxObjects) coverage.unobservable.push(`inventory bounded at ${maxObjects} objects: keys beyond it were not classified or probed`)
        observations.push(`inventory: ${objects.length} object(s), ${classified.filter(entry => entry.public).length} under the public prefixes (${config.publicPrefixes.join(', ') || 'none declared'}), ${classified.filter(entry => !entry.public).length} private`)

        // Private objects: round-robin over groups (riskiest group first), riskiest names first within a group.
        const groups = new Map<string, string[]>()
        for (const key of privateFiles) { const group = groupOf(key, root); groups.set(group, [...(groups.get(group) ?? []), key]) }
        for (const keys of groups.values()) keys.sort(byRisk)
        const order = [...groups.keys()].sort((a, b) => Math.max(...groups.get(b)!.map(riskOf)) - Math.max(...groups.get(a)!.map(riskOf)) || (a < b ? -1 : a > b ? 1 : 0))
        for (let round = 0; privatePlan.length < maxProbes; round++) {
          const before = privatePlan.length
          for (const group of order) { const key = groups.get(group)![round]; if (key !== undefined && privatePlan.length < maxProbes) privatePlan.push(key) }
          if (privatePlan.length === before) break
        }
        for (const key of privatePlan) await probe(key, 'private', groupOf(key, root))
        if (privatePlan.length < privateFiles.length) coverage.unobservable.push(`probed ${privatePlan.length} of ${privateFiles.length} private objects (bounded at ${maxProbes}, grouped by prefix, riskiest names first)`)

        // Listings: the root, every private directory in the inventory, and every group prefix.
        const directories = new Set<string>([''])
        for (const entry of classified) if (!entry.public && isDirectoryKey(entry.object.key)) directories.add(entry.object.key.replace(/^\/+/, ''))
        for (const group of groups.keys()) directories.add(group)
        const listingPlan = [...directories].filter(key => !isPublicKey(key, config.publicPrefixes)).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : byRisk(a, b)))
        for (const key of listingPlan.slice(0, maxProbes)) await probe(key, 'listing', key)
        if (listingPlan.length > maxProbes) coverage.unobservable.push(`listing probed for ${maxProbes} of ${listingPlan.length} private directories`)

        // Negative control: a public object should answer an anonymous GET.
        const control = publicFiles[0]
        if (control === undefined) observations.push('negative control not run: the inventory has no object under the public prefixes')
        else {
          const result = await probe(control, 'negative-control', null)
          if (isSuccess(result.status)) observations.push(`negative control: public ${control} answered HTTP ${result.status} anonymously, so the probes reach the store as a visitor does`)
          else observations.push(`negative control: public ${control} was not readable (${result.error ?? `HTTP ${result.status}`}); the private probes may not reach the store as a visitor does, check publicBaseUrl`)
        }

        // Signed links.
        const signedTarget = privatePlan[0] ?? privateFiles[0]
        if (typeof adapter.signedLinkExpiry !== 'function') coverage.unobservable.push(`signed-link expiry not tested: the ${config.kind} storage adapter has no signed links`)
        else if (signedTarget === undefined) coverage.unobservable.push('signed-link expiry not tested: the inventory has no private object to sign')
        else {
          throwIfAborted(context)
          try {
            const result = await adapter.signedLinkExpiry(signedTarget, ttl)
            if (!result) coverage.unobservable.push(`signed-link expiry not tested: the store minted no signed link for ${signedTarget}`)
            else {
              signedLink = { key: signedTarget, ttlSeconds: ttl, ...result }
              if (!isSuccess(result.beforeStatus)) {
                observations.push(`signed link for ${signedTarget} answered HTTP ${result.beforeStatus ?? 'none'} before expiry`)
                if (!isSuccess(result.afterStatus)) coverage.unobservable.push(`signed-link expiry not shown: the fresh signed link for ${signedTarget} was already refused (HTTP ${result.beforeStatus ?? 'none'})`)
              } else if (!isSuccess(result.afterStatus)) observations.push(`signed link for ${signedTarget}: HTTP ${result.beforeStatus} before expiry, HTTP ${result.afterStatus} ${ttl + 2} s after it was minted with a ${ttl} s TTL`)
            }
          } catch (error) {
            unconcluded.push(`signed-link expiry test failed: ${message(error)}`)
          }
        }

        const failed = probes.filter(record => record.error && record.purpose !== 'negative-control')
        if (failed.length) unconcluded.push(`${failed.length} anonymous probe(s) failed, so their exposure is unknown (first: ${failed[0]!.key || '/'}: ${failed[0]!.error})`)
      }

      const evidence: string[] = []
      try {
        const ref = await context.evidence.writeJson('storage', `C16 storage inventory and anonymous probe statuses (${config.kind})`, {
          kind: config.kind,
          location: config.location,
          publicPrefixes: config.publicPrefixes,
          inventoryCount: objects.length,
          bounded: objects.length >= maxObjects,
          objects: classified.map(({ object, public: isPublic }) => ({
            key: object.key, bytes: object.bytes, lastModified: object.lastModified, public: isPublic,
            adapterPublic: object.public, source: (object as { source?: string }).source ?? null,
          })),
          probes,
          signedLink,
        })
        evidence.push(ref.id)
      } catch (error) {
        unconcluded.push(`storage evidence could not be written: ${message(error)}`)
      }

      for (const draftFinding of exposureFindings(context, probes, evidence)) findings.add(draftFinding)
      if (signedLink && isSuccess(signedLink.afterStatus)) {
        findings.add(draft(context, CHECK_ID, {
          key: 'signed-link-no-expiry', scope: 'config', component: signedLink.key, severity: 'high', confidence: 'confirmed', evidence,
          title: 'A signed storage link still works after it expired',
          expected: `A signed link minted with a ${signedLink.ttlSeconds} s lifetime is refused once that lifetime has passed.`,
          observed: `A signed GET link for ${signedLink.key} answered HTTP ${signedLink.beforeStatus ?? 'none'} when minted and HTTP ${signedLink.afterStatus} ${signedLink.ttlSeconds + 2} s later, after its ${signedLink.ttlSeconds} s lifetime.`,
          reproduction: [`Mint a signed GET link for ${signedLink.key} with a ${signedLink.ttlSeconds} s expiry`, `Request it anonymously ${signedLink.ttlSeconds + 2} s later: HTTP ${signedLink.afterStatus}`],
          proposedFix: 'Make the store enforce the link lifetime (a presigned URL whose signature and expiry are checked, no public-read fallback on the object), keep lifetimes short, and rotate links already handed out.',
        }))
      }

      return outcome(CHECK_ID, { findings: findings.list(), unconcluded, evidence, humanReview: [], coverage, observations })
    },
  }
}

function exposureFindings(context: CheckContext, probes: readonly ProbeRecord[], evidence: string[]): FindingDraft[] {
  const out: FindingDraft[] = []
  const exposed = new Map<string, ProbeRecord[]>()
  for (const record of probes) if (record.purpose === 'private' && isSuccess(record.status)) exposed.set(record.group ?? '', [...(exposed.get(record.group ?? '') ?? []), record])
  for (const [group, records] of exposed) {
    const probed = probes.filter(record => record.purpose === 'private' && record.group === group).length
    const sensitive = records.some(record => SENSITIVE.test(record.key))
    out.push(draft(context, CHECK_ID, {
      key: `private-exposed:${label(group)}`, scope: 'config', component: label(group), severity: sensitive ? 'critical' : 'high', confidence: 'confirmed', evidence,
      title: `Private storage under ${label(group)} is readable without logging in`,
      expected: 'Objects outside the declared public prefixes answer an anonymous request with 401, 403 or 404.',
      observed: `${records.length} of ${probed} probed private object(s) under ${label(group)} answered 2xx to an anonymous GET: ${records.slice(0, 5).map(record => `${record.key} (HTTP ${record.status})`).join(', ')}${records.length > 5 ? ', ...' : ''}.`,
      reproduction: records.slice(0, 3).map(record => `GET ${record.key} with no cookie and no Authorization header: HTTP ${record.status}`),
      proposedFix: sensitive
        ? 'Deny anonymous reads outside the public prefixes (a web-server deny rule or bucket policy/Block Public Access), move backups and personal data out of the web root, and treat what was reachable as disclosed: rotate credentials in backups and assess notification duties.'
        : 'Deny anonymous reads outside the public prefixes (a web-server deny rule or bucket policy/Block Public Access), or declare the prefix public if it is meant to be.',
    }))
  }
  for (const record of probes) {
    if (record.purpose !== 'listing' || !record.listing) continue
    out.push(draft(context, CHECK_ID, {
      key: `listing:${label(record.key)}`, scope: 'config', component: label(record.key), severity: 'high', confidence: 'confirmed', evidence,
      title: `Storage directory ${label(record.key)} lists its contents to anyone`,
      expected: 'A private directory or bucket prefix does not list its objects to an anonymous visitor.',
      observed: `An anonymous GET of ${label(record.key)} answered HTTP ${record.status} with a directory or bucket listing.`,
      reproduction: [`GET ${record.key || '/'} with no cookie and no Authorization header: HTTP ${record.status}, listing`],
      proposedFix: 'Turn off directory listing (Options -Indexes, autoindex off, an index file), or remove anonymous s3:ListBucket from the bucket policy.',
    }))
  }
  return out
}

export const storageCheck = createStorageCheck()
