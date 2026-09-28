import type { DecisionKind } from '../../shared/model-routing'
import type { DecisionService, ThresholdSettings } from './decision-service'
import type { ModelIntelligenceStore } from './store'

/**
 * Which decision boundaries act on their local (system-one) verdict, under the owner's rule of 2026-09-28: a
 * boundary goes live only when the owner or a wizard switches it (decisions.live), and only at GO_LIVE agreement
 * over GO_LIVE cases for that kind and boundary; nothing switches live by itself. A live boundary whose agreement
 * falls below the rule goes back to shadow automatically (safety, not a flip). Every switch is journaled.
 *
 * An approval is judged per boundary (the gate's workspace-write or native-owner): only workspace-write can go live,
 * and there only a confident local allow is used (approval-shadow.ts decideLive); native-owner and every deny stay
 * with the reviewer and the owner. The approval kind's own DecisionService mode stays shadow, so both verdicts keep
 * being journaled and agreement keeps being measured. Another kind is one boundary, ALL, and its switch is its
 * DecisionService mode.
 */

export const GO_LIVE = { agreement: 0.95, cases: 30, windowDays: 90 } as const
export const ALL_BOUNDARY = 'all'
export const APPROVAL_BOUNDARIES = ['workspace-write', 'native-owner'] as const
/** The approval boundaries a local verdict may answer; native-owner is the owner's by definition. */
export const LIVEABLE_APPROVAL_BOUNDARIES: readonly string[] = ['workspace-write']
/** Every this-many confident local allows on a live boundary is still reviewed, so agreement keeps being measured. */
export const LIVE_AUDIT_EVERY = 5
/** {"<kind>:<boundary>": {live, at, by}}: the boundaries switched through decisions.live. */
export const LIVE_BOUNDARIES_SETTING = 'model-intelligence:live-boundaries'
/** The switch journal, newest last, at most LIVE_FLIPS_MAX entries. */
export const LIVE_FLIPS_SETTING = 'model-intelligence:live-flips'
const LIVE_FLIPS_MAX = 200
const DAY_MS = 86_400_000

export interface BoundaryStatus {
  kind: DecisionKind
  boundary: string
  /** Decisions in the window whose local verdict could be compared with the reviewer's or the owner's answer. */
  cases: number
  agreed: number
  agreement: number | null
  live: boolean
  /** Whether this boundary can go live at all (native-owner approvals cannot). */
  liveable: boolean
  /** The owner's rule holds now: at least GO_LIVE.cases at GO_LIVE.agreement. */
  meetsRule: boolean
  /** When and by whom it was last switched through decisions.live, or reverted. */
  switched?: { live: boolean; at: string; by: string }
}
export interface LiveFlip { at: string; kind: DecisionKind; boundary: string; live: boolean; by: string; cases: number; agreement: number | null; reason: string }
type Switched = { live: boolean; at: string; by: string }

const idOf = (kind: DecisionKind, boundary: string) => `${kind}:${boundary}`
const percent = (value: number | null) => value === null ? 'no' : `${Math.round(value * 1000) / 10}%`
const cases = (count: number) => `${count} case${count === 1 ? '' : 's'}`

