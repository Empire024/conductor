import type { DurableJobBudgets, DurableJobEvent } from '../../shared/durable-jobs.ts'

/**
 * Bounded waits for a durable local-model job: one watch per model call, tool call or stage,
 * fed by progress signals, driven by `tick()` on the controller's interval. Nothing here owns a
 * timer or a model; the clock, the health probe and the event sink are passed in, so the tests
 * run the whole ladder on a fake clock.
 *
 * Exported surface (Opus A wires it from ports.ts):
 *   type DurableJobEventDraft = Pick<DurableJobEvent, 'kind' | 'message' | 'data'>
 *   type WatchScope = 'model-call' | 'tool-call' | 'stage'
 *   type ProgressSignal = { kind: 'tokens'; count } | { kind: 'prompt-processing' } | { kind: 'tool-started'; name }
 *     | { kind: 'tool-finished'; name; failed } | { kind: 'file-diff'; path } | { kind: 'test-ran'; command; outcome }
 *     | { kind: 'decision'; summary } | { kind: 'stage-output'; summary }
 *   interface HealthProbe { healthy: boolean; processing?: boolean; detail?: string }
 *   interface WatchdogPorts { now(): number; probeHealth(): Promise<HealthProbe>; emit(event: DurableJobEventDraft): void }
 *   interface WatchdogOptions { tickMs; clockJumpMs; stallAfterMs; extensionFraction; maxModelCallRetries; maxToolCallRetries }
 *   const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions
 *   type WatchDecision = { watchId; scope; label; action: 'ok' | 'extend' | 'interrupt' | 'reconcile'; reason; diagnostics }
 *   type RetryDecision = { action: 'retry'; attempt; remaining } | { action: 'block'; attempt; reason; nextAction; diagnostics }
 *   class Watchdog(budgets: DurableJobBudgets, ports: WatchdogPorts, options?: Partial<WatchdogOptions>)
 *     begin(scope, label, key?): string            -> watch id; `key` groups retries of the same call
 *     signal(watchId, signal: ProgressSignal): void -> any signal resets the no-progress clock
 *     end(watchId): void
 *     pause(): void / resume(): void               -> owner pause: suspended time never counts
 *     tick(): Promise<WatchDecision[]>             -> decisions that are not 'ok'
 *     afterInterrupt(watchId | key, scope): RetryDecision
 *     active(): WatchSnapshot[]                    -> for diagnostics / status
 *   function redactSensitive(text: string, secrets?: string[]): string
 *   function redactData<T>(value: T, secrets?: string[]): T
 *   function boundedExcerpt(text: string, maxChars?: number, secrets?: string[]): string
 *
 * The ladder, per watch on each tick: a clock jump (sleep/wake) is subtracted and reported as
 * 'reconcile', never counted as a stall. Past the deadline or past `stallAfterMs` without any
 * progress signal, the server is probed. An unhealthy server interrupts at once (the controller
 * hands it to ServerSupervisor). A healthy server that is still streaming tokens, or whose slot
 * is evaluating the prompt, gets exactly one extension of `extensionFraction` of the budget; a
 * healthy server with no progress past the stall window, or a call past its extended deadline,
 * is interrupted. `afterInterrupt` then says retry (within budgets) or block with diagnostics.
 */

export type DurableJobEventDraft = Pick<DurableJobEvent, 'kind' | 'message' | 'data'>
export type WatchScope = 'model-call' | 'tool-call' | 'stage'

export type ProgressSignal =
  | { kind: 'tokens'; count: number }
  | { kind: 'prompt-processing' }
  | { kind: 'tool-started'; name: string }
  | { kind: 'tool-finished'; name: string; failed: boolean }
  | { kind: 'file-diff'; path: string }
  | { kind: 'test-ran'; command: string; outcome: 'pass' | 'fail' }
  | { kind: 'decision'; summary: string }
  | { kind: 'stage-output'; summary: string }

export interface HealthProbe { healthy: boolean; processing?: boolean; detail?: string }

export interface WatchdogPorts {
  now(): number
  probeHealth(): Promise<HealthProbe>
  emit(event: DurableJobEventDraft): void
}

