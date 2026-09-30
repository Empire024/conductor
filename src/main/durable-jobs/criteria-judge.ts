import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ChatMessage, CompletionRequest, CompletionResult } from '../local-models/client'
import type { CriteriaJudgePort, CriteriaVerdict } from './ports'
import { visibleContent } from './handoff'

/**
 * The model-judged half of the completion check (docs/verification/2026-09-29-durable-jobs.md,
 * finding 2). completion-check.ts verifies the criteria phrased as a mechanical fact about a file;
 * a criterion such as "CROSSREF.md has a row for every import listed in notes/" is left to this:
 * one bounded call to the job's own local model, which reads the files the stage produced and the
 * files the criterion names, never the stage's own claims, and answers per criterion met / not
 * met (with what is missing) / cannot tell. The controller sends a "not met" back to the stage as
 * its retry reason; "cannot tell" and an unavailable judge leave the criterion unverified, which
 * the job's events record.
 */

export interface JudgeConnection { endpoint: string; apiKey: string; model: string; contextTokens: number }

export interface LocalCriteriaJudgeOptions {
  /** The job model's server, or null when it is not configured on this machine. */
  connection(model: string): JudgeConnection | null
  complete(request: CompletionRequest): Promise<CompletionResult>
  /** The process-wide generation gate: the judge's call takes its turn like a stage attempt. */
  gate?: { acquire(jobId: string, signal?: AbortSignal): Promise<{ release(): void }> }
  timeoutMs?: number
  maxTokens?: number
}

const MAX_FILES = 24
const MAX_FILE_BYTES = 2_000_000
const MIN_PER_FILE = 2_000
const MAX_EVIDENCE_CHARS = 60_000
const clip = (text: string, max: number): string => { const flat = text.trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }

/** Path-like words in a criterion: `notes/`, `CROSSREF.md`, `src/a.ts`. */
export function criterionPaths(criterion: string): string[] {
  const found = criterion.match(/[\w.\-/\\]*[\w\-]+(?:\/|\.[A-Za-z0-9]{1,8})(?![\w])[\w.\-/\\]*/g) ?? []
  return [...new Set(found.map(word => word.replace(/[.,;:]+$/, '')).filter(word => word && !/^\d+(\.\d+)*$/.test(word)))]
}

/** A path inside cwd, or undefined for one that escapes it. */
function inside(cwd: string, path: string): string | undefined {
  const absolute = resolve(cwd, path)
  const rel = relative(cwd, absolute)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : undefined
}

async function expand(cwd: string, rel: string, depth = 0): Promise<string[]> {
  const info = await stat(join(cwd, rel)).catch(() => null)
  if (!info) return []
  if (info.isFile()) return [rel]
  if (!info.isDirectory() || depth > 1) return []
  const entries = await readdir(join(cwd, rel), { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.filter(entry => !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).map(entry => expand(cwd, `${rel.replace(/\/$/, '')}/${entry.name}`, depth + 1)))
  return nested.flat()
}

export interface Evidence { files: Array<{ path: string; text: string; truncated: boolean }>; missing: string[] }

/** The files the judge reads: what the stage changed plus what its criteria name, bounded. */
export async function collectEvidence(cwd: string, criteria: readonly string[], changed: readonly string[], maxChars = MAX_EVIDENCE_CHARS): Promise<Evidence> {
  const named = criteria.flatMap(criterionPaths)
  const wanted = [...new Set([...named, ...changed].map(path => inside(cwd, path)).filter((path): path is string => Boolean(path)))]
  const paths: string[] = [], missing: string[] = []
  for (const path of wanted) {
    const files = await expand(cwd, path)
    if (!files.length && named.some(name => inside(cwd, name) === path)) missing.push(path)
    for (const file of files) if (!paths.includes(file)) paths.push(file)
  }
  const chosen = paths.slice(0, MAX_FILES)
  const perFile = Math.max(MIN_PER_FILE, Math.floor(maxChars / Math.max(1, chosen.length)))
  const files: Evidence['files'] = []
  let used = 0
  for (const path of chosen) {
    if (used >= maxChars) break
    const info = await stat(join(cwd, path)).catch(() => null)
    if (!info || info.size > MAX_FILE_BYTES) continue
    const raw = await readFile(join(cwd, path), 'utf8').catch(() => null)
    if (raw === null || raw.includes('\u0000')) continue
    const room = Math.min(perFile, maxChars - used)
    files.push({ path, text: raw.slice(0, room), truncated: raw.length > room })
    used += Math.min(raw.length, room)
  }
  return { files, missing }
}

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'integer' }, met: { type: 'string', enum: ['yes', 'no', 'unknown'] }, missing: { type: 'string' } },
        required: ['criterion', 'met', 'missing'], additionalProperties: false
      }
    }
  },
  required: ['verdicts'], additionalProperties: false
} as const