export function createLiveBoundaries(deps: {
  store: Pick<ModelIntelligenceStore, 'approvalAgreement'>
  decisions: Pick<DecisionService, 'thresholds' | 'setThresholds'>
  settings: ThresholdSettings
  now(): Date
  log(message: string, error?: unknown): void
}) {
  const read = <T>(key: string, fallback: T, valid: (value: unknown) => boolean): T => {
    try { const value: unknown = JSON.parse(deps.settings.getSetting(key) ?? 'null'); return valid(value) ? value as T : fallback } catch { return fallback }
  }
  const switchedAll = (): Record<string, Switched> => read(LIVE_BOUNDARIES_SETTING, {}, value => !!value && typeof value === 'object' && !Array.isArray(value))
  const flips = (): LiveFlip[] => read(LIVE_FLIPS_SETTING, [], Array.isArray)
  const normalise = (kind: DecisionKind, boundary: string | undefined): string => {
    if (kind !== 'approval') {
      if (boundary !== undefined && boundary !== ALL_BOUNDARY) throw new Error(`${kind} has one boundary, "${ALL_BOUNDARY}"; only approval is judged per boundary (${APPROVAL_BOUNDARIES.join(', ')})`)
      return ALL_BOUNDARY
    }
    // The only approval boundary that can go live is the default.
    const chosen = boundary ?? LIVEABLE_APPROVAL_BOUNDARIES[0]!
    if (!(APPROVAL_BOUNDARIES as readonly string[]).includes(chosen)) throw new Error(`approval boundary must be one of ${APPROVAL_BOUNDARIES.join(', ')}`)
    return chosen
  }
  const isLive = (kind: DecisionKind, boundary: string): boolean => kind === 'approval'
    ? LIVEABLE_APPROVAL_BOUNDARIES.includes(boundary) && switchedAll()[idOf(kind, boundary)]?.live === true
    : deps.decisions.thresholds(kind).mode === 'live'
  const status = (kind: DecisionKind, boundary: string): BoundaryStatus => {
    const since = new Date(deps.now().getTime() - GO_LIVE.windowDays * DAY_MS).toISOString()
    const measured = deps.store.approvalAgreement({ kind, since, ...(boundary !== ALL_BOUNDARY ? { boundary } : {}) })
    const agreement = measured.cases ? measured.rate : null, switched = switchedAll()[idOf(kind, boundary)]
    return {
      kind, boundary, cases: measured.cases, agreed: measured.agreed, agreement, live: isLive(kind, boundary),
      liveable: kind !== 'approval' || LIVEABLE_APPROVAL_BOUNDARIES.includes(boundary),
      meetsRule: measured.cases >= GO_LIVE.cases && agreement !== null && agreement >= GO_LIVE.agreement, ...(switched ? { switched } : {})
    }
  }
  const journal = (flip: LiveFlip, switched: Switched | null): void => {
    const all = switchedAll()
    if (switched) all[idOf(flip.kind, flip.boundary)] = switched
    deps.settings.setSetting(LIVE_BOUNDARIES_SETTING, JSON.stringify(all))
    try { deps.settings.setSetting(LIVE_FLIPS_SETTING, JSON.stringify([...flips(), flip].slice(-LIVE_FLIPS_MAX))) }
    catch (error) { deps.log('live switch not journaled', error) }
    deps.log(`${flip.kind}/${flip.boundary} ${flip.live ? 'went live' : 'back to shadow'} (${flip.by}): ${flip.reason}`)
  }
  const apply = (kind: DecisionKind, boundary: string, live: boolean): void => {
    if (kind !== 'approval') deps.decisions.setThresholds(kind, { mode: live ? 'live' : 'shadow' })
  }

  return {
    status,
    isLive,
    /** Every kind's boundary, approval per boundary: what decisions.list reports. */
    all(kinds: readonly DecisionKind[]): BoundaryStatus[] {
      return kinds.flatMap(kind => kind === 'approval' ? APPROVAL_BOUNDARIES.map(boundary => status(kind, boundary)) : [status(kind, ALL_BOUNDARY)])
    },
    /** decisions.live: the owner's or a wizard's switch. Going live is refused, naming the numbers, below the rule. */
    set(kind: DecisionKind, requestedBoundary: string | undefined, live: boolean, by: string): BoundaryStatus & { previous: boolean } {
      const boundary = normalise(kind, requestedBoundary), current = status(kind, boundary)
      if (live && !current.liveable) throw new Error(`approval/${boundary} cannot go live: a native-owner request is answered by the reviewer or the owner, never by a local verdict`)
      if (live && !current.meetsRule)
        throw new Error(`${kind}/${boundary} stays in shadow: its local verdict agreed on ${percent(current.agreement)}${current.agreement === null ? '' : ' of'} ${cases(current.cases)} in ${GO_LIVE.windowDays} days (${current.agreed} agreed); going live needs at least ${GO_LIVE.agreement * 100}% over ${GO_LIVE.cases} or more`)
      const at = deps.now().toISOString()
      apply(kind, boundary, live)
      journal({ at, kind, boundary, live, by, cases: current.cases, agreement: current.agreement, reason: live ? `${percent(current.agreement)} over ${cases(current.cases)}` : 'switched back to shadow' }, { live, at, by })
      return { ...status(kind, boundary), previous: current.live }
    },
    /**
     * The automatic revert: a boundary switched live through decisions.live whose agreement fell below GO_LIVE.agreement
     * goes back to shadow, journaled. Boundaries that are live by default (route and the other routine kinds) were never
     * switched, so this leaves them alone. Too few cases in the window is not a disagreement and reverts nothing.
     */
    check(kind: DecisionKind, requestedBoundary?: string | null): LiveFlip[] {
      const reverted: LiveFlip[] = []
      for (const [id, switched] of Object.entries(switchedAll())) {
        const [switchedKind, boundary] = id.split(':') as [DecisionKind, string]
        if (switchedKind !== kind || !switched.live || (requestedBoundary && kind === 'approval' && boundary !== requestedBoundary)) continue
        try {
          const current = status(kind, boundary)
          if (!current.live || current.agreement === null || current.agreement >= GO_LIVE.agreement) continue
          const at = deps.now().toISOString(), flip: LiveFlip = { at, kind, boundary, live: false, by: 'auto-revert', cases: current.cases, agreement: current.agreement,
            reason: `agreement fell to ${percent(current.agreement)} of ${cases(current.cases)}, below the ${GO_LIVE.agreement * 100}% rule` }
          apply(kind, boundary, false)
          journal(flip, { live: false, at, by: 'auto-revert' })
          reverted.push(flip)
        } catch (error) { deps.log(`live boundary ${id} not checked`, error) }
      }
      return reverted
    },
    flips(limit = 20): LiveFlip[] { return flips().slice(-limit).reverse() },
  }
}
export type LiveBoundaries = ReturnType<typeof createLiveBoundaries>
