import type { ActivityStatus, AgentEventData, Json, SessionPhase, TimelineItem } from '../../../shared/structured-agent'
import type { AgentProviderId } from '../../../shared/models'
import { updatedSequence, type TokenFigures } from '../../../shared/usage-accounting'
import { modelDisplayName } from './composer-settings'

function object(value: Json | undefined): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Account and token accounting is shared with the main process, which enforces usage caps
 *  against the same figures the panel shows. Re-exported so panes keep one import site. */
export {
  accountWindowMovement, describeUsageCap, evaluateUsageCap, isUsageCap, liveTokenLabel, normalizeUsageWindows,
  NO_USAGE_CAP, parseUsageCapSetting, shortWindow, summarizeContext, summarizeUsage, summarizeUsageRun,
  summarizeWorkingUsage, updatedSequence, usageWindowLabel, weeklyWindow
} from '../../../shared/usage-accounting'
export type {
  ContextSummary, TokenFigures, UsageCap, UsageCapBasis, UsageCapMetric, UsageCapSetting, UsageCapSnapshot,
  UsageCapStatus, UsageRunReport, UsageScopeReport, UsageSummary, UsageWindow, UsageWindowKind, UsageWindowMovement
} from '../../../shared/usage-accounting'
// "Becoming expensive" while a conversation runs, well before a cap would stop it -- one
// shared definition with the tab-strip's own warning and the cross-project Processes summary.
export { evaluateUsageWarning } from '../../../shared/usage-warning'
export type { UsageWarning, UsageWarningLevel } from '../../../shared/usage-warning'

