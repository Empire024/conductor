import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileJson,
  Folder,
  FolderOpen,
  RefreshCw
} from 'lucide-react'
import type { FileEntry, ProjectRecord } from '../../../shared/models'

const fileIcon = (name: string): typeof File => {
  if (/\.(tsx?|jsx?|css|html|py|php|rs|go|java|cs)$/i.test(name)) return FileCode2
  if (/\.(json|jsonc|ya?ml)$/i.test(name)) return FileJson
  return File
}

function DirectoryNode({
  projectId,
  entry,
  depth,
  onOpenFile
}: {
  projectId: string
  entry: FileEntry
  depth: number
  onOpenFile(path: string): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)

  const toggle = async (): Promise<void> => {
    if (!open && children.length === 0) {
      setLoading(true)
      try {
        setChildren(await window.conductor.files.list(projectId, entry.relativePath))
      } finally {
        setLoading(false)
      }
    }
    setOpen((value) => !value)
  }

  if (entry.kind === 'file') {
    const Icon = fileIcon(entry.name)
    return (
      <button className="tree-row file-row" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => onOpenFile(entry.relativePath)}>
        <span className="tree-chevron" />
        <Icon size={14} />
        <span className="ellipsis">{entry.name}</span>
      </button>
    )
  }

  return (
    <div>
      <button className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => void toggle()}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {open ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span className="ellipsis">{entry.name}</span>
        {loading && <i className="tree-loading" />}
      </button>
      {open && children.map((child) => (
        <DirectoryNode key={child.relativePath} projectId={projectId} entry={child} depth={depth + 1} onOpenFile={onOpenFile} />
      ))}
    </div>
  )
}

export function FileTreePane({
  project,
  onOpenFile
}: {
  project: ProjectRecord
  onOpenFile(path: string): void
}): React.JSX.Element {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [version, setVersion] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    void window.conductor.files.list(project.id).then(setEntries).catch((reason) => setError(String(reason)))
  }, [project.id, version])

  return (
    <div className="file-tree-pane">
      <div className="file-tree-toolbar">
        <div><FolderOpen size={14} /><span className="ellipsis">{project.name}</span></div>
        <button onClick={() => setVersion((value) => value + 1)} title="Refresh files"><RefreshCw size={13} /></button>
      </div>
      <div className="tree-path" title={project.path}>{project.path}</div>
      <div className="file-tree-scroll">
        {error && <div className="tree-error">{error}</div>}
        {entries.map((entry) => (
          <DirectoryNode key={entry.relativePath} projectId={project.id} entry={entry} depth={0} onOpenFile={onOpenFile} />
        ))}
      </div>
      <div className="file-tree-footer"><span>{entries.length} root items</span><span>Local</span></div>
    </div>
  )
}
