import type { AgentEventData, Json, StructuredProvider, TimelineItem } from './structured-agent'

type Usage = Extract<AgentEventData, { type: 'usage' }>
type UsageItem = TimelineItem & { data: Usage }
const tokenFields = ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'cacheCreationTokens', 'totalTokens'] as const
type TokenField = typeof tokenFields[number]
export type TokenFigures = Partial<Record<TokenField, number>>

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
    limits = {
      ...limits, ...next,
      ...(next.rateLimits && typeof next.rateLimits === 'object' && !Array.isArray(next.rateLimits) ? { rateLimits: { ...object(limits?.rateLimits), ...object(next.rateLimits) } } : {}),
      ...(next.rateLimitsByLimitId && typeof next.rateLimitsByLimitId === 'object' && !Array.isArray(next.rateLimitsByLimitId) ? { rateLimitsByLimitId: { ...object(limits?.rateLimitsByLimitId), ...object(next.rateLimitsByLimitId) } } : {})
    }
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

export interface ContextSummary { used: number; capacity: number; window?: number; percent: number; level: 'normal' | 'warning' | 'critical' }
export function summarizeContext(items: TimelineItem[], runtimeId?: string): ContextSummary | undefined {
  const root = items.filter(item => !item.parentId)
  const runtime = runtimeId ?? root.at(-1)?.runtimeId
  const usage = root.filter(item => item.runtimeId === runtime && item.data.type === 'usage').sort((a, b) => updatedSequence(a) - updatedSequence(b))
  let used: number | undefined, capacity: number | undefined, window: number | undefined
  for (const item of usage) {
    if (item.data.type !== 'usage') continue
    const limits = object(item.data.limits)
    if ('contextUsedTokens' in limits) used = number(limits.contextUsedTokens)
    if ('contextCapacityTokens' in limits) capacity = number(limits.contextCapacityTokens)
    if ('modelContextWindow' in limits) window = number(limits.modelContextWindow)
  }
  if (used === undefined || capacity === undefined || capacity <= 0) return undefined
  const percent = Math.min(100, used / capacity * 100)
  return { used, capacity, window, percent, level: percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal' }
}

/** Undefined means still pending; callers render a loader instead of text. */
export function liveTokenLabel(summary: UsageSummary): string | undefined {
  const count = summary.tokens?.outputTokens
  return count === undefined ? undefined : `${summary.estimated ? '~' : ''}${count.toLocaleString()} output tokens`
}

/** Working text describes the current response, never its input context or session total. */
export function summarizeWorkingUsage(items: TimelineItem[]): UsageSummary {
  const root = items.filter(item => !item.parentId)
  const latestUser = root.filter(item => item.data.type === 'text' && item.data.role === 'user').at(-1)
  const runtime = root.at(-1)?.runtimeId
  const usage = root.filter((item): item is UsageItem => item.runtimeId === runtime && item.data.type === 'usage' && updatedSequence(item) > (latestUser?.sequence ?? 0))
    .sort((a, b) => updatedSequence(a) - updatedSequence(b))
  for (const item of usage.reverse()) {
    const latestOutput = number(object(item.data.limits).workingOutputTokens)
    const output = latestOutput ?? (item.data.scope !== 'session' ? number(item.data.outputTokens) : undefined)
    if (output !== undefined) return { tokens: { outputTokens: output }, scope: 'latest', estimated: item.data.source === 'estimate', costEstimated: false, costScope: 'latest' }
  }
  return { scope: 'latest', estimated: false, costEstimated: false, costScope: 'latest' }
}

/* ------------------------------------------------------------------------- *
 * Account allowance windows
 *
 * Both adapters normalize their provider's own account telemetry into
 * `limits.rateLimits`: Codex reports `account/rateLimits/updated` windows and
 * Claude reports `rate_limit_event` unified windows. Everything below reads
 * only those reported values; nothing here models a plan Conductor cannot see.
 * ------------------------------------------------------------------------- */

export type UsageWindowKind = 'weekly' | 'short' | 'other'
export interface UsageWindow {
  key: string
  kind: UsageWindowKind
  label: string
  windowMinutes?: number
  /** Exactly as reported by the provider, on a 0-100 scale. */
  usedPercent: number
  /** ISO instant; absent when the provider reported no reset time. */
  resetsAt?: string
  /** Retained for old provider snapshots; model-scoped Fable usage is not universal overage. */
  overage: boolean
  /** Provider-wide windows apply to every model; model windows only to a reported selector. */
  scope: 'provider' | 'model'
  /** Provider-owned model identifiers/names. Conductor never invents a model-to-bucket table. */
  modelSelectors?: string[]
}

const WEEKLY_MINUTES = 10_080
function windowKind(minutes: number | undefined): UsageWindowKind {
  if (minutes === undefined || minutes <= 0) return 'other'
  return minutes >= WEEKLY_MINUTES ? 'weekly' : 'short'
}
export function usageWindowLabel(minutes: number | undefined, overage = false, model?: string): string {
  const base = minutes === WEEKLY_MINUTES ? 'Weekly'
    : minutes === 1440 ? 'Daily'
    : minutes !== undefined && minutes > 0 ? (minutes % 60 === 0 ? `${minutes / 60} hour` : `${minutes} minute`)
    : 'Usage window'
  if (model) return `${model} ${base.toLowerCase()}`
  return overage ? `${base} (incl. overage)` : base
}

const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const providerLimitIds = new Set(['default', 'codex', 'claude'])
const selectorTokens = (value: string): string[] => value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** A provider-owned selector must actually occur in the catalog identity. Substring guesses such
 * as treating every "codex" model as one Codex model bucket are deliberately not allowed. */
export function usageWindowAppliesToModel(window: UsageWindow, model: { id: string; label?: string } | string | undefined): boolean {
  if (window.scope === 'provider') return true
  if (!model || !window.modelSelectors?.length) return false
  const identities = typeof model === 'string' ? [model] : [model.id, model.label ?? '']
  const identityTokens = identities.map(selectorTokens)
  return window.modelSelectors.some(selector => {
    const wanted = selectorTokens(selector)
    return wanted.length > 0 && identityTokens.some(tokens => {
      if (wanted.length > tokens.length) return false
      return tokens.some((_, start) => wanted.every((token, offset) => tokens[start + offset] === token))
    })
  })
}

function normalizedWindow(key: string, value: Json, metadata: { scope: UsageWindow['scope']; modelSelectors?: string[]; label?: string; overage?: boolean }): UsageWindow | undefined {
  const limit = object(value)
  const usedPercent = number(limit.usedPercent)
  if (usedPercent === undefined) return undefined
  const windowMinutes = number(limit.windowDurationMins)
  const seconds = number(limit.resetsAt)
  const resetsAt = seconds === undefined ? undefined : new Date(seconds * 1000)
  return {
    key, kind: windowKind(windowMinutes), label: metadata.label ?? usageWindowLabel(windowMinutes, metadata.overage), windowMinutes, usedPercent,
    overage: metadata.overage ?? false, scope: metadata.scope,
    ...(metadata.modelSelectors?.length ? { modelSelectors: metadata.modelSelectors } : {}),
    ...(resetsAt && !Number.isNaN(resetsAt.getTime()) ? { resetsAt: resetsAt.toISOString() } : {})
  }
}

function snapshotWindows(bucketKey: string, value: Json): UsageWindow[] {
  const snapshot = object(value)
  const limitId = string(snapshot.limitId) ?? bucketKey
  const limitName = string(snapshot.limitName)
  const providerWide = providerLimitIds.has(limitId.toLocaleLowerCase())
  const metadata = providerWide
    ? { scope: 'provider' as const }
    : { scope: 'model' as const, modelSelectors: [limitId, ...(limitName ? [limitName] : [])] }
  return ['primary', 'secondary'].flatMap(name => {
    const window = normalizedWindow(`${limitId}:${name}`, snapshot[name] ?? null, metadata)
    return window ? [window] : []
  })
}

/** Reads one reported snapshot. Entries without a reported percentage are dropped, never zeroed.
 * Supports Claude's normalized keyed windows, Codex sparse snapshots, and Codex's full
 * `rateLimitsByLimitId` response without guessing which model a provider-owned bucket names. */
export function normalizeUsageWindows(limits: Json | undefined): UsageWindow[] {
  const root = object(limits)
  const byLimitId = object(root.rateLimitsByLimitId)
  const rateLimits = object(root.rateLimits)
  const windows: UsageWindow[] = []
  if (Object.keys(byLimitId).length) {
    for (const [key, value] of Object.entries(byLimitId)) windows.push(...snapshotWindows(key, value))
  } else if ('primary' in rateLimits || 'secondary' in rateLimits) {
    windows.push(...snapshotWindows('default', rateLimits))
  } else {
    for (const [key, value] of Object.entries(rateLimits)) {
      const reported = object(value)
      const fable = key === 'seven_day_overage_included'
      const reportedSelectors = Array.isArray(reported.modelSelectors) ? reported.modelSelectors.filter((selector): selector is string => typeof selector === 'string' && Boolean(selector.trim())) : []
      const reportedModelScope = reported.scope === 'model' && reportedSelectors.length > 0
      const window = normalizedWindow(key, value, reportedModelScope
        ? { scope: 'model', modelSelectors: reportedSelectors, ...(string(reported.label) ? { label: string(reported.label)! } : {}) }
        : fable
        ? { scope: 'model', modelSelectors: ['fable'], label: 'Fable weekly' }
        : { scope: 'provider', overage: key.includes('overage') })
      if (window) windows.push(window)
    }
  }
  // Longest window first so the plan-level allowance leads; unknown durations last.
  return windows.sort((a, b) => (b.windowMinutes ?? -1) - (a.windowMinutes ?? -1))
}

export interface UsageWindowMovement extends UsageWindow {
  /** The first level this scope observed. The difference to `usedPercent` is account-wide movement. */
  startPercent: number
  /** Undefined when the window rolled over mid-scope and the earlier share is unattributable. */
  consumedPercent?: number
  windowReset: boolean
  samples: number
}

function rootUsage(items: TimelineItem[], runtimeId?: string): UsageItem[] {
  return items
    .filter((item): item is UsageItem => item.data.type === 'usage' && !item.parentId && (runtimeId === undefined || item.runtimeId === runtimeId))
    .sort((a, b) => updatedSequence(a) - updatedSequence(b))
}

/**
 * How far each account window moved while this scope was open. The provider reports one
 * account-wide level, so the movement bounds this conversation's share from above: other
 * conversations on the same account move the same counter.
 */
export function accountWindowMovement(items: TimelineItem[], runtimeId?: string, model?: string): UsageWindowMovement[] {
  const tracked = new Map<string, { first: UsageWindow; last: UsageWindow; samples: number; reset: boolean }>()
  for (const item of rootUsage(items, runtimeId)) {
    for (const window of normalizeUsageWindows(item.data.limits).filter(window => usageWindowAppliesToModel(window, model))) {
      const previous = tracked.get(window.key)
      if (!previous) { tracked.set(window.key, { first: window, last: window, samples: 1, reset: false }); continue }
      previous.samples += 1
      // A drop means the provider's window rolled over; earlier consumption belongs to the expired window.
      if (window.usedPercent < previous.last.usedPercent) { previous.reset = true; previous.first = window }
      previous.last = window
    }
  }
  return [...tracked.values()]
    .map(entry => ({
      ...entry.last,
      startPercent: entry.first.usedPercent,
      windowReset: entry.reset,
      samples: entry.samples,
      ...(entry.reset ? {} : { consumedPercent: Math.max(0, entry.last.usedPercent - entry.first.usedPercent) })
    }))
    .sort((a, b) => (b.windowMinutes ?? -1) - (a.windowMinutes ?? -1))
}

export const weeklyWindow = <T extends UsageWindow>(windows: T[], model?: string): T | undefined =>
  windows.filter(window => window.kind === 'weekly' && usageWindowAppliesToModel(window, model)).sort((a, b) => b.usedPercent - a.usedPercent)[0]
export const shortWindow = <T extends UsageWindow>(windows: T[], model?: string): T | undefined =>
  windows.filter(window => window.kind === 'short' && usageWindowAppliesToModel(window, model)).sort((a, b) => b.usedPercent - a.usedPercent || (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))[0]

export interface UsageScopeReport {
  scope: 'conversation' | 'run'
  runtimeId?: string
  model?: string
  windows: UsageWindowMovement[]
  tokens?: TokenFigures
  tokensScope: UsageSummary['scope']
  tokensEstimated: boolean
  costUsd?: number
  costEstimated: boolean
  /** Distinct provider turn identifiers seen in this scope. Derived from the timeline, not reported. */
  turns: number
  /** Number of usage reports the provider sent in this scope. Derived. */
  usageReports: number
  /** First to last recorded event in this scope. Derived from Conductor's own clock. */
  wallMs?: number
  startedAt?: string
  endedAt?: string
}

function scopeReport(items: TimelineItem[], scope: UsageScopeReport['scope'], runtimeId?: string, model?: string): UsageScopeReport {
  const scoped = runtimeId === undefined ? items : items.filter(item => item.runtimeId === runtimeId)
  const summary = summarizeUsage(scoped)
  const ordered = [...scoped].filter(item => !item.parentId).sort((a, b) => updatedSequence(a) - updatedSequence(b))
  const startedAt = ordered[0]?.timestamp, endedAt = ordered.at(-1)?.timestamp
  const start = startedAt ? Date.parse(startedAt) : NaN, end = endedAt ? Date.parse(endedAt) : NaN
  const wallMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
  return {
    scope, runtimeId, model,
    windows: accountWindowMovement(scoped, runtimeId, model),
    tokens: summary.tokens, tokensScope: summary.scope, tokensEstimated: summary.estimated,
    costUsd: summary.costUsd, costEstimated: summary.costEstimated,
    turns: new Set(ordered.filter(item => item.turnId).map(item => JSON.stringify([item.runtimeId, item.turnId]))).size,
    usageReports: rootUsage(scoped, runtimeId).length,
    ...(wallMs !== undefined ? { wallMs } : {}), ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {})
  }
}

