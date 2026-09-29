import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_AUDIT_BUDGET,
  type Adapters, type AuditBrowser, type CapturedMailAdapter, type CheckContext, type ControlId, type EnvironmentKind, type FactKey,
  type Interpreter, type InterpretationResult, type ProductionEnvironment, type RouteEntry,
} from '../../../shared/production'
import { createAuditBrowser, type ProductionAuditBrowser } from '../browser'
import { createEvidenceSink, type ProductionEvidenceSink } from '../evidence'
import type { FixtureServer } from '../fixtures/server'
import { assertMutationAllowed, policyForEnvironment } from '../netpolicy'
import { defaultProfile, ownerFact } from '../profile'
import { controlDefinition } from '../registry'
import { createSyntheticFactory } from '../synthetic'

/**
 * Builds a real CheckContext over a fixture site for the document and claims check tests (M5): the
 * M2 audit browser (headless, the network policy attached in code), the evidence sink, synthetic
 * values and a profile made from owner facts. Only tests import it; the runner builds its own
 * context (M7).
 */

export interface DocumentContextOptions {
  server: FixtureServer
  site: string
  controlId: ControlId
  scratch: string
  /** Owner facts; every other fact stays unknown. */
  facts?: Partial<Record<FactKey, unknown>>
  /** Route paths (full coverage) or entries; default the home page only through planRoutes. */
  routes?: Array<string | RouteEntry>
  /** `production` audits read-only under production policy (loopback allowed for the fixture server). */
  environmentKind?: EnvironmentKind
  interpreter?: Interpreter
  mail?: CapturedMailAdapter | null
  browser?: AuditBrowser
}

export interface DocumentContext {
  context: CheckContext
  browser: AuditBrowser
  evidence: ProductionEvidenceSink
  logs: string[]
  interpretations: string[]
  close(): Promise<void>
}

const AT = new Date('2026-09-29T08:00:00.000Z')

/** An interpreter with no model: every call is a recorded refusal. */
export const refusingInterpreter = (asked: string[] = []): Interpreter => ({
  async ask(request): Promise<InterpretationResult> {
    asked.push(`${request.role}:${request.purpose}`)
    return {
      ok: false, json: null, refused: 'local model unavailable',
      record: { id: `call-${asked.length}`, runId: 'run-test', role: request.role, provider: 'local', model: 'none', decisionId: null, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0, at: AT.toISOString(), refused: 'local model unavailable' },
    }
  },
})

/** An interpreter that answers every call with the same JSON. */
export const answeringInterpreter = (json: unknown, asked: string[] = []): Interpreter => ({
  async ask(request): Promise<InterpretationResult> {
    asked.push(`${request.role}:${request.purpose}`)
    return {
      ok: true, json, refused: null,
      record: { id: `call-${asked.length}`, runId: 'run-test', role: request.role, provider: 'local', model: 'fake', decisionId: null, inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 1, at: AT.toISOString(), refused: null },
    }
  },
})

export function createDocumentContext(options: DocumentContextOptions): DocumentContext {
  const site = options.server.site(options.site)
  const kind = options.environmentKind ?? 'local'
  const environment: ProductionEnvironment = {
    id: `env-${options.site}`, kind, label: options.site, baseUrl: `${site.origin}/`, allowedOrigins: [site.origin], accounts: [],
    capturedMail: options.mail ? { kind: 'mailpit', location: 'http://127.0.0.1:0' } : null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null,
  }
  const profile = defaultProfile('project-test', AT)
  for (const [key, value] of Object.entries(options.facts ?? {})) (profile.facts as unknown as Record<string, unknown>)[key] = ownerFact(value, AT.toISOString())
  profile.environments = [environment]
  profile.scope.routes = (options.routes ?? []).map(route => typeof route === 'string' ? { path: route, source: 'owner', tags: [], coverage: 'full' } : route)
  const budget = { ...DEFAULT_AUDIT_BUDGET, requestsPerSecondPerOrigin: 0 }
  // A fixture server lives on loopback; production policy otherwise refuses private addresses.
  const policy = { ...policyForEnvironment(environment, { budget }), allowPrivateAddresses: true }
  const directory = join(options.scratch, `${options.site}-${options.controlId}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(directory, { recursive: true })
  const synthetic = createSyntheticFactory()
  const evidence = createEvidenceSink(join(directory, 'artifacts'), () => synthetic.markers())
  const browser = options.browser ?? createAuditBrowser(policy, { userDataDir: join(directory, 'browser'), evidence, navigationTimeoutMs: 10_000 })
  const logs: string[] = []
  const interpretations: string[] = []
  const abort = new AbortController()
  const adapters: Adapters = { mail: options.mail ?? null, commerce: null, storage: null }
  const control = controlDefinition(options.controlId)
  const context: CheckContext = {
    run: { id: 'run-test', projectId: profile.projectId, kind: 'audit', environmentId: environment.id, budget, fingerprint: {
      environmentId: environment.id, commit: null, build: null, configHash: '', policyHash: '', dependencyHash: '', routesHash: '', profileVersion: 1, registryVersion: 1, computedAt: AT.toISOString(),
    } },
    profile, environment, control, policy, browser, adapters, evidence,
    interpreter: options.interpreter ?? refusingInterpreter(interpretations),
    source: { root: directory, read: async () => null, list: async () => [], exists: async () => false },
    synthetic: kindOf => synthetic.next(kindOf),
    async operation(mutation, _target, act) { assertMutationAllowed(policy, mutation); return await act() },
    routes: filter => profile.scope.routes.filter(route => !filter?.tags?.length || filter.tags.some(tag => route.tags.includes(tag))),
    url: path => new URL(path, environment.baseUrl).href,
    log: line => { logs.push(line) },
    signal: abort.signal,
    now: () => AT.toISOString(),
  }
  return {
    context, browser, evidence, logs, interpretations,
    async close() { abort.abort(); await browser.close() },
  }
}

export type { ProductionAuditBrowser }
