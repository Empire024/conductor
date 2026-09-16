import { MEMORY_KINDS } from '../shared/models'
import type { AgentMemory, MemoryKind, MemorySource } from '../shared/models'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'will', 'have', 'has'
])

// The list itself lives in shared/models so the renderer can build its menus from the same
// array the main process validates against. Re-exported here because memory rules are read
// from this module.
export { MEMORY_KINDS, isMemoryKind } from '../shared/models'

// Stripping the write-directive out of what the user reads has to run in the renderer too
// (assistant text is rendered straight off the shared structured-agent projection), so the
// logic lives in shared/ and is re-exported here for the main process's own imports.
export { stripMemoryDirectives } from '../shared/memory-directive'

export const clampMemoryWeight = (value: number): number => Math.min(1, Math.max(0, value))

export const memoryTokens = (value: string): string[] => [
  ...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [])
].filter((word) => !STOP_WORDS.has(word))

export const normalizeMemoryCues = (cues: string[]): string[] => [
  ...new Set(cues.flatMap((cue) => memoryTokens(cue)))
].slice(0, 20)

export const shouldConsolidateMemory = (
  existingKind: MemoryKind,
  existingCues: string[],
  incomingKind: MemoryKind,
  incomingCues: string[]
): boolean => {
  if (existingKind !== incomingKind) return false
  const existing = new Set(normalizeMemoryCues(existingCues))
  const incoming = normalizeMemoryCues(incomingCues)
  const comparable = Math.min(existing.size, incoming.length)
  // A single broad cue (for example "checkout") is not enough evidence that
  // two distinct experiences represent the same memory.
  if (comparable < 2) return false
  const common = incoming.filter((cue) => existing.has(cue)).length
  return common / comparable >= 2 / 3
}

// Episodes fade fastest, stable knowledge outlives them, and the way a project
// wants work done is the last thing to be forgotten.
export const memoryHalfLifeDays = (kind: MemoryKind): number =>
  kind === 'episodic' ? 90 : kind === 'semantic' ? 1460 : 2190

/** Probability that a memory is still accessible, given how long ago it was last activated. */
export const memoryRetrievability = (
  memory: Pick<AgentMemory, 'kind' | 'occurredAt' | 'lastRecalledAt' | 'strength' | 'recallCount'>,
  currentTime: number
): number => {
  const occurredAt = Date.parse(memory.occurredAt)
  const recalledAt = memory.lastRecalledAt ? Date.parse(memory.lastRecalledAt) : Number.NaN
  const latestActivation = Math.max(
    Number.isFinite(occurredAt) ? occurredAt : currentTime,
    Number.isFinite(recalledAt) ? recalledAt : Number.NEGATIVE_INFINITY
  )
  const ageDays = Math.max(0, (currentTime - latestActivation) / 86_400_000)
  // Every rehearsal lengthens the horizon rather than merely resetting it.
  const rehearsals = Math.max(0, memory.strength - 1) + Math.max(0, memory.recallCount)
  const halfLife = memoryHalfLifeDays(memory.kind) * (1 + Math.log2(rehearsals + 1))
  return Math.pow(0.5, ageDays / halfLife)
}

export interface MemoryScore {
  overlap: number
  score: number
}

export const scoreMemory = (
  memory: Pick<AgentMemory,
    'kind' | 'gist' | 'cues' | 'salience' | 'confidence' | 'strength' | 'recallCount' | 'occurredAt' | 'lastRecalledAt'>,
  queryTokens: ReadonlySet<string>,
  currentTime: number
): MemoryScore => {
  const words = new Set([...normalizeMemoryCues(memory.cues), ...memoryTokens(memory.gist)])
  const common = [...queryTokens].filter((token) => words.has(token)).length
  const overlap = common / Math.max(1, queryTokens.size)
  const recency = memoryRetrievability(memory, currentTime)
  const rehearsal = Math.min(
    1,
    Math.log2(Math.max(0, memory.strength) + Math.max(0, memory.recallCount) + 1) / 5
  )
  return {
    overlap,
    score:
      overlap * 0.58 +
      clampMemoryWeight(memory.salience) * 0.16 +
      clampMemoryWeight(memory.confidence) * 0.12 +
      recency * 0.08 +
      rehearsal * 0.06
  }
}

