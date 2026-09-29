import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IngestionBatch } from '../../shared/model-routing'
import type { ModelUpgradeOffer, UpgradeProvider } from '../../shared/model-upgrades'
import { CLAUDE_FALLBACK_MODEL, CODEX_FALLBACK_MODEL } from '../../shared/agent-model-selection'
import { isFrontierModel } from '../../shared/structured-agent'
import { capabilityRank } from '../../shared/model-routing'
import { promotedModel, promotedModels, setPromotedModels, type PromotedModels } from '../../shared/promoted-models'
import { activeCliVersions } from '../cli-versions'
import { CODEX_VERIFIED_RUNTIMES } from '../providers/codex'
import { claudeCompatibility } from '../providers/claude'
import { familyOf } from '../model-intelligence/registry'
import type { LocalUpdateBuildService } from '../local-update-build'
import { installScratchCli, latestVersion, npmRegistry, CLI_PACKAGES, probeCatalog, pruneScratch, readCliVersion } from './cli-source'
import { ModelUpgradeService, type InstallAppResult, type ModelUpgradePorts } from './service'
import type { BetterModel } from './better'

export const PROMOTED_SETTING = 'model-upgrades:promoted'

/** The protocol gate the Codex adapter applies at connect (codex.ts initialize): the minors of the
 *  fixture-verified runtimes. Claude Code: claudeCompatibility. */
export function conductorSupports(provider: UpgradeProvider, version: string): boolean {
  if (provider === 'claude') return claudeCompatibility(version).supported
  const minor = (value: string): string | null => /^0\.(\d+)\./.exec(value)?.[1] ?? null
  const wanted = minor(version)
  return Boolean(wanted && CODEX_VERIFIED_RUNTIMES.some(runtime => minor(runtime) === wanted))
}

export interface ModelUpgradeWiring {
  userData: string
  appVersion: string
  enabled: boolean
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  /** The project whose folder is the Conductor checkout (it has the protocol generator), if open. */
  conductorProject(): { id: string; path: string } | null
  /** Owner-scope app control, for router.dispatch and app.update.install. */
  control(projectId: string | null, method: string, args: Record<string, unknown>): Promise<unknown>
  agentOpen(agentId: string): boolean
  localUpdates: LocalUpdateBuildService | null
  updates(): { check(): Promise<{ phase: string }>; download(): Promise<{ phase: string }> } | null
  catalogScript: string
  recordObservations?(batch: IngestionBatch): void
  broadcast(channel: string, payload: unknown): void
  log(message: string): void
}

/** The coworker brief for a protocol bump, following docs/codex-compatibility.md step by step. */
export function fixerBrief(offer: ModelUpgradeOffer, scratchExecutable: string | null): string {
  const cli = offer.cli!
  const codex = offer.provider === 'codex'
  return [
    `Auto model upgrade ${offer.id} (docs/model-upgrades.md): ${offer.label} needs ${codex ? 'Codex' : 'Claude Code'} ${cli.to}, and this Conductor cannot connect to that CLI yet (installed ${cli.from ?? 'unknown'}). Read AGENTS.md first. Your job is to prepare the compatibility bump and a verified build, not to switch anything: the owner switches with one OK afterwards.`,
    '',
    `A scratch copy of the new CLI is installed at ${scratchExecutable ?? '(missing)'}. Use it through CONDUCTOR_${codex ? 'CODEX' : 'CLAUDE'}_PATH; never install or upgrade the global CLI.`,
    codex
      ? `Steps (docs/codex-compatibility.md, "Reproduce the protocol baseline"): bump \`expected\` in scripts/generate-codex-protocol.mjs to ${cli.to}; run it with CONDUCTOR_CODEX_PATH set to the scratch executable; diff src/main/providers/generated/codex against HEAD (split the single-line unions on " | "); bump CODEX_PROTOCOL_BASELINE, CODEX_VERIFIED_RUNTIMES (keep the previous minor so the installed CLI keeps working) and the /^0\\.<minor>\\./ gate in src/main/providers/codex.ts; change the adapter and scripts/fixtures/codex-app-server.mjs together for anything it reads or sends that moved; record the rebaseline and new SHA-256 table in docs/codex-compatibility.md.`
      : `Steps (docs/claude-compatibility.md): check the new CLI's --help for every flag the adapter passes (src/main/providers/claude.ts), move CLAUDE_COMPATIBILITY and claudeCompatibility so ${cli.to} connects while the installed version keeps working, update the fixtures, and record it in docs/claude-compatibility.md.`,
    'Run npx tsc --noEmit and npm run test:agent-contracts, then deliver with git.ship({message, paths}) as a local commit (never publish).',
    'Then build a verified candidate: app.update({commit:"<that sha>", smoke:["smoke-model-upgrades"]}) and poll app.update.status({waitSeconds:45}) until it is verified.',
    `Finally call control models.upgrades.prepared({id:"${offer.id}", commit:"<sha>"}). If the bump needs changes you cannot make safely, leave no half state (revert your edits) and call models.upgrades.prepared({id:"${offer.id}", blocked:"<the reason, one paragraph>"}) instead.`,
    'Then report to your controller and finish with agents.finish({}).'
  ].join('\n')
}

