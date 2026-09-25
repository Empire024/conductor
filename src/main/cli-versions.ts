import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { CliPinState, PinnableCli, RestorePlan, RestorePlanCli, RestorePoint, RestoreScope } from '../shared/models'

/** FX20: Conductor never installs or changes the owner's CLIs. It keeps its own copies of the
 * Claude Code and Codex versions it has seen (hard links into the CLIs' own immutable version
 * folders where it can, copies otherwise) and a pin per CLI; a pinned CLI is what every tab of
 * that provider launches, so rolling the CLIs back is instant and needs no network. */
export const PINNABLE_CLIS: PinnableCli[] = ['claude', 'codex']
export const CLI_LABEL: Record<PinnableCli, string> = { claude: 'Claude Code', codex: 'Codex' }
const ENV: Record<PinnableCli, string> = { claude: 'CONDUCTOR_CLAUDE_PATH', codex: 'CONDUCTOR_CODEX_PATH' }
const EXE = process.platform === 'win32' ? '.exe' : ''
const PINS = 'cli-pins.json'
const MANIFEST = 'cli-version.json'

export const isPinnableCli = (value: string): value is PinnableCli => (PINNABLE_CLIS as string[]).includes(value)
/** `2.1.281 (Claude Code)`, `codex-cli 0.155.1` → the bare version the restore point means. */
export const plainCliVersion = (value: string | null | undefined): string | null => /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(value ?? '')?.[0] ?? null
const safeVersion = (version: string): string => {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error(`Invalid CLI version ${version}`)
  return version
}

interface CliPin { version: string; executable: string; pinnedAt: string; restorePoint?: string }
interface PinFile { schemaVersion: 1; pins: Partial<Record<PinnableCli, CliPin>> }
interface Manifest { schemaVersion: 1; provider: PinnableCli; version: string; entry: string; cachedAt: string; source: string }
/** A CLI version's files: one executable, or a Codex standalone package (bin/, resources, path). */
type Source = { kind: 'file'; path: string; immutable: boolean } | { kind: 'package'; root: string; entry: string }
export type CliAvailability = 'installed' | 'saved copy' | 'CLI install folder' | 'missing'

export interface CliVersionStoreOptions {
  /** Where the copies and the pin file live (beside the restore points). */
  directory: string
  /** Home folder whose CLI install folders are searched for older versions. */
  home?: string
  /** The CLI Conductor would launch without a pin: CONDUCTOR_<CLI>_PATH, then PATH. */
  resolveInstalled?(provider: PinnableCli): string | null
  readVersion?(executable: string): Promise<string | null>
  now?(): number
}

const findInstalled = (provider: PinnableCli): string | null => {
  const configured = process.env[ENV[provider]]?.trim()
  if (configured) return configured
  try {
    const output = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [provider], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return output.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null
  } catch { return null }
}
const runVersion = (executable: string): Promise<string | null> => new Promise(resolve => {
  execFile(executable, ['--version'], { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 }, (error, stdout) => resolve(error ? null : plainCliVersion(String(stdout))))
})
const atomicJson = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}
/** A hard link shares the bytes of a version folder the CLI never rewrites; anything else (the
 * live `claude.exe` an updater overwrites in place, another volume) is copied. */
const place = (from: string, to: string, link: boolean): void => {
  if (link) { try { linkSync(from, to); return } catch { /* another volume or no permission: copy */ } }
  copyFileSync(from, to)
}
const mirror = (from: string, to: string): void => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name), target = join(to, entry.name)
    if (entry.isDirectory()) mirror(source, target)
    else if (entry.isFile()) place(source, target, true)
  }
}

export class CliVersionStore {
  private pinCache: PinFile | null = null
  private readonly home: string
  constructor(private readonly options: CliVersionStoreOptions) {
    mkdirSync(options.directory, { recursive: true })
    this.home = options.home ?? homedir()
  }

  /** Sync: every tab launch asks. A pin whose copy has gone is ignored rather than breaking tabs. */
  pinnedExecutable(provider: PinnableCli): string | null {
    const pin = this.readPins().pins[provider]
    return pin && existsSync(pin.executable) ? pin.executable : null
  }
  pins(): Partial<Record<PinnableCli, CliPin>> { return structuredClone(this.readPins().pins) }