export interface UsageRunReport {
  provider?: StructuredProvider
  model?: string
  effort?: string
  /** Everything this Conductor conversation has recorded, across resumes. */
  conversation: UsageScopeReport
  /** The current provider process only. Absent when nothing has run yet. */
  run?: UsageScopeReport
  /** The latest absolute account levels the provider reported. */
  currentWindows: UsageWindow[]
  /** Figures the provider itself reported. */
  measured: string[]
  /** Figures Conductor computed from those reports or from its own clock. */
  derived: string[]
}

/** The whole-run accounting behind "this conversation used N% of your weekly". */
export function summarizeUsageRun(items: TimelineItem[], runtimeId?: string, modelHint?: string): UsageRunReport {
  const root = items.filter(item => !item.parentId).sort((a, b) => updatedSequence(a) - updatedSequence(b))
  const runtime = runtimeId ?? root.at(-1)?.runtimeId
  let provider: StructuredProvider | undefined, model: string | undefined = modelHint, effort: string | undefined
  for (const item of root) {
    if (item.data.type !== 'session') continue
    provider = item.data.capabilities?.provider ?? provider
    const effective = object(item.data.capabilities?.effectiveSettings)
    if (!modelHint) model = (typeof effective.model === 'string' ? effective.model : undefined) ?? item.data.settings?.model ?? model
    effort = (typeof effective.effort === 'string' ? effective.effort : undefined) ?? item.data.settings?.effort ?? effort
  }
  const conversation = scopeReport(items, 'conversation', undefined, model)
  const run = runtime && root.some(item => item.runtimeId === runtime) ? scopeReport(items, 'run', runtime, model) : undefined
  const measured: string[] = [], derived: string[] = []
  if (conversation.tokens) measured.push(conversation.tokensEstimated ? 'Token counts (provider figures include estimated entries)' : 'Token counts, reported by the provider')
  const currentWindows = normalizeUsageWindows(summarizeUsage(items).limits).filter(window => usageWindowAppliesToModel(window, model))
  if (currentWindows.length) measured.push('Account allowance levels, reported by the provider')
  if (conversation.costUsd !== undefined) measured.push(conversation.costEstimated ? 'Cost, estimated by the provider CLI from its own price table (not a subscription charge)' : 'Cost, reported by the provider')
  if (conversation.windows.some(window => window.consumedPercent !== undefined && window.samples > 1)) derived.push('Share consumed here: the difference between the first and latest account level reported while this conversation was open. The account counter also moves for other conversations, so this is an upper bound.')
  if (conversation.turns) derived.push('Turn count, from provider turn identifiers on this timeline')
  if (conversation.wallMs !== undefined) derived.push("Wall time, from Conductor's own clock between the first and last recorded event")
  return { provider, model, effort, conversation, run, currentWindows, measured, derived }
}

