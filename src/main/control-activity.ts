import type { AgentControlScope } from '../shared/agent-control'
import type { Json, SessionProjection } from '../shared/structured-agent'
import {
  APP_CONTROL_HISTORY_KEY, APP_CONTROL_HISTORY_LIMIT, CONTROL_ACTIVITY_ITEM_PREFIX, CONTROL_ACTIVITY_KEY, CONTROL_ROW_ACTION_LIMIT, CONTROLLED_BY_KEY,
  controlActivityOf, controlActivitySummary, type AppControlEntry, type ControlAction, type ControlActionKind, type ControlActivity, type ControlledBy, type ControlTarget
} from '../shared/control-activity'
import { controlMethodClass } from './control-method-classes'

/**
 * Records what each conversation does through app control, Conductor-side (FX15): no prompt text,
 * no model tokens. The caller's timeline gets one chip row per turn, upserted in place under a
 * stable item id; the tab it acted on gets a short "Opened by / Closed by" notice; app-wide actions
 * also go to a bounded history the status bar shows. Reads are only counted, and a read-only burst
 * writes at most one row update per READ_FLUSH_MS, so polling never floods the journal.
 */
export interface ControlActivityDeps {
  notice(agentSessionId: string, message: string, payload: Json, itemId?: string): boolean
  snapshot(agentSessionId: string): SessionProjection | null | undefined
  /** Title and tab of an open conversation or tab; undefined when it is not open anywhere. */
  describe(target: { agentSessionId?: string; tabId?: string }): ControlTarget | undefined
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  now?(): number
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}
export interface ControlCall { scope: AgentControlScope; method: string; args: unknown; result?: unknown; error?: string }

export const READ_FLUSH_MS = 5000
const MAX_TRACKED_CALLERS = 200

interface CallerRow { key: string; activity: ControlActivity; dirty: boolean; timer?: unknown }
type Described = { actions: ControlAction[]; driven: Array<{ target: ControlTarget; verb: string }> }

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** Verb for a method acting on one conversation; `notify` marks the ones its target is told about.
 *  A prompt (submit, steer, report) already names its sender in the target's timeline. */
const AGENT_VERBS: Record<string, { verb: string; kind: ControlActionKind; notify: boolean }> = {
  'agents.submit': { verb: 'Prompted', kind: 'steer', notify: false },
  'agents.steer': { verb: 'Steered', kind: 'steer', notify: false },
  'agents.interrupt': { verb: 'Interrupted', kind: 'steer', notify: true },
  'agents.configure': { verb: 'Configured', kind: 'steer', notify: true },
  'agents.grant': { verb: 'Granted access to', kind: 'decide', notify: true },
  'agents.compact': { verb: 'Compacted', kind: 'steer', notify: true },
  'agents.resume': { verb: 'Resumed', kind: 'steer', notify: true },
  'agents.fork': { verb: 'Forked', kind: 'open', notify: true },
  'agents.release': { verb: 'Released', kind: 'close', notify: true },
  'agents.supersede': { verb: 'Superseded', kind: 'close', notify: true },
  'agents.finish': { verb: 'Finished', kind: 'close', notify: true }
}
const TAB_VERBS: Record<string, { verb: string; kind: ControlActionKind; notify: boolean }> = {
  'tabs.focus': { verb: 'Focused', kind: 'other', notify: false },
  'tabs.rename': { verb: 'Renamed', kind: 'other', notify: true },
  'tabs.split': { verb: 'Split', kind: 'other', notify: false },
  'tabs.detach': { verb: 'Detached', kind: 'other', notify: false },
  'tabs.close': { verb: 'Closed', kind: 'close', notify: true }
}
const APP_LABELS: Record<string, { label: string; kind: ControlActionKind; appWide: boolean }> = {
  'app.restart': { label: 'Restarted Conductor', kind: 'app', appWide: true },
  'app.restart.request': { label: 'Asked the owner to restart', kind: 'app', appWide: true },
  'app.update': { label: 'Built a local update', kind: 'app', appWide: true },
  'app.update.install': { label: 'Installed the update', kind: 'app', appWide: true },
  'app.update.download': { label: 'Downloaded the update', kind: 'app', appWide: false },
  'app.update.check': { label: 'Checked for updates', kind: 'other', appWide: false },
  'app.update.authorize': { label: 'Authorized app.update', kind: 'decide', appWide: false },
  'app.quit.confirm': { label: 'Answered the quit dialog', kind: 'decide', appWide: true },
  'local.stop': { label: 'Stopped a local model server', kind: 'app', appWide: true },
  'projects.open': { label: 'Opened a project', kind: 'open', appWide: false }
}
const OTHER_LABELS: Record<string, { label: string; kind: ControlActionKind }> = {
  'router.start': { label: 'Opened a router', kind: 'open' },
  'agents.handoff': { label: 'Handed itself on', kind: 'open' },
  'workspace.rename': { label: 'Renamed the workspace', kind: 'other' },
  'files.open': { label: 'Opened a file', kind: 'other' },
  'tasks.update': { label: 'Updated a task', kind: 'write' },
  'memory.remember': { label: 'Saved a memory', kind: 'write' },
  'memory.forget': { label: 'Forgot a memory', kind: 'write' },
  'orchestration.tasks.create': { label: 'Created a task', kind: 'write' },
  'orchestration.tasks.update': { label: 'Updated its task', kind: 'write' }
}

