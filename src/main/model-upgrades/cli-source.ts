import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { plainCliVersion, runVersion } from '../cli-versions'
import type { CatalogModel, UpgradeProvider } from '../../shared/model-upgrades'

/** The npm packages the native CLIs are published as. The installed CLIs on this machine may come
 *  from the standalone installers instead; npm is only where Conductor learns a new version exists
 *  and where it fetches a scratch copy to probe. */
export const CLI_PACKAGES: Record<UpgradeProvider, string> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const EXE = process.platform === 'win32' ? '.exe' : ''
const READY = 'conductor-scratch-cli.json'

/** `CONDUCTOR_NPM_REGISTRY` points the watch at a fake registry in tests. */
export const npmRegistry = (environment: NodeJS.ProcessEnv = process.env): string => (environment.CONDUCTOR_NPM_REGISTRY?.trim() || DEFAULT_REGISTRY).replace(/\/+$/, '')

/** The `latest` dist-tag of a package: one small GET, no npm process. */
export async function latestVersion(pkg: string, registry: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<string> {
  const response = await fetchImpl(`${registry}/${pkg.replace('/', '%2f')}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${pkg}: registry answered HTTP ${response.status}`)
  const version = plainCliVersion(String(((await response.json()) as { version?: unknown }).version ?? ''))
  if (!version) throw new Error(`${pkg}: registry reported no version`)
  return version
}

/** Node for helper scripts: Electron behaves as Node when told to, so no PATH lookup on main. */
export const nodeCommand = (): { command: string; env: NodeJS.ProcessEnv } => ({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })

const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise(resolve => {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const child = shell
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(arg => /[\s"]/.test(arg) ? `"${arg}"` : arg).join(' ')}"`], { cwd: options.cwd, env: options.env, windowsHide: true, windowsVerbatimArguments: true })
    : spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout?.on('data', chunk => { if (stdout.length < 2_000_000) stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000) })
  const timer = setTimeout(() => child.kill(), options.timeoutMs)
  child.once('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` }) })
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
})

export const readCliVersion = (executable: string): Promise<string | null> => runVersion(executable)

/** The native executable inside an npm install: Codex ships it in its platform package
 *  (vendor/<triple>/codex/codex.exe), Claude Code in its own. A package that only ships a
 *  JavaScript entry has no executable a tab can launch directly. On Windows a package-owned
 *  `<provider>.cmd` (never npm's own .bin shims) is the fallback. */
export function findPackagedExecutable(prefix: string, provider: UpgradeProvider): string | null {
  return findFile(prefix, `${provider}${EXE}`) ?? (process.platform === 'win32' ? findFile(prefix, `${provider}.cmd`) : null)
}
function findFile(prefix: string, wanted: string): string | null {
  const queue: Array<[string, number]> = [[join(prefix, 'node_modules'), 0]]
  while (queue.length) {
    const [folder, depth] = queue.shift()!
    let entries: import('node:fs').Dirent[] = []
    try { entries = readdirSync(folder, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isFile() && entry.name === wanted) return path
      if (entry.isDirectory() && depth < 9 && entry.name !== '.bin') queue.push([path, depth + 1])
    }
  }
  return null
}

export interface ScratchCli { provider: UpgradeProvider; version: string; prefix: string; executable: string }

/** npm used for scratch installs: `CONDUCTOR_MODEL_UPGRADE_NPM` (a script run with Node in tests,
 *  or another npm), otherwise npm from PATH. */
function npmInvocation(environment: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const configured = environment.CONDUCTOR_MODEL_UPGRADE_NPM?.trim()
  if (configured && /\.(mjs|cjs|js)$/i.test(configured)) { const node = nodeCommand(); return { command: node.command, args: [configured], env: node.env } }
  return { command: configured || (process.platform === 'win32' ? 'npm.cmd' : 'npm'), args: [], env: {} }
}

/**
 * Installs `<package>@<version>` into `<root>/<provider>/<version>`, never globally. Staged and
 * renamed into place only after its executable reports the expected version, so a failed or
 * interrupted install leaves nothing behind. A finished install is reused.
 */