/* ------------------------------------------------------------------------- *
 * Usage caps
 * ------------------------------------------------------------------------- */

export type UsageCapMetric = 'weekly-percent' | 'short-window-percent' | 'tokens'
export type UsageCapBasis = 'conversation' | 'account'
export interface UsageCap {
  metric: UsageCapMetric
  /** Percentage points for window metrics, whole tokens for the token metric. */
  limit: number
  /** `conversation` caps what this conversation consumed; `account` caps the absolute account level. */
  basis: UsageCapBasis
}
/** An explicit "no cap" so a tab can opt out of a workspace cap rather than inherit it. */
export type UsageCapSetting = UsageCap | { metric: 'none' }
export const NO_USAGE_CAP: UsageCapSetting = { metric: 'none' }
export const isUsageCap = (setting: UsageCapSetting | null | undefined): setting is UsageCap =>
  Boolean(setting) && setting!.metric !== 'none'

const metrics: UsageCapMetric[] = ['weekly-percent', 'short-window-percent', 'tokens']
export function parseUsageCapSetting(value: unknown): UsageCapSetting | null {
  const raw = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  const setting = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!setting) return null
  if (setting.metric === 'none') return NO_USAGE_CAP
  if (!metrics.includes(setting.metric as UsageCapMetric)) return null
  const limit = typeof setting.limit === 'number' && Number.isFinite(setting.limit) ? setting.limit : NaN
  const metric = setting.metric as UsageCapMetric
  if (!(limit > 0)) return null
  if (metric !== 'tokens' && limit > 100) return null
  const basis: UsageCapBasis = metric === 'tokens' || setting.basis === 'conversation' ? 'conversation' : setting.basis === 'account' ? 'account' : 'conversation'
  return { metric, limit: metric === 'tokens' ? Math.floor(limit) : limit, basis }
}

