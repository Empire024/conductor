import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RestorePointStore, type RestorePointInput } from './restore-points'

const roots: string[] = []
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'conductor-restore-points-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const point = (sequence: number, extra: Partial<RestorePointInput> = {}): RestorePointInput => ({
  version: `0.2.0-local.${sequence}`,
  commit: String(sequence).padStart(40, 'a'),
  createdAt: new Date(Date.UTC(2026, 8, sequence)).toISOString(),
  dirty: false,
  cliVersions: { claude: '2.1.278', codex: '0.155.1', grok: '1.0.41' },
  models: [{ provider: 'local', models: [{ id: 'local/qwen', label: 'Qwen' }] }],
  installer: `Conductor-Setup-0.2.0-local.${sequence}.exe`,
  blockmap: `Conductor-Setup-0.2.0-local.${sequence}.exe.blockmap`,
  ...extra
})

function artifacts(root: string, input: RestorePointInput): void {
  for (const name of [input.installer, input.blockmap]) writeFileSync(join(root, name), name)
  writeFileSync(join(root, `restore-point-${input.version}.json`), JSON.stringify({ schemaVersion: 1, ...input }))
}

describe('restore points', () => {
  it('keeps the newest eight unpinned builds plus every pinned build', () => {
    const root = temp(), store = new RestorePointStore(root)
    for (let index = 1; index <= 10; index++) { const input = point(index); artifacts(root, input); store.record(input) }
    store.pin('0.2.0-local.1', true)
    store.prune()
    expect(store.list().map(entry => entry.version)).toEqual([
      '0.2.0-local.10', '0.2.0-local.9', '0.2.0-local.8', '0.2.0-local.7', '0.2.0-local.6',
      '0.2.0-local.5', '0.2.0-local.4', '0.2.0-local.3', '0.2.0-local.1'
    ])
    expect(() => readFileSync(join(root, 'Conductor-Setup-0.2.0-local.2.exe'))).toThrow()
    expect(readFileSync(join(root, 'Conductor-Setup-0.2.0-local.1.exe'), 'utf8')).toContain('local.1')
  })

  it('pinning marks a build known good and 24 crash-free hours do the same automatically', () => {
    const root = temp()
    let now = Date.parse('2026-09-24T00:00:00Z')
    const store = new RestorePointStore(root, { now: () => now })
    store.record(point(1, { createdAt: new Date(now).toISOString() }))
    store.beginRun('0.2.0-local.1')
    now += 24 * 60 * 60_000 + 1
    expect(store.list()[0]).toMatchObject({ knownGood: true, pinned: false })
    store.record(point(2, { createdAt: new Date(now).toISOString() }))
    expect(store.pin('0.2.0-local.2', true)).toMatchObject({ knownGood: true, pinned: true })
  })

  it('does not bless a build after an unclean run or failed ship', () => {
    const root = temp()
    let now = Date.parse('2026-09-24T00:00:00Z')
    let store = new RestorePointStore(root, { now: () => now })
    store.record(point(1, { createdAt: new Date(now).toISOString() }))
    store.beginRun('0.2.0-local.1')
    store = new RestorePointStore(root, { now: () => now })
    store.beginRun('0.2.0-local.1') // the prior process never called endRun
    store.recordFailedShip('0.2.0-local.1')
    now += 25 * 60 * 60_000
    expect(store.list()[0]).toMatchObject({ knownGood: false, crashCount: 1, failedShipCount: 1 })
  })

  it('activates a historical descriptor for the existing local update feed', () => {
    const root = temp(), store = new RestorePointStore(root)
    const input = point(3); artifacts(root, input); store.record(input)
    store.activate(input.version)
    const active = JSON.parse(readFileSync(join(root, 'conductor-local-build.json'), 'utf8'))
    expect(active.version).toBe(input.version)
  })

  it('rejects traversal-shaped artifact metadata', () => {
    const root = temp(), store = new RestorePointStore(root)
    expect(() => store.record(point(1, { installer: '../escape.exe' }))).toThrow(/artifact name/)
    expect(() => store.pin('missing', true)).toThrow(/No restore point/)
    mkdirSync(join(root, 'nested'))
  })
})
