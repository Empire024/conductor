import type { ActivityStatus, AgentEventData, Json, SessionPhase, TimelineItem } from '../../../shared/structured-agent'

type Usage = Extract<AgentEventData, { type: 'usage' }>
type UsageItem = TimelineItem & { data: Usage }
const tokenFields = ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'cacheCreationTokens', 'totalTokens'] as const
type TokenField = typeof tokenFields[number]
export type TokenFigures = Partial<Record<TokenField, number>>
export interface UsageSummary {
  tokens?: TokenFigures
  scope: 'session' | 'reported' | 'latest'
  estimated: boolean
  costUsd?: number
  costEstimated: boolean
  costScope: 'session' | 'reported' | 'latest'
  limits?: Json
  contextWindow?: number
}

function object(value: Json | undefined): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
export function updatedSequence(item: TimelineItem): number { return item.updatedSequence ?? item.sequence }
function hasTokens(value: Usage): boolean { return tokenFields.some(key => number(value[key]) !== undefined) }
function figures(value: Usage): TokenFigures {
  const tokens: TokenFigures = {}
  for (const key of tokenFields) {
    const count = number(value[key])
    if (count !== undefined) tokens[key] = count
  }
  if (tokens.totalTokens === undefined && tokens.inputTokens !== undefined && tokens.outputTokens !== undefined) tokens.totalTokens = tokens.inputTokens + tokens.outputTokens
  return tokens
}
function turnKey(item: TimelineItem): string { return JSON.stringify([item.runtimeId, item.turnId ?? 'unidentified']) }

/** Final turn totals replace message snapshots; cumulative session snapshots are never added. */
function scopedSnapshots(items: UsageItem[]): UsageItem[] {
  const turns = new Map<string, { final?: UsageItem; messages: Map<string, UsageItem> }>()
  for (const item of items) {
    const key = turnKey(item)
    const turn = turns.get(key) ?? { messages: new Map<string, UsageItem>() }
    if (item.data.scope === 'turn') turn.final = item
    if (item.data.scope === 'message') turn.messages.set(item.nativeItemId ?? item.id, item)
    turns.set(key, turn)
  }
  return [...turns.values()].flatMap(turn => turn.final ? [turn.final] : [...turn.messages.values()])
}
function sumFigures(items: UsageItem[]): TokenFigures {
  const snapshots = items.map(item => figures(item.data))
  const totals: TokenFigures = {}
  for (const key of tokenFields) {
    // A missing count is unknown, including when only some messages report it.
    if (snapshots.every(value => value[key] !== undefined)) totals[key] = snapshots.reduce((total, value) => total + value[key]!, 0)
  }
  return totals
}

export function summarizeUsage(items: TimelineItem[]): UsageSummary {
  const usage = items.filter((item): item is UsageItem => item.data.type === 'usage' && !item.parentId).sort((a, b) => updatedSequence(a) - updatedSequence(b))
  const tokenItems = usage.filter(item => hasTokens(item.data))
  const session = tokenItems.filter(item => item.data.scope === 'session').at(-1)
  const scoped = scopedSnapshots(tokenItems)
  const fallback = tokenItems.at(-1)
  const selected = session ? [session] : scoped.length ? scoped : fallback ? [fallback] : []
  const costItems = usage.filter(item => number(item.data.costUsd) !== undefined)
  const sessionCost = costItems.filter(item => item.data.scope === 'session').at(-1)
  const scopedCosts = scopedSnapshots(costItems)
  const costs = sessionCost ? [sessionCost] : scopedCosts.length ? scopedCosts : costItems.slice(-1)
  let limits: Record<string, Json> | undefined
  for (const item of usage) {
    if (item.data.limits === undefined) continue
    const next = object(item.data.limits)
    limits = { ...limits, ...next, ...(next.rateLimits && typeof next.rateLimits === 'object' && !Array.isArray(next.rateLimits) ? { rateLimits: { ...object(limits?.rateLimits), ...object(next.rateLimits) } } : {}) }
  }
  return {
    tokens: selected.length ? selected.length === 1 ? figures(selected[0]!.data) : sumFigures(selected) : undefined,
    scope: session ? 'session' : scoped.length ? 'reported' : 'latest',
    estimated: selected.some(item => item.data.source === 'estimate'),
    costUsd: costs.length ? costs.reduce((total, item) => total + item.data.costUsd!, 0) : undefined,
    costEstimated: costs.some(item => item.data.source === 'estimate'),
    costScope: sessionCost ? 'session' : scopedCosts.length ? 'reported' : 'latest',
    limits,
    contextWindow: number(limits?.modelContextWindow)
  }
}

export function liveTokenLabel(summary: UsageSummary): string {
  const tokens = summary.tokens
  const prefix = summary.estimated ? '~' : ''
  if (tokens?.totalTokens !== undefined) return `${prefix}${tokens.totalTokens.toLocaleString()} tokens`
  if (tokens?.outputTokens !== undefined) return `${prefix}${tokens.outputTokens.toLocaleString()} output tokens`
  if (tokens?.inputTokens !== undefined) return `${prefix}${tokens.inputTokens.toLocaleString()} input tokens`
  return 'Tokens pending'
}

