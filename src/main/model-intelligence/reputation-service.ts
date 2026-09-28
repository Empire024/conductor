/**
 * ReputationService: reputation.ts over a store. The port is the smallest slice of module A's
 * ModelIntelligenceStore it needs; every read is by key and bounded by a time window and a limit.
 * Raw rows are cached per key for a short TTL and dropped when an outcome for that key (or one of
 * its family, whose prior it feeds) is recorded.
 */
import { BEHAVIOUR_DIMENSIONS, modelKeyId, OUTCOME_RETENTION_DAYS, REPUTATION_POLICY, TASK_CATEGORIES, type BenchmarkResult, type ExecutionOutcome, type ModelKey, type ReputationScore, type TaskCategory } from '../../shared/model-routing'
import { isProven, priorFor, score, type ReputationDimension } from './reputation'

export interface ReputationStorePort {
  /** Newest first or any order; `since` is an ISO instant, `limit` bounds the rows. */
  outcomes(query: { key: ModelKey; category?: TaskCategory; since: string; limit: number }): ExecutionOutcome[]
  benchmarks(key: ModelKey): BenchmarkResult[]
  /** The other keys of the same model family (other providers, sibling sizes); may include key. */
  family(key: ModelKey): ModelKey[]
  /** Whether the registry knows the key. When absent, a key is known once it has any outcome,
   *  benchmark or family member. */
  known?(key: ModelKey): boolean
}

export interface ReputationServiceOptions { now?: () => number; ttlMs?: number; limit?: number }

const DIMENSIONS: readonly ReputationDimension[] = [...TASK_CATEGORIES, ...BEHAVIOUR_DIMENSIONS]
interface Entry { at: number; outcomes: ExecutionOutcome[]; benchmarks: BenchmarkResult[]; family: ModelKey[] }

export class ReputationService {
  private cache = new Map<string, Entry>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly limit: number
  constructor(private port: ReputationStorePort, options: ReputationServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 60_000
    this.limit = options.limit ?? 5_000
  }

  private entry(key: ModelKey): Entry {
    const id = modelKeyId(key), at = this.now(), cached = this.cache.get(id)
    if (cached && at - cached.at < this.ttlMs) return cached
    const since = new Date(at - OUTCOME_RETENTION_DAYS * 86_400_000).toISOString()
    const entry: Entry = { at, outcomes: this.port.outcomes({ key, since, limit: this.limit }).filter(outcome => modelKeyId(outcome.key) === id), benchmarks: this.port.benchmarks(key), family: this.port.family(key).filter(other => modelKeyId(other) !== id) }
    this.cache.set(id, entry)
    return entry
  }
  private known(key: ModelKey, entry: Entry): boolean {
    return this.port.known ? this.port.known(key) : entry.outcomes.length > 0 || entry.benchmarks.length > 0 || entry.family.length > 0
  }
  /** A family member's own posterior on the default prior (never its own family prior: no recursion). */
  private familyScores(entry: Entry, dimension: ReputationDimension): ReputationScore[] {
    return entry.family.map(other => score({ mean: REPUTATION_POLICY.defaultPrior, source: 'default' }, this.entry(other).outcomes, dimension, this.now(), other))
  }
  private compute(key: ModelKey, entry: Entry, dimension: ReputationDimension): ReputationScore {
    return score(priorFor(key, dimension, entry.benchmarks, this.familyScores(entry, dimension)), entry.outcomes, dimension, this.now(), key)
  }

  /** Null only when the key is unknown; a known key with no evidence gets its prior. */
  reputation(key: ModelKey, dimension: ReputationDimension): ReputationScore | null {
    const entry = this.entry(key)
    return this.known(key, entry) ? this.compute(key, entry, dimension) : null
  }
  /** Every dimension with evidence, plus those whose prior is not the default. */
  profile(key: ModelKey): ReputationScore[] {
    const entry = this.entry(key)
    if (!this.known(key, entry)) return []
    return DIMENSIONS.map(dimension => this.compute(key, entry, dimension)).filter(result => result.evidence > 0 || result.priorSource !== 'default')
  }
  proven(key: ModelKey): boolean { return isProven(this.entry(key).outcomes, this.now()) }
  /** Called after the store recorded an outcome: drops that key and every cached key whose
   *  family prior it feeds. */
  outcomeRecorded(outcome: Pick<ExecutionOutcome, 'key'>): void {
    const id = modelKeyId(outcome.key)
    this.cache.delete(id)
    for (const [other, entry] of this.cache) if (entry.family.some(member => modelKeyId(member) === id)) this.cache.delete(other)
  }
  invalidate(): void { this.cache.clear() }
}
