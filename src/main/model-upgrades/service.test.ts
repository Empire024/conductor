import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel, UpgradeProvider } from '../../shared/model-upgrades'
import { ModelUpgradeService, type InstallAppResult, type ModelUpgradePorts } from './service'

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, displayName: extra.displayName ?? id, hidden: false, isDefault: false, ...extra })
const OLD = [model('gpt-6-astra', { displayName: 'GPT-6-Astra', isDefault: true }), model('gpt-5.6-luna')]
const NEW = [model('gpt-6.1-sol', { displayName: 'GPT-6.1-Sol', isDefault: true }), model('gpt-6-astra', { displayName: 'GPT-6-Astra' }), model('gpt-5.6-luna')]

interface World {
  installed: Record<UpgradeProvider, string | null>
  pinned: Partial<Record<UpgradeProvider, string>>
  latest: Record<UpgradeProvider, string>
  catalogs: Record<string, CatalogModel[]>
  supported: Set<string>
  app: string
  build: { state: string; commit: string | null; verified: boolean | null }
  install: InstallAppResult
  promoted: Array<[string, string, string]>
  fixerOpen: boolean
}

function harness(file: string, world: World, overrides: Partial<ModelUpgradePorts> = {}) {
  const calls = { installScratch: 0, prepare: 0, installApp: 0 }
  const ports: ModelUpgradePorts = {
    now: () => Date.parse('2026-09-30T12:00:00Z'),
    appVersion: () => world.app,
    currentCli: async provider => {
      const version = world.pinned[provider] ?? world.installed[provider]
      return version ? { executable: `${provider}@${version}`, version, installed: world.installed[provider] } : null
    },
    latestVersion: async provider => world.latest[provider],
    installScratch: async (provider, version) => { calls.installScratch++; return { provider, version, prefix: `/scratch/${provider}/${version}`, executable: `${provider}@${version}` } },
    pruneScratch: () => {},
    probe: async (_provider, executable) => ({ version: executable.split('@')[1] ?? null, models: world.catalogs[executable] ?? [] }),
    picks: provider => provider === 'codex' ? ['gpt-6-astra'] : ['opus[1m]'],
    supports: (provider, version) => world.supported.has(`${provider}@${version}`),
    prepare: async () => { calls.prepare++; return { agentId: 'agent_fixer' } },
    fixerOpen: () => world.fixerOpen,
    candidate: () => world.build,
    installApp: async () => { calls.installApp++; return world.install },
    adoptCli: async (provider, version) => { world.pinned[provider] = version },
    releaseCli: provider => { delete world.pinned[provider] },
    promote: (provider, to, from) => { world.promoted.push([provider, to, from]) },
    ...overrides
  }
  return { service: new ModelUpgradeService(file, ports), calls, ports }
}