  installedExecutable(provider: PinnableCli): string | null { return (this.options.resolveInstalled ?? findInstalled)(provider) }
  async installed(provider: PinnableCli): Promise<{ executable: string; version: string | null } | null> {
    const executable = this.installedExecutable(provider)
    return executable ? { executable, version: await this.version(executable) } : null
  }
  async pinStates(): Promise<CliPinState[]> {
    const pins = this.readPins().pins, states: CliPinState[] = []
    for (const provider of PINNABLE_CLIS) {
      const pin = pins[provider]
      if (pin) states.push({ provider, label: CLI_LABEL[provider], version: pin.version, installed: (await this.installed(provider))?.version ?? null, pinnedAt: pin.pinnedAt, ...(pin.restorePoint ? { restorePoint: pin.restorePoint } : {}) })
    }
    return states
  }

  cachedVersions(provider: PinnableCli): string[] {
    try { return readdirSync(join(this.options.directory, provider)).filter(name => !name.startsWith('.') && this.cachedEntry(provider, name)) }
    catch { return [] }
  }
  /** Where a version can come from without the network, best first. */
  availability(provider: PinnableCli, version: string, installedVersion: string | null): CliAvailability {
    if (installedVersion === version) return 'installed'
    if (this.cachedEntry(provider, version)) return 'saved copy'
    return this.installFolderSource(provider, version) ? 'CLI install folder' : 'missing'
  }

  /** Saves the installed CLIs and every still-installed version the given restore points name. */
  async snapshot(recorded: Partial<Record<PinnableCli, Iterable<string>>> = {}): Promise<void> {
    for (const provider of PINNABLE_CLIS) {
      const installed = await this.installed(provider).catch(() => null)
      if (installed?.version && !installed.executable.startsWith(this.options.directory)) {
        await this.save(provider, installed.version, this.installFolderSource(provider, installed.version) ?? this.sourceOf(provider, installed.executable, installed.version)).catch(error => console.warn(`Could not save ${CLI_LABEL[provider]} ${installed.version}`, error))
      }
      for (const version of recorded[provider] ?? []) {
        const source = this.cachedEntry(provider, version) ? null : this.installFolderSource(provider, version)
        if (source) await this.save(provider, version, source).catch(error => console.warn(`Could not save ${CLI_LABEL[provider]} ${version}`, error))
      }
    }
  }

  /** Puts back the recorded CLI versions: all copies are made and checked before any pin moves. */
  async restore(plan: RestorePlan): Promise<RestorePlanCli[]> {
    const next = this.readPins()
    const pins: Array<[PinnableCli, CliPin | null]> = []
    for (const change of plan.clis) {
      if (change.action === 'unpin') pins.push([change.provider, null])
      if (change.action !== 'pin' || !change.to) continue
      const executable = await this.ensureSaved(change.provider, change.to)
      pins.push([change.provider, { version: change.to, executable, pinnedAt: new Date(this.now()).toISOString(), restorePoint: plan.version }])
    }
    for (const [provider, pin] of pins) {
      if (pin) next.pins[provider] = pin
      else delete next.pins[provider]
    }
    if (pins.length) this.writePins(next)
    return plan.clis.filter(change => change.action === 'pin' || change.action === 'unpin')
  }
  /** "Use installed CLIs": every tab launches what CONDUCTOR_<CLI>_PATH or PATH names again. */
  clearPins(provider?: PinnableCli): void {
    const next = this.readPins()
    for (const key of provider ? [provider] : PINNABLE_CLIS) delete next.pins[key]
    this.writePins(next)
  }

  /** Removes copies no restore point, pin or installed CLI still names. */
  async prune(keep: Partial<Record<PinnableCli, Iterable<string>>>): Promise<void> {
    const pins = this.readPins().pins
    for (const provider of PINNABLE_CLIS) {
      const installed = (await this.installed(provider).catch(() => null))?.version
      const kept = new Set([...(keep[provider] ?? []), ...(installed ? [installed] : []), ...(pins[provider] ? [pins[provider]!.version] : [])])
      for (const version of this.cachedVersions(provider)) if (!kept.has(version)) rmSync(join(this.options.directory, provider, version), { recursive: true, force: true })
    }
  }

