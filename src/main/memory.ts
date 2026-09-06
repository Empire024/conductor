import type { AgentMemory, MemoryKind } from '../shared/models'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'will', 'have', 'has'
])

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
  const occurredAt = Date.parse(memory.occurredAt)
  const recalledAt = memory.lastRecalledAt ? Date.parse(memory.lastRecalledAt) : Number.NaN
  const latestActivation = Math.max(
    Number.isFinite(occurredAt) ? occurredAt : currentTime,
    Number.isFinite(recalledAt) ? recalledAt : Number.NEGATIVE_INFINITY
  )
  const ageDays = Math.max(0, (currentTime - latestActivation) / 86_400_000)
  const halfLife = memory.kind === 'episodic' ? 90 : memory.kind === 'semantic' ? 1460 : 2190
  const recency = Math.pow(0.5, ageDays / halfLife)
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