describe('ModelUpgradeService', () => {
  let directory: string, file: string, world: World
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'model-upgrades-'))
    file = join(directory, 'state.json')
    world = {
      installed: { codex: '0.155.1', claude: null }, pinned: {}, latest: { codex: '0.159.1', claude: '2.1.282' },
      catalogs: { 'codex@0.155.1': OLD, 'codex@0.159.1': NEW },
      supported: new Set(['codex@0.155.1']), app: '0.1.60',
      build: { state: 'idle', commit: null, verified: null }, install: { installing: true }, promoted: [], fixerOpen: true
    }
  })
  afterEach(() => { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }) })

  it('probes a newer CLI, prepares the protocol bump, and waits for a verified build before asking', async () => {
    const { service, calls } = harness(file, world)
    await service.check()
    let offer = service.status().offers[0]!
    expect(offer).toMatchObject({ id: 'codex:gpt-6.1-sol', state: 'preparing', protocolBump: true, cli: { from: '0.155.1', to: '0.159.1' }, fixer: { agentId: 'agent_fixer' } })
    expect(offer.summary).toMatch(/^GPT-6.1-Sol is available \(better than GPT-6-Astra: .*\)\. Needs Codex 0.159.1 \(now 0.155.1\)\. Switch\?$/)
    expect(calls).toMatchObject({ installScratch: 1, prepare: 1 })
    // A second pass neither reinstalls nor re-dispatches.
    await service.check()
    expect(calls).toMatchObject({ installScratch: 1, prepare: 1 })

    expect(() => service.prepared(offer.id, { commit: 'abc1234' })).toThrow(/not a verified build/)
    world.build = { state: 'succeeded', commit: 'abc1234def', verified: true }
    offer = service.prepared(offer.id, { commit: 'abc1234' })
    expect(offer).toMatchObject({ state: 'ready', candidate: { commit: 'abc1234def', verified: true } })
  })

  it('an OK installs the verified build, then finishes on the new app: CLI switched and model promoted', async () => {
    const { service, calls } = harness(file, world)
    await service.check()
    world.build = { state: 'succeeded', commit: 'abc1234', verified: true }
    service.prepared('codex:gpt-6.1-sol', { commit: 'abc1234' })
    const accepted = await service.accept('codex:gpt-6.1-sol', 'owner')
    expect(accepted.state).toBe('applying')
    expect(calls.installApp).toBe(1)
    expect(world.pinned.codex).toBeUndefined()

    // The restart: a new app build that speaks 0.159 picks the job up.
    world.app = '0.1.61'
    world.supported.add('codex@0.159.1')
    const next = harness(file, world).service
    await next.resume()
    const offer = next.status().offers[0]!
    expect(offer.state).toBe('applied')
    expect(world.pinned.codex).toBe('0.159.1')
    expect(world.promoted).toEqual([['codex', 'gpt-6.1-sol', 'gpt-6-astra']])
  })

  it('waits for busy tabs before installing and retries', async () => {
    vi.useFakeTimers()
    world.install = { installing: false, waiting: '2 tabs are working' }
    const { service, calls } = harness(file, world)
    await service.check()
    world.build = { state: 'succeeded', commit: 'abc1234', verified: true }
    service.prepared('codex:gpt-6.1-sol', { commit: 'abc1234' })
    await service.accept('codex:gpt-6.1-sol', 'owner')
    expect(service.status().offers[0]!.steps.at(-1)).toMatch(/waiting to install.*2 tabs/)
    world.install = { installing: true }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.installApp).toBe(2)
    expect(service.status().offers[0]!.steps.at(-1)).toMatch(/installing the verified Conductor build/)
    service.stop()
  })

  it('reports blocked, switching nothing, when the new app still cannot run the CLI', async () => {
    const { service } = harness(file, world)
    await service.check()
    world.build = { state: 'succeeded', commit: 'abc1234', verified: true }
    service.prepared('codex:gpt-6.1-sol', { commit: 'abc1234' })
    await service.accept('codex:gpt-6.1-sol', 'owner')
    world.app = '0.1.61'
    const next = harness(file, world).service
    await next.resume()
    expect(next.status().offers[0]).toMatchObject({ state: 'blocked' })
    expect(next.status().offers[0]?.reason).toMatch(/did not install\. Nothing was switched/)
    expect(world.pinned.codex).toBeUndefined()
    expect(world.promoted).toEqual([])
  })

  it('offers straight away when this Conductor already speaks the new CLI, and a wizard needs the owner\'s opt-in', async () => {
    world.supported.add('codex@0.159.1')
    const { service, calls } = harness(file, world)
    await service.check()
    expect(service.status().offers[0]).toMatchObject({ state: 'ready', protocolBump: false })
    expect(calls.prepare).toBe(0)
    await expect(service.accept('codex:gpt-6.1-sol', 'wizard')).rejects.toThrow(/has not let wizard tabs/)
    service.setWizardMayAccept(true)
    expect((await service.accept('codex:gpt-6.1-sol', 'wizard')).state).toBe('applied')
    expect(world.pinned.codex).toBe('0.159.1')
    // The catalog is re-discovered from the CLI new tabs launch, so models.list offers the new model at once.
    expect(service.discoveredCatalog('codex')).toEqual({ version: '0.159.1', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: true }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }] })
    expect(service.discoveredCatalog('grok')).toBeNull()
  })

  it('remembers a decline per model, across restarts', async () => {
    world.supported.add('codex@0.159.1')
    const { service } = harness(file, world)
    await service.check()
    service.decline('codex:gpt-6.1-sol')
    const next = harness(file, world).service
    await next.check()
    expect(next.status().offers.map(offer => offer.state)).toEqual(['declined'])
    expect(next.status().declined['codex:gpt-6.1-sol']).toBeTruthy()
  })

  it('notices a model that appears on the current CLI without a new version', async () => {
    world.latest.codex = '0.155.1'
    const { service, calls } = harness(file, world)
    await service.check()
    expect(service.status().offers).toEqual([])
    world.catalogs['codex@0.155.1'] = NEW
    await service.check()
    expect(service.status().offers[0]).toMatchObject({ id: 'codex:gpt-6.1-sol', state: 'ready', cli: null })
    expect(calls.installScratch).toBe(0)
  })

  it('does not reinstall a newer CLI that offered nothing better, and records npm failures', async () => {
    world.catalogs['codex@0.159.1'] = OLD
    const { service, calls } = harness(file, world)
    await service.check()
    await service.check()
    expect(calls.installScratch).toBe(1)
    expect(service.status().offers).toEqual([])
    const failing = harness(file, world, { latestVersion: async () => { throw new Error('offline') } }).service
    await failing.check()
    expect(failing.status().providers.find(entry => entry.provider === 'codex')?.error).toMatch(/npm: offline/)
  })

  it('blocks when the fixer closes without a verified build, and a retry dispatches again', async () => {
    const { service, calls } = harness(file, world)
    await service.check()
    world.fixerOpen = false
    world.latest.codex = '0.155.1'
    await service.check()
    expect(service.status().offers[0]).toMatchObject({ state: 'blocked', fixer: null })
    world.fixerOpen = true
    expect((await service.retry('codex:gpt-6.1-sol')).state).toBe('preparing')
    expect(calls.prepare).toBe(2)
  })

  it('releases its pin once the owner\'s own CLI catches up', async () => {
    world.supported.add('codex@0.159.1')
    const { service } = harness(file, world)
    await service.check()
    await service.accept('codex:gpt-6.1-sol', 'owner')
    expect(world.pinned.codex).toBe('0.159.1')
    world.installed.codex = '0.159.1'
    await service.check()
    expect(world.pinned.codex).toBeUndefined()
  })
})
