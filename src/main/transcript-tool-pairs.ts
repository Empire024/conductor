import type { TranscriptToolCall } from '../shared/tool-timings'

/**
 * Pairs Claude Code transcript rows' tool calls with their results by the exact tool_use_id, for
 * the cloud-transcript (cloud/runs.ts) and cli-transcript (native-history.ts) timings. The caller
 * decides which rows are on the clock it trusts; this only pairs what it is given.
 *
 * A result row names the assistant row it answers (sourceToolAssistantUUID); one naming another
 * row is noted, as is a call or result restated with different times. The first statements' times
 * stay labels; a call with notes is never timed from them. A call with no result is not returned.
 * Held rows are bounded: past `maxIds` calls or results, the oldest are let go.
 */
export const MAX_TRANSCRIPT_TOOLS = 2000
/** The note a teleport writes after the session's own rows: rows before it came from the cloud, rows after it from this machine. */
export const TELEPORT_NOTE = /^This session is being continued from another machine/
const isoTime = (value: unknown): string | null => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null
const toolId = (value: unknown): string | undefined => typeof value === 'string' && value && value.length <= 256 ? value : undefined

export class TranscriptToolPairs {
  private readonly uses = new Map<string, { name: string; input: unknown; at: string | null; uuid: string | null; conflict: boolean }>()
  private readonly results = new Map<string, { at: string | null; isError: boolean; denied: string | null; source: string | null; result: string; conflict: boolean }>()
  /** Held calls or results let go at the bound: coverage the caller must report, never hide. */
  private evicted = 0
  constructor(private readonly maxIds = 8192) {}

  /** One transcript row (a parsed JSONL record). */
  add(record: any): void {
    if (record?.type !== 'user' && record?.type !== 'assistant') return
    const content = record.message?.content
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (part?.type === 'tool_use' && record.type === 'assistant') {
        const id = toolId(part.id)
        if (!id) continue
        const use = { name: typeof part.name === 'string' ? part.name.slice(0, 80) : 'Tool', input: part.input, at: isoTime(record.timestamp), uuid: typeof record.uuid === 'string' ? record.uuid : null, conflict: false }
        const prior = this.uses.get(id)
        if (prior) prior.conflict ||= prior.at !== use.at || prior.uuid !== use.uuid
        else this.hold(this.uses, id, use)
      } else if (part?.type === 'tool_result' && record.type === 'user') {
        const id = toolId(part.tool_use_id)
        if (!id) continue
        const body = Array.isArray(part.content) ? part.content.map((item: any) => item?.text ?? '').join('\n') : String(part.content ?? '')
        const result = { at: isoTime(record.timestamp), isError: part.is_error === true, denied: typeof record.toolDenialKind === 'string' ? record.toolDenialKind.slice(0, 40) : null,
          source: typeof record.sourceToolAssistantUUID === 'string' ? record.sourceToolAssistantUUID : null, result: body.slice(0, 4000), conflict: false }
        const prior = this.results.get(id)
        if (prior) prior.conflict ||= prior.at !== result.at || prior.isError !== result.isError
        else this.hold(this.results, id, result)
      }
    }
  }

  private hold<T>(map: Map<string, T>, id: string, value: T): void {
    if (map.size >= this.maxIds) { map.delete(map.keys().next().value!); this.evicted++ }
    map.set(id, value)
  }

  /** The paired calls, the same and in the same order however the rows were ordered, how many calls
   *  have no result, how many results have no call among these rows (a partial read), and how many
   *  held entries or paired calls the bounds let go. */
  calls(): { tools: TranscriptToolCall[]; unmatched: number; orphans: number; dropped: number } {
    const tools: TranscriptToolCall[] = []
    for (const [toolUseId, result] of this.results) {
      const use = this.uses.get(toolUseId)
      // A result whose call is not among these rows (a partial read) waits for a read that has both.
      if (!use) continue
      const notes: string[] = []
      if (use.conflict || result.conflict) notes.push('conflicting-restatement')
      if (result.source && use.uuid && result.source !== use.uuid) notes.push('result-names-another-row')
      tools.push({ toolUseId, name: use.name, input: use.input, usedAt: use.at, resultAt: result.at, isError: result.isError, denied: result.denied, result: result.result, notes })
    }
    const unmatched = [...this.uses.keys()].filter(id => !this.results.has(id)).length
    const orphans = [...this.results.keys()].filter(id => !this.uses.has(id)).length
    tools.sort((a, b) => (a.usedAt ?? '').localeCompare(b.usedAt ?? '') || a.toolUseId.localeCompare(b.toolUseId))
    return { tools: tools.slice(-MAX_TRANSCRIPT_TOOLS), unmatched, orphans, dropped: this.evicted + Math.max(0, tools.length - MAX_TRANSCRIPT_TOOLS) }
  }
}
