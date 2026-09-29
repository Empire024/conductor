import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentProviderId } from '../../shared/models'
import { upgradeOfferId, type CatalogModel, type ModelUpgradeOffer, type ModelUpgradesStatus, type ProviderUpgradeWatch, type UpgradeProvider } from '../../shared/model-upgrades'
import { betterModels, compareVersions, label, type BetterModel } from './better'
import { CLI_PACKAGES, type CatalogProbe, type ScratchCli } from './cli-source'

export const UPGRADE_PROVIDERS: UpgradeProvider[] = ['codex', 'claude']
export const CHECK_EVERY_MS = 6 * 60 * 60_000
export const FIRST_CHECK_MS = 2 * 60_000
/** Retry an install that waits for busy tabs this often. */
export const INSTALL_RETRY_MS = 60_000
/** A protocol bump that has not produced a verified build by then is reported blocked. */
export const PREPARE_TIMEOUT_MS = 24 * 60 * 60_000

export interface InstallAppResult { installing: boolean; waiting?: string }

/** Everything the service needs from the app; each is a seam the tests replace. */
export interface ModelUpgradePorts {
  now(): number
  appVersion(): string
  /** The CLI every new tab of this provider launches (a pin wins over PATH), with its version, and
   *  the version of the owner's own installed CLI underneath any pin. */
  currentCli(provider: UpgradeProvider): Promise<{ executable: string; version: string | null; installed: string | null } | null>
  latestVersion(provider: UpgradeProvider): Promise<string>
  installScratch(provider: UpgradeProvider, version: string): Promise<ScratchCli>
  pruneScratch(keep: Partial<Record<UpgradeProvider, string[]>>): void
  probe(provider: UpgradeProvider, executable: string): Promise<CatalogProbe>
  /** The models the owner's picks currently name for this provider (default, preferred). */
  picks(provider: UpgradeProvider, catalog: readonly CatalogModel[]): string[]
  /** Whether this running Conductor connects to that CLI version (its protocol gate). */
  supports(provider: UpgradeProvider, version: string): boolean
  /** Record better models in the model registry. Best effort. */
  record?(provider: UpgradeProvider, cliVersion: string, models: BetterModel[]): void
  /** Start preparing a protocol bump: dispatch one fixer coworker. Returns its agent id, or why it cannot. */
  prepare(offer: ModelUpgradeOffer): Promise<{ agentId: string } | { blocked: string }>
  /** Whether that coworker's tab is still open. */
  fixerOpen(agentId: string): boolean
  /** The local update build, as app.update.status reports it. */
  candidate(): { state: string; commit: string | null; verified: boolean | null }
  /** Install the verified app update when no tab is working (the caller retries while waiting). */
  installApp(): Promise<InstallAppResult>
  /** Make `executable` the CLI every new tab of the provider launches. */
  adoptCli(provider: UpgradeProvider, version: string, executable: string): Promise<void>
  /** Drop a pin this service made once the installed CLI has caught up. */
  releaseCli(provider: UpgradeProvider): void
  /** Make `model` the pick wherever `replaces` was. */
  promote(provider: UpgradeProvider, model: string, replaces: string): void
  changed?(status: ModelUpgradesStatus): void
  log?(message: string): void
}

interface Persisted {
  schemaVersion: 1
  lastCheckAt: string | null
  wizardMayAccept: boolean
  providers: Partial<Record<UpgradeProvider, ProviderUpgradeWatch>>
  /** The catalog last seen per provider on the CLI it came from, so a model that appears on the
   *  current CLI is noticed too. */
  catalogs: Partial<Record<UpgradeProvider, { version: string | null; models: CatalogModel[] }>>
  /** Newer CLI versions already probed that offered nothing better: not installed again. */
  probed: Partial<Record<UpgradeProvider, string>>
  /** Pins this service made, per provider (the version). */
  pins: Partial<Record<UpgradeProvider, string>>
  offers: Array<ModelUpgradeOffer & { acceptedOnApp?: string }>
  declined: Record<string, string>
}
const empty = (): Persisted => ({ schemaVersion: 1, lastCheckAt: null, wizardMayAccept: false, providers: {}, catalogs: {}, probed: {}, pins: {}, offers: [], declined: {} })
const newer = (a: string, b: string | null): boolean => !b || compareVersions(a.split(/[.-]/).map(Number).filter(Number.isFinite), b.split(/[.-]/).map(Number).filter(Number.isFinite)) > 0
const settled = (offer: ModelUpgradeOffer): boolean => offer.state === 'applied' || offer.state === 'declined'
const message = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 400)

