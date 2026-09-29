import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  DEFAULT_AUDIT_BUDGET,
  type Adapters, type AuditBrowser, type CheckContext, type ControlId, type EnvironmentKind, type FactKey, type Interpreter, type InterpretationResult,
  type MutationKind, type NetworkPolicy, type ProductionEnvironment, type RouteEntry, type SandboxWriteAuthorization, type SourceTree, type TestAccountRef,
} from '../../../shared/production'
import { createAuditBrowser } from '../browser'
import { createEvidenceSink, type ProductionEvidenceSink } from '../evidence'
import type { FixtureServer } from '../fixtures/server'
import { assertMutationAllowed, policyForEnvironment } from '../netpolicy'
import { defaultProfile, ownerFact } from '../profile'
import { controlDefinition } from '../registry'
import { createSyntheticFactory, type SyntheticFactory } from '../synthetic'

/**
 * Builds a real CheckContext for the commerce and lifecycle check tests (M6): the M2 audit browser
 * (headless, network policy attached in code), the evidence sink, synthetic values, a profile of
 * owner facts, an optional sandbox write authorization and an operation journal that refuses
 * exactly as the runner's `operation` does. Only tests import it; the runner builds its own
 * context (M7).
 */

export interface CommerceContextOptions {
  scratch: string
  controlId: ControlId
  /** Fixture site the environment points at; without one `baseUrl` is used. */
  server?: FixtureServer
  site?: string
  baseUrl?: string
  facts?: Partial<Record<FactKey, unknown>>
  routes?: Array<string | RouteEntry>
  environmentKind?: EnvironmentKind
  /** Mutation kinds a live write authorization names; none means read-only. */
  authorize?: MutationKind[]
  /** More allowed origins (the fakes standing in for the shop's backend or mail sender). */
  extraOrigins?: string[]
  accounts?: TestAccountRef[]
  /** Adapters, or a factory given the run's network policy (the commerce adapters check it before a mutation). */
  adapters?: Partial<Adapters> | ((policy: NetworkPolicy) => Partial<Adapters>)
  interpreter?: Interpreter
  /** A real directory the source tree reads from. */
  sourceRoot?: string
  browser?: AuditBrowser
}

export interface JournalEntry { mutation: MutationKind; target: string; status: 'intended' | 'done' | 'failed' }

export interface CommerceContext {
  context: CheckContext
  environment: ProductionEnvironment
  evidence: ProductionEvidenceSink
  /** Where the evidence sink writes, for assertions over what reached the evidence. */
  artifactsDir: string
  synthetic: SyntheticFactory
  operations: JournalEntry[]
  logs: string[]
  close(): Promise<void>
}

export const AT = new Date('2026-09-29T08:00:00.000Z')

export const refusingInterpreter = (asked: string[] = []): Interpreter => ({
  async ask(request): Promise<InterpretationResult> {
    asked.push(`${request.role}:${request.purpose}`)
    return {
      ok: false, json: null, refused: 'local model unavailable',
      record: { id: `call-${asked.length}`, runId: 'run-test', role: request.role, provider: 'local', model: 'none', decisionId: null, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0, at: AT.toISOString(), refused: 'local model unavailable' },
    }
  },
})

export const answeringInterpreter = (answer: (purpose: string, user: string) => unknown, asked: string[] = []): Interpreter => ({
  async ask(request): Promise<InterpretationResult> {
    asked.push(`${request.role}:${request.purpose}`)
    return {
      ok: true, json: answer(request.purpose, request.user), refused: null,
      record: { id: `call-${asked.length}`, runId: 'run-test', role: request.role, provider: 'local', model: 'fake', decisionId: null, inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 1, at: AT.toISOString(), refused: null },
    }
  },
})

export const testAccount = (role: TestAccountRef['role'] = 'subscriber', username = 'subscriber@shop.test'): TestAccountRef => ({
  id: `acct-${role}`, label: `Test ${role}`, role,
  usernameRef: { id: `user-${role}`, source: 'env', key: `TEST_${role.toUpperCase()}_USER`, purpose: username },
  passwordRef: { id: `pass-${role}`, source: 'env', key: `TEST_${role.toUpperCase()}_PASS`, purpose: 'password' },
})

