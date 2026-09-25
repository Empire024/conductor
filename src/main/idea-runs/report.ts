import type { IdeaRunAction } from '../../shared/idea-runs'
import { isActionType } from './policy'

/**
 * What a stage agent hands back at the end of each turn: one fenced ```idea-run-report block of
 * JSON (the stage brief spells the format out). Anything the agent writes around it is kept as
 * prose only; the controller acts on the block alone.
 */
export interface StageReport {
  status: 'done' | 'continue' | 'blocked'
  summary: string
  artifacts: Array<{ target: string; label: string }>
  decisions: string[]
  actions: IdeaRunAction[]
  spentEur: number
  /** A recurring stage's occurrence: how each loop step went, and an optional adjustment. */
  loop?: {
    steps: Array<{ id: string; outcome: string; note?: string }>
    adjust?: { stepId: string; model?: string; effort?: string; reason: string }
  }
}

const str = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : ''
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/** The JSON inside the last ```<fence> block of an answer, or null. */
export function fencedJson(text: string, fence: string): unknown {
  const pattern = new RegExp('```' + fence + '\\s*\\n([\\s\\S]*?)```', 'g')
  let last: string | null = null
  for (const match of text.matchAll(pattern)) last = match[1] ?? null
  if (last === null) return null
  try { return JSON.parse(last) } catch { return null }
}

export function parseStageReport(text: string): StageReport | null {
  const raw = fencedJson(text, 'idea-run-report')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const status = value.status === 'done' || value.status === 'blocked' ? value.status : 'continue'
  const list = (key: string): unknown[] => Array.isArray(value[key]) ? value[key] as unknown[] : []
  const artifacts = list('artifacts').flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ target: item.trim().slice(0, 1000), label: '' }]
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    const target = str(entry.path ?? entry.url ?? entry.target, 1000)
    return target ? [{ target, label: str(entry.label, 300) }] : []
  }).slice(0, 40)
  const decisions = list('decisions').map(item => str(item, 1000)).filter(Boolean).slice(0, 40)
  const actions = list('actions').flatMap((item): IdeaRunAction[] => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    const summary = str(entry.summary, 300), detail = str(entry.detail, 8000)
    if (!summary) return []
    const target = str(entry.target, 500), amount = num(entry.amountEur)
    // An unknown or missing type is still an outside action: it pauses like one.
    return [{ type: isActionType(entry.type) ? entry.type : 'external', summary, detail: detail || summary, ...(target ? { target } : {}), ...(amount ? { amountEur: amount } : {}) }]
  }).slice(0, 20)
  let loop: StageReport['loop']
  if (value.loop && typeof value.loop === 'object' && !Array.isArray(value.loop)) {
    const source = value.loop as Record<string, unknown>
    const steps = (Array.isArray(source.steps) ? source.steps : []).flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Record<string, unknown>
      const id = str(entry.id, 80), outcome = str(entry.outcome, 100)
      const note = str(entry.note, 4000)
      return id && outcome ? [{ id, outcome, ...(note ? { note } : {}) }] : []
    })
    let adjust: NonNullable<StageReport['loop']>['adjust']
    if (source.adjust && typeof source.adjust === 'object') {
      const entry = source.adjust as Record<string, unknown>
      const stepId = str(entry.stepId, 80), reason = str(entry.reason, 1000), model = str(entry.model, 200), effort = str(entry.effort, 40)
      if (stepId && reason && (model || effort)) adjust = { stepId, reason, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    }
    loop = { steps, ...(adjust ? { adjust } : {}) }
  }
  return { status, summary: str(value.summary, 4000) || '(no summary)', artifacts, decisions, actions, spentEur: num(value.spentEur), ...(loop ? { loop } : {}) }
}