  async ensureSaved(provider: PinnableCli, version: string): Promise<string> {
    safeVersion(version)
    const cached = this.cachedEntry(provider, version)
    if (cached) return cached
    const installed = await this.installed(provider)
    const source = this.installFolderSource(provider, version) ?? (installed?.version === version ? this.sourceOf(provider, installed.executable, version) : null)
    if (!source) throw new Error(`${CLI_LABEL[provider]} ${version} is no longer on this machine and Conductor has no saved copy of it`)
    return this.save(provider, version, source)
  }

  private async save(provider: PinnableCli, version: string, source: Source): Promise<string> {
    safeVersion(version)
    const existing = this.cachedEntry(provider, version)
    if (existing) return existing
    const parent = join(this.options.directory, provider), target = join(parent, version)
    const staging = join(parent, `.staging-${process.pid}-${Date.now()}`)
    mkdirSync(staging, { recursive: true })
    try {
      let entry: string
      if (source.kind === 'file') { entry = `${provider}${EXE}`; place(source.path, join(staging, entry), source.immutable) }
      else { mirror(source.root, staging); entry = source.entry }
      const reported = await this.version(join(staging, entry))
      if (reported !== version) throw new Error(`${CLI_LABEL[provider]} copy reports ${reported ?? 'no version'}, expected ${version}`)
      atomicJson(join(staging, MANIFEST), { schemaVersion: 1, provider, version, entry, cachedAt: new Date(this.now()).toISOString(), source: source.kind === 'file' ? source.path : source.root } satisfies Manifest)
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      renameSync(staging, target)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    return join(target, source.kind === 'file' ? `${provider}${EXE}` : source.entry)
  }

  private cachedEntry(provider: PinnableCli, version: string): string | null {
    try {
      const folder = join(this.options.directory, provider, safeVersion(version))
      const manifest = JSON.parse(readFileSync(join(folder, MANIFEST), 'utf8')) as Manifest
      const entry = join(folder, manifest.entry)
      return manifest.version === version && !relative(folder, entry).startsWith('..') && existsSync(entry) ? entry : null
    } catch { return null }
  }
  /** The CLIs' own per-version folders, which their updaters add to and never rewrite: Claude
   * Code's native installer keeps ~/.local/share/claude/versions/<version>, the Codex standalone
   * installer ~/.codex/packages/standalone/releases/<version>-<target>/. */
  private installFolderSource(provider: PinnableCli, version: string): Source | null {
    if (provider === 'claude') {
      const path = join(this.home, '.local', 'share', 'claude', 'versions', version)
      try { return statSync(path).isFile() ? { kind: 'file', path, immutable: true } : null } catch { return null }
    }
    const releases = join(this.home, '.codex', 'packages', 'standalone', 'releases')
    let names: string[] = []
    try { names = readdirSync(releases).filter(name => name === version || name.startsWith(`${version}-`)) } catch { return null }
    for (const name of names) {
      const source = this.codexPackage(join(releases, name), version)
      if (source) return source
    }
    return null
  }
  private codexPackage(root: string, version: string): Source | null {
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'codex-package.json'), 'utf8')) as { version?: string; entrypoint?: string }
      const entry = manifest.entrypoint ?? `bin/codex${EXE}`
      return manifest.version === version && existsSync(join(root, entry)) && !relative(root, join(root, entry)).startsWith('..') ? { kind: 'package', root, entry } : null
    } catch { return null }
  }
  /** The installed executable itself: a Codex standalone package when it sits in one (following
   * the `current` link to its release folder), otherwise the one file, copied. */
  private sourceOf(provider: PinnableCli, executable: string, version: string): Source {
    let real = executable
    try { real = realpathSync(executable) } catch { /* keep the given path */ }
    if (provider === 'codex' && basename(dirname(real)) === 'bin') {
      const source = this.codexPackage(dirname(dirname(real)), version)
      if (source) return source
    }
    return { kind: 'file', path: real, immutable: false }
  }
  private version(executable: string): Promise<string | null> { return (this.options.readVersion ?? runVersion)(executable) }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private readPins(): PinFile {
    if (this.pinCache) return structuredClone(this.pinCache)
    let value: PinFile = { schemaVersion: 1, pins: {} }
    try {
      const parsed = JSON.parse(readFileSync(join(this.options.directory, PINS), 'utf8')) as PinFile
      if (parsed?.schemaVersion === 1 && parsed.pins && typeof parsed.pins === 'object') value = { schemaVersion: 1, pins: Object.fromEntries(Object.entries(parsed.pins).filter(([key, pin]) => isPinnableCli(key) && typeof pin?.executable === 'string' && typeof pin.version === 'string')) }
    } catch { /* no pins */ }
    this.pinCache = value
    return structuredClone(value)
  }
  private writePins(value: PinFile): void {
    atomicJson(join(this.options.directory, PINS), value)
    this.pinCache = structuredClone(value)
  }
}

