import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, utimes, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteFileDescription, RemoteFileIdentity } from '../shared/remote-files'
import { isRemoteOpenableDocument, REMOTE_FILE_CHUNK_BYTES, REMOTE_FILE_MAX_ASSET_BYTES } from '../shared/remote-files'
import type { RemoteFiles } from './remote-files'

/** Copies older than this are removed on the next open, whatever their size. */
export const REMOTE_OPEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** And past this total the oldest go first, so the cache never grows without bound. */
export const REMOTE_OPEN_MAX_BYTES = 500 * 1024 * 1024

export interface RemoteOpenCacheDependencies {
  files: Pick<RemoteFiles, 'describe' | 'readChunk'>
  /** Where the copies live; owned by this cache alone (userData/remote-open). */
  root: string
  /** Opens a finished copy with this computer's default app. */
  open(path: string): Promise<void>
  now?(): number
  maxAgeMs?: number
  maxBytes?: number
}

/** A host file name made safe as a file name here; the extension, which picks the app, is kept. */
export function safeCopyName(path: string): string {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? ''
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(-120)
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'file'
}

/**
 * A document a conversation on a paired machine delivered - a PDF, an archive, an office file -
 * opened on the computer in front of the owner. It is fetched through the same guarded chunk
 * transport as a media preview (every chunk re-checked by the host against the project grant),
 * written to a private cache as a read-only copy, and handed to the default app. The copy is not
 * the file: nothing written to it goes back, which is why it is read-only and why the cache is
 * pruned freely.
 */
export class RemoteOpenCache {
  constructor(private readonly deps: RemoteOpenCacheDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  async open(file: RemoteFileIdentity): Promise<{ path: string }> {
    // Checked here as well as on the host: this is the computer whose default app would run it.
    if (!isRemoteOpenableDocument(file.path)) throw new Error('Only PDFs, archives and office documents from another machine open with this computer\'s default app.')
    const description = await this.deps.files.describe(file)
    if (description.kind !== 'document' || description.size <= 0 || description.size > REMOTE_FILE_MAX_ASSET_BYTES) {
      throw new Error('That machine did not describe the file as a document this computer can open.')
    }
    const folder = join(this.deps.root,
      createHash('sha256').update([file.machineId, file.projectId, file.path].join('\0')).digest('hex').slice(0, 24),
      description.version.slice(0, 16))
    const destination = join(folder, safeCopyName(file.path))
    const existing = await lstat(destination).catch(() => null)
    if (existing?.isFile() && !existing.isSymbolicLink() && existing.size === description.size) {
      // Reopening the same version reuses the copy and marks it recently used for pruning.
      const at = new Date(this.now())
      await utimes(destination, at, at).catch(() => undefined)
    } else {
      await this.fetch(description, folder, destination)
    }
    await this.prune(destination).catch(error => console.warn('Remote open cache was not pruned', error))
    await this.deps.open(destination)
    return { path: destination }
  }

  private async fetch(description: RemoteFileDescription, folder: string, destination: string): Promise<void> {
    await mkdir(folder, { recursive: true })
    const temporary = join(folder, `.${randomBytes(12).toString('hex')}.conductor-open`)
    let handle: FileHandle | null = null
    let published = false
    try {
      handle = await open(temporary, 'wx')
      let offset = 0
      while (offset < description.size) {
        const length = Math.min(REMOTE_FILE_CHUNK_BYTES, description.size - offset)
        const chunk = await this.deps.files.readChunk({ ...description.file, offset, length, version: description.version })
        if (chunk.offset !== offset || chunk.totalSize !== description.size || chunk.version !== description.version
          || chunk.length < 1 || chunk.length > length) {
          throw new Error('That machine returned an inconsistent part of the file.')
        }
        const bytes = Buffer.from(chunk.bytesBase64, 'base64')
        if (bytes.length !== chunk.length) throw new Error('That machine returned invalid bytes.')
        let written = 0
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, offset + written)
          if (result.bytesWritten < 1) throw new Error('The copy of the file could not be written.')
          written += result.bytesWritten
        }
        offset += bytes.length
      }
      await handle.close()
      handle = null
      await chmod(temporary, 0o444)
      await rm(destination, { force: true }).catch(() => undefined)
      await rename(temporary, destination)
      published = true
    } finally {
      await handle?.close().catch(() => undefined)
      if (!published) await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Removes copies past the age limit, then the least recently used until the total fits. The copy
   * about to be opened is never removed. Only this cache's own layout (root/<file>/<version>/name)
   * is walked, and a symbolic link found in it is removed as a link, never followed.
   */
  async prune(keep?: string): Promise<void> {
    const maxAge = this.deps.maxAgeMs ?? REMOTE_OPEN_MAX_AGE_MS
    const maxBytes = this.deps.maxBytes ?? REMOTE_OPEN_MAX_BYTES
    const now = this.now()
    const copies: Array<{ path: string; folder: string; size: number; usedAt: number }> = []
    for (const fileFolder of await readdir(this.deps.root).catch(() => [] as string[])) {
      const fileDir = join(this.deps.root, fileFolder)
      for (const version of await readdir(fileDir).catch(() => [] as string[])) {
        const versionDir = join(fileDir, version)
        for (const name of await readdir(versionDir).catch(() => [] as string[])) {
          const path = join(versionDir, name)
          const info = await lstat(path).catch(() => null)
          if (!info) continue
          copies.push({ path, folder: versionDir, size: info.isFile() ? info.size : 0, usedAt: info.mtimeMs })
        }
      }
    }
    const remove = async (copy: { path: string; folder: string }): Promise<void> => {
      await chmod(copy.path, 0o666).catch(() => undefined)
      await rm(copy.path, { force: true })
      // The version folder goes with its last copy; rmdir refuses one that still holds anything.
      await rmdir(copy.folder).catch(() => undefined)
    }
    let total = 0
    const kept: typeof copies = []
    for (const copy of copies) {
      if (copy.path !== keep && now - copy.usedAt > maxAge) await remove(copy)
      else { kept.push(copy); total += copy.size }
    }
    for (const copy of kept.sort((left, right) => left.usedAt - right.usedAt)) {
      if (total <= maxBytes) break
      if (copy.path === keep) continue
      await remove(copy)
      total -= copy.size
    }
  }
}
