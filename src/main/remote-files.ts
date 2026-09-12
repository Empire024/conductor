import type { EditorFileWriteResult } from '../shared/models'
import type {
  RemoteFileContents,
  RemoteFileChunk,
  RemoteFileChunkRequest,
  RemoteFileDescription,
  RemoteFileEntry,
  RemoteFileIdentity,
  RemoteFileStat,
  RemoteFileWriteRequest,
  RemoteFileWriteResponse
} from '../shared/remote-files'
import { REMOTE_FILE_CHUNK_BYTES, REMOTE_FILE_MAX_ASSET_BYTES } from '../shared/remote-files'
import type { ProjectIdentity } from '../shared/project-identity'
import { checkRemoteProjectPlacement } from '../shared/project-identity'
import { LOCAL_MACHINE_ID, readRemoteProjectSummaries, type RemoteConnection, type RemoteProjectSummary } from '../shared/remote-control'
import type { RemoteControlClient } from './remote-control-client'
import { RemoteAccessError } from './remote-peers'

const MAX_TEXT_BYTES = 1024 * 1024
const VERSION = /^[a-f0-9]{64}$/

export interface RemoteFilesDependencies {
  client: RemoteControlClient
  project(projectId: string): RemoteProjectSummary | null
}

interface CapturedRoute {
  machineId: string
  localProjectId: string
  connection: RemoteConnection
  revision: number
  grant: RemoteConnection['projectGrants'][number]
  localIdentity: ProjectIdentity
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {}

const bounded = (value: unknown, name: string, maximum: number, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > maximum || value.includes('\0')) {
    throw new RemoteAccessError(`Invalid remote file ${name}.`, 400)
  }
  return value
}

const relativeFilePath = (value: unknown, allowEmpty = false): string => {
  const path = bounded(value, 'path', 4000, allowEmpty).replaceAll('\\', '/')
  if (path === '.' && allowEmpty) return ''
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) {
    throw new RemoteAccessError('Remote file paths must stay relative to the confirmed host project.', 400)
  }
  return path.split('/').filter(part => part && part !== '.').join('/')
}

/**
 * Controller-side remote files adapter. It deliberately has no local filesystem dependency: an
 * offline, forgotten, revoked or remapped machine can only fail, never turn into a local read.
 */
export class RemoteFiles {
  constructor(private readonly deps: RemoteFilesDependencies) {}

  private identity(value: RemoteFileIdentity, allowEmptyPath = false): RemoteFileIdentity {
    const machineId = bounded(value?.machineId, 'machine', 160)
    if (machineId === LOCAL_MACHINE_ID) throw new RemoteAccessError('Remote files require a paired machine.', 400)
    return {
      machineId,
      projectId: bounded(value?.projectId, 'project', 160),
      path: relativeFilePath(value?.path, allowEmptyPath)
    }
  }

  private capture(file: RemoteFileIdentity): CapturedRoute {
    const connection = this.deps.client.get(file.machineId)
    if (!connection) throw new RemoteAccessError('This machine is not paired with that one.', 404)
    if (connection.status === 'revoked') throw new RemoteAccessError('That machine revoked this pairing.', 403, 'peer-revoked')
    if (!connection.peerId) throw new RemoteAccessError('That pairing has not been approved yet.', 409)
    const grant = connection.projectGrants.find(entry => entry.localProjectId === file.projectId)
    if (!grant) throw new RemoteAccessError('This project is not mapped to that machine.', 409)
    const local = this.deps.project(file.projectId)
    if (!local?.identity) throw new RemoteAccessError(local?.identityError || 'This project identity is unavailable.', 409)
    return {
      machineId: file.machineId,
      localProjectId: file.projectId,
      connection,
      revision: this.deps.client.authorityRevision(file.machineId),
      grant,
      localIdentity: local.identity
    }
  }

  private current(route: CapturedRoute): { connection: RemoteConnection; localIdentity: ProjectIdentity } {
    const connection = this.deps.client.get(route.machineId)
    if (!connection || connection !== route.connection || this.deps.client.authorityRevision(route.machineId) !== route.revision) {
      throw new RemoteAccessError('Remote file access changed while this request was pending.', 409)
    }
    if (connection.status === 'revoked') throw new RemoteAccessError('That machine revoked this pairing.', 403, 'peer-revoked')
    const grant = connection.projectGrants.find(entry => entry.localProjectId === route.localProjectId)
    if (grant !== route.grant) throw new RemoteAccessError('The confirmed remote project changed while this request was pending.', 409)
    const local = this.deps.project(route.localProjectId)
    if (!local?.identity) throw new RemoteAccessError(local?.identityError || 'The controller project identity is no longer available.', 409)
    const placement = checkRemoteProjectPlacement({ grant, advertised: grant.remote, local: local.identity, machineName: connection.machineName })
    if (!placement.ok) throw new RemoteAccessError(placement.message, 409)
    return { connection, localIdentity: local.identity }
  }

  private async route(file: RemoteFileIdentity): Promise<CapturedRoute> {
    const route = this.capture(file)
    const advertised = readRemoteProjectSummaries(await this.deps.client.call(route.machineId, 'projects.list'))
    const { connection, localIdentity } = this.current(route)
    const observed = advertised.find(project => project.id === route.grant.remoteProjectId)
    const placement = checkRemoteProjectPlacement({
      grant: route.grant,
      advertised: observed?.identity,
      local: localIdentity,
      machineName: connection.machineName
    })
    if (!placement.ok) throw new RemoteAccessError(placement.message, 409)
    return route
  }

  private async call(file: RemoteFileIdentity, method: string, args: Record<string, unknown>): Promise<unknown> {
    const route = await this.route(file)
    this.current(route)
    const result = await this.deps.client.call(route.machineId, method, { projectId: route.grant.remoteProjectId, ...args })
    this.current(route)
    return result
  }

