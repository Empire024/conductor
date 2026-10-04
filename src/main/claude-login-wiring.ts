import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import * as pty from 'node-pty'
import { PhoneAccessError } from './phone-access'
import { registerPhoneApiRoute } from './phone-access-server'
import { ClaudeTokenStore, CLAUDE_TOKEN_ENV, LoginFlowError, LoginFlows, setClaudeTokenSource, type SettingsStore, type SpawnLoginPty } from './claude-login'
import { probeClaudeAuth, probeCodexAuth, type ProviderAuthMonitor } from './provider-auth'
import type { SecretVault } from './secret-store'
import type { LoginFlowView, LoginMode, LoginProvider, ProviderLoginState } from '../shared/claude-login'

/**
 * The provider login surfaces (claude-login.ts): Settings over trusted IPC, the paired phone over
 * /api/login. Neither is app control: an agent, even a wizard, cannot start a login or read the
 * token state through it, and nothing here returns a token or a code.
 */
export interface ProviderLoginDeps {
  vault: SecretVault
  settings: SettingsStore
  userData: string
  executable(provider: LoginProvider): string | null
  providerAuth(): ProviderAuthMonitor | undefined
  spawn: SpawnLoginPty
  /** Every window and phone hears the new state. */
  broadcast(state: ProviderLoginState): void
  environment?: NodeJS.ProcessEnv
  log?(message: string): void
}

export interface ProviderLogin {
  store: ClaudeTokenStore
  flows: LoginFlows
  state(): ProviderLoginState
  start(request: { provider: unknown; mode: unknown }, origin: { kind: 'desktop' } | { kind: 'phone'; deviceId: string }): LoginFlowView
  submitCode(request: { id: unknown; code: unknown }): LoginFlowView
  cancel(id: unknown): LoginFlowView | null
  removeToken(): ProviderLoginState
  /** A turn refused the long-lived token: stop handing it out. */
  tokenRejected(message: string): void
  /** The /api/login phone route (registerPhoneApiRoute); the server has already authenticated the
   *  device and, when a phone code is set, checked that it is unlocked. */
  phoneRoute(method: string, path: string, body: Record<string, unknown>, deviceId: string): Promise<unknown>
  dispose(): void
}

/** The login CLI in a PTY Conductor owns. A .cmd/.bat (the smokes' fake CLI, an npm shim) runs
 *  through cmd.exe, which ConPTY cannot start directly. */
export const spawnLoginPty: SpawnLoginPty = (file, args, options) => {
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
  const child = pty.spawn(shim ? process.env.ComSpec || 'cmd.exe' : file, shim ? ['/d', '/s', '/c', file, ...args] : args, {
    name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd,
    env: Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    useConptyDll: process.platform === 'win32'
  })
  return {
    onData: listener => { child.onData(listener) },
    onExit: listener => { child.onExit(event => listener({ exitCode: event.exitCode })) },
    write: data => child.write(data),
    kill: () => child.kill()
  }
}

/** A test launch (CONDUCTOR_TEST_USER_DATA, unpackaged) may point the login at a fake CLI, so a
 *  smoke never signs anyone in. */
export function loginCliOverride(provider: LoginProvider, packaged: boolean, environment: NodeJS.ProcessEnv = process.env): string | null {
  if (packaged || !environment.CONDUCTOR_TEST_USER_DATA) return null
  return environment[provider === 'claude' ? 'CONDUCTOR_TEST_LOGIN_CLAUDE' : 'CONDUCTOR_TEST_LOGIN_CODEX']?.trim() || null
}

const PROVIDERS: readonly LoginProvider[] = ['claude', 'codex']
const MODES: readonly LoginMode[] = ['login', 'setup-token', 'device']