const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null

export function createModelUpgrades(wiring: ModelUpgradeWiring): ModelUpgradeService {
  const root = join(wiring.userData, 'model-upgrades')
  const scratch = join(root, 'cli')
  try { setPromotedModels(JSON.parse(wiring.getSetting(PROMOTED_SETTING) ?? '{}') as PromotedModels) } catch { setPromotedModels({}) }
  const store = () => {
    const found = activeCliVersions()
    if (!found) throw new Error('The CLI version store is unavailable in this Conductor')
    return found
  }
  const ports: ModelUpgradePorts = {
    now: () => Date.now(),
    appVersion: () => wiring.appVersion,
    currentCli: async provider => {
      const cli = activeCliVersions()
      const installedPath = cli?.installedExecutable(provider) ?? null
      const pinned = cli?.pinnedExecutable(provider) ?? null
      const executable = pinned ?? installedPath
      if (!executable) return null
      const installed = installedPath ? await readCliVersion(installedPath) : null
      return { executable, version: pinned ? await readCliVersion(pinned) : installed, installed }
    },
    latestVersion: provider => latestVersion(CLI_PACKAGES[provider], npmRegistry()),
    installScratch: (provider, version) => installScratchCli(scratch, provider, version),
    pruneScratch: keep => pruneScratch(scratch, keep),
    probe: (provider, executable) => probeCatalog({ provider, executable, script: wiring.catalogScript, workDirectory: join(root, 'probes') }),
    picks: (provider, catalog) => [...new Set([
      promotedModel(provider),
      catalog.find(model => model.isDefault && model.id !== 'default')?.id ?? null,
      provider === 'codex' ? CODEX_FALLBACK_MODEL : CLAUDE_FALLBACK_MODEL,
      ...catalog.filter(model => isFrontierModel(provider, model.id)).map(model => model.id)
    ].filter((id): id is string => Boolean(id)))],
    supports: conductorSupports,
    record: (provider, cliVersion, models) => wiring.recordObservations?.(observations(provider, cliVersion, models)),
    prepare: async offer => {
      const project = wiring.conductorProject()
      if (!project) return { blocked: `This Conductor cannot run ${offer.provider} ${offer.cli?.to} yet, and no Conductor checkout is open in this window to prepare the compatibility bump. Open the Conductor project and retry.` }
      if (process.env.CONDUCTOR_MODEL_UPGRADE_FIXER === 'off') return { blocked: 'Dispatching the protocol-bump coworker is turned off (CONDUCTOR_MODEL_UPGRADE_FIXER=off).' }
      const result = await wiring.control(project.id, 'router.dispatch', { tasks: [{ title: `Model upgrade: ${offer.provider} ${offer.cli?.to} protocol bump for ${offer.label}`, prompt: fixerBrief(offer, offer.cli?.executable ?? null), provider: 'claude', model: 'opus[1m]', effort: 'high' }] }) as Array<{ agentSessionId?: unknown; accepted?: unknown; error?: unknown }>
      const task = Array.isArray(result) ? result[0] : undefined
      const agentId = text(task?.agentSessionId)
      return agentId && task?.accepted === true ? { agentId } :{ blocked: `The protocol-bump coworker did not open: ${text(task?.error) ?? 'router.dispatch returned no conversation'}` }
    },
    fixerOpen: agentId => wiring.agentOpen(agentId),
    candidate: () => {
      const status = wiring.localUpdates?.status()
      return status ? { state: status.state, commit: status.commit, verified: status.verified } : { state: 'unavailable', commit: null, verified: null }
    },
    installApp: async (): Promise<InstallAppResult> => {
      const updates = wiring.updates()
      if (!updates) throw new Error('The updater is unavailable in this Conductor')
      let state = await updates.check()
      if (state.phase === 'available') state = await updates.download()
      if (state.phase === 'downloading') return { installing: false, waiting: 'the update is downloading' }
      if (state.phase !== 'ready') throw new Error(`no downloaded update to install (update phase ${state.phase})`)
      try {
        await wiring.control(wiring.conductorProject()?.id ?? null, 'app.update.install', {})
        return { installing: true }
      } catch (error) {
        const reason = String((error as Error)?.message ?? error)
        if (/^(?:app\.update\.install: )?Not installing yet/.test(reason)) return { installing: false, waiting: reason.replace(/^(?:app\.update\.install: )?Not installing yet: /, '').split('. Wait for')[0] }
        throw error
      }
    },
    adoptCli: async (provider, version, executable) => { await store().adopt(provider, version, executable) },
    releaseCli: provider => { const cli = store(); if (cli.adoptedPin(provider)) cli.clearPins(provider) },
    promote: (provider, model, replaces) => {
      const next: PromotedModels = { ...promotedModels(), [provider]: { model, replaces, rank: Math.max(capabilityRank(provider, model), capabilityRank(provider, replaces)) as 0 | 1 | 2 | 3, frontier: isFrontierModel(provider, replaces) || isFrontierModel(provider, model), at: new Date().toISOString() } }
      wiring.setSetting(PROMOTED_SETTING, JSON.stringify(next))
      setPromotedModels(next)
      wiring.broadcast('model-upgrades:promoted', next)
    },
    changed: status => wiring.broadcast('model-upgrades:status', status),
    log: message => wiring.log(`[model-upgrades] ${message}`)
  }
  return new ModelUpgradeService(join(root, 'state.json'), ports, { enabled: wiring.enabled })
}

/** A non-complete batch for the better models a newer CLI offers: they are real but not usable on
 *  the installed CLI yet, hence `limited`. */
function observations(provider: UpgradeProvider, cliVersion: string, models: BetterModel[]): IngestionBatch {
  const source = { kind: 'cli' as const, name: `model-upgrades:${provider}@${cliVersion}` }
  const observedAt = new Date().toISOString()
  const list: IngestionBatch['observations'] = []
  for (const { model } of models) {
    const key = { provider, model: model.id }
    const add = (field: IngestionBatch['observations'][number]['field'], value: IngestionBatch['observations'][number]['value']): void => { if (value !== null && value !== undefined) list.push({ key, field, value, source, observedAt }) }
    add('displayName', model.displayName)
    add('family', familyOf(model.id, model.displayName))
    if (model.efforts?.length) add('efforts', model.efforts)
    add('availability', 'limited')
  }
  return { source, fetchedAt: observedAt, observations: list, benchmarks: [], complete: false }
}

/** The project whose folder holds scripts/generate-codex-protocol.mjs. */
export const isConductorCheckout = (path: string): boolean => existsSync(join(path, 'scripts', 'generate-codex-protocol.mjs')) && existsSync(join(path, 'src', 'main', 'providers', 'codex.ts'))