export interface SubagentSummary {
  id: string
  name: string
  nativeSessionId?: string
  runtimeId: string
  startedAt: string
  updatedAt: string
  parentIds: string[]
  task?: string
  outputFile?: string
  output?: string
  outputTruncated?: boolean
  outputError?: string
  activity: TimelineItem[]
  status: ActivityStatus | 'unknown'
  /** Background work that keeps running after the turn that launched it ends. */
  detached: boolean
  /** Set when this task is itself running one of Conductor's own agent runtimes. */
  linkedProvider?: AgentProviderId
  sequence: number
  /** Only reported for a genuine spawned agent thread (Codex); a bash background task has no model. */
  model?: string
  effort?: string
  /** The LLM vendor behind `model` (e.g. 'openai', 'anthropic'), which can differ from this
   *  conversation's own provider when a collab agent is spawned on another company's model. */
  modelProvider?: string
  /** Token usage attributed to this subagent's own scope, when the provider reports it per child. */
  tokens?: TokenFigures
  tokensEstimated?: boolean
}
/** Match the executable, not a passing mention, so a prompt about Codex is not a Codex run. */
const providerCommands: Array<{ provider: AgentProviderId; pattern: RegExp }> = [
  { provider: 'codex', pattern: /(^|[\\/\s"'])codex(\.\w+)?(\s|$)/i },
  { provider: 'claude', pattern: /(^|[\\/\s"'])claude(\.\w+)?(\s|$)/i },
  { provider: 'gemini', pattern: /(^|[\\/\s"'])gemini(\.\w+)?(\s|$)/i },
  { provider: 'qwen', pattern: /(^|[\\/\s"'])qwen(\.\w+)?(\s|$)/i },
  { provider: 'kimi', pattern: /(^|[\\/\s"'])kimi(\.\w+)?(\s|$)/i }
]

export const providerOfCommand = (command: string): AgentProviderId | undefined =>
  providerCommands.find(candidate => candidate.pattern.test(command))?.provider

const tokenFields = ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'cacheCreationTokens', 'totalTokens'] as const
/** A subagent's own token usage is a per-thread cumulative snapshot (Codex), not a stream of
 *  per-message deltas to reconcile, so the latest reported snapshot is the whole answer. */
function subagentTokenTotals(items: TimelineItem[]): { tokens?: TokenFigures; estimated: boolean } {
  const usage = items.filter((item): item is TimelineItem & { data: Extract<AgentEventData, { type: 'usage' }> } => item.data.type === 'usage').sort((a, b) => updatedSequence(a) - updatedSequence(b)).at(-1)
  if (!usage) return { estimated: false }
  const tokens: TokenFigures = {}
  for (const key of tokenFields) {
    const value = usage.data[key]
    if (typeof value === 'number' && Number.isFinite(value)) tokens[key] = value
  }
  if (tokens.totalTokens === undefined && tokens.inputTokens !== undefined && tokens.outputTokens !== undefined) tokens.totalTokens = tokens.inputTokens + tokens.outputTokens
  return Object.keys(tokens).length ? { tokens, estimated: usage.data.source === 'estimate' } : { estimated: false }
}
/** Matches the "GPT 6 Astra xhigh" convention the composer uses; a subagent should never look
 *  like it ran on an unnamed default model when the provider actually told us which one. */
export function subagentModelLabel(agent: Pick<SubagentSummary, 'model' | 'effort'>): string | undefined {
  return agent.model ? [modelDisplayName(agent.model), agent.effort].filter(Boolean).join(' · ') : undefined
}
export function subagentTokenLabel(agent: Pick<SubagentSummary, 'tokens' | 'tokensEstimated'>): string | undefined {
  const total = agent.tokens?.totalTokens ?? (agent.tokens?.inputTokens !== undefined && agent.tokens?.outputTokens !== undefined ? agent.tokens.inputTokens + agent.tokens.outputTokens : undefined)
  return total === undefined ? undefined : `${agent.tokensEstimated ? '~' : ''}${total.toLocaleString()} tokens`
}

const activeStatuses = new Set<ActivityStatus>(['preparing', 'running', 'awaiting_approval'])
const inactivePhases = new Set<SessionPhase>(['idle', 'completed', 'failed', 'disconnected', 'interrupted'])
export const subagentStatusLabels: Record<SubagentSummary['status'], string> = {
  preparing: 'Starting', running: 'Running', awaiting_approval: 'Needs approval', completed: 'Completed', failed: 'Failed', rejected: 'Declined', interrupted: 'Stopped', unknown: 'Status unavailable'
}
export const isGenericSubagentName = (name: string): boolean => ['Codex agent', 'Background activity', 'Agent'].includes(name)
/** Same identity notion summarizeSubagents groups lifecycle events by, exposed so nested "Within X" labels name the same agent the subagent roster counts. */
export const subagentIdentityId = (data: Extract<AgentEventData, { type: 'subagent' }>, runtimeId: string, nativeItemId: string | undefined, fallbackId: string): string =>
  data.nativeSessionId ?? JSON.stringify([runtimeId, nativeItemId ?? fallbackId])
export const subagentColorBuckets = 6
/** A small deterministic hash keeps one subagent's color stable across re-renders and reconnects without persisting an assigned index anywhere. */
export function subagentColorIndex(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return hash % subagentColorBuckets
}
/** Same-named subagents ("Codex agent" ×3) are meaningless in a nested label unless numbered; a unique name needs no suffix. */
export function distinguishSubagentLabels(agents: Array<{ id: string; name: string }>): Map<string, string> {
  const groups = new Map<string, Array<{ id: string; name: string }>>()
  for (const agent of agents) { const list = groups.get(agent.name) ?? []; list.push(agent); groups.set(agent.name, list) }
  const labels = new Map<string, string>()
  for (const [name, group] of groups) group.forEach((agent, index) => labels.set(agent.id, group.length > 1 ? `${name} #${index + 1}` : name))
  return labels
}

export function summarizeSubagents(items: TimelineItem[], runtimeId: string, phase: SessionPhase, includeActivity = true): SubagentSummary[] {
  const agents = new Map<string, SubagentSummary>()
  const legacyShellTasks = new Set<string>()
  for (const item of [...items].sort((a, b) => updatedSequence(a) - updatedSequence(b))) {
    if (item.data.type !== 'subagent') continue
    const id = subagentIdentityId(item.data, item.runtimeId, item.nativeItemId, item.id)
    const previous = agents.get(id)
    const genericName = isGenericSubagentName(item.data.name)
    const name = genericName && previous ? previous.name : item.data.name
    // A finished turn cannot vouch for a child that still claims to be running, but
    // detached background work is defined to outlive its turn. Only a genuinely
    // different runtime makes a detached task's reported status unverifiable.
    const stale = item.data.detached ? item.runtimeId !== runtimeId : item.runtimeId !== runtimeId || inactivePhases.has(phase)
    const status = activeStatuses.has(item.data.status) && stale ? 'unknown' : item.data.status
    agents.set(id, { id, name, nativeSessionId: item.data.nativeSessionId, runtimeId: item.runtimeId, detached: item.data.detached ?? false,
      startedAt: previous?.startedAt ?? item.timestamp, updatedAt: item.timestamp,
      parentIds: [...new Set([...(previous?.runtimeId === item.runtimeId ? previous.parentIds : []), item.parentId, item.nativeItemId].filter((value): value is string => Boolean(value)))],
      activity: [], outputFile: item.data.outputFile ?? previous?.outputFile, output: item.data.output ?? previous?.output, outputTruncated: item.data.outputTruncated ?? previous?.outputTruncated, outputError: item.data.outputError, status, sequence: previous?.sequence ?? item.sequence,
      model: item.data.model ?? previous?.model, effort: item.data.effort ?? previous?.effort, modelProvider: item.data.modelProvider ?? previous?.modelProvider })
  }
  for (const agent of agents.values()) {
    const launch = items.find(item => item.runtimeId === agent.runtimeId && item.nativeItemId && agent.parentIds.includes(item.nativeItemId) && item.data.type === 'tool')
    if (launch?.data.type === 'tool' && agent.detached && ['bash', 'powershell', 'shell'].includes(launch.data.name.toLowerCase())) legacyShellTasks.add(agent.id)
  }
  const visibleAgents = (): SubagentSummary[] => [...agents.values()].filter(agent => !legacyShellTasks.has(agent.id)).sort((a, b) => a.sequence - b.sequence)
  if (!includeActivity) return visibleAgents()
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
      // Older projections classified any background task with output_file as a subagent. The
      // parent tool is the durable discriminator available in that saved history: Bash and
      // PowerShell are processes, while Agent/Task launches remain genuine model-called agents.
      const input = object(launch.data.input)
      // Backgrounded shell work carries a command rather than a prompt; without it these
      // tasks render with no description at all.
      const command = typeof input.command === 'string' ? input.command : undefined
      agent.task = typeof input.prompt === 'string' ? input.prompt : typeof input.message === 'string' ? input.message : command ?? launch.data.description
      agent.linkedProvider = command ? providerOfCommand(command) : undefined
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
    const totals = subagentTokenTotals(scoped.filter(item => item.parentId && parents.has(item.parentId) && item.data.type === 'usage'))
    agent.tokens = totals.tokens
    agent.tokensEstimated = totals.estimated
    const latest = agent.activity.at(-1)
    if (latest && latest.timestamp > agent.updatedAt) agent.updatedAt = latest.timestamp
  }
  return visibleAgents()
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
