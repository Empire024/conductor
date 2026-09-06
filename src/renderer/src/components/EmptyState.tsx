import { FolderOpen } from 'lucide-react'

export function EmptyState({ onOpen }: { onOpen(): void }): React.JSX.Element {
  return (
    <main className="empty-state">
      <div className="empty-glow" />
      <div className="empty-content">
        <h1>Open a project</h1>
        <button className="primary-action" onClick={onOpen}>
          <FolderOpen size={16} /> New project
        </button>
      </div>
    </main>
  )
}