export interface RestorePlanInput {
  point: RestorePoint
  scope: RestoreScope
  currentAppVersion: string
  /** False when the saved build's update descriptor is gone; only the CLIs can come back then. */
  appRestorable: boolean
  clis: Record<PinnableCli, { installed: string | null; pinned: string | null; availability: CliAvailability }>
  currentModels: RestorePoint['models']
}

const modelIds = (models: RestorePoint['models'], provider: string): Set<string> => new Set(models.find(entry => entry.provider === provider)?.models.map(model => model.id) ?? [])

/** What a rollback will change, shown to the owner before they confirm it. */
export function restorePlan(input: RestorePlanInput): RestorePlan {
  const { point, scope } = input
  const warnings: string[] = []
  const clis = PINNABLE_CLIS.map((provider): RestorePlanCli => {
    const state = input.clis[provider], label = CLI_LABEL[provider]
    const to = plainCliVersion(point.cliVersions[provider]), from = state.pinned ?? state.installed
    if (!to) return { provider, label, from, to: null, action: 'unrecorded' }
    if (to === from) return { provider, label, from, to, action: 'keep' }
    if (to === state.installed) return { provider, label, from, to, action: 'unpin' }
    if (state.availability === 'saved copy' || state.availability === 'CLI install folder') return { provider, label, from, to, action: 'pin', source: state.availability }
    warnings.push(`${label} ${to} is no longer on this machine and Conductor has no saved copy; it stays on ${from ?? 'the installed version'}.`)
    return { provider, label, from, to, action: 'unavailable' }
  })
  const app = scope === 'all' ? { from: input.currentAppVersion, to: point.version } : null
  const changes = clis.filter(change => change.action === 'pin' || change.action === 'unpin')
  let blocked: string | undefined
  if (scope === 'all') {
    if (point.version === input.currentAppVersion) blocked = `Conductor ${point.version} is already running; roll back the CLIs only.`
    else if (!input.appRestorable) blocked = `Restore point ${point.version} has no saved build any more; roll back the CLIs only.`
    else if (changes.some(change => change.action === 'pin') && !point.cliPinning) warnings.push(`Conductor ${point.version} was built before CLI rollback: once it restarts it launches the installed CLIs again. Roll back the CLIs only to keep this Conductor and the older CLIs.`)
  } else if (!changes.length) {
    blocked = clis.some(change => change.action === 'unavailable') ? 'None of the recorded CLI versions can be restored on this machine.'
      : clis.every(change => change.action === 'unrecorded') ? `Restore point ${point.version} did not record its CLI versions.`
        : 'The CLIs already match this restore point.'
  }
  if (changes.length) warnings.push('Open tabs keep the CLI process they are running; new tabs, and tabs whose CLI restarts, use the restored versions.')
  const providers = [...new Set([...point.models, ...input.currentModels].map(entry => entry.provider))].sort()
  const models = providers.map(provider => {
    const recorded = modelIds(point.models, provider), now = modelIds(input.currentModels, provider)
    return { provider, added: [...recorded].filter(id => !now.has(id)).sort(), removed: [...now].filter(id => !recorded.has(id)).sort() }
  }).filter(entry => point.models.some(recorded => recorded.provider === entry.provider) && (entry.added.length || entry.removed.length))
  return { version: point.version, scope, app, clis, models, warnings, ...(blocked ? { blocked } : {}) }
}

/** The store every provider launch consults; set once by the UpdateManager that owns it. */
let active: CliVersionStore | null = null
export const setActiveCliVersions = (store: CliVersionStore | null): void => { active = store }
export const pinnedCliExecutable = (provider: string): string | null => active && isPinnableCli(provider) ? active.pinnedExecutable(provider) : null
