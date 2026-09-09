import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, FileDigit, FilePenLine, FolderOpen, Maximize, Minus, Plus, RefreshCw, RotateCcw } from 'lucide-react'
import type { FileDataResource, ProjectRecord } from '../../../shared/models'
import { classifyExplorerFile } from '../components/workspace-sidebar-types'
import './FilePreviewPane.css'

const extensionOf = (path: string): string => path.split('.').pop()?.toLowerCase() ?? ''
const audioExtensions = new Set(['mp3', 'wav', 'ogg', 'm4a'])

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + ' MB'
    : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB'
      : bytes + ' bytes'

export type PreviewKind = 'markdown' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'binary'

/** Only kinds this pane can really render get a player or a decode. Anything
 * else is described rather than opened, so a video never becomes megabytes of
 * mojibake in a <pre> — or, worse, in the editor. */
export const previewKindFor = (path: string): PreviewKind => {
  switch (classifyExplorerFile(path)) {
    case 'markdown': return 'markdown'
    case 'image': return 'image'
    case 'media': return audioExtensions.has(extensionOf(path)) ? 'audio' : 'video'
    case 'pdf': return 'pdf'
    case 'text': return 'text'
    default: return 'binary'
  }
}

function MarkdownDocument({ source }: { source: string }): React.JSX.Element {
  const nodes: React.ReactNode[] = []
  let code: string[] | null = null
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  for (const [index, line] of lines.entries()) {
    if (/^```/.test(line)) {
      if (code) {
        nodes.push(<pre key={`code-${index}`}><code>{code.join('\n')}</code></pre>)
        code = null
      } else code = []
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements
      nodes.push(<Tag key={index}>{heading[2]}</Tag>)
    } else if (/^\s*[-*+]\s+/.test(line)) {
      nodes.push(<div className="markdown-list-item" key={index}><i />{line.replace(/^\s*[-*+]\s+/, '')}</div>)
    } else if (/^>\s?/.test(line)) {
      nodes.push(<blockquote key={index}>{line.replace(/^>\s?/, '')}</blockquote>)
    } else if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={index} />)
    } else if (line.trim()) {
      nodes.push(<p key={index}>{line}</p>)
    } else nodes.push(<span className="markdown-space" key={index} />)
  }
  if (code) nodes.push(<pre key="code-final"><code>{code.join('\n')}</code></pre>)
  return <article className="markdown-document">{nodes}</article>
}

export function FilePreviewPane({
  project,
  path,
  onOpenEditor
}: {
  project: ProjectRecord
  path: string
  onOpenEditor(path: string, allowBinary?: boolean): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [resource, setResource] = useState<FileDataResource | null>(null)
  const [size, setSize] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [zoom, setZoom] = useState(1)
  const kind = useMemo(() => previewKindFor(path), [path])
  const name = path.split('/').pop() ?? path

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setSize(null)
    const request = kind === 'binary'
      // Describing the file is enough here; its bytes are never worth loading.
      ? window.conductor.files.stat(project.id, path).then((info) => { if (active) { setSize(info.size); setResource(null); setText('') } })
      : kind === 'markdown' || kind === 'text'
        ? window.conductor.files.read(project.id, path).then((value) => { if (active) { setText(value); setResource(null) } })
        : window.conductor.files.readDataUrl(project.id, path).then((value) => { if (active) { setResource(value); setText('') } })
    void request.catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [kind, path, project.id, version])

  const openExternally = (): void => {
    void window.conductor.files.openExternal(project.id, path).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }

  return (
    <div className="file-preview-pane">
      <header className="file-preview-toolbar">
        <strong title={path}>{name}</strong>
        <span>{resource ? formatBytes(resource.size) : size !== null ? formatBytes(size) : kind}</span>
        <i />
        {kind === 'image' && <>
          <button title="Zoom out" onClick={() => setZoom((value) => Math.max(.2, value - .2))}><Minus size={14} /></button>
          <button title="Actual size" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button title="Zoom in" onClick={() => setZoom((value) => Math.min(5, value + .2))}><Plus size={14} /></button>
          <button title="Fit image" onClick={() => setZoom(0)}><Maximize size={14} /></button>
        </>}
        {(kind === 'markdown' || kind === 'text') && <button title="Open in editor" onClick={() => onOpenEditor(path)}><FilePenLine size={15} /></button>}
        <button title="Open with the Windows default app" onClick={openExternally}><ExternalLink size={15} /></button>
        <button title="Reload preview" onClick={() => setVersion((value) => value + 1)}><RefreshCw className={loading ? 'spin' : ''} size={15} /></button>
      </header>
      <div className={`file-preview-content preview-${kind}`}>
        {loading && <div className="file-preview-state"><RefreshCw className="spin" size={19} /> Loading preview…</div>}
        {!loading && error && <div className="file-preview-state error"><strong>Preview unavailable</strong><span>{error}</span><button onClick={() => setVersion((value) => value + 1)}><RotateCcw size={14} /> Try again</button></div>}
        {!loading && !error && kind === 'markdown' && <MarkdownDocument source={text} />}
        {!loading && !error && kind === 'text' && <pre className="text-preview"><code>{text}</code></pre>}
        {!loading && !error && kind === 'image' && resource && <div className="image-preview-stage"><img src={resource.dataUrl} alt={resource.name} style={zoom === 0 ? { maxWidth: '100%', maxHeight: '100%' } : { width: `${zoom * 100}%`, maxWidth: 'none' }} /></div>}
        {!loading && !error && kind === 'audio' && resource && <audio controls src={resource.dataUrl} />}
        {!loading && !error && kind === 'video' && resource && <video controls src={resource.dataUrl} />}
        {!loading && !error && kind === 'pdf' && resource && <embed title={resource.name} src={resource.dataUrl} type="application/pdf" />}
        {!loading && !error && kind === 'binary' && <div className="file-preview-state binary">
          <FileDigit size={26} />
          <strong>{name}</strong>
          <span>{size === null ? 'This file' : formatBytes(size)} · Conductor has no viewer for this file type.</span>
          <div>
            <button onClick={openExternally}><ExternalLink size={14} /> Open with default app</button>
            <button onClick={() => void window.conductor.files.reveal(project.id, path)}><FolderOpen size={14} /> Show in File Explorer</button>
            <button onClick={() => onOpenEditor(path, true)}><FilePenLine size={14} /> Open as text anyway</button>
          </div>
        </div>}
      </div>
    </div>
  )
}