export interface SubagentSummary {
  id: string
  name: string
  nativeSessionId?: string
  runtimeId: string
  startedAt: string
  updatedAt: string
  parentIds: string[]
  task?: string
  activity: TimelineItem[]
  status: ActivityStatus | 'unknown'
  sequence: number
}
const activeStatuses = new Set<ActivityStatus>(['preparing', 'running', 'awaiting_approval'])
const inactivePhases = new Set<SessionPhase>(['idle', 'completed', 'failed', 'disconnected', 'interrupted'])
export const subagentStatusLabels: Record<SubagentSummary['status'], string> = {
  preparing: 'Starting', running: 'Running', awaiting_approval: 'Needs approval', completed: 'Completed', failed: 'Failed', rejected: 'Declined', interrupted: 'Stopped', unknown: 'Status unavailable'
}

export function summarizeSubagents(items: TimelineItem[], runtimeId: string, phase: SessionPhase, includeActivity = true): SubagentSummary[] {
  const agents = new Map<string, SubagentSummary>()
  for (const item of [...items].sort((a, b) => updatedSequence(a) - updatedSequence(b))) {
    if (item.data.type !== 'subagent') continue
    const id = item.data.nativeSessionId ?? JSON.stringify([item.runtimeId, item.nativeItemId ?? item.id])
    const previous = agents.get(id)
    const genericName = ['Codex agent', 'Background activity', 'Agent'].includes(item.data.name)
    const name = genericName && previous ? previous.name : item.data.name
    const status = activeStatuses.has(item.data.status) && (item.runtimeId !== runtimeId || inactivePhases.has(phase)) ? 'unknown' : item.data.status
    agents.set(id, { id, name, nativeSessionId: item.data.nativeSessionId, runtimeId: item.runtimeId,
      startedAt: previous?.startedAt ?? item.timestamp, updatedAt: item.timestamp,
      parentIds: [...new Set([...(previous?.runtimeId === item.runtimeId ? previous.parentIds : []), item.parentId, item.nativeItemId].filter((value): value is string => Boolean(value)))],
      activity: [], status, sequence: previous?.sequence ?? item.sequence })
  }
  if (!includeActivity) return [...agents.values()].sort((a, b) => a.sequence - b.sequence)
  // A shared launch/wait tool is not evidence that every child produced its output.
  const owners = new Map<string, Set<string>>()
  for (const agent of agents.values()) for (const parent of agent.parentIds) {
    const key = JSON.stringify([agent.runtimeId, parent])
    const ids = owners.get(key) ?? new Set<string>()
    ids.add(agent.id); owners.set(key, ids)
  }
  for (const agent of agents.values()) {
    const parents = new Set(agent.parentIds.filter(parent => owners.get(JSON.stringify([agent.runtimeId, parent]))?.size === 1))
    const scoped = items.filter(item => item.runtimeId === agent.runtimeId)
    const launch = scoped.find(item => item.nativeItemId && parents.has(item.nativeItemId) && item.data.type === 'tool')
    if (launch?.data.type === 'tool') {
      const input = object(launch.data.input)
      agent.task = typeof input.prompt === 'string' ? input.prompt : typeof input.message === 'string' ? input.message : launch.data.description
    }
    // Follow nested tool parents, independent of arrival order.
    let changed = true
    while (changed) {
      changed = false
      for (const item of scoped) if (item.parentId && parents.has(item.parentId) && item.nativeItemId && !parents.has(item.nativeItemId) && item.data.type !== 'subagent') {
        parents.add(item.nativeItemId); changed = true
      }
    }
    agent.activity = scoped.filter(item => item.parentId && parents.has(item.parentId) && ['text', 'tool', 'error', 'changes'].includes(item.data.type)).sort((a, b) => updatedSequence(a) - updatedSequence(b))
    const latest = agent.activity.at(-1)
    if (latest && latest.timestamp > agent.updatedAt) agent.updatedAt = latest.timestamp
  }
  return [...agents.values()].sort((a, b) => a.sequence - b.sequence)
}

export function subagentCountLabel(agents: SubagentSummary[]): string {
  const running = agents.filter(agent => agent.status === 'running' || agent.status === 'preparing').length
  const waiting = agents.filter(agent => agent.status === 'awaiting_approval').length
  const completed = agents.filter(agent => agent.status === 'completed').length
  const failed = agents.filter(agent => agent.status === 'failed').length
  const stopped = agents.filter(agent => agent.status === 'interrupted' || agent.status === 'rejected').length
  const unknown = agents.filter(agent => agent.status === 'unknown').length
  return [`${agents.length} subagent${agents.length === 1 ? '' : 's'}`, running ? `${running} running` : '', waiting ? `${waiting} awaiting approval` : '', completed ? `${completed} completed` : '', failed ? `${failed} failed` : '', stopped ? `${stopped} stopped` : '', unknown ? `${unknown} unknown` : ''].filter(Boolean).join(' · ')
}
