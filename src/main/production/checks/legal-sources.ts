import type { ControlId, ProductionProfile, Provenance } from '../../../shared/production'
import { sha256 } from '../fingerprint'
import { controlDefinition, provenanceFor } from '../registry'

/**
 * The `legal-sources` step (docs/production-agent.md sections 1 and 11): reachability and a
 * content hash of the primary sources the run's controls cite, through the web reader Conductor
 * already has (`readPublicWeb`), never through the audit browser (those sites are not the audited
 * environment). No legal research and no model: a source that moved or cannot be reached is a
 * note for the report and a reason to review the registry entry, never a control status.
 */

export const MAX_LEGAL_SOURCES = 40
const TIMEOUT_MS = 20_000

export interface LegalSourceCheck {
  title: string
  url: string
  status: 'reachable' | 'unreachable' | 'skipped'
  sha256: string | null
  checkedAt: string
  detail: string
}

/** Reads a public page: status and text, or null when it could not be fetched. */
export type PublicReader = (url: string, signal: AbortSignal) => Promise<{ status: number; text: string } | null>

/** The primary-law and regulator sources the controls apply for this profile, one per URL, bounded. */
export function sourcesFor(controls: readonly ControlId[], profile: Pick<ProductionProfile, 'facts'>): Provenance[] {
  const byUrl = new Map<string, Provenance>()
  for (const controlId of controls) {
    for (const source of provenanceFor(controlDefinition(controlId), profile.facts)) {
      if (!source.url || (source.kind !== 'primary-law' && source.kind !== 'regulator-guidance')) continue
      if (!byUrl.has(source.url)) byUrl.set(source.url, source)
    }
  }
  return [...byUrl.values()].slice(0, MAX_LEGAL_SOURCES)
}

export async function checkLegalSources(sources: readonly Provenance[], read: PublicReader | null, signal: AbortSignal, now: () => Date = () => new Date()): Promise<LegalSourceCheck[]> {
  const out: LegalSourceCheck[] = []
  for (const source of sources) {
    const at = now().toISOString()
    if (!read) { out.push({ title: source.title, url: source.url!, status: 'skipped', sha256: null, checkedAt: at, detail: 'no public web reader is wired for this run' }); continue }
    if (signal.aborted) break
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout])
    try {
      const page = await read(source.url!, combined)
      if (!page || page.status >= 400) out.push({ title: source.title, url: source.url!, status: 'unreachable', sha256: null, checkedAt: at, detail: page ? `HTTP ${page.status}` : 'could not be fetched' })
      else out.push({ title: source.title, url: source.url!, status: 'reachable', sha256: sha256(page.text.replace(/\s+/g, ' ').trim()), checkedAt: at, detail: source.reviewBy ? `review by ${source.reviewBy}` : '' })
    } catch (error) {
      out.push({ title: source.title, url: source.url!, status: 'unreachable', sha256: null, checkedAt: at, detail: error instanceof Error ? error.message.slice(0, 200) : String(error) })
    }
  }
  return out
}
