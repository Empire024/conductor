import type { RemoteFileEntry, RemoteFileIdentity, RemoteFilePreviewKind, RemotePromptFileAttachment } from '../../../shared/remote-files'

const normalizeDirectory = (path: string): string => path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/')

export const remoteTreeKey = (file: RemoteFileIdentity): string =>
  `${file.machineId}\0${file.projectId}\0${normalizeDirectory(file.path)}`

export function acceptRemoteTreeResponse(
  requested: RemoteFileIdentity,
  currentKey: string,
  entries: RemoteFileEntry[]
): RemoteFileEntry[] | null {
  if (remoteTreeKey(requested) !== currentKey) return null
  const directory = normalizeDirectory(requested.path)
  if (!Array.isArray(entries) || entries.length > 5000) throw new Error('The remote file list is invalid.')
  return entries.map(entry => {
    const path = normalizeDirectory(entry?.file?.path ?? '')
    const parts = path.split('/')
    const parent = parts.slice(0, -1).join('/')
    if (!entry || entry.file.machineId !== requested.machineId || entry.file.projectId !== requested.projectId
      || entry.name !== parts.at(-1) || parent !== directory || !entry.name || entry.name === '.' || entry.name === '..'
      || entry.name.includes('/') || entry.name.includes('\\') || !['file', 'directory'].includes(entry.kind)) {
      throw new Error('The remote machine returned a file outside the requested directory.')
    }
    return { ...entry, file: { ...entry.file, path } }
  })
}

export function remotePreviewKind(path: string): RemoteFilePreviewKind | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(extension)) return 'image'
  if (['.mp4', '.webm', '.mov'].includes(extension)) return 'video'
  return null
}

export function parentRemoteDirectory(path: string): string {
  return normalizeDirectory(path).split('/').slice(0, -1).join('/')
}

export function remotePromptFileAttachment(file: RemoteFileIdentity, name: string, id: string): RemotePromptFileAttachment {
  return { id, kind: 'file', name, remoteFile: { ...file } }
}
