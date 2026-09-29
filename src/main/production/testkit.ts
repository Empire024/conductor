import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CreateOrchestrationTaskInput, OrchestrationTask, UpdateOrchestrationTaskInput } from '../../shared/orchestration'
import type { ModelKey } from '../../shared/model-routing'
import type {
  AuditBrowser, AuditPage, CheckContext, CheckOutcome, ControlCheck, ControlId, FactKey, FindingDraft, NetworkPolicy, ProductionEnvironment,
  ProductionProfile, RouteEntry, TargetFingerprint,
} from '../../shared/production'
import type { InterpreterPorts } from './interpret'
import { ownerFact } from './profile'
import { ProductionStore } from './store'
import type { FixTaskBoard } from './tasks'

/**
 * Fakes for the M7 tests (runner, triggers, gate, verifier, drift, service): a real ProductionStore
 * on a temp database, a profile with one environment, a browser that never touches the network, a
 * fixture board, recording interpreter ports and scripted checks. Only tests import it.
 */

export const T0 = new Date('2026-09-29T08:00:00.000Z')

export interface TempStore { store: ProductionStore; dir: string; close(): void }

export function tempStore(clock: () => Date = () => new Date()): TempStore {
  const dir = mkdtempSync(join(tmpdir(), 'prod-m7-'))
  // The production tables reference conductor.db's projects table (ON DELETE CASCADE).
  const raw = new DatabaseSync(join(dir, 'conductor.db'))
  raw.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)')
  for (const id of ['project-a', 'project-b']) raw.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, id, join(dir, id), T0.toISOString(), T0.toISOString())
  raw.close()
  const store = new ProductionStore(join(dir, 'conductor.db'), clock)
  return { store, dir, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

export const ENV_ID = 'env-a'

export function environment(overrides: Partial<ProductionEnvironment> = {}): ProductionEnvironment {
  return {
    id: ENV_ID, kind: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:9/', allowedOrigins: ['http://127.0.0.1:9'], accounts: [],
    capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null, ...overrides,
  }
}

export function seedProfile(store: ProductionStore, projectId = 'project-a', options: { environment?: Partial<ProductionEnvironment>; facts?: Partial<Record<FactKey, unknown>>; routes?: RouteEntry[]; designate?: boolean } = {}): ProductionProfile {
  return store.mutateProfile(projectId, 'owner', current => {
    const next: ProductionProfile = { ...current, environments: [environment(options.environment)] }
    for (const [key, value] of Object.entries(options.facts ?? {})) (next.facts as unknown as Record<string, unknown>)[key] = ownerFact(value, T0.toISOString())
    next.scope = { ...next.scope, routes: options.routes ?? [{ path: '/', source: 'owner', tags: ['home'], coverage: 'full' }] }
    if (options.designate) next.designation = { productionReady: true, environmentId: ENV_ID, by: 'owner', at: T0.toISOString(), note: 'test' }
    return next
  })
}

export function fingerprint(overrides: Partial<TargetFingerprint> = {}): TargetFingerprint {
  return {
    environmentId: ENV_ID, commit: 'c0ffee0000000000000000000000000000000000', build: null, configHash: 'cfg', policyHash: 'pol', dependencyHash: 'dep', routesHash: 'routes',
    profileVersion: 1, registryVersion: 1, computedAt: T0.toISOString(), ...overrides,
  }
}

/** A browser that is "available" and spends `spend` requests whenever a check calls `use()`. */
export interface FakeBrowser extends AuditBrowser {
  policy: NetworkPolicy | null
  requests: number
  use(count: number): void
  closed: number
}

export function fakeBrowserFactory(options: { available?: boolean } = {}): { factory: (policy: NetworkPolicy) => FakeBrowser; browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = []
  const factory = (policy: NetworkPolicy): FakeBrowser => {
    let exhausted = false
    const browser: FakeBrowser = {
      policy, requests: 0, closed: 0,
      use(count) { for (let i = 0; i < count; i++) { if (this.requests >= policy.maxRequests) { exhausted = true; return } this.requests++ } },
      async availability() { return options.available === false ? { available: false, engine: null, reason: 'no browser in this test' } : { available: true, engine: 'playwright-chromium', reason: null } },
      async open(): Promise<AuditPage> { throw new Error('the fake browser opens no pages') },
      budget() { return { requests: browser.requests, exhausted } },
      async close() { browser.closed++ },
    }
    browsers.push(browser)
    return browser
  }
  return { factory, browsers }
}

export interface RecordingPorts extends InterpreterPorts {
  calls: Array<{ kind: 'route' | 'cloud' | 'local'; detail: string; projectId?: string }>
}

export function recordingPorts(options: {
  key?: ModelKey
  cloudText?: (prompt: string) => string
  localText?: ((prompt: string) => string) | null
  stop?: number | null
  used?: number | null
  routeError?: string
} = {}): RecordingPorts {
  const calls: RecordingPorts['calls'] = []
  return {
    calls,
    async route(features) {
      calls.push({ kind: 'route', detail: features.category })
      if (options.routeError) throw new Error(options.routeError)
      return { decisionId: 'decision-1', key: options.key ?? { provider: 'anthropic', model: 'claude-test' } }
    },
    async cloudTurn(key, prompt, _signal, _maxTokens, context) {
      calls.push({ kind: 'cloud', detail: `${key.provider}/${key.model}`, projectId: context.projectId })
      return { text: options.cloudText?.(prompt) ?? '{"rationale":"ok"}', inputTokens: 100, outputTokens: 20, costUsd: 0.001 }
    },
    async localAsk(request) {
      calls.push({ kind: 'local', detail: request.system.slice(0, 40) })
      if (options.localText === null || options.localText === undefined) return null
      return { text: options.localText(request.user), model: 'local-test', inputTokens: 50, outputTokens: 10 }
    },
    weeklyStop: () => options.stop ?? null,
    usagePercent: () => options.used ?? null,
  }
}

export interface FakeBoard extends FixTaskBoard {
  tasks: Map<string, OrchestrationTask>
  created: number
  onCreate?: (task: OrchestrationTask) => void
}

export function fakeBoard(): FakeBoard {
  const tasks = new Map<string, OrchestrationTask>()
  const board: FakeBoard = {
    tasks, created: 0,
    createTask(input: CreateOrchestrationTaskInput) {
      const at = new Date().toISOString()
      const task: OrchestrationTask = {
        id: `task-${tasks.size + 1}`, projectId: input.projectId, title: input.title, description: input.description ?? '', status: input.status ?? 'backlog', priority: input.priority ?? 'normal',
        assignedAgentId: null, routineId: null, routineRunId: null, routineStepId: null, blockedByTaskId: null, sortOrder: tasks.size, createdAt: at, updatedAt: at,
      } as OrchestrationTask
      tasks.set(task.id, task)
      board.created++
      board.onCreate?.(task)
      return task
    },
    updateTask(id: string, input: UpdateOrchestrationTaskInput) {
      const task = tasks.get(id)
      if (!task) throw new Error(`no task ${id}`)
      const next = { ...task, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), updatedAt: new Date().toISOString() } as OrchestrationTask
      tasks.set(id, next)
      return next
    },
    task: (_projectId, id) => tasks.get(id) ?? null,
  }
  return board
}

