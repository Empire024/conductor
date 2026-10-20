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

/**
 * `document` is a file no Conductor view reads - a PDF, an archive, an office file - which is only
 * ever fetched whole to the controlling computer and opened there with its default app. It is never
 * served through a preview URL, and nothing that could run (scripts, executables, HTML) is one.
 */
export type RemoteFilePreviewKind = 'image' | 'video' | 'document'

/** The files a paired machine may hand over to be opened with the controlling computer's default app. */
export const REMOTE_OPENABLE_DOCUMENTS: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.epub': 'application/epub+zip'
}

/** The lower-case extension of a host path, or '' when it has none. */
export const remoteFileExtension = (path: string): string => {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export const isRemoteOpenableDocument = (path: string): boolean => Object.hasOwn(REMOTE_OPENABLE_DOCUMENTS, remoteFileExtension(path))

/** The media a paired machine previews and hands over (the host's own list is the authority). */
export const REMOTE_MEDIA_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4', '.webm', '.mov']

/** Whether a host file can be saved to this computer whole: safe media, or an allowlisted document. */
export const isRemoteTransferable = (path: string): boolean => isRemoteOpenableDocument(path) || REMOTE_MEDIA_EXTENSIONS.includes(remoteFileExtension(path))

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
/** Text the owner pasted into the composer (see shared/pasted-text.ts) is message content, not a
 *  host file, so it is the one attachment a controller supplies bytes for. */
export type RemotePromptTextAttachment = Pick<ContextAttachment, 'id' | 'name'> & {
  kind: 'selection'
  content: string
}
export type RemotePromptAttachment = RemotePromptFileAttachment | RemotePromptTextAttachment

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
  /**
   * Fetches a host document (REMOTE_OPENABLE_DOCUMENTS) into a read-only copy on this computer and
   * opens it with the default app. The copy is a cache, pruned by age and size; edits never go back.
   */
  openLocal(file: RemoteFileIdentity): Promise<{ path: string }>
}

/** Kept separate from the local files bridge so callers cannot accidentally fall back to disk. */
export interface RemoteFilesBridge {
  list(directory: RemoteFileIdentity): Promise<RemoteFileEntry[]>
  stat(file: RemoteFileIdentity): Promise<RemoteFileStat>
  read(file: RemoteFileIdentity): Promise<RemoteFileContents>
  write(request: RemoteFileWriteRequest): Promise<RemoteFileWriteResponse>
}