  async list(value: RemoteFileIdentity): Promise<RemoteFileEntry[]> {
    const directory = this.identity(value, true)
    const raw = await this.call(directory, 'files.list', { path: directory.path })
    if (!Array.isArray(raw) || raw.length > 5000) throw new RemoteAccessError('That machine returned an invalid file list.', 502)
    return raw.map(item => {
      const entry = record(item)
      const path = relativeFilePath(entry.path)
      const kind = entry.kind
      if (kind !== 'file' && kind !== 'directory') throw new RemoteAccessError('That machine returned an invalid file kind.', 502)
      const name = bounded(entry.name, 'name', 512)
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.split('/').at(-1) !== name) {
        throw new RemoteAccessError('That machine returned an invalid file name.', 502)
      }
      return {
        file: { ...directory, path },
        name,
        kind
      }
    })
  }

  async stat(value: RemoteFileIdentity): Promise<RemoteFileStat> {
    const file = this.identity(value)
    const result = record(await this.call(file, 'files.stat', { path: file.path }))
    if (typeof result.size !== 'number' || !Number.isSafeInteger(result.size) || result.size < 0
      || typeof result.isFile !== 'boolean' || typeof result.modifiedAt !== 'string' || !Number.isFinite(Date.parse(result.modifiedAt))) {
      throw new RemoteAccessError('That machine returned invalid file metadata.', 502)
    }
    return { file, size: result.size, isFile: result.isFile, modifiedAt: result.modifiedAt }
  }

  async read(value: RemoteFileIdentity): Promise<RemoteFileContents> {
    const file = this.identity(value)
    const result = record(await this.call(file, 'files.read', { path: file.path }))
    if (typeof result.content !== 'string' || Buffer.byteLength(result.content) > MAX_TEXT_BYTES) {
      throw new RemoteAccessError('That machine returned invalid or oversized file contents.', 502)
    }
    return { file, content: result.content }
  }

  async describe(value: RemoteFileIdentity): Promise<RemoteFileDescription> {
    const file = this.identity(value)
    const result = record(await this.call(file, 'files.describe', { path: file.path }))
    if (typeof result.size !== 'number' || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > REMOTE_FILE_MAX_ASSET_BYTES
      || typeof result.modifiedAt !== 'string' || !Number.isFinite(Date.parse(result.modifiedAt))
      || typeof result.version !== 'string' || !VERSION.test(result.version)
      || result.kind !== 'image' && result.kind !== 'video'
      || typeof result.mimeType !== 'string' || result.mimeType.length > 100) {
      throw new RemoteAccessError('That machine returned invalid remote resource metadata.', 502)
    }
    return {
      file, size: result.size, modifiedAt: result.modifiedAt, version: result.version,
      kind: result.kind, mimeType: result.mimeType
    }
  }

  async readChunk(value: RemoteFileChunkRequest): Promise<RemoteFileChunk> {
    const file = this.identity(value)
    if (!Number.isSafeInteger(value.offset) || value.offset < 0
      || !Number.isSafeInteger(value.length) || value.length < 1 || value.length > REMOTE_FILE_CHUNK_BYTES
      || typeof value.version !== 'string' || !VERSION.test(value.version)) {
      throw new RemoteAccessError('Invalid remote resource range or version.', 400)
    }
    const result = record(await this.call(file, 'files.readChunk', {
      path: file.path, offset: value.offset, length: value.length, version: value.version
    }))
    if (result.offset !== value.offset || typeof result.length !== 'number' || !Number.isSafeInteger(result.length)
      || result.length < 1 || result.length > value.length
      || typeof result.totalSize !== 'number' || !Number.isSafeInteger(result.totalSize)
      || result.totalSize <= 0 || result.totalSize > REMOTE_FILE_MAX_ASSET_BYTES
      || result.version !== value.version || typeof result.bytesBase64 !== 'string'
      || result.bytesBase64.length > Math.ceil(REMOTE_FILE_CHUNK_BYTES / 3) * 4 + 4
      || typeof result.eof !== 'boolean') {
      throw new RemoteAccessError('That machine returned an invalid remote resource chunk.', 502)
    }
    const bytes = Buffer.from(result.bytesBase64, 'base64')
    if (bytes.toString('base64') !== result.bytesBase64 || bytes.length !== result.length || value.offset + bytes.length > result.totalSize
      || result.eof !== (value.offset + bytes.length >= result.totalSize)) {
      throw new RemoteAccessError('That machine returned an inconsistent remote resource chunk.', 502)
    }
    return {
      file, offset: value.offset, length: result.length, totalSize: result.totalSize,
      version: value.version, bytesBase64: result.bytesBase64, eof: result.eof
    }
  }

  async write(value: RemoteFileWriteRequest): Promise<RemoteFileWriteResponse> {
    const file = this.identity(value)
    if (typeof value.content !== 'string' || Buffer.byteLength(value.content) > MAX_TEXT_BYTES
      || !(value.expectedContent === null || typeof value.expectedContent === 'string' && Buffer.byteLength(value.expectedContent) <= MAX_TEXT_BYTES)) {
      throw new RemoteAccessError('Provide content and exact expected contents, up to 1 MiB.', 400)
    }
    const result = record(await this.call(file, 'files.write', { path: file.path, content: value.content, expectedContent: value.expectedContent }))
    let writeResult: EditorFileWriteResult
    if (result.status === 'saved') writeResult = { status: 'saved' }
    else if (result.status === 'conflict' && typeof result.message === 'string' && result.message.length <= 2000) {
      writeResult = { status: 'conflict', message: result.message }
    } else throw new RemoteAccessError('That machine returned an invalid write result.', 502)
    return { file, result: writeResult }
  }
}