export function createCommerceContext(options: CommerceContextOptions): CommerceContext {
  const kind = options.environmentKind ?? 'local'
  const origin = options.site && options.server ? options.server.site(options.site).origin : new URL(options.baseUrl ?? 'http://127.0.0.1:9').origin
  const environment: ProductionEnvironment = {
    id: `env-${options.site ?? 'none'}`, kind, label: options.site ?? 'no site', baseUrl: `${origin}/`, allowedOrigins: [origin, ...(options.extraOrigins ?? [])],
    accounts: options.accounts ?? [],
    capturedMail: null, commerce: null,
    storage: null, buildInfoCommand: null, smokeCommand: null,
  }
  const profile = defaultProfile('project-test', AT)
  for (const [key, value] of Object.entries(options.facts ?? {})) (profile.facts as unknown as Record<string, unknown>)[key] = ownerFact(value, AT.toISOString())
  profile.environments = [environment]
  profile.scope.routes = (options.routes ?? []).map(route => typeof route === 'string' ? { path: route, source: 'owner', tags: [], coverage: 'full' } : route)
  const authorizations: SandboxWriteAuthorization[] = options.authorize?.length
    ? [{ id: 'auth-test', environmentId: environment.id, mutations: options.authorize, grantedBy: { kind: 'owner', agentSessionId: null }, grantedAt: AT.toISOString(), expiresAt: '2099-01-01T00:00:00.000Z', note: 'test' }]
    : []
  profile.writeAuthorizations = authorizations
  const budget = { ...DEFAULT_AUDIT_BUDGET, requestsPerSecondPerOrigin: 0 }
  // Fixtures live on loopback; production policy otherwise refuses private addresses.
  const policy = { ...policyForEnvironment(environment, { authorizations, budget }), allowPrivateAddresses: true }
  const directory = join(options.scratch, `${options.site ?? 'none'}-${options.controlId}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(directory, { recursive: true })
  const synthetic = createSyntheticFactory()
  const artifactsDir = join(directory, 'artifacts')
  const evidence = createEvidenceSink(artifactsDir, () => synthetic.markers())
  const browser = options.browser ?? createAuditBrowser(policy, {
    userDataDir: join(directory, 'browser'), evidence, navigationTimeoutMs: 10_000,
    // Fixture account pages are public; a real run reaches them through a recorded login state.
    ...(options.accounts?.length ? { login: async () => undefined } : {}),
  })
  const operations: JournalEntry[] = []
  const logs: string[] = []
  const abort = new AbortController()
  const adapters: Adapters = { mail: null, commerce: null, storage: null, ...(typeof options.adapters === 'function' ? options.adapters(policy) : options.adapters) }
  if (adapters.mail) environment.capturedMail = { kind: 'mailpit', location: 'http://127.0.0.1:0' }
  if (adapters.commerce) environment.commerce = { kind: 'woocommerce', endpoint: 'http://127.0.0.1:0', credentialRef: null }
  const context: CheckContext = {
    run: { id: 'run-test', projectId: profile.projectId, kind: 'audit', environmentId: environment.id, budget, fingerprint: {
      environmentId: environment.id, commit: null, build: null, configHash: '', policyHash: '', dependencyHash: '', routesHash: '', profileVersion: 1, registryVersion: 1, computedAt: AT.toISOString(),
    } },
    profile, environment, control: controlDefinition(options.controlId), policy, browser, adapters, evidence,
    interpreter: options.interpreter ?? refusingInterpreter(),
    source: options.sourceRoot ? directorySource(options.sourceRoot) : { root: directory, read: async () => null, list: async () => [], exists: async () => false },
    synthetic: kindOf => synthetic.next(kindOf),
    async operation(mutation, target, act) {
      assertMutationAllowed(policy, mutation)
      const entry: JournalEntry = { mutation, target, status: 'intended' }
      operations.push(entry)
      try { const value = await act(); entry.status = 'done'; return value } catch (error) { entry.status = 'failed'; throw error }
    },
    routes: filter => profile.scope.routes.filter(route => !filter?.tags?.length || filter.tags.some(tag => route.tags.includes(tag))),
    url: path => new URL(path, environment.baseUrl).href,
    log: line => { logs.push(line) },
    signal: abort.signal,
    now: () => AT.toISOString(),
  }
  return { context, environment, evidence, artifactsDir, synthetic, operations, logs, async close() { abort.abort(); await browser.close() } }
}

/** A bounded source tree over a real directory; `list` understands `*`, `**` and `{a,b}`. */
export function directorySource(root: string): SourceTree {
  const base = resolve(root)
  const inside = (path: string): string | null => {
    const target = resolve(base, path)
    return target === base || target.startsWith(base + sep) ? target : null
  }
  const walk = (directory: string, out: string[]): void => {
    for (const name of readdirSync(directory)) {
      if (out.length >= 5000 || name === 'node_modules' || name === '.git') continue
      const path = join(directory, name)
      if (statSync(path).isDirectory()) walk(path, out); else out.push(relative(base, path).split(sep).join('/'))
    }
  }
  return {
    root: base,
    async read(path, maxBytes = 256 * 1024) {
      const target = inside(path)
      if (!target) return null
      try { return readFileSync(target).subarray(0, maxBytes).toString('utf8') } catch { return null }
    },
    async list(glob, limit = 500) {
      const files: string[] = []
      walk(base, files)
      const pattern = globToRegExp(glob)
      return files.filter(file => pattern.test(file)).slice(0, limit)
    },
    async exists(path) {
      const target = inside(path)
      try { return !!target && statSync(target).isFile() } catch { return false }
    },
  }
}

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '*' && glob[index + 1] === '*') { source += glob[index + 2] === '/' ? '(?:.*/)?' : '.*'; index += glob[index + 2] === '/' ? 2 : 1 }
    else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '{') { const end = glob.indexOf('}', index); source += `(?:${glob.slice(index + 1, end).split(',').map(escape).join('|')})`; index = end }
    else source += escape(char)
  }
  return new RegExp(`^${source}$`, 'i')
}

const escape = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/** Every evidence file's text under an artifacts directory, for leak assertions. */
export function evidenceText(artifactsDir: string): string {
  if (!existsSync(artifactsDir)) return ''
  const out: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) walk(path); else if (!/\.(png|jpe?g)$/i.test(name)) out.push(readFileSync(path, 'utf8'))
    }
  }
  walk(artifactsDir)
  return out.join('\n')
}
