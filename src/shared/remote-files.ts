import type { EditorFileWriteResult } from './models'
import type { ContextAttachment } from './structured-agent'

/**
 * A file is identified by all three parts. `projectId` is the project in the controller's
 * database; it is never accepted by the host until the owner-confirmed mapping translates it to
 * that host's own project id.
 */
export interface RemoteFileIdentity {
  machineId: string
  projectId: string
  path: string
}

export interface RemoteFileEntry {
  file: RemoteFileIdentity
  name: string
  kind: 'file' | 'directory'
}

export interface RemoteFileStat {
  file: RemoteFileIdentity
  size: number
  isFile: boolean
  modifiedAt: string
}

export interface RemoteFileContents {
  file: RemoteFileIdentity
  content: string
}

export interface RemoteFileWriteRequest extends RemoteFileIdentity {
  content: string
  /** Exact host contents seen by the editor, or null only when creating a new file. */
  expectedContent: string | null
}

export interface RemoteFileWriteResponse {
  file: RemoteFileIdentity
  result: EditorFileWriteResult
}

export const REMOTE_FILE_CHUNK_BYTES = 256 * 1024
export const REMOTE_FILE_MAX_ASSET_BYTES = 256 * 1024 * 1024

export type RemoteFilePreviewKind = 'image' | 'video'

export interface RemoteFileDescription {
  file: RemoteFileIdentity
  size: number
  modifiedAt: string
  /** Stable for every chunk in one preview/download; a changed host file gets a new token. */
  version: string
  kind: RemoteFilePreviewKind
  mimeType: string
}

export interface RemoteFileChunkRequest extends RemoteFileIdentity {
  offset: number
  length: number
  version: string
}

export interface RemoteFileChunk {
  file: RemoteFileIdentity
  offset: number
  length: number
  totalSize: number
  version: string
  bytesBase64: string
  eof: boolean
}

export interface RemoteFilePreviewResource extends RemoteFileDescription {
  url: string
  expiresAt: string
}

export interface RemoteFileDownloadResult {
  file: RemoteFileIdentity
  path: string
  size: number
  version: string
}

/** A controller never supplies attachment bytes or a controller path for a host-owned file. */
export type RemotePromptFileAttachment = Pick<ContextAttachment, 'id' | 'name'> & {
  kind: 'file'
  remoteFile: RemoteFileIdentity
}

/** Host/controller transport; never expose raw chunk iteration directly to untrusted web content. */
export interface RemoteFileResourceTransport {
  describe(file: RemoteFileIdentity): Promise<RemoteFileDescription>
  readChunk(request: RemoteFileChunkRequest): Promise<RemoteFileChunk>
}

/** Narrow renderer surface. Preview URLs are opaque capabilities; save paths remain in main. */
export interface RemoteFileResourceBridge {
  preview(file: RemoteFileIdentity): Promise<RemoteFilePreviewResource>
  revokePreview(url: string): Promise<void>
  download(file: RemoteFileIdentity): Promise<RemoteFileDownloadResult | null>
}

/** Kept separate from the local files bridge so callers cannot accidentally fall back to disk. */
export interface RemoteFilesBridge {
  list(directory: RemoteFileIdentity): Promise<RemoteFileEntry[]>
  stat(file: RemoteFileIdentity): Promise<RemoteFileStat>
  read(file: RemoteFileIdentity): Promise<RemoteFileContents>
  write(request: RemoteFileWriteRequest): Promise<RemoteFileWriteResponse>
}
