import { TASK_CATEGORIES, type BenchmarkResult, type IngestionBatch, type ModelKey, type SourceRef, type TaskCategory } from '../../../shared/model-routing'

/**
 * A checked-in or fetched file of public scores:
 *   {"source": {"name": "swe-bench-verified", "url": "..."}, "observedAt": "2026-09-01T00:00:00Z",
 *    "results": [{"provider": "claude", "model": "opus[1m]", "benchmark": "swe-bench-verified",
 *                 "score": 79.4, "max": 100, "categories": ["difficult-coding"]}]}
 * `key: "claude/opus[1m]"` may replace provider+model. Scores are normalised to 0..1: `max` when
 * given, else a score above 1 is read as a percentage. Categories default per benchmark.
 */
export interface BenchmarkFile {
  source: { name: string; url?: string }
  observedAt: string
  results: Array<{ provider?: string; model?: string; key?: string; benchmark?: string; score: number | string; max?: number; raw?: string; categories?: string[] }>
}

export interface BenchmarkPorts { read(): string | Promise<string> }

/** Which task categories a benchmark speaks to, when the file does not say. */
export const BENCHMARK_CATEGORIES: Record<string, TaskCategory[]> = {
  'swe-bench': ['difficult-coding', 'debugging', 'large-repo'],
  'swe-bench-verified': ['difficult-coding', 'debugging', 'large-repo'],
  'terminal-bench': ['terminal-use', 'tool-calling'],
  'aider-polyglot': ['simple-coding', 'difficult-coding'],
  livecodebench: ['simple-coding', 'difficult-coding'],
  'tau-bench': ['tool-calling'],
  'bfcl': ['tool-calling', 'structured-output'],
  'gpqa-diamond': ['research'],
  'humanitys-last-exam': ['research'],
  mmmu: ['vision'],
  'artificial-analysis-intelligence-index': ['general'],
  'artificial-analysis-coding-index': ['simple-coding', 'difficult-coding']
}
const CATEGORIES: ReadonlySet<string> = new Set(TASK_CATEGORIES)
const slug = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function keyOf(entry: BenchmarkFile['results'][number]): ModelKey | null {
  if (entry.provider && entry.model) return { provider: entry.provider, model: entry.model }
  const slash = entry.key?.indexOf('/') ?? -1
  return entry.key && slash > 0 && slash < entry.key.length - 1 ? { provider: entry.key.slice(0, slash), model: entry.key.slice(slash + 1) } : null
}

/** Pure: a benchmark file to one batch holding only benchmarks (priors, never registry facts).
 *  Entries that cannot be read are skipped and counted, never guessed. */
export function parseBenchmarks(input: string | BenchmarkFile, fetchedAt: string): { batch: IngestionBatch; skipped: number } {
  const file = (typeof input === 'string' ? JSON.parse(input) : input) as BenchmarkFile
  if (!file?.source?.name || !Array.isArray(file.results)) throw new Error('Benchmark file needs source.name and a results list')
  const source: SourceRef = { kind: 'benchmark', name: `benchmark:${slug(file.source.name)}`, ...(file.source.url ? { url: file.source.url } : {}) }
  const observedAt = Number.isFinite(Date.parse(file.observedAt)) ? new Date(file.observedAt).toISOString() : fetchedAt
  const benchmarks: BenchmarkResult[] = []
  let skipped = 0
  for (const entry of file.results) {
    const key = keyOf(entry ?? {})
    const figure = typeof entry?.score === 'string' ? Number(entry.score.replace(/%$/, '')) : entry?.score
    const benchmark = slug(entry?.benchmark ?? file.source.name)
    const max = typeof entry?.max === 'number' && entry.max > 0 ? entry.max : typeof figure === 'number' && figure > 1 ? 100 : 1
    const score = typeof figure === 'number' && Number.isFinite(figure) ? figure / max : NaN
    if (!key || !benchmark || !(score >= 0 && score <= 1)) { skipped++; continue }
    const listed = (entry.categories ?? []).filter(category => CATEGORIES.has(category)) as TaskCategory[]
    benchmarks.push({
      key, benchmark, score: Number(score.toFixed(4)), raw: entry.raw ?? String(entry.score),
      categories: listed.length ? listed : BENCHMARK_CATEGORIES[benchmark] ?? ['general'], source, observedAt
    })
  }
  return { batch: { source, fetchedAt, observations: [], benchmarks, complete: false }, skipped }
}

export async function fetchBatch(ports: BenchmarkPorts, now: () => Date = () => new Date()): Promise<IngestionBatch> {
  return parseBenchmarks(await ports.read(), now().toISOString()).batch
}