export class ControlActivityRecorder {
  private rows = new Map<string, CallerRow>()
  constructor(private readonly deps: ControlActivityDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Never throws: recording is decoration and must not fail the call it describes. */
  record(call: ControlCall): void {
    try { this.recordUnsafe(call) } catch (error) { console.warn('Control activity was not recorded', error) }
  }

  appHistory(): AppControlEntry[] {
    try {
      const parsed = JSON.parse(this.deps.getSetting(APP_CONTROL_HISTORY_KEY) ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed.filter((entry): entry is AppControlEntry => Boolean(entry && typeof entry === 'object' && typeof (entry as AppControlEntry).label === 'string')) : []
    } catch { return [] }
  }

  private recordUnsafe(call: ControlCall): void {
    const at = new Date(this.now()).toISOString()
    const caller = call.scope.owner ? undefined : call.scope.agentSessionId || undefined
    const read = controlMethodClass(call.method) === 'read' || !controlMethodClass(call.method) && call.error !== undefined
    if (read) {
      const commit = call.method === 'git.ship.status' ? this.shipOutcome(call.result) : undefined
      if (!caller) return
      const row = this.row(caller)
      row.activity.reads += 1
      row.activity.readMethods[call.method] = (row.activity.readMethods[call.method] ?? 0) + 1
      row.dirty = true
      if (commit && this.applyShipOutcome(row, commit)) this.flush(caller)
      else this.schedule(caller)
      return
    }
    const described = this.describeCall(call, at)
    const by = caller ? this.deps.describe({ agentSessionId: caller }) : undefined
    const byTitle = call.scope.owner ? 'the owner' : by?.title ?? 'another conversation'
    if (caller && described.actions.length) {
      const row = this.row(caller)
      for (const action of described.actions) row.activity.actions.push(action)
      const overflow = row.activity.actions.length - CONTROL_ROW_ACTION_LIMIT
      if (overflow > 0) { row.activity.actions.splice(0, overflow); row.activity.dropped += overflow }
      row.dirty = true
      this.flush(caller)
    }
    if (!call.error) for (const { target, verb } of described.driven) {
      if (!target.agentSessionId || target.agentSessionId === caller) continue
      const payload: ControlledBy = { agentSessionId: caller ?? null, ...(by?.tabId ? { tabId: by.tabId } : {}), title: byTitle, method: call.method, verb, at }
      this.deps.notice(target.agentSessionId, `${verb} by ${byTitle} (${call.method})`, { [CONTROLLED_BY_KEY]: payload as unknown as Json })
    }
    const appWide = described.actions.filter(action => action.appWide)
    if (appWide.length) {
      const history = this.appHistory()
      for (const action of appWide) history.push({ method: action.method, label: action.label, at, by: { agentSessionId: caller ?? null, title: byTitle }, ...(action.failed ? { failed: true } : {}) })
      this.deps.setSetting(APP_CONTROL_HISTORY_KEY, JSON.stringify(history.slice(-APP_CONTROL_HISTORY_LIMIT)))
    }
  }

  /** The chips one mutation adds, and the conversations it acted on. */
  private describeCall(call: ControlCall, at: string): Described {
    const args = object(call.args), result = call.result, failure = call.error ? { failed: true, error: call.error.slice(0, 160) } : {}
    const { method } = call
    const named = (agentSessionId?: string, tabId?: string): ControlTarget => {
      const found = agentSessionId || tabId ? this.deps.describe({ ...(agentSessionId ? { agentSessionId } : {}), ...(tabId ? { tabId } : {}) }) : undefined
      return { ...(agentSessionId ? { agentSessionId } : {}), ...(tabId ? { tabId } : {}), ...found }
    }
    const titled = (target: ControlTarget, fallback: string): string => target.title || fallback
    if (method === 'tabs.open') {
      const tab = object(result), target = { ...named(str(tab.resourceId), str(tab.id)), ...(str(tab.title) ? { title: str(tab.title) } : {}) }
      return { actions: [{ method, kind: 'open', label: `Opened ${titled(target, str(args.title) ?? 'a tab')}`, at, target, ...failure }], driven: [{ target, verb: 'Opened' }] }
    }
    if (method === 'router.dispatch') {
      const entries = Array.isArray(result) ? result.map(object) : []
      if (!entries.length) return { actions: [{ method, kind: 'open', label: 'Dispatched coworkers', at, ...failure }], driven: [] }
      const tasks = Array.isArray(args.tasks) ? args.tasks.map(object) : []
      const described = entries.map((entry, index) => {
        const target = named(str(entry.agentSessionId), str(entry.tabId))
        if (!target.title && str(tasks[index]?.title)) target.title = str(tasks[index]!.title)
        const failed = entry.error !== undefined && entry.error !== null
        return { action: { method, kind: 'open' as const, label: `Dispatched ${titled(target, 'a coworker')}`, at, target, ...(failed ? { failed: true, error: String(entry.error).slice(0, 160) } : {}) }, target, failed }
      })
      return { actions: described.map(entry => entry.action), driven: described.filter(entry => !entry.failed).map(entry => ({ target: entry.target, verb: 'Opened' })) }
    }
    const tabVerb = TAB_VERBS[method]
    if (tabVerb) {
      const target = named(undefined, str(args.tabId))
      return { actions: [{ method, kind: tabVerb.kind, label: `${tabVerb.verb} ${titled(target, 'a tab')}`, at, target, ...failure }], driven: tabVerb.notify ? [{ target, verb: tabVerb.verb }] : [] }
    }
    if (method === 'agents.report') {
      const target = named(str(object(result).agentSessionId))
      return { actions: [{ method, kind: 'steer', label: `Reported to ${titled(target, 'its controller')}`, at, target, ...failure }], driven: [] }
    }
    if (method === 'agents.finish' && !str(args.agentSessionId)) return { actions: [{ method, kind: 'close', label: 'Finished itself', at, ...failure }], driven: [] }
    const agentVerb = AGENT_VERBS[method]
    if (agentVerb) {
      const target = named(str(args.agentSessionId))
      return { actions: [{ method, kind: agentVerb.kind, label: `${agentVerb.verb} ${titled(target, 'a conversation')}`, at, target, ...failure }], driven: agentVerb.notify ? [{ target, verb: agentVerb.verb }] : [] }
    }
    if (method === 'git.ship') {
      const outcome = this.shipOutcome(result)
      return { actions: [{ method, kind: 'ship', label: 'git.ship', at, ...(outcome?.runId ? { runId: outcome.runId } : {}), ...(outcome?.commit ? { commit: outcome.commit } : {}), ...(outcome?.failed ? { failed: true } : {}), ...failure }], driven: [] }
    }
    const app = APP_LABELS[method] ?? (/rollback/i.test(method) ? { label: 'Rolled back the app', kind: 'app' as const, appWide: true } : undefined)
    if (app) {
      const pending = method === 'app.restart' && object(result).confirmationPending === true
      return { actions: [{ method, kind: app.kind, label: pending ? 'Asked to restart Conductor' : app.label, at, ...(app.appWide ? { appWide: true } : {}), ...failure }], driven: [] }
    }
    if (method === 'files.write') return { actions: [{ method, kind: 'write', label: `Wrote ${basename(str(args.path) ?? 'a file')}`, at, ...failure }], driven: [] }
    const other = OTHER_LABELS[method]
    return { actions: [{ method, kind: other?.kind ?? 'other', label: other?.label ?? method, at, ...failure }], driven: [] }
  }

  private shipOutcome(result: unknown): { runId?: string; commit?: string; failed: boolean } | undefined {
    const run = object(object(result).run ?? result)
    if (!str(run.id) && !str(run.commit)) return undefined
    return { ...(str(run.id) ? { runId: str(run.id) } : {}), ...(str(run.commit) ? { commit: str(run.commit) } : {}), failed: run.state === 'failed' || run.state === 'cancelled' }
  }

  /** git.ship.status reporting a commit or failure for a ship chip of this row. */
  private applyShipOutcome(row: CallerRow, outcome: { runId?: string; commit?: string; failed: boolean }): boolean {
    const ship = [...row.activity.actions].reverse().find(action => action.kind === 'ship' && (!outcome.runId || !action.runId || action.runId === outcome.runId))
    if (!ship || ship.commit && ship.commit === outcome.commit || !outcome.commit && !outcome.failed) return false
    if (outcome.commit) { ship.commit = outcome.commit; delete ship.failed }
    else ship.failed = true
    return true
  }

  /** The row of the caller's current turn: keyed by its latest prompt, seeded from what an earlier
   *  process already wrote for that turn so a restart never shortens a row. */
  private row(agentSessionId: string): CallerRow {
    const items = this.deps.snapshot(agentSessionId)?.items ?? []
    let prompt = 0
    for (let index = items.length - 1; index >= 0; index--) {
      const data = items[index]!.data
      if (data.type === 'text' && data.role === 'user') { prompt = items[index]!.sequence; break }
    }
    const key = CONTROL_ACTIVITY_ITEM_PREFIX + prompt
    const current = this.rows.get(agentSessionId)
    if (current?.key === key) return current
    if (current) this.flush(agentSessionId)
    const existing = items.find(item => item.nativeItemId === key)
    const seeded = existing ? controlActivityOf(existing.data) : null
    const row: CallerRow = { key, activity: seeded ? { ...seeded, actions: [...seeded.actions], readMethods: { ...seeded.readMethods } } : { actions: [], reads: 0, readMethods: {}, dropped: 0 }, dirty: false }
    this.rows.delete(agentSessionId)
    this.rows.set(agentSessionId, row)
    if (this.rows.size > MAX_TRACKED_CALLERS) { const oldest = this.rows.keys().next().value as string; this.flush(oldest); this.rows.delete(oldest) }
    return row
  }

  private schedule(agentSessionId: string): void {
    const row = this.rows.get(agentSessionId)
    if (!row || row.timer !== undefined) return
    const set = this.deps.setTimer ?? ((callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer })
    row.timer = set(() => { row.timer = undefined; this.flush(agentSessionId) }, READ_FLUSH_MS)
  }

  private flush(agentSessionId: string): void {
    const row = this.rows.get(agentSessionId)
    if (!row) return
    if (row.timer !== undefined) { (this.deps.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout)))(row.timer); row.timer = undefined }
    if (!row.dirty) return
    row.dirty = false
    this.deps.notice(agentSessionId, controlActivitySummary(row.activity), { [CONTROL_ACTIVITY_KEY]: row.activity as unknown as Json }, row.key)
  }
}