export interface WatchdogOptions {
  /** The controller's tick interval; a gap much longer than this is the machine sleeping. */
  tickMs: number
  /** A tick gap beyond tickMs + clockJumpMs is treated as sleep/wake, not as elapsed work time. */
  clockJumpMs: number
  /** No progress signal for this long on a model call means the server is probed. */
  stallAfterMs: number
  /** One extension, as a fraction of the scope's budget, for a call that is visibly working. */
  extensionFraction: number
  maxModelCallRetries: number
  maxToolCallRetries: number
}

export const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions = {
  tickMs: 15_000,
  clockJumpMs: 90_000,
  stallAfterMs: 3 * 60_000,
  extensionFraction: 0.5,
  maxModelCallRetries: 2,
  maxToolCallRetries: 1
}

export interface WatchDecision {
  watchId: string
  scope: WatchScope
  label: string
  action: 'ok' | 'extend' | 'interrupt' | 'reconcile'
  reason: 'within-budget' | 'clock-jump' | 'streaming-past-deadline' | 'prompt-processing-past-deadline' | 'server-unhealthy' | 'stalled' | 'deadline'
  diagnostics: Record<string, unknown>
}

export type RetryDecision =
  | { action: 'retry'; attempt: number; remaining: number }
  | { action: 'block'; attempt: number; reason: string; nextAction: string; diagnostics: Record<string, unknown> }

export interface WatchSnapshot {
  id: string
  scope: WatchScope
  label: string
  key: string
  elapsedMs: number
  sinceProgressMs: number
  deadlineMs: number
  extended: boolean
  tokens: number
  lastSignal?: ProgressSignal['kind']
}

interface Watch {
  id: string
  scope: WatchScope
  label: string
  key: string
  startedAt: number
  lastProgressAt: number
  /** Time excluded from the budget: owner pauses and machine sleep. */
  excludedMs: number
  deadlineMs: number
  extended: boolean
  tokens: number
  lastSignal?: ProgressSignal['kind']
  interrupted: boolean
}

export class Watchdog {
  private readonly budgets: DurableJobBudgets
  private readonly ports: WatchdogPorts
  private readonly options: WatchdogOptions
  private readonly watches = new Map<string, Watch>()
  private readonly attempts = new Map<string, number>()
  private lastTickAt: number
  private pausedAt: number | null = null
  private sequence = 0

  constructor(budgets: DurableJobBudgets, ports: WatchdogPorts, options: Partial<WatchdogOptions> = {}) {
    this.budgets = budgets
    this.ports = ports
    this.options = { ...DEFAULT_WATCHDOG_OPTIONS, ...options }
    this.lastTickAt = ports.now()
  }

  private budgetFor(scope: WatchScope): number {
    return scope === 'model-call' ? this.budgets.modelCallTimeoutMs : scope === 'tool-call' ? this.budgets.toolCallTimeoutMs : this.budgets.stageTimeoutMs
  }

  begin(scope: WatchScope, label: string, key = `${scope}:${label}`): string {
    const now = this.ports.now()
    const id = `watch-${++this.sequence}`
    this.watches.set(id, { id, scope, label, key, startedAt: now, lastProgressAt: now, excludedMs: 0, deadlineMs: this.budgetFor(scope), extended: false, tokens: 0, interrupted: false })
    return id
  }

  signal(watchId: string, signal: ProgressSignal): void {
    const watch = this.watches.get(watchId)
    if (!watch) return
    if (signal.kind === 'tokens') { if (signal.count <= 0) return; watch.tokens += signal.count }
    watch.lastProgressAt = this.ports.now()
    watch.lastSignal = signal.kind
  }

  /** A watch that finished; its retry counter survives under its key until the key succeeds. */
  end(watchId: string, succeeded = true): void {
    const watch = this.watches.get(watchId)
    if (!watch) return
    this.watches.delete(watchId)
    if (succeeded && !watch.interrupted) this.attempts.delete(watch.key)
  }

  pause(): void { if (this.pausedAt === null) this.pausedAt = this.ports.now() }

  resume(): void {
    if (this.pausedAt === null) return
    const now = this.ports.now()
    this.exclude(now - this.pausedAt)
    this.pausedAt = null
    this.lastTickAt = now
  }

  private exclude(ms: number): void {
    for (const watch of this.watches.values()) { watch.excludedMs += ms; watch.lastProgressAt += ms }
  }

