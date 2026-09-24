import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RestorePoint } from '../shared/models'

export type RestorePointInput = Omit<RestorePoint, 'pinned' | 'knownGood' | 'crashCount' | 'failedShipCount' | 'firstLaunchedAt'>

interface Catalog { schemaVersion: 1; points: RestorePoint[] }
interface RunState { version: string; startedAt: string; clean: boolean }
const CATALOG = 'restore-points.json'
const RUN_STATE = 'restore-point-run.json'
const ACTIVE_DESCRIPTOR = 'conductor-local-build.json'
const DAY_MS = 24 * 60 * 60_000
const KEEP = 8

const safeArtifact = (name: string): string => {
  if (!name || basename(name) !== name || /[\\/:]/.test(name)) throw new Error('Invalid restore point artifact name')
  return name
}
const validTime = (value: string | undefined): boolean => Boolean(value && Number.isFinite(Date.parse(value)))
const atomicJson = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/** Persistent catalog beside the immutable local-update artifacts. It never runs an installer:
 * activating a point only swaps the descriptor consumed by LocalUpdateFeed. */
export class RestorePointStore {
  constructor(readonly directory: string, private readonly options: { now?: () => number } = {}) { mkdirSync(directory, { recursive: true }) }

  list(): RestorePoint[] {
    const catalog = this.readCatalog()
    let changed = false
    for (const point of catalog.points) {
      if (!point.knownGood && !point.crashCount && !point.failedShipCount && validTime(point.firstLaunchedAt) && this.now() - Date.parse(point.firstLaunchedAt!) >= DAY_MS) {
        point.knownGood = true; changed = true
      }
    }
    if (changed) this.writeCatalog(catalog)
    return catalog.points.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(point => structuredClone(point))
  }

  record(input: RestorePointInput): RestorePoint {
    this.validateInput(input)
    const catalog = this.readCatalog()
    const existing = catalog.points.find(point => point.version === input.version)
    const point: RestorePoint = {
      ...structuredClone(input), pinned: existing?.pinned ?? false, knownGood: existing?.knownGood ?? false,
      crashCount: existing?.crashCount ?? 0, failedShipCount: existing?.failedShipCount ?? 0,
      ...(existing?.firstLaunchedAt ? { firstLaunchedAt: existing.firstLaunchedAt } : {})
    }
    catalog.points = [point, ...catalog.points.filter(entry => entry.version !== input.version)]
    this.writeCatalog(catalog)
    return structuredClone(point)
  }

  pin(version: string, pinned: boolean): RestorePoint {
    const catalog = this.readCatalog(), point = this.require(catalog, version)
    point.pinned = pinned
    if (pinned) point.knownGood = true
    this.writeCatalog(catalog)
    return structuredClone(point)
  }

  beginRun(version: string): void {
    const catalog = this.readCatalog()
    const prior = this.readRun()
    if (prior && !prior.clean) {
      const crashed = catalog.points.find(point => point.version === prior.version)
      if (crashed) { crashed.crashCount++; crashed.knownGood = false }
    }
    const point = catalog.points.find(entry => entry.version === version)
    if (point && !point.firstLaunchedAt) point.firstLaunchedAt = new Date(this.now()).toISOString()
    this.writeCatalog(catalog)
    atomicJson(join(this.directory, RUN_STATE), { version, startedAt: new Date(this.now()).toISOString(), clean: false } satisfies RunState)
  }

  endRun(version: string): void {
    const state = this.readRun()
    if (state?.version === version) atomicJson(join(this.directory, RUN_STATE), { ...state, clean: true })
  }

  recordFailedShip(version: string): void {
    const catalog = this.readCatalog(), point = catalog.points.find(entry => entry.version === version)
    if (!point) return
    point.failedShipCount++; point.knownGood = false
    this.writeCatalog(catalog)
  }

  /** Makes an immutable saved build the descriptor LocalUpdateFeed serves next. */
  activate(version: string): RestorePoint {
    const catalog = this.readCatalog(), point = this.require(catalog, version)
    const descriptorPath = join(this.directory, `restore-point-${version}.json`)
    if (!existsSync(descriptorPath)) throw new Error(`Restore point ${version} has no saved update descriptor`)
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as { version?: string }
    if (descriptor.version !== version) throw new Error(`Restore point ${version} descriptor does not match its version`)
    atomicJson(join(this.directory, ACTIVE_DESCRIPTOR), descriptor)
    return structuredClone(point)
  }

  /** Delete only catalog-owned artifacts older than the newest eight; pins are never removed. */
  prune(): void {
    const catalog = this.readCatalog()
    const newest = [...catalog.points].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const keep = new Set([...newest.filter(point => point.pinned).map(point => point.version), ...newest.filter(point => !point.pinned).slice(0, KEEP).map(point => point.version)])
    for (const point of newest) {
      if (keep.has(point.version)) continue
      for (const name of [safeArtifact(point.installer), safeArtifact(point.blockmap), `restore-point-${point.version}.json`]) {
        rmSync(join(this.directory, name), { force: true })
      }
    }
    catalog.points = newest.filter(point => keep.has(point.version))
    this.writeCatalog(catalog)
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
  private require(catalog: Catalog, version: string): RestorePoint {
    const point = catalog.points.find(entry => entry.version === version)
    if (!point) throw new Error(`No restore point ${version}`)
    return point
  }
  private validateInput(input: RestorePointInput): void {
    if (!/^\d+\.\d+\.\d+-local\.\d+$/.test(input.version) || !validTime(input.createdAt)) throw new Error('Invalid restore point metadata')
    safeArtifact(input.installer); safeArtifact(input.blockmap)
    if (input.commit !== null && !/^[a-f0-9]{7,64}$/.test(input.commit)) throw new Error('Invalid restore point commit')
    if (!input.cliVersions || typeof input.cliVersions !== 'object' || !Array.isArray(input.models)) throw new Error('Invalid restore point environment snapshot')
  }
  private readRun(): RunState | null {
    try {
      const value = JSON.parse(readFileSync(join(this.directory, RUN_STATE), 'utf8')) as RunState
      return typeof value.version === 'string' && validTime(value.startedAt) && typeof value.clean === 'boolean' ? value : null
    } catch { return null }
  }
  private readCatalog(): Catalog {
    try {
      const value = JSON.parse(readFileSync(join(this.directory, CATALOG), 'utf8')) as Catalog
      if (value.schemaVersion !== 1 || !Array.isArray(value.points)) throw new Error('Invalid restore point catalog')
      return { schemaVersion: 1, points: value.points }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, points: [] }
      throw error
    }
  }
  private writeCatalog(catalog: Catalog): void { atomicJson(join(this.directory, CATALOG), catalog) }
}