export function describeUsageCap(setting: UsageCapSetting, windows: UsageWindow[] = []): string {
  if (!isUsageCap(setting)) return 'No usage cap'
  if (setting.metric === 'tokens') return `Stop after ${setting.limit.toLocaleString()} tokens in this conversation`
  const window = setting.metric === 'weekly-percent' ? weeklyWindow(windows) : shortWindow(windows)
  const name = window?.label ?? (setting.metric === 'weekly-percent' ? 'Weekly' : 'Short')
  return setting.basis === 'account'
    ? `Stop when the account reaches ${setting.limit}% of the ${name.toLowerCase()} allowance`
    : `Stop after this conversation consumes ${setting.limit} points of the ${name.toLowerCase()} allowance`
}

export type UsageCapScope = 'tab' | 'workspace' | 'default'
/** What is configured at each scope plus which one actually applies. */
export interface UsageCapSnapshot {
  tab: UsageCapSetting | null
  workspace: UsageCapSetting | null
  default: UsageCapSetting | null
  effective: { setting: UsageCapSetting; scope: UsageCapScope } | null
}

export interface UsageCapStatus {
  cap: UsageCap
  unit: 'percent' | 'tokens'
  limit: number
  /** Undefined when the provider has not reported enough to evaluate the cap. */
  value?: number
  reached: boolean
  /** A sentence naming the measured figure the decision rests on, or why there is none. */
  detail: string
}