  active(): WatchSnapshot[] {
    const now = this.ports.now()
    return [...this.watches.values()].map(w => ({ id: w.id, scope: w.scope, label: w.label, key: w.key, elapsedMs: now - w.startedAt - w.excludedMs, sinceProgressMs: now - w.lastProgressAt, deadlineMs: w.deadlineMs, extended: w.extended, tokens: w.tokens, lastSignal: w.lastSignal }))
  }

  async tick(): Promise<WatchDecision[]> {
    const now = this.ports.now()
    const gap = now - this.lastTickAt
    this.lastTickAt = now
    if (this.pausedAt !== null) return []
    const decisions: WatchDecision[] = []
    // Sleep/wake: the whole gap beyond one tick is excluded, so a laptop lid closed for an hour
    // is a reconcile (check the server, settle in-flight operations), not an hour of stall.
    if (gap > this.options.tickMs + this.options.clockJumpMs) {
      const jumpMs = gap - this.options.tickMs
      this.exclude(jumpMs)
      this.ports.emit({ kind: 'recovery', message: `Clock jumped ${Math.round(jumpMs / 1000)}s (machine sleep or wake); the gap is not counted against any budget and the server is re-checked.`, data: { jumpMs } })
      for (const w of this.watches.values()) decisions.push(this.decision(w, now, 'reconcile', 'clock-jump', { jumpMs }))
      return decisions
    }
    let probe: HealthProbe | undefined
    const probeOnce = async (): Promise<HealthProbe> => probe ??= await this.ports.probeHealth().catch(error => ({ healthy: false, detail: error instanceof Error ? error.message : String(error) }))
    for (const w of [...this.watches.values()]) {
      if (w.interrupted) continue
      const elapsed = now - w.startedAt - w.excludedMs
      const sinceProgress = now - w.lastProgressAt
      const pastDeadline = elapsed >= w.deadlineMs
      // Silence only means "stalled" for a model call: a test suite or a stage may be quiet.
      const silent = w.scope === 'model-call' && sinceProgress >= this.options.stallAfterMs
      if (!pastDeadline && !silent) continue
      if (w.scope !== 'model-call') {
        const working = sinceProgress < this.options.stallAfterMs
        if (w.scope === 'stage' && working && !w.extended) { decisions.push(this.extend(w, now, 'streaming-past-deadline')); continue }
        decisions.push(this.interrupt(w, now, 'deadline'))
        continue
      }
      const health = await probeOnce()
      if (!health.healthy) { decisions.push(this.interrupt(w, now, 'server-unhealthy', { health: redactSensitive(health.detail ?? 'unhealthy') })); continue }
      if (silent && !health.processing) { decisions.push(this.interrupt(w, now, 'stalled')); continue }
      if (pastDeadline) {
        if (!w.extended) { decisions.push(this.extend(w, now, silent ? 'prompt-processing-past-deadline' : 'streaming-past-deadline')); continue }
        decisions.push(this.interrupt(w, now, 'deadline'))
      }
      // Silent but the slot is evaluating the prompt, within the deadline: slow, not stalled.
    }
    return decisions
  }

  private decision(w: Watch, now: number, action: WatchDecision['action'], reason: WatchDecision['reason'], extra: Record<string, unknown> = {}): WatchDecision {
    return { watchId: w.id, scope: w.scope, label: w.label, action, reason, diagnostics: { elapsedMs: now - w.startedAt - w.excludedMs, sinceProgressMs: now - w.lastProgressAt, deadlineMs: w.deadlineMs, tokens: w.tokens, lastSignal: w.lastSignal ?? null, ...extra } }
  }

  private extend(w: Watch, now: number, reason: WatchDecision['reason']): WatchDecision {
    w.extended = true
    w.deadlineMs += Math.round(this.budgetFor(w.scope) * this.options.extensionFraction)
    const decision = this.decision(w, now, 'extend', reason)
    this.ports.emit({ kind: 'note', message: `${w.scope} ${redactSensitive(w.label)} passed its budget while still working (${reason}); extended once to ${Math.round(w.deadlineMs / 1000)}s.`, data: decision.diagnostics })
    return decision
  }

  private interrupt(w: Watch, now: number, reason: WatchDecision['reason'], extra: Record<string, unknown> = {}): WatchDecision {
    w.interrupted = true
    const decision = this.decision(w, now, 'interrupt', reason, extra)
    this.ports.emit({ kind: reason === 'server-unhealthy' ? 'server' : 'note', message: `${w.scope} ${redactSensitive(w.label)} interrupted: ${reason}.`, data: decision.diagnostics })
    return decision
  }