export function createProviderLogin(deps: ProviderLoginDeps): ProviderLogin {
  const environment = deps.environment ?? process.env
  const store = new ClaudeTokenStore(deps.vault, deps.settings, environment)
  setClaudeTokenSource(() => store.token())
  const scratchRoot = join(deps.userData, 'provider-login')
  const withoutToken = (): NodeJS.ProcessEnv => { const env = { ...environment }; delete env[CLAUDE_TOKEN_ENV]; return env }

  const state = (): ProviderLoginState => ({
    token: store.status(),
    flow: flows.view(),
    outages: (deps.providerAuth()?.status() ?? []).map(outage => ({ provider: outage.provider, since: outage.since, tabs: outage.tabs.length }))
  })
  const changed = (): void => { try { deps.broadcast(state()) } catch { /* a listener never breaks a login */ } }

  const flows: LoginFlows = new LoginFlows({
    spawn: deps.spawn,
    executable: provider => deps.executable(provider),
    environment: () => environment,
    scratchDirectory: () => {
      mkdirSync(scratchRoot, { recursive: true, mode: 0o700 })
      return mkdtempSync(join(scratchRoot, 'flow-'))
    },
    removeDirectory: path => rmSync(path, { recursive: true, force: true }),
    saveToken: (token, expiresAt) => store.save(token, expiresAt),
    // The file login, checked without the token: with it, `auth status` always says logged in.
    verify: async provider => {
      const executable = deps.executable(provider)
      if (!executable) return { loggedIn: false, detail: `no ${provider} CLI` }
      return provider === 'claude' ? probeClaudeAuth(executable, withoutToken()) : probeCodexAuth(executable, environment)
    },
    restored: provider => { void deps.providerAuth()?.loginRestored(provider).then(() => changed(), () => changed()) },
    changed: () => changed(),
    log: message => deps.log?.(message)
  })

  const provider = (value: unknown): LoginProvider => { if (PROVIDERS.includes(value as LoginProvider)) return value as LoginProvider; throw new LoginFlowError('Unknown provider.') }
  const mode = (value: unknown): LoginMode => { if (MODES.includes(value as LoginMode)) return value as LoginMode; throw new LoginFlowError('Unknown login.') }

  const api: ProviderLogin = {
    store, flows, state,
    start: (request, origin) => {
      if (origin.kind === 'phone' && !/^[\w-]{1,128}$/.test(origin.deviceId)) throw new LoginFlowError('Unknown phone.', 403)
      return flows.start({ provider: provider(request.provider), mode: mode(request.mode), origin: origin.kind, requester: origin.kind === 'phone' ? `phone:${origin.deviceId}` : 'desktop' })
    },
    submitCode: request => flows.submitCode({ id: String(request.id ?? ''), code: request.code }),
    cancel: id => flows.cancel(String(id ?? '')),
    removeToken: () => { store.remove(); changed(); return state() },
    tokenRejected: message => { if (store.reject(message)) { deps.log?.('The long-lived Claude token was rejected; new Claude processes use the normal login.'); changed() } },
    phoneRoute: async (method, path, body, deviceId) => {
      if (method === 'GET' && path === '/api/login') return state()
      if (method !== 'POST') throw new LoginFlowError('Method not allowed', 405)
      if (path === '/api/login/start') return api.start({ provider: body.provider, mode: body.mode }, { kind: 'phone', deviceId })
      if (path === '/api/login/code') return api.submitCode({ id: body.id, code: body.code })
      if (path === '/api/login/cancel') return api.cancel(body.id)
      throw new LoginFlowError('Unknown route.', 404)
    },
    dispose: () => { flows.dispose(); setClaudeTokenSource(null) }
  }
  return api
}

/** The phone's /api/login routes. The listener has authenticated the paired device and, whenever a
 *  phone code is set, checked that this phone is unlocked before any of this runs. */
export function registerProviderLoginPhone(login: () => ProviderLogin | undefined): () => void {
  return registerPhoneApiRoute('/api/login', async (method, path, body, _query, device) => {
    const service = login()
    if (!service) throw new PhoneAccessError('Provider login is still starting.', 503)
    try { return await service.phoneRoute(method, path, body, device.id) }
    catch (error) { throw error instanceof LoginFlowError ? new PhoneAccessError(error.message, error.status) : error }
  })
}

/** Settings' calls (src/preload/provider-login.ts). Registered with the other trusted-UI handlers,
 *  before the login service exists; a call that comes earlier is refused. */
export function registerProviderLoginIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, login: () => ProviderLogin | undefined, authorize: (event: IpcMainInvokeEvent) => void): () => void {
  const ready = (event: IpcMainInvokeEvent): ProviderLogin => {
    authorize(event)
    const service = login()
    if (!service) throw new Error('Provider login is still starting.')
    return service
  }
  ipc.handle('provider-login:state', event => ready(event).state())
  ipc.handle('provider-login:start', (event, request: { provider?: unknown; mode?: unknown } | undefined) => ready(event).start({ provider: request?.provider, mode: request?.mode }, { kind: 'desktop' }))
  ipc.handle('provider-login:code', (event, request: { id?: unknown; code?: unknown } | undefined) => ready(event).submitCode({ id: request?.id, code: request?.code }))
  ipc.handle('provider-login:cancel', (event, id: unknown) => ready(event).cancel(id))
  ipc.handle('provider-login:remove-token', event => ready(event).removeToken())
  return () => { for (const channel of ['state', 'start', 'code', 'cancel', 'remove-token']) ipc.removeHandler(`provider-login:${channel}`) }
}