export function evaluateUsageCap(cap: UsageCap, report: UsageScopeReport): UsageCapStatus {
  if (cap.metric === 'tokens') {
    const value = report.tokens?.totalTokens
    return {
      cap, unit: 'tokens', limit: cap.limit, value, reached: value !== undefined && value >= cap.limit,
      detail: value === undefined
        ? 'The provider has not reported a total token count for this conversation yet.'
        : `${value.toLocaleString()} of ${cap.limit.toLocaleString()} capped tokens reported for this conversation${report.tokensEstimated ? ' (includes estimated figures)' : ''}.`
    }
  }
  const window = cap.metric === 'weekly-percent' ? weeklyWindow(report.windows, report.model) : shortWindow(report.windows, report.model)
  const name = window?.label ?? (cap.metric === 'weekly-percent' ? 'weekly' : 'short')
  if (!window) return { cap, unit: 'percent', limit: cap.limit, reached: false, detail: `The provider has not reported a ${name.toLowerCase()} allowance window, so this cap cannot be evaluated.` }
  if (cap.basis === 'account') {
    return {
      cap, unit: 'percent', limit: cap.limit, value: window.usedPercent, reached: window.usedPercent >= cap.limit,
      detail: `${window.label} allowance is at ${round(window.usedPercent)}% account-wide, against a ${cap.limit}% cap.`
    }
  }
  if (window.consumedPercent === undefined) {
    return { cap, unit: 'percent', limit: cap.limit, reached: false, detail: `The ${window.label.toLowerCase()} window reset while this conversation was open, so its share before the reset cannot be attributed.` }
  }
  return {
    cap, unit: 'percent', limit: cap.limit, value: window.consumedPercent, reached: window.consumedPercent >= cap.limit,
    detail: `The ${window.label.toLowerCase()} allowance moved from ${round(window.startPercent)}% to ${round(window.usedPercent)}% while this conversation was open (${round(window.consumedPercent)} points, account-wide), against a ${cap.limit} point cap.`
  }
}

const round = (value: number): number => Math.round(value * 10) / 10