  /** After a watch was interrupted (or failed): retry within budgets, or block with diagnostics.
   *  Model and tool calls use the watchdog's own retry limits; a stage uses maxStageAttempts. */
  afterInterrupt(watchIdOrKey: string, scope?: WatchScope): RetryDecision {
    const watch = this.watches.get(watchIdOrKey)
    const key = watch?.key ?? watchIdOrKey
    const resolvedScope = watch?.scope ?? scope ?? 'model-call'
    if (watch) this.watches.delete(watch.id)
    const attempt = (this.attempts.get(key) ?? 0) + 1
    this.attempts.set(key, attempt)
    const limit = resolvedScope === 'model-call' ? this.options.maxModelCallRetries + 1 : resolvedScope === 'tool-call' ? this.options.maxToolCallRetries + 1 : this.budgets.maxStageAttempts
    if (attempt < limit) {
      this.ports.emit({ kind: 'retry', message: `Retrying ${resolvedScope} ${redactSensitive(key)} (attempt ${attempt + 1} of ${limit}).`, data: { key: redactSensitive(key), attempt: attempt + 1, limit } })
      return { action: 'retry', attempt: attempt + 1, remaining: limit - attempt - 1 }
    }
    const reason = `${resolvedScope} ${redactSensitive(key)} was interrupted ${attempt} time${attempt === 1 ? '' : 's'}; the retry budget (${limit}) is spent.`
    const nextAction = resolvedScope === 'tool-call'
      ? 'Inspect the tool command in the job log: it may hang on input or need a longer toolCallTimeoutMs. Resume the job after changing it.'
      : resolvedScope === 'stage'
        ? 'Read the stage handoff and log, narrow the stage objective or raise stageTimeoutMs/maxStageAttempts, then resume the job.'
        : 'Check the local model server (Conductor local models panel): it may be overloaded or the prompt too long for the context. Resume the job when it answers.'
    const diagnostics = { key: redactSensitive(key), scope: resolvedScope, attempts: attempt, limit }
    this.ports.emit({ kind: 'note', message: `Blocked: ${reason}`, data: diagnostics })
    return { action: 'block', attempt, reason, nextAction, diagnostics }
  }
}

// --- Redaction -------------------------------------------------------------------------------

const REDACTED = '[redacted]'
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `[redacted private key]`],
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s"',;]+/gi, `$1${REDACTED}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/(--(?:api-key|token|password|secret)(?:-file)?(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, `$1${REDACTED}`],
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd|token|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/gi, `$1${REDACTED}`],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${REDACTED}@`],
  // A long unbroken hex run is a key (llama.cpp's own key is 32+ hex); git hashes are 40 hex and
  // useful evidence, so exactly 40 or 7-12 hex characters are left alone.
  [/\b(?![a-f0-9]{40}\b)[a-f0-9]{32,}\b/gi, REDACTED]
]

/** Removes credentials from text headed for events, diagnostics or handoff: known secrets passed
 *  in (the local API key), then header, flag, assignment and well-known token shapes. */
export function redactSensitive(text: string, secrets: string[] = []): string {
  let out = String(text)
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join(REDACTED)
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Deep copy with every string redacted and any value under a credential-named key replaced. */
export function redactData<T>(value: T, secrets: string[] = []): T {
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 8) return '[truncated]'
    if (typeof item === 'string') return redactSensitive(item, secrets)
    if (Array.isArray(item)) return item.map(entry => walk(entry, depth + 1))
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, /^(?:authorization|api[_-]?key|apikey|token|access[_-]?token|secret|password|cookie|credentials?)$/i.test(key) ? REDACTED : walk(entry, depth + 1)]))
    }
    return item
  }
  return walk(value, 0) as T
}

/** A bounded, redacted excerpt of raw output (a tool result, a server log tail): the head and
 *  the tail, since the error is usually at the end. The full output stays on disk. */
export function boundedExcerpt(text: string, maxChars = 600, secrets: string[] = []): string {
  const clean = redactSensitive(text, secrets)
  if (clean.length <= maxChars) return clean
  const head = Math.floor(maxChars / 3)
  return `${clean.slice(0, head)}\n… [${clean.length - maxChars} chars omitted] …\n${clean.slice(clean.length - (maxChars - head))}`
}
