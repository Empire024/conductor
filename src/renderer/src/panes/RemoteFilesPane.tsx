import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, Eye, File, Folder, FolderOpen, LoaderCircle, Paperclip, RefreshCw, X } from 'lucide-react'
import type {
  RemoteFileEntry,
  RemoteFileIdentity,
  RemoteFilePreviewResource,
  RemoteFileResourceBridge,
  RemoteFilesBridge,
  RemotePromptFileAttachment
} from '../../../shared/remote-files'
import {
  CoalescedRefresh, REMOTE_TREE_REFRESH_MS, acceptRemoteTreeResponse, parentRemoteDirectory,
  remotePreviewKind, remotePromptFileAttachment, remoteTreeKey, shouldRelistRemoteDirectory
} from './remote-files-pane-state'
import './RemoteFilesPane.css'

export interface RemoteFilesPaneProps {
  machineId: string
  machineName: string
  projectId: string
  files: Pick<RemoteFilesBridge, 'list'> & RemoteFileResourceBridge
  onOpenFile(file: RemoteFileIdentity): void
  onAttachFile?(attachment: RemotePromptFileAttachment): void
}

/** Remote-only tree and safe media viewer. It has no local files bridge and therefore no fallback. */
export function RemoteFilesPane({ machineId, machineName, projectId, files, onOpenFile, onAttachFile }: RemoteFilesPaneProps): React.JSX.Element {
  const [directory, setDirectory] = useState('')
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<RemoteFilePreviewResource | null>(null)
  const [previewError, setPreviewError] = useState('')
  const requestKey = useRef('')
  const previewRequest = useRef(0)
  const identity = { machineId, projectId, path: directory }

  /**
   * `quiet` is what makes following the host bearable to look at.
   *
   * Opening a folder empties the list and shows a spinner, which is right: nothing on screen is
   * true yet. A re-list caused by the host writing a file is the opposite - almost everything on
   * screen is still true - and doing the same thing would blank the list, drop the scroll position
   * and steal whatever the owner was about to click, several times a minute, for a change they may
   * not even care about. So a background re-list replaces the rows in place and shows nothing.
   */
  const load = (quiet = false): void => {
    const requested = { ...identity }
    const key = remoteTreeKey(requested)
    requestKey.current = key
    if (!quiet) { setEntries([]); setLoading(true) }
    setError('')
    void files.list(requested).then(result => {
      const accepted = acceptRemoteTreeResponse(requested, requestKey.current, result)
      if (accepted) setEntries(accepted)
    }).catch(reason => {
      // A background re-list that fails leaves the last good listing alone rather than replacing a
      // usable tree with an error the owner never asked for.
      if (requestKey.current === key && !quiet) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (requestKey.current === key && !quiet) setLoading(false) })
  }

  useEffect(() => {
    setDirectory('')
    setPreview(current => { if (current) void files.revokePreview(current.url).catch(() => {}); return null })
    setPreviewError('')
  }, [machineId, projectId])

  useEffect(() => {
    load()
    return () => { requestKey.current = ''; previewRequest.current++ }
  }, [machineId, projectId, directory])

  /**
   * The host keeps working while this pane is open - an agent runs there, a build writes there, the
   * owner types there - so a tree that only ever showed the moment it was opened is a particular
   * kind of wrong: the owner acts on it. Main delivers host changes on the same `files:changed`
   * channel, tagged with the machine and the host's own project id.
   */
  useEffect(() => {
    const refresh = new CoalescedRefresh(REMOTE_TREE_REFRESH_MS, () => load(true))
    const stop = window.conductor.files.onChanged(change => {
      if (shouldRelistRemoteDirectory(change, { machineId, projectId }, directory)) refresh.schedule()
    })
    // Cancel before unsubscribing: a burst that has not settled must not re-list a folder this
    // pane has already navigated away from, or one it no longer exists to show.
    return () => { refresh.cancel(); stop() }
  }, [machineId, projectId, directory])

  useEffect(() => () => {
    if (preview) void files.revokePreview(preview.url).catch(() => {})
  }, [preview?.url])

  const showPreview = (file: RemoteFileIdentity): void => {
    const request = ++previewRequest.current
    setPreview(current => { if (current) void files.revokePreview(current.url).catch(() => {}); return null })
    setPreviewError('')
    void files.preview(file).then(resource => {
      if (request !== previewRequest.current) { void files.revokePreview(resource.url).catch(() => {}); return }
      if (remoteTreeKey(resource.file) !== remoteTreeKey(file) || resource.file.path !== file.path) {
        void files.revokePreview(resource.url).catch(() => {})
        throw new Error('The preview belongs to a different remote file.')
      }
      setPreview(resource)
    }).catch(reason => { if (request === previewRequest.current) setPreviewError(reason instanceof Error ? reason.message : String(reason)) })
  }

  const download = (file: RemoteFileIdentity): void => {
    setError('')
    void files.download(file).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }

  return <section className="remote-files-pane" data-machine-id={machineId}>
    <header>
      <span><FolderOpen size={15} /> Remote files</span>
      <strong title={machineId}>{machineName}</strong>
      <button aria-label="Refresh remote files" title="Refresh" onClick={() => load()} disabled={loading}><RefreshCw size={14} /></button>
    </header>
    <nav aria-label="Remote folder">
      <button disabled={!directory || loading} onClick={() => setDirectory(parentRemoteDirectory(directory))}><ArrowLeft size={13} /> Back</button>
      <code>{directory || '/'}</code>
    </nav>
    {error && <div className="remote-files-error" role="alert">{error}</div>}
    {loading ? <div className="remote-files-empty"><LoaderCircle className="spin" size={17} /> Loading host files…</div>
      : entries.length === 0 && !error ? <div className="remote-files-empty">This host folder is empty.</div>
        : <div className="remote-files-list" role="list">
          {entries.map(entry => <div className="remote-file-row" role="listitem" key={remoteTreeKey(entry.file)}>
            <button className="remote-file-name" onClick={() => entry.kind === 'directory' ? setDirectory(entry.file.path) : onOpenFile(entry.file)}>
              {entry.kind === 'directory' ? <Folder size={14} /> : <File size={14} />}<span>{entry.name}</span>
            </button>
            {entry.kind === 'file' && remotePreviewKind(entry.file.path) && <button aria-label={`Preview ${entry.name}`} onClick={() => showPreview(entry.file)}><Eye size={13} /></button>}
            {entry.kind === 'file' && onAttachFile && <button aria-label={`Attach ${entry.name} to focused conversation`} onClick={() => onAttachFile(remotePromptFileAttachment(entry.file, entry.name, crypto.randomUUID()))}><Paperclip size={13} /></button>}
            {entry.kind === 'file' && <button aria-label={`Download ${entry.name}`} onClick={() => download(entry.file)}><Download size={13} /></button>}
          </div>)}
        </div>}
    {(preview || previewError) && <aside className="remote-file-preview" aria-label="Remote file preview">
      <header><strong>{preview?.file.path ?? 'Preview unavailable'}</strong><button aria-label="Close preview" onClick={() => { previewRequest.current++; setPreview(null); setPreviewError('') }}><X size={14} /></button></header>
      {previewError ? <div className="remote-files-error" role="alert">{previewError}</div>
        : preview?.kind === 'image' ? <img src={preview.url} alt={preview.file.path} />
          : preview ? <video src={preview.url} controls preload="metadata" /> : null}
    </aside>}
  </section>
}