export function judgeMessages(input: { objective: string; criteria: readonly string[]; evidence: Evidence }): ChatMessage[] {
  const files = input.evidence.files.map(file => `=== ${file.path}${file.truncated ? ' (cut off here; the rest is not shown)' : ''} ===\n${file.text}`).join('\n\n')
  return [
    {
      role: 'system',
      content: [
        'You check whether finished work meets its completion criteria. Judge only from the file contents shown, never from what the worker says it did.',
        'For each numbered criterion answer met "yes", "no" or "unknown".',
        '"no" when the files show the criterion is not met: then say concretely what is missing or wrong (which rows, items, sections or files), in at most a few lines.',
        '"unknown" only when the part you would need is not shown. Check every item a criterion asks for; "every", "all" and "each" mean the whole list.',
        'Answer with JSON only.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `Objective of the work: ${clip(input.objective, 2_000)}`,
        '',
        'Completion criteria:',
        ...input.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
        '',
        ...(input.evidence.missing.length ? [`Named in the criteria but not found on disk: ${input.evidence.missing.join(', ')}`, ''] : []),
        input.evidence.files.length ? `Files:\n\n${files}` : 'No files were found to read.'
      ].join('\n')
    }
  ]
}

/** The model's JSON as verdicts, one per criterion; anything unreadable becomes "unknown". */
export function parseVerdicts(content: string, criteria: readonly string[]): CriteriaVerdict[] | undefined {
  const text = visibleContent(content).text.replace(/^```(?:json)?\s*|\s*```$/g, '')
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) } catch { return undefined }
  const list = (parsed as { verdicts?: unknown })?.verdicts
  if (!Array.isArray(list)) return undefined
  return criteria.map((criterion, index) => {
    const entry = list.find(item => Number((item as { criterion?: unknown })?.criterion) === index + 1) ?? (list.length === criteria.length ? list[index] : undefined)
    const met = String((entry as { met?: unknown })?.met ?? '').toLowerCase()
    const missing = clip(String((entry as { missing?: unknown })?.missing ?? ''), 600)
    if (met === 'no') return { criterion, verdict: 'not-met', missing: missing || 'the verifier found it not met but named nothing specific' }
    if (met === 'yes') return { criterion, verdict: 'met', missing: '' }
    return { criterion, verdict: 'unknown', missing }
  })
}

export function localCriteriaJudge(options: LocalCriteriaJudgeOptions): CriteriaJudgePort {
  return {
    async judge({ job, stage, criteria, filesChanged, signal }) {
      const connection = options.connection(job.model.model)
      if (!connection) return { unavailable: `${job.model.model} is not configured on this machine` }
      const maxTokens = options.maxTokens ?? 1_024
      // Bytes/3 per token (handoff.ts textTokens): half the window for the files, the rest for
      // the instructions and the answer.
      const room = Math.max(MIN_PER_FILE, Math.min(MAX_EVIDENCE_CHARS, Math.floor((connection.contextTokens - maxTokens) * 3 * 0.5)))
      const evidence = await collectEvidence(job.cwd, criteria, filesChanged, room)
      const messages = judgeMessages({ objective: stage.objective, criteria, evidence })
      const lease = await options.gate?.acquire(job.id, signal)
      try {
        let lastProblem = ''
        // One retry for an answer that does not parse; a refused or timed-out call is not retried.
        for (let attempt = 0; attempt < 2; attempt++) {
          const abort = new AbortController()
          const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 180_000)
          const onAbort = (): void => abort.abort()
          signal?.addEventListener('abort', onAbort, { once: true })
          try {
            const result = await options.complete({ endpoint: connection.endpoint, apiKey: connection.apiKey, model: connection.model, messages, temperature: 0, maxTokens, reasoningEffort: 'none', jsonSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>, signal: abort.signal })
            const verdicts = parseVerdicts(result.content ?? '', criteria)
            if (verdicts) return { verdicts }
            lastProblem = 'the verifier answer was not readable JSON'
          } catch (error) {
            return { unavailable: abort.signal.aborted ? (signal?.aborted ? 'the verification was cancelled' : 'the verifier did not answer in time') : `the verifier call failed: ${clip(error instanceof Error ? error.message : String(error), 300)}` }
          } finally {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
          }
        }
        return { unavailable: lastProblem }
      } finally { lease?.release() }
    }
  }
}
