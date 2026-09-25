import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RestorePoint } from '../shared/models'
import { CliVersionStore, pinnedCliExecutable, plainCliVersion, restorePlan, setActiveCliVersions, type RestorePlanInput } from './cli-versions'

const roots: string[] = []
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'conductor-cli-versions-')); roots.push(root); return root }
afterEach(() => { setActiveCliVersions(null); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const point = (extra: Partial<RestorePoint> = {}): RestorePoint => ({
  version: '0.2.0-local.8', commit: 'a'.repeat(40), createdAt: '2026-09-23T12:00:00Z', dirty: false,
  cliVersions: { claude: '2.1.278 (Claude Code)', codex: 'codex-cli 0.155.1', grok: null },
  models: [{ provider: 'codex', models: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-sol' }] }],
  installer: 'Conductor-Setup-0.2.0-local.8.exe', blockmap: 'Conductor-Setup-0.2.0-local.8.exe.blockmap',
  pinned: false, knownGood: true, crashCount: 0, failedShipCount: 0, cliPinning: true, ...extra
})
const input = (extra: Partial<RestorePlanInput> = {}): RestorePlanInput => ({
  point: point(), scope: 'all', currentAppVersion: '0.2.0-local.9', appRestorable: true,
  clis: { claude: { installed: '2.1.290', pinned: null, availability: 'saved copy' }, codex: { installed: '0.156.0', pinned: null, availability: 'CLI install folder' } },
  currentModels: [{ provider: 'codex', models: [{ id: 'gpt-6-astra' }, { id: 'gpt-7-preview' }] }],
  ...extra
})

describe('restore plan', () => {
  it('app + CLIs: installs the saved build and pins both recorded CLI versions', () => {
    const plan = restorePlan(input())
    expect(plan.app).toEqual({ from: '0.2.0-local.9', to: '0.2.0-local.8' })
    expect(plan.clis).toEqual([
      { provider: 'claude', label: 'Claude Code', from: '2.1.290', to: '2.1.278', action: 'pin', source: 'saved copy' },
      { provider: 'codex', label: 'Codex', from: '0.156.0', to: '0.155.1', action: 'pin', source: 'CLI install folder' }
    ])
    expect(plan.models).toEqual([{ provider: 'codex', added: ['gpt-5.6-sol'], removed: ['gpt-7-preview'] }])
    expect(plan.blocked).toBeUndefined()
  })

  it('CLIs only: leaves the app alone and is what a broken CLI update needs', () => {
    const plan = restorePlan(input({ scope: 'clis' }))
    expect(plan.app).toBeNull()
    expect(plan.clis.map(change => change.action)).toEqual(['pin', 'pin'])
    expect(plan.warnings.join(' ')).toMatch(/new tabs.*use the restored versions/)
  })

  it('CLIs only works even when the saved build is gone or is the running one', () => {
    expect(restorePlan(input({ scope: 'clis', appRestorable: false })).blocked).toBeUndefined()
    expect(restorePlan(input({ scope: 'clis', currentAppVersion: '0.2.0-local.8' })).blocked).toBeUndefined()
    expect(restorePlan(input({ appRestorable: false })).blocked).toMatch(/no saved build.*CLIs only/)
    expect(restorePlan(input({ currentAppVersion: '0.2.0-local.8' })).blocked).toMatch(/already running.*CLIs only/)
  })

  it('goes back to the installed CLI when that is the recorded version, and keeps a match', () => {
    const plan = restorePlan(input({ scope: 'clis', clis: {
      claude: { installed: '2.1.278', pinned: '2.1.270', availability: 'installed' },
      codex: { installed: '0.155.1', pinned: null, availability: 'installed' }
    } }))
    expect(plan.clis.map(change => [change.provider, change.from, change.action])).toEqual([['claude', '2.1.270', 'unpin'], ['codex', '0.155.1', 'keep']])
  })

  it('names a version that is gone and blocks a CLI-only rollback with nothing to restore', () => {
    const missing = { claude: { installed: '2.1.290', pinned: null, availability: 'missing' as const }, codex: { installed: '0.156.0', pinned: null, availability: 'missing' as const } }
    const all = restorePlan(input({ clis: missing }))
    expect(all.blocked).toBeUndefined()
    expect(all.clis.map(change => change.action)).toEqual(['unavailable', 'unavailable'])
    expect(all.warnings[0]).toMatch(/Claude Code 2\.1\.278 is no longer on this machine.*stays on 2\.1\.290/)
    expect(restorePlan(input({ scope: 'clis', clis: missing })).blocked).toMatch(/None of the recorded CLI versions/)
    expect(restorePlan(input({ scope: 'clis', point: point({ cliVersions: { claude: null, codex: null, grok: null } }) })).blocked).toMatch(/did not record/)
  })

  it('warns that a build from before CLI rollback launches the installed CLIs again', () => {
    expect(restorePlan(input({ point: point({ cliPinning: undefined }) })).warnings[0]).toMatch(/built before CLI rollback/)
    expect(restorePlan(input({ scope: 'clis', point: point({ cliPinning: undefined }) })).warnings.join(' ')).not.toMatch(/built before/)
  })
})

// Fake CLIs are text files holding their version; readVersion reads them instead of running them.
const fakeRead = async (executable: string): Promise<string | null> => { try { return plainCliVersion(readFileSync(executable, 'utf8')) } catch { return null } }
function fixture() {
  const root = temp(), home = join(root, 'home'), bin = join(root, 'bin'), cache = join(root, 'cache')
  const claudeVersions = join(home, '.local', 'share', 'claude', 'versions')
  mkdirSync(claudeVersions, { recursive: true }); mkdirSync(bin, { recursive: true })
  for (const version of ['2.1.278', '2.1.290']) writeFileSync(join(claudeVersions, version), `${version} (Claude Code)`)
  for (const version of ['0.155.1', '0.156.0']) {
    const release = join(home, '.codex', 'packages', 'standalone', 'releases', `${version}-x86_64-pc-windows-msvc`)
    mkdirSync(join(release, 'bin'), { recursive: true }); mkdirSync(join(release, 'codex-resources'), { recursive: true })
    writeFileSync(join(release, 'bin', 'codex.exe'), `codex-cli ${version}`)
    writeFileSync(join(release, 'codex-resources', 'codex-command-runner.exe'), 'runner')
    writeFileSync(join(release, 'codex-package.json'), JSON.stringify({ version, entrypoint: 'bin/codex.exe' }))
  }
  const installed = { claude: join(bin, 'claude.exe'), codex: join(home, '.codex', 'packages', 'standalone', 'releases', '0.156.0-x86_64-pc-windows-msvc', 'bin', 'codex.exe') }
  writeFileSync(installed.claude, '2.1.290 (Claude Code)')
  const store = new CliVersionStore({ directory: cache, home, resolveInstalled: provider => installed[provider], readVersion: fakeRead, now: () => Date.parse('2026-09-25T12:00:00Z') })
  return { root, home, cache, store, installed, claudeVersions }
}

describe('CLI version store', () => {
  it('saves the installed CLIs and recorded versions from their own install folders, as hard links', async () => {
    const { store, cache, claudeVersions } = fixture()
    await store.snapshot({ claude: ['2.1.278'], codex: ['0.155.1'] })
    expect(store.cachedVersions('claude').sort()).toEqual(['2.1.278', '2.1.290'])
    expect(store.cachedVersions('codex').sort()).toEqual(['0.155.1', '0.156.0'])
    // A version folder is linked, not copied: same file, no extra disk.
    expect(statSync(join(cache, 'claude', '2.1.278', 'claude.exe')).nlink).toBeGreaterThan(1)
    expect(existsSync(join(cache, 'codex', '0.155.1', 'codex-resources', 'codex-command-runner.exe'))).toBe(true)
    // The CLI cleaning up its old version does not take the saved copy with it.
    rmSync(join(claudeVersions, '2.1.278'))
    expect(store.availability('claude', '2.1.278', '2.1.290')).toBe('saved copy')
  })

  it('pins the restored versions so tabs launch them, and unpins back to the installed CLIs', async () => {
    const { store, cache, installed } = fixture()
    setActiveCliVersions(store)
    const plan = restorePlan(input({ scope: 'clis', clis: {
      claude: { installed: '2.1.290', pinned: null, availability: store.availability('claude', '2.1.278', '2.1.290') },
      codex: { installed: '0.156.0', pinned: null, availability: store.availability('codex', '0.155.1', '0.156.0') }
    } }))
    expect(plan.clis.map(change => change.source)).toEqual(['CLI install folder', 'CLI install folder'])
    await store.restore(plan)
    expect(pinnedCliExecutable('claude')).toBe(join(cache, 'claude', '2.1.278', process.platform === 'win32' ? 'claude.exe' : 'claude'))
    expect(await fakeRead(pinnedCliExecutable('codex')!)).toBe('0.155.1')
    expect(await store.pinStates()).toEqual([
      { provider: 'claude', label: 'Claude Code', version: '2.1.278', installed: '2.1.290', pinnedAt: '2026-09-25T12:00:00.000Z', restorePoint: '0.2.0-local.8' },
      { provider: 'codex', label: 'Codex', version: '0.155.1', installed: '0.156.0', pinnedAt: '2026-09-25T12:00:00.000Z', restorePoint: '0.2.0-local.8' }
    ])
    // The owner's installed CLI was never touched.
    expect(readFileSync(installed.claude, 'utf8')).toBe('2.1.290 (Claude Code)')
    // A new store (the next launch) reads the same pins.
    expect(new CliVersionStore({ directory: cache, readVersion: fakeRead }).pinnedExecutable('claude')).toBe(pinnedCliExecutable('claude'))
    store.clearPins()
    expect(pinnedCliExecutable('claude')).toBeNull()
    expect(pinnedCliExecutable('grok')).toBeNull()
  })

  it('moves no pin when one CLI cannot be restored, and refuses a copy reporting another version', async () => {
    const { store, claudeVersions } = fixture()
    writeFileSync(join(claudeVersions, '2.1.278'), '2.1.999 (Claude Code)')
    const plan = restorePlan(input({ scope: 'clis', clis: {
      claude: { installed: '2.1.290', pinned: null, availability: 'CLI install folder' },
      codex: { installed: '0.156.0', pinned: null, availability: 'CLI install folder' }
    } }))
    await expect(store.restore(plan)).rejects.toThrow(/reports 2\.1\.999, expected 2\.1\.278/)
    expect(store.pins()).toEqual({})
    expect(store.cachedVersions('claude')).toEqual([])
    await expect(store.ensureSaved('claude', '2.0.1')).rejects.toThrow(/no longer on this machine/)
  })

  it('ignores a pin whose saved copy is gone and prunes copies nothing names', async () => {
    const { store, cache } = fixture()
    await store.snapshot({ claude: ['2.1.278'], codex: ['0.155.1'] })
    await store.restore(restorePlan(input({ scope: 'clis' })))
    rmSync(join(cache, 'codex', '0.155.1'), { recursive: true })
    expect(store.pinnedExecutable('codex')).toBeNull()
    store.clearPins('codex')
    await store.prune({ claude: [] })
    // Kept: the pinned 2.1.278 and the installed 2.1.290 / 0.156.0.
    expect(store.cachedVersions('claude').sort()).toEqual(['2.1.278', '2.1.290'])
    store.clearPins()
    await store.prune({})
    expect(store.cachedVersions('claude')).toEqual(['2.1.290'])
    expect(store.cachedVersions('codex')).toEqual(['0.156.0'])
  })
})
