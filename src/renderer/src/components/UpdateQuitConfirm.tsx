import { useEffect } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import type { UpdateBusyTab } from '../use-app-updates'
import './UpdateQuitConfirm.css'

export function UpdateQuitConfirm({
  running,
  onConfirm,
  onCancel
}: {
  running: UpdateBusyTab[]
  onConfirm(): void
  onCancel(): void
}): React.JSX.Element {
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onCancel])

  return (
    <div className="update-quit-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <section className="update-quit-confirm" role="alertdialog" aria-modal="true" aria-labelledby="update-quit-confirm-title">
        <header>
          <span className="update-quit-confirm-icon"><TriangleAlert size={17} /></span>
          <strong id="update-quit-confirm-title">Quit while work is in progress?</strong>
        </header>
        <p>{running.length === 1 ? 'This conversation is still running:' : `These ${running.length} conversations are still running:`}</p>
        <ul className="update-quit-confirm-list">{running.map((tab) => <li key={tab.id}>{tab.title}</li>)}</ul>
        <p>Restarting Conductor now will interrupt them.</p>
        <footer>
          <button type="button" onClick={onCancel}>Keep working</button>
          <button type="button" className="primary" onClick={onConfirm}><RotateCcw size={13} /> Quit and restart</button>
        </footer>
      </section>
    </div>
  )
}