export function finding(controlId: ControlId, checkId: string, key: string, overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    controlId, checkId, key, route: '/', component: null, scope: 'page', category: 'legal', severity: 'high', confidence: 'confirmed',
    title: `${controlId} ${key}`, expected: 'expected state', observed: 'observed state', reproduction: ['open /'], evidence: [], proposedFix: 'fix it', owner: 'engineering', legal: null,
    ...overrides,
  }
}

export function outcome(checkId: string, status: CheckOutcome['status'], findings: FindingDraft[] = [], extra: Partial<CheckOutcome> = {}): CheckOutcome {
  return {
    checkId, status, reason: status === 'UNVERIFIED' ? 'could not conclude' : null, findings, evidence: [], humanReview: [],
    coverage: { tested: [{ path: '/', devices: ['desktop'], consentStates: ['clean'], authStates: ['guest'] }], sampled: [], excluded: [], unobservable: [] },
    observations: [`${checkId} ${status}`], ...extra,
  }
}

/** A check whose behaviour the test scripts; `calls` counts invocations. */
export interface ScriptedCheck extends ControlCheck { calls: number }

export function scriptedCheck(controlId: ControlId, checkId: string, run: (context: CheckContext, call: number) => Promise<CheckOutcome> | CheckOutcome): ScriptedCheck {
  const check: ScriptedCheck = {
    controlId, checkId, title: `scripted ${checkId}`, requires: [], calls: 0,
    async run(context) { check.calls++; return await run(context, check.calls) },
  }
  return check
}

/** Resolves when `predicate` holds (polling the store); for waiting on a run inside a test. */
export async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