export async function installScratchCli(root: string, provider: UpgradeProvider, version: string, options: { registry?: string; environment?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ScratchCli> {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error(`Invalid CLI version ${version}`)
  const environment = options.environment ?? process.env
  const prefix = join(root, provider, version)
  const ready = readReady(prefix)
  if (ready && existsSync(ready.executable)) return { provider, version, prefix, executable: ready.executable }
  const staging = join(root, provider, `.staging-${version}-${process.pid}-${Date.now()}`)
  mkdirSync(staging, { recursive: true })
  try {
    // A package.json keeps npm from walking up to some parent project.
    writeFileSync(join(staging, 'package.json'), '{"name":"conductor-scratch-cli","private":true}\n')
    const npm = npmInvocation(environment)
    const registry = options.registry ?? npmRegistry(environment)
    const result = await run(npm.command, [...npm.args, 'install', '--prefix', staging, '--no-save', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`, `${CLI_PACKAGES[provider]}@${version}`], { cwd: staging, env: { ...process.env, ...environment, ...npm.env, npm_config_global: 'false' }, timeoutMs: options.timeoutMs ?? 10 * 60_000 })
    if (result.code !== 0) throw new Error(`npm install ${CLI_PACKAGES[provider]}@${version} failed (exit ${result.code ?? 'none'}): ${lastLine(result.stderr)}`)
    const staged = findPackagedExecutable(staging, provider)
    if (!staged) throw new Error(`${CLI_PACKAGES[provider]}@${version} ships no ${provider}${EXE} executable Conductor could launch`)
    const reported = await readCliVersion(staged)
    if (reported !== version) throw new Error(`the scratch ${provider} reports ${reported ?? 'no version'}, expected ${version}`)
    rmSync(prefix, { recursive: true, force: true })
    renameSync(staging, prefix)
    const executable = join(prefix, staged.slice(staging.length + 1))
    writeFileSync(join(prefix, READY), `${JSON.stringify({ provider, version, executable, installedAt: new Date().toISOString() }, null, 2)}\n`)
    return { provider, version, prefix, executable }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}
function readReady(prefix: string): { executable: string } | null {
  try { const value = JSON.parse(readFileSync(join(prefix, READY), 'utf8')) as { executable?: unknown }; return typeof value.executable === 'string' ? { executable: value.executable } : null } catch { return null }
}
const lastLine = (text: string): string => text.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400) || 'no output'

/** Removes scratch installs other than `keep` (per provider). */
export function pruneScratch(root: string, keep: Partial<Record<UpgradeProvider, string[]>>): void {
  for (const provider of ['claude', 'codex'] as const) {
    let names: string[] = []
    try { names = readdirSync(join(root, provider)) } catch { continue }
    for (const name of names) if (!(keep[provider] ?? []).includes(name)) rmSync(join(root, provider, name), { recursive: true, force: true })
  }
}

/** Where each CLI keeps its sign-in, and the variable that moves its whole config home. */
function authFiles(provider: UpgradeProvider, environment: NodeJS.ProcessEnv, home: string): { variable: string; files: Array<[string, string]> } {
  if (provider === 'codex') {
    const codexHome = environment.CODEX_HOME?.trim() || join(home, '.codex')
    return { variable: 'CODEX_HOME', files: [[join(codexHome, 'auth.json'), 'auth.json']] }
  }
  const claudeHome = environment.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  return { variable: 'CLAUDE_CONFIG_DIR', files: [[join(claudeHome, '.credentials.json'), '.credentials.json']] }
}

/** A scratch home's sign-in must not be able to refresh. Both CLIs rotate their OAuth refresh
 *  token: a copy that refreshes spends the token the owner's own file still holds, the refreshed
 *  pair is deleted with the scratch home, and the owner's next refresh fails ("OAuth session
 *  expired and could not be refreshed", docs/verification/2026-10-04-claude-logout.md). The CLI's
 *  own cross-process refresh lock cannot see a copy in another config home. So the copy keeps the
 *  access token and drops the refresh token; null when the access token is about to expire (a
 *  CLI would try to refresh it) or the file is not one Conductor can strip safely. */
export const SCRATCH_SIGN_IN_MARGIN_MS = 15 * 60_000
export function scratchSignIn(provider: UpgradeProvider, raw: string, now = Date.now()): string | null {
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  if (provider === 'claude') {
    const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined
    if (!oauth || typeof oauth.accessToken !== 'string') return null
    if (typeof oauth.expiresAt !== 'number' || oauth.expiresAt - now < SCRATCH_SIGN_IN_MARGIN_MS) return null
    const { refreshToken: _refresh, refreshTokenExpiresAt: _refreshExpiry, ...kept } = oauth
    return JSON.stringify({ claudeAiOauth: kept })
  }
  const tokens = parsed.tokens as Record<string, unknown> | null | undefined
  if (!tokens) return typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY ? JSON.stringify(parsed) : null
  if (typeof tokens.access_token !== 'string') return null
  // An empty refresh token fails a refresh instead of rotating the owner's; a fresh last_refresh
  // keeps Codex from refreshing proactively on start.
  return JSON.stringify({ ...parsed, tokens: { ...tokens, refresh_token: '' }, last_refresh: new Date(now).toISOString() })
}

export interface CatalogProbe { version: string | null; models: CatalogModel[] }

/**
 * What `executable` offers this account: the latest-models `cli-catalogs.mjs` probe (initialize
 * and model/list; never a turn) run against it with a scratch config home that holds only a copy of
 * the sign-in file, so the owner's config, history and MCP servers are neither read nor touched. The
 * copy can never refresh (scratchSignIn); with a long-lived Claude token in the environment
 * (CLAUDE_CODE_OAUTH_TOKEN) nothing is copied at all.
 */
export async function probeCatalog(options: { provider: UpgradeProvider; executable: string; script: string; workDirectory: string; environment?: NodeJS.ProcessEnv; home?: string; timeoutMs?: number; now?: number }): Promise<CatalogProbe> {
  const environment = options.environment ?? process.env
  const scratch = join(options.workDirectory, `probe-${options.provider}-${process.pid}-${Date.now()}`)
  const configHome = join(scratch, 'home')
  mkdirSync(configHome, { recursive: true })
  try {
    const auth = authFiles(options.provider, environment, options.home ?? homedir())
    const tokenInEnvironment = options.provider === 'claude' && Boolean(environment.CLAUDE_CODE_OAUTH_TOKEN?.trim())
    if (!tokenInEnvironment) for (const [from, to] of auth.files) {
      if (!existsSync(from) || !statSync(from).isFile()) continue
      const copy = scratchSignIn(options.provider, readFileSync(from, 'utf8'), options.now)
      if (copy === null) throw new Error(`the ${options.provider} sign-in is due for a refresh; the catalog probe waits for the next check rather than refresh a copy of it`)
      writeFileSync(join(configHome, to), copy, { mode: 0o600 })
    }
    const scriptPath = join(scratch, 'cli-catalogs.mjs')
    writeFileSync(scriptPath, options.script)
    const node = nodeCommand()
    const other = options.provider === 'codex' ? 'CONDUCTOR_CLAUDE_PATH' : 'CONDUCTOR_CODEX_PATH'
    const own = options.provider === 'codex' ? 'CONDUCTOR_CODEX_PATH' : 'CONDUCTOR_CLAUDE_PATH'
    const result = await run(node.command, [scriptPath], { cwd: scratch, env: { ...process.env, ...environment, ...node.env, [own]: options.executable, [other]: join(scratch, `missing${EXE}`), [auth.variable]: configHome }, timeoutMs: options.timeoutMs ?? 180_000 })
    let parsed: Record<string, { version?: unknown; models?: unknown; error?: unknown }>
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error(`catalog probe of ${basename(options.executable)} printed no catalog: ${lastLine(result.stderr)}`) }
    const side = parsed[options.provider]
    if (!side || side.error || !Array.isArray(side.models)) throw new Error(`catalog probe of ${options.provider}: ${String(side?.error ?? 'no models')}`)
    return { version: typeof side.version === 'string' ? side.version : null, models: normalizeCatalog(options.provider, side.models) }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/** cli-catalogs entries (Claude `value`, Codex `id`) to CatalogModel. */
export function normalizeCatalog(provider: UpgradeProvider, models: unknown[]): CatalogModel[] {
  const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
  return models.flatMap(entry => {
    const model = (entry ?? {}) as Record<string, unknown>
    const id = provider === 'claude' ? text(model.value) ?? text(model.id) : text(model.id)
    if (!id) return []
    return [{ id, displayName: text(model.displayName), description: text(model.description), hidden: model.hidden === true, isDefault: model.isDefault === true, upgrade: text(model.upgrade), efforts: Array.isArray(model.efforts) ? model.efforts.filter((item): item is string => typeof item === 'string') : [] }]
  })
}