/**
 * How useful a policy is when nothing in the request named it. Procedural memory
 * describes how this project wants work done, so it has to reach the agent even
 * when the wording of a request shares no vocabulary with the rule itself.
 */
export const standingMemoryScore = (
  memory: Pick<AgentMemory, 'kind' | 'salience' | 'confidence' | 'strength' | 'recallCount' | 'occurredAt' | 'lastRecalledAt'>,
  currentTime: number
): number =>
  clampMemoryWeight(memory.salience) * 0.4 +
  clampMemoryWeight(memory.confidence) * 0.35 +
  memoryRetrievability(memory, currentTime) * 0.25

/**
 * Forgetting keeps recall sharp. Only unrehearsed, low-stakes episodes are ever
 * dropped: knowledge and policy are what the project is expected to retain, and
 * anything a human wrote or an agent reinforced stays until it is removed by hand.
 */
export const shouldForgetMemory = (memory: AgentMemory, currentTime: number): boolean => {
  if (memory.kind !== 'episodic') return false
  if (memory.source === 'human') return false
  // A person who edited or re-weighted this memory has vouched for it by hand; only they
  // may take it back out again.
  if (memory.correctedAt) return false
  if (memory.strength > 1 || memory.recallCount > 0) return false
  if (memory.salience >= 0.7) return false
  return memoryRetrievability(memory, currentTime) < 0.02
}

/**
 * Why a memory surfaced in the visible prune. Automatic forgetting only ever touches
 * unrehearsed episodes, so the prune has to explain decay in every other case too —
 * otherwise a stale semantic fact has no route out of the project except being noticed.
 */
export const memoryPruneReason = (
  memory: Pick<AgentMemory, 'kind' | 'salience' | 'confidence' | 'strength' | 'recallCount' | 'occurredAt' | 'lastRecalledAt'>,
  currentTime: number
): string => {
  const retrievability = memoryRetrievability(memory, currentTime)
  if (retrievability < 0.1) {
    return memory.recallCount === 0
      ? 'Faded, and nothing has ever recalled it'
      : 'Faded since the last time it was recalled'
  }
  if (memory.confidence < 0.4) return 'Written with low confidence'
  if (memory.recallCount === 0 && memory.salience < 0.4) return 'Never recalled, and marked low-stakes'
  if (memory.recallCount === 0) return 'Never recalled since it was written'
  return 'Holding its standing'
}

export interface RankedMemory<T> {
  memory: T
  standing: number
  retrievability: number
  reason: string
}

/**
 * Ranks memories weakest-first for the visible prune. Nothing is removed here: decay is a
 * suggestion the owner accepts or refuses, which is the whole difference between this and
 * the automatic once-per-session pass.
 */
export const rankMemoriesForPrune = <T extends Parameters<typeof standingMemoryScore>[0] & Pick<AgentMemory, 'gist'>>(
  memories: readonly T[],
  currentTime: number
): RankedMemory<T>[] =>
  memories
    .map((memory) => ({
      memory,
      standing: standingMemoryScore(memory, currentTime),
      retrievability: memoryRetrievability(memory, currentTime),
      reason: memoryPruneReason(memory, currentTime)
    }))
    // Ties are broken by gist so a stable ranking does not reshuffle under the cursor.
    .sort((a, b) => a.standing - b.standing || a.memory.gist.localeCompare(b.memory.gist))

export interface CapturedMemory {
  kind: MemoryKind
  gist: string
  cues: string[]
  salience?: number
  confidence?: number
}

