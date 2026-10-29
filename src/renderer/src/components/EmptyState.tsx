import { FolderOpen, MessageSquarePlus } from 'lucide-react'
import './EmptyState.css'

/**
 * First launch, or every project removed. A thread needs no project (src/shared/threads.ts), so
 * starting one is the first offer; making a project stays one click away.
 */
export function EmptyState({ onOpen, onNewThread }: { onOpen(): void; onNewThread?(): void }): React.JSX.Element {
  return (
    <main className="empty-state">
      <div className="empty-glow" />
      <div className="empty-content">
        <h1>{onNewThread ? 'What should we work on?' : 'Open a project'}</h1>
        {onNewThread && (
          <button className="primary-action" data-empty-new-thread onClick={onNewThread} title="Ctrl+Alt+N">
            <MessageSquarePlus size={16} /> Start without a project
          </button>
        )}
        <button className={onNewThread ? 'secondary-action' : 'primary-action'} data-empty-new-project onClick={onOpen}>
          <FolderOpen size={16} /> New project
        </button>
      </div>
    </main>
  )
}
