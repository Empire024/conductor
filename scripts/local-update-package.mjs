import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'

export const descriptorName = 'conductor-local-build.json'

export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^v/, '').replace(/^(\d+\.\d+\.\d+)\.0$/, '$1')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized)
  if (!match) return null
  const core = match.slice(1, 4).map(Number)
  if (core.some(part => !Number.isSafeInteger(part))) return null
  if (match[4]?.split('.').some(part => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null
  return { version: normalized, core, prerelease: match[4] ?? null }
}

function compareCore(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

/** A new stable patch supersedes its local prereleases; repeated local builds share that patch. */
export function selectLocalVersion({ versions, previousVersion, now = Date.now() }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid local build timestamp')
  const inputs = [...versions, previousVersion].filter(value => value != null)
  const parsed = inputs.map(value => {
    const result = parseVersion(value)
    if (!result) throw new Error(`Invalid version baseline: ${String(value)}`)
    return result
  })
  if (!parsed.length) throw new Error('A known version baseline is required')
  let nextCore = [0, 0, 0]
  let sequence = now
  for (const version of parsed) {
    const candidate = [...version.core]
    if (!version.prerelease) candidate[2]++
    if (!Number.isSafeInteger(candidate[2])) throw new Error('Version baseline is too large')
    if (compareCore(candidate, nextCore) > 0) nextCore = candidate
    const local = /^local\.(\d+)$/.exec(version.prerelease ?? '')
    if (local) {
      const prior = Number(local[1])
      if (!Number.isSafeInteger(prior) || !Number.isSafeInteger(prior + 1)) throw new Error('Invalid prior local build sequence')
      sequence = Math.max(sequence, prior + 1)
    }
  }
  return `${nextCore.join('.')}-local.${sequence}`
}

export function localFeedDirectory(environment = process.env) {
  if (!environment.APPDATA) throw new Error('APPDATA is unavailable; pass --feed-dir explicitly')
  return resolve(environment.APPDATA, 'Conductor', 'local-updates')
}

export function installerNames(version) {
  const parsed = parseVersion(version)
  if (!parsed || parsed.version !== version || !/^local\.\d+$/.test(parsed.prerelease ?? '')) throw new Error('Expected a local prerelease version')
  return { installer: `Conductor-Setup-${version}.exe`, blockmap: `Conductor-Setup-${version}.exe.blockmap` }
}

export async function readPreviousDescriptor(feedDirectory) {
  try {
    const path = resolve(feedDirectory, descriptorName)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error('Unsafe local feed descriptor')
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.schemaVersion !== 1 || !parseVersion(value.version)) throw new Error('Invalid local feed descriptor')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function hashArtifact(path) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error(`Expected a nonempty regular artifact: ${basename(path)}`)
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { sha512: hash.digest('base64'), size: metadata.size }
}

export function builderArguments(version, outputDirectory) {
  installerNames(version)
  return ['--win', 'nsis', '--x64', '--publish', 'never', `-c.extraMetadata.version=${version}`, `-c.directories.output=${resolve(outputDirectory)}`]
}

/** Artifacts are immutable and copied first; a flushed atomic descriptor swap publishes the build. */
export async function publishLocalPackage({ version, outputDirectory, feedDirectory, commit = null, dirty = false, createdAt = new Date().toISOString() }) {
  const names = installerNames(version)
  if (commit !== null && !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid commit metadata')
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid build date')
  for (const name of Object.values(names)) await hashArtifact(resolve(outputDirectory, name))
  await mkdir(feedDirectory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(feedDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Local feed must be a regular directory')
  const lockPath = resolve(feedDirectory, '.conductor-local-publish.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    const previous = await readPreviousDescriptor(feedDirectory)
    if (previous) {
      const incoming = parseVersion(version)
      const existing = parseVersion(previous.version)
      const coreOrder = compareCore(incoming.core, existing.core)
      const priorSequence = /^local\.(\d+)$/.exec(existing.prerelease ?? '')
      if (coreOrder < 0 || (coreOrder === 0 && (!priorSequence || Number(incoming.prerelease.slice(6)) <= Number(priorSequence[1])))) {
        throw new Error('A newer or identical local feed version is already published; refusing to overwrite it')
      }
    }
    for (const name of Object.values(names)) await copyFile(resolve(outputDirectory, name), resolve(feedDirectory, name), constants.COPYFILE_EXCL)
    const installer = await hashArtifact(resolve(feedDirectory, names.installer))
    const blockmap = await hashArtifact(resolve(feedDirectory, names.blockmap))
    const descriptor = {
      schemaVersion: 1, version, createdAt, commit, dirty: Boolean(dirty),
      ...names, sha512: installer.sha512, size: installer.size,
      blockmapSha512: blockmap.sha512, blockmapSize: blockmap.size
    }
    const temporary = resolve(feedDirectory, `.conductor-local-build-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, resolve(feedDirectory, descriptorName))
    return descriptor
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}