export type UpgradeActor = 'owner' | 'wizard'

/**
 * WATCH → PROBE → PREPARE → ONE OK (docs/model-upgrades.md). Checks each native CLI on npm and
 * re-reads the current catalog at startup and every 6 h; installs a newer CLI into a scratch
 * prefix, probes its catalog with a scratch config home, and when it offers a better model than the
 * owner's picks prepares what the switch needs (a protocol-bump build through one fixer coworker
 * when this Conductor cannot speak the new CLI) before showing the owner one offer. OK switches the
 * CLI, installs the verified build and promotes the model; a decline is remembered per model.
 */
export class ModelUpgradeService {
  private state: Persisted
  private timer: ReturnType<typeof setTimeout> | null = null
  private installTimer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private checking = false
  private nextCheckAt: number | null = null

  constructor(private readonly file: string, private readonly ports: ModelUpgradePorts, private readonly options: { enabled?: boolean } = {}) {
    this.state = this.load()
  }

  status(): ModelUpgradesStatus {
    return {
      enabled: this.options.enabled !== false,
      checking: this.checking,
      lastCheckAt: this.state.lastCheckAt,
      nextCheckAt: this.nextCheckAt ? new Date(this.nextCheckAt).toISOString() : null,
      wizardMayAccept: this.state.wizardMayAccept,
      providers: UPGRADE_PROVIDERS.map(provider => this.state.providers[provider] ?? { provider, package: CLI_PACKAGES[provider], installed: null, launches: null, latest: null, checkedAt: null, error: null }),
      offers: this.state.offers.map(({ acceptedOnApp: _acceptedOnApp, ...offer }) => structuredClone(offer)),
      declined: { ...this.state.declined }
    }
  }