// Built from the canonical kind list so a new kind is recognised in agent output the moment
// it is added, rather than being silently downgraded to `semantic`.
const SENTINEL = new RegExp(
  String.raw`CONDUCTOR_MEMORY(?:\[(${MEMORY_KINDS.join('|')})\])?:[ \t]*([^\r\n|]{12,1000}?)[ \t]*((?:\|[ \t]*[a-z]+[ \t]*:[^\r\n|]*)*)(?=\r|\n|$)`,
  'gi'
)

/**
 * Reads memory-write sentinels out of agent output. The instruction Conductor
 * gives agents spells the format with `<placeholder>` slots precisely so that
 * the instruction itself — which terminals echo straight back at us — can never
 * parse as a memory.
 */
export const captureMemories = (text: string): CapturedMemory[] => {
  const captured: CapturedMemory[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(SENTINEL)) {
    const gist = match[2]!.trim()
    if (!gist || /^[\p{P}\p{S}\s]+$/u.test(gist)) continue
    // An unfilled template, not something the agent chose to remember.
    if (/<[^<>]*>/.test(gist)) continue
    const fields = new Map<string, string>()
    for (const part of (match[3] ?? '').split('|')) {
      const field = /^[ \t]*([a-zA-Z]+)[ \t]*:[ \t]*(.*)$/.exec(part)
      if (field) fields.set(field[1]!.toLowerCase(), field[2]!.trim())
    }
    const kind = (match[1]?.toLowerCase() as MemoryKind | undefined) ?? 'semantic'
    const key = `${kind}:${gist.toLocaleLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const weight = (name: string): number | undefined => {
      const raw = fields.get(name)
      if (raw === undefined) return undefined
      const value = Number.parseFloat(raw)
      return Number.isFinite(value) ? clampMemoryWeight(value) : undefined
    }
    captured.push({
      kind,
      gist,
      cues: (fields.get('cues') ?? '').split(',').map((cue) => cue.trim()).filter(Boolean),
      salience: weight('salience'),
      confidence: weight('confidence')
    })
  }
  return captured
}

/**
 * The write half of the memory contract, handed to an agent once per session.
 * Kept short on purpose: it competes with the user's actual request for
 * attention, and a rule that is skimmed is a rule that is not followed.
 */
export const MEMORY_PROTOCOL = [
  'Conductor keeps durable, project-scoped memory across sessions, and you may write to it directly.',
  '- semantic — what is true here: architecture, constraints, decisions, owner preferences.',
  '- episodic — what happened: a specific situation, what was tried, and how it turned out.',
  '- procedural — how work should be done here: workflows, policies, conventions, tool-use rules.',
  '',
  'To save one, put this on a line of its own in your reply:',
  'CONDUCTOR_MEMORY[<kind>]: <one self-contained sentence> | cues: <comma-separated keywords>',
  `Replace <kind> with ${MEMORY_KINDS.join(', ')}, and replace every other <placeholder> with real content.`,
  '',
  'Only save what will still matter in a future, unrelated session and would cost real work to rediscover.',
  'Do not save progress updates, restatements of the request, file contents, or anything you are unsure of.',
  'Write the corrected sentence to fix a memory you now know to be wrong.'
].join('\n')

/** Renders recalled memories as prompt context, most useful first. */
export const formatRecalledMemories = (
  memories: readonly Pick<AgentMemory, 'kind' | 'gist'>[],
  budget = 3_500
): string => {
  const lines: string[] = []
  let used = 0
  for (const memory of memories) {
    const line = `- [${memory.kind}] ${memory.gist.replace(/\s+/g, ' ').trim().slice(0, 520)}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

/** Assistant snapshots are re-emitted as the message grows, so the same sentinel arrives many
 *  times in one turn. Re-remembering it would inflate its strength for free and distort recall. */
export const capturedMemoryKey = (itemId: string | undefined, memory: CapturedMemory): string =>
  `${itemId ?? ''}:${memory.kind}:${memory.gist.toLocaleLowerCase()}`

export const memorySourceOf = (value: unknown): MemorySource => (value === 'agent' ? 'agent' : 'human')
