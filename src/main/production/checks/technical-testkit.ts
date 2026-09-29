import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_AUDIT_BUDGET,
  type Adapters, type AuditBrowser, type AuditScope, type CheckContext, type ControlId, type EnvironmentKind, type FactKey, type Interpreter,
  type InterpretationResult, type MutationKind, type NetworkPolicy, type ProductionEnvironment, type RouteEntry, type StorageAdapter, type StorageConfig,
} from '../../../shared/production'
import { createAuditBrowser } from '../browser'
import { createEvidenceSink, type ProductionEvidenceSink } from '../evidence'
import type { FixtureServer } from '../fixtures/server'
import { assertMutationAllowed, policyForEnvironment } from '../netpolicy'
import { defaultProfile, ownerFact } from '../profile'
import { controlDefinition } from '../registry'
import { createSyntheticFactory } from '../synthetic'

/**
 * Builds a real CheckContext over a fixture site for the technical and accessibility check tests
 * (M4): the M2 audit browser (headless, network policy attached in code), the evidence sink,
 * synthetic values and a profile made from owner facts. Only tests import it; the runner builds its
 * own context (M7).
 */

export interface TechnicalContextOptions {
  server: FixtureServer | null
  site: string | null
  controlId: ControlId
  scratch: string
  facts?: Partial<Record<FactKey, unknown>>
  routes?: Array<string | RouteEntry>
  scope?: Partial<Pick<AuditScope, 'devices' | 'consentStates' | 'locales'>>
  /** `production` audits read-only (loopback still allowed so the fixture server is reachable). */
  environmentKind?: EnvironmentKind
  /** A live write authorization for these kinds (non-production environments only). */
  authorize?: MutationKind[]
  storage?: { config: StorageConfig; adapter: StorageAdapter | null }
  interpreter?: Interpreter
  browser?: AuditBrowser
}

export interface TechnicalContext {
  context: CheckContext
  browser: AuditBrowser
  evidence: ProductionEvidenceSink
  policy: NetworkPolicy
  logs: string[]
  operations: string[]
  close(): Promise<void>
}

const AT = new Date('2026-09-29T08:00:00.000Z')

export const refusingInterpreter = (): Interpreter => ({
  async ask(request): Promise<InterpretationResult> {
    return {
      ok: false, json: null, refused: 'local model unavailable',
      record: { id: 'call', runId: 'run-test', role: request.role, provider: 'local', model: 'none', decisionId: null, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0, at: AT.toISOString(), refused: 'local model unavailable' },
    }
  },
})

export function createTechnicalContext(options: TechnicalContextOptions): TechnicalContext {
  const site = options.server && options.site ? options.server.site(options.site) : null
  const origin = site?.origin ?? 'http://127.0.0.1:9'
  const kind = options.environmentKind ?? 'local'
  const environment: ProductionEnvironment = {
    id: `env-${options.site ?? 'none'}`, kind, label: options.site ?? 'none', baseUrl: `${origin}/`, allowedOrigins: [origin], accounts: [],
    capturedMail: null, commerce: null, storage: options.storage?.config ?? null, buildInfoCommand: null, smokeCommand: null,
  }
  const profile = defaultProfile('project-test', AT)
  for (const [key, value] of Object.entries(options.facts ?? {})) (profile.facts as unknown as Record<string, unknown>)[key] = ownerFact(value, AT.toISOString())
  profile.environments = [environment]
  profile.scope.routes = (options.routes ?? ['/']).map(route => typeof route === 'string' ? { path: route, source: 'owner', tags: [], coverage: 'full' } : route)
  profile.scope.devices = options.scope?.devices ?? ['desktop']
  if (options.scope?.consentStates) profile.scope.consentStates = options.scope.consentStates
  if (options.scope?.locales) profile.scope.locales = options.scope.locales
  if (options.authorize?.length && kind !== 'production') {
    profile.writeAuthorizations = [{
      id: 'auth-test', environmentId: environment.id, mutations: options.authorize, grantedBy: { kind: 'owner', agentSessionId: null },
      grantedAt: AT.toISOString(), expiresAt: '2099-01-01T00:00:00.000Z', note: 'test',
    }]
  }
  const budget = { ...DEFAULT_AUDIT_BUDGET, requestsPerSecondPerOrigin: 0 }
  const policy: NetworkPolicy = { ...policyForEnvironment(environment, { authorizations: profile.writeAuthorizations, budget, now: AT }), allowPrivateAddresses: true }
  const directory = join(options.scratch, `${options.site ?? 'none'}-${options.controlId}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(directory, { recursive: true })
  const synthetic = createSyntheticFactory()
  const evidence = createEvidenceSink(join(directory, 'artifacts'), () => synthetic.markers())
  const browser = options.browser ?? createAuditBrowser(policy, { userDataDir: join(directory, 'browser'), evidence, navigationTimeoutMs: 10_000 })
  const logs: string[] = []
  const operations: string[] = []
  const abort = new AbortController()
  const adapters: Adapters = { mail: null, commerce: null, storage: options.storage?.adapter ?? null }
  const context: CheckContext = {
    run: {
      id: 'run-test', projectId: profile.projectId, kind: 'audit', environmentId: environment.id, budget,
      fingerprint: { environmentId: environment.id, commit: null, build: null, configHash: '', policyHash: '', dependencyHash: '', routesHash: '', profileVersion: 1, registryVersion: 1, computedAt: AT.toISOString() },
    },
    profile, environment, control: controlDefinition(options.controlId), policy, browser, adapters, evidence,
    interpreter: options.interpreter ?? refusingInterpreter(),
    source: { root: directory, read: async () => null, list: async () => [], exists: async () => false },
    synthetic: kindOf => synthetic.next(kindOf),
    async operation(mutation, target, act) {
      assertMutationAllowed(policy, mutation, AT)
      operations.push(`${mutation} ${target}`)
      return await act()
    },
    routes: filter => profile.scope.routes.filter(route => !filter?.tags?.length || filter.tags.some(tag => route.tags.includes(tag))),
    url: path => new URL(path, environment.baseUrl).href,
    log: line => { logs.push(line) },
    signal: abort.signal,
    now: () => AT.toISOString(),
  }
  return {
    context, browser, evidence, policy, logs, operations,
    async close() { abort.abort(); await browser.close() },
  }
}