  /** Startup: finish an OK that spanned a restart, then check shortly and every 6 h. */
  start(): void {
    if (this.options.enabled === false) return
    void this.resume()
    this.schedule(FIRST_CHECK_MS)
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.installTimer) clearTimeout(this.installTimer)
    this.timer = this.installTimer = null
    this.nextCheckAt = null
  }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.nextCheckAt = this.ports.now() + delay
    this.timer = setTimeout(() => { void this.check().finally(() => this.schedule(CHECK_EVERY_MS)) }, delay)
    this.timer.unref?.()
  }

  /** The catalog of the CLI new tabs launch, from the last probe (a short-lived app-server model/list
   *  or Claude initialize), in models.list shape; null before the first probe. */
  discoveredCatalog(provider: string): { version: string | null; models: Array<{ id: string; label: string; effort?: string[]; isDefault?: boolean }> } | null {
    const seen = UPGRADE_PROVIDERS.includes(provider as UpgradeProvider) ? this.state.catalogs[provider as UpgradeProvider] : undefined
    if (!seen) return null
    const models = seen.models.filter(model => !model.hidden && model.id !== 'default' && model.id !== 'auto').map(model => ({ id: model.id, label: model.displayName ?? model.id, ...(model.efforts?.length ? { effort: model.efforts } : {}), ...(model.isDefault ? { isDefault: true } : {}) }))
    return models.length ? { version: seen.version, models } : null
  }

  private async rediscover(provider: UpgradeProvider): Promise<void> {
    try {
      const current = await this.ports.currentCli(provider)
      if (!current) return
      const probe = await this.ports.probe(provider, current.executable)
      this.state.catalogs[provider] = { version: current.version ?? probe.version, models: probe.models }
      this.save()
    } catch (error) { this.ports.log?.(`${provider} catalog not re-discovered: ${message(error)}`) }
  }

  setWizardMayAccept(value: boolean): ModelUpgradesStatus {
    this.state.wizardMayAccept = value
    this.save()
    return this.status()
  }

  /** One pass over every provider; concurrent callers share it. */
  check(): Promise<void> {
    this.running ??= (async () => {
      this.checking = true
      this.emit()
      try {
        for (const provider of UPGRADE_PROVIDERS) await this.checkProvider(provider).catch(error => this.watch(provider, { error: message(error) }))
        this.maintain()
        this.state.lastCheckAt = new Date(this.ports.now()).toISOString()
        this.pruneScratch()
      } finally {
        this.checking = false
        this.running = null
        this.save()
      }
    })()
    return this.running
  }

  private async checkProvider(provider: UpgradeProvider): Promise<void> {
    const current = await this.ports.currentCli(provider)
    if (!current) { this.watch(provider, { installed: null, launches: null, error: `${provider} is not installed` }); return }
    // A pin this service made is released once the owner's own CLI has caught up with it.
    const pinned = this.state.pins[provider]
    if (pinned && current.installed && !newer(pinned, current.installed)) {
      this.ports.releaseCli(provider)
      delete this.state.pins[provider]
      return this.checkProvider(provider)
    }
    let latest: string | null = null, error: string | null = null
    try { latest = await this.ports.latestVersion(provider) } catch (failure) { error = `npm: ${message(failure)}` }
    this.watch(provider, { installed: current.installed, launches: current.version, latest, error })

    // The catalog on the current CLI: a model can arrive without a new CLI.
    let catalog: CatalogModel[] | null = null
    try { catalog = (await this.ports.probe(provider, current.executable)).models } catch (failure) { this.watch(provider, { error: `catalog: ${message(failure)}` }) }
    const seen = this.state.catalogs[provider]
    if (catalog) {
      if (seen && seen.version === current.version) {
        for (const found of this.better(provider, seen.models, catalog)) this.offer(provider, found, null, false)
      }
      this.state.catalogs[provider] = { version: current.version, models: catalog }
    }

    if (!latest || !current.version || !newer(latest, current.version)) return
    if (this.state.probed[provider] === latest) return
    if (this.state.offers.some(offer => offer.provider === provider && offer.cli?.to === latest && !settled(offer))) return
    const scratch = await this.ports.installScratch(provider, latest)
    const probe = await this.ports.probe(provider, scratch.executable)
    const found = this.better(provider, catalog ?? seen?.models ?? [], probe.models)
    if (!found.length) { this.state.probed[provider] = latest; this.ports.log?.(`${provider} ${latest} offers no better model`); return }
    try { this.ports.record?.(provider, latest, found) } catch (failure) { this.ports.log?.(`registry: ${message(failure)}`) }
    const bump = !this.ports.supports(provider, latest)
    const offer = this.offer(provider, found[0]!, { from: current.version, to: latest, executable: scratch.executable }, bump, found.slice(1))
    if (offer && bump) await this.startPrepare(offer)
  }

  private better(provider: UpgradeProvider, previous: readonly CatalogModel[], next: readonly CatalogModel[]): BetterModel[] {
    const skip = new Set([...Object.keys(this.state.declined), ...this.state.offers.map(offer => offer.id)].filter(id => id.startsWith(`${provider}:`)).map(id => id.slice(provider.length + 1)))
    return betterModels(provider as AgentProviderId, previous, next, this.ports.picks(provider, previous), skip)
  }

  private offer(provider: UpgradeProvider, found: BetterModel, cli: ModelUpgradeOffer['cli'], protocolBump: boolean, others: BetterModel[] = []): ModelUpgradeOffer | null {
    const id = upgradeOfferId(provider, found.model.id)
    if (this.state.declined[id] || this.state.offers.some(offer => offer.id === id)) return null
    const at = new Date(this.ports.now()).toISOString()
    const why = found.reasons.map(reason => reason.text).join('; ')
    const also = others.length ? ` Also new: ${others.map(entry => label(entry.model)).join(', ')}.` : ''
    const offer: ModelUpgradeOffer = {
      id, provider, model: found.model.id, label: label(found.model),
      replaces: { model: found.replaces.id, label: label(found.replaces) },
      reasons: found.reasons,
      summary: `${label(found.model)} is available (better than ${label(found.replaces)}: ${why}).${cli ? ` Needs ${provider === 'codex' ? 'Codex' : 'Claude Code'} ${cli.to} (now ${cli.from ?? 'unknown'}).` : ''}${also} Switch?`,
      state: protocolBump ? 'preparing' : 'ready', cli, protocolBump, candidate: null, fixer: null, reason: null, steps: [], createdAt: at, updatedAt: at
    }
    this.state.offers.push(offer)
    this.save()
    return offer
  }

  private async startPrepare(offer: ModelUpgradeOffer): Promise<void> {
    let result: { agentId: string } | { blocked: string }
    try { result = await this.ports.prepare(offer) } catch (error) { result = { blocked: message(error) } }
    this.update(offer.id, 'blocked' in result ? { state: 'blocked', reason: result.blocked } : { fixer: { agentId: result.agentId, startedAt: new Date(this.ports.now()).toISOString() } })
  }

  /** Offers that moved without anyone saying so: the running app now speaks the CLI, the fixer's
   *  tab closed without a verified build, or preparing took too long. */
  private maintain(): void {
    for (const offer of this.state.offers) {
      if (offer.state !== 'preparing') continue
      if (offer.cli?.to && this.ports.supports(offer.provider, offer.cli.to)) { this.update(offer.id, { state: 'ready', protocolBump: false, fixer: null, reason: null }); continue }
      if (offer.fixer && !offer.candidate && !this.ports.fixerOpen(offer.fixer.agentId)) this.update(offer.id, { state: 'blocked', fixer: null, reason: 'The coworker preparing the protocol bump closed without reporting a verified build (models.upgrades.prepared). Retry with models.upgrades.retry.' })
      else if (this.ports.now() - Date.parse(offer.createdAt) > PREPARE_TIMEOUT_MS) this.update(offer.id, { state: 'blocked', reason: 'Preparing the protocol bump took more than 24 h without a verified build.' })
    }
  }

  /** The fixer's report: a commit whose verified app.update build speaks the new CLI, or why not. */
  prepared(id: string, input: { commit?: string; blocked?: string }): ModelUpgradeOffer {
    const offer = this.find(id)
    if (offer.state !== 'preparing' && offer.state !== 'blocked') throw new Error(`${offer.label} is ${offer.state}, not being prepared`)
    if (input.blocked) return this.update(id, { state: 'blocked', reason: input.blocked.slice(0, 1000), fixer: null })
    const commit = input.commit?.trim()
    if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error('commit must be the sha whose app.update build was verified')
    const build = this.ports.candidate()
    if (build.state !== 'succeeded' || build.verified !== true || !build.commit || !(build.commit.startsWith(commit) || commit.startsWith(build.commit))) {
      throw new Error(`The local update build is not a verified build of ${commit} (state ${build.state}, commit ${build.commit ?? 'none'}, verified ${String(build.verified)}). Run app.update({commit, smoke:[...]}) and wait until app.update.status says verified, then call this again.`)
    }
    return this.update(id, { state: 'ready', candidate: { commit: build.commit, verified: true }, reason: null })
  }

  /** Try preparing a blocked offer again. */
  async retry(id: string): Promise<ModelUpgradeOffer> {
    const offer = this.find(id)
    if (offer.state !== 'blocked') throw new Error(`${offer.label} is ${offer.state}, not blocked`)
    if (!offer.protocolBump || (offer.cli?.to && this.ports.supports(offer.provider, offer.cli.to))) return this.update(id, { state: 'ready', protocolBump: false, reason: null })
    this.update(id, { state: 'preparing', reason: null, fixer: null, createdAt: new Date(this.ports.now()).toISOString() })
    await this.startPrepare(this.find(id))
    return this.find(id)
  }

  decline(id: string): ModelUpgradeOffer {
    const offer = this.find(id)
    if (offer.state === 'applying' || offer.state === 'applied') throw new Error(`${offer.label} is already ${offer.state}`)
    this.state.declined[id] = new Date(this.ports.now()).toISOString()
    return this.update(id, { state: 'declined', fixer: null })
  }

  /** The owner's one OK. A wizard tab may answer it only when the owner opted in. */
  async accept(id: string, actor: UpgradeActor): Promise<ModelUpgradeOffer> {
    if (actor === 'wizard' && !this.state.wizardMayAccept) throw new Error('The owner has not let wizard tabs accept model upgrades (models.upgrades.configure({wizardMayAccept:true}) from the owner, or the switch on the upgrade card). Ask the owner to click OK on the card.')
    const offer = this.find(id)
    if (offer.state !== 'ready') throw new Error(`${offer.label} is ${offer.state}${offer.reason ? ` (${offer.reason})` : ''}; only a ready upgrade can be accepted`)
    this.update(id, { state: 'applying', steps: [`accepted by the ${actor}`], reason: null })
    this.find(id).acceptedOnApp = this.ports.appVersion()
    this.save()
    await this.advance(id)
    return this.find(id)
  }

  /** On startup: an OK that installed a Conductor update continues on the new build. */
  async resume(): Promise<void> {
    for (const offer of this.state.offers.filter(entry => entry.state === 'applying')) await this.advance(offer.id).catch(error => this.update(offer.id, { state: 'blocked', reason: message(error) }))
  }

  private async advance(id: string): Promise<void> {
    const offer = this.find(id)
    if (offer.state !== 'applying') return
    const to = offer.cli?.to
    if (to && !this.ports.supports(offer.provider, to)) {
      if (offer.acceptedOnApp && offer.acceptedOnApp !== this.ports.appVersion()) {
        this.update(id, { state: 'blocked', reason: `Conductor ${this.ports.appVersion()} still cannot run ${offer.provider} ${to}; the verified update did not install. Nothing was switched.` })
        return
      }
      if (!offer.candidate) { this.update(id, { state: 'blocked', reason: `This Conductor cannot run ${offer.provider} ${to} and no verified build that can is ready. Nothing was switched.` }); return }
      let result: InstallAppResult
      try { result = await this.ports.installApp() } catch (error) { this.update(id, { state: 'blocked', reason: `Installing the verified Conductor build failed: ${message(error)}. Nothing was switched.` }); return }
      if (result.installing) { this.step(id, 'installing the verified Conductor build; the switch finishes after the restart'); return }
      this.step(id, `waiting to install the Conductor update: ${result.waiting ?? 'tabs are working'}`)
      if (this.installTimer) clearTimeout(this.installTimer)
      this.installTimer = setTimeout(() => { this.installTimer = null; void this.advance(id).catch(error => this.update(id, { state: 'blocked', reason: message(error) })) }, INSTALL_RETRY_MS)
      this.installTimer.unref?.()
      return
    }
    if (offer.cli?.to && offer.cli.executable) {
      await this.ports.adoptCli(offer.provider, offer.cli.to, offer.cli.executable)
      this.state.pins[offer.provider] = offer.cli.to
      this.step(id, `new ${offer.provider} tabs launch ${offer.provider} ${offer.cli.to}`)
    }
    // Re-discover the catalog of the CLI new tabs now launch, so models.list and router.dispatch
    // offer the new model at once rather than the catalog an older tab still carries.
    await this.rediscover(offer.provider)
    this.ports.promote(offer.provider, offer.model, offer.replaces.model)
    this.step(id, `${offer.label} is now the pick where ${offer.replaces.label} was`)
    this.update(id, { state: 'applied' })
  }

  private step(id: string, text: string): void {
    const offer = this.find(id)
    this.update(id, { steps: [...offer.steps, text].slice(-20) })
  }
  private find(id: string): Persisted['offers'][number] {
    const offer = this.state.offers.find(entry => entry.id === id)
    if (!offer) throw new Error(`No model upgrade ${id}; models.upgrades.status lists them`)
    return offer
  }
  private update(id: string, patch: Partial<ModelUpgradeOffer>): ModelUpgradeOffer {
    const offer = this.find(id)
    Object.assign(offer, patch, { updatedAt: new Date(this.ports.now()).toISOString() })
    this.save()
    const { acceptedOnApp: _acceptedOnApp, ...rest } = offer
    return structuredClone(rest)
  }
  private watch(provider: UpgradeProvider, patch: Partial<ProviderUpgradeWatch>): void {
    const previous = this.state.providers[provider] ?? { provider, package: CLI_PACKAGES[provider], installed: null, launches: null, latest: null, checkedAt: null, error: null }
    this.state.providers[provider] = { ...previous, ...patch, checkedAt: new Date(this.ports.now()).toISOString() }
  }
  private pruneScratch(): void {
    const keep: Partial<Record<UpgradeProvider, string[]>> = {}
    for (const offer of this.state.offers) if (offer.cli?.to && !settled(offer)) (keep[offer.provider] ??= []).push(offer.cli.to)
    try { this.ports.pruneScratch(keep) } catch (error) { this.ports.log?.(`prune: ${message(error)}`) }
  }
  private emit(): void { try { this.ports.changed?.(this.status()) } catch { /* a closed window */ } }
  private load(): Persisted {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.offers)) return { ...empty(), ...parsed }
    } catch { /* first run */ }
    return empty()
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
    this.emit()
  }
}
