import { useState } from 'react'
import { Cloud } from 'lucide-react'
import { CLOUD_EFFORTS, CLOUD_MODELS } from '../../../shared/cloud'
import './CloudPane.css'

// Kept apart from CloudPane so the launcher never loads the terminal (xterm) it does not need.
/** The launcher's form for a new cloud session: model, effort, base branch and the task. */
export function CloudLaunchForm({ projectId, workspaceId, onDone }: { projectId: string; workspaceId: string; onDone(): void }): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(CLOUD_MODELS.find(entry => entry.isDefault)!.id)
  const [effort, setEffort] = useState('')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = (): void => {
    setBusy(true); setError('')
    void window.conductor.cloud.start({ projectId, workspaceId, prompt, model, ...(effort ? { effort } : {}), ...(ref.trim() ? { ref: ref.trim() } : {}) })
      .then(() => onDone())
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false))
  }
  return <div className="launcher-cloud-form" aria-label="New cloud session">
    <label>Task<textarea rows={4} value={prompt} placeholder="What the cloud session should do. It works on this project's GitHub repository and pushes a branch." onChange={event => setPrompt(event.target.value)} /></label>
    <label>Model<select value={model} onChange={event => setModel(event.target.value)}>{CLOUD_MODELS.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
    <label>Effort<select value={effort} onChange={event => setEffort(event.target.value)}><option value="">Default</option>{CLOUD_EFFORTS.map(level => <option key={level} value={level}>{level}</option>)}</select></label>
    <label>Base branch<input value={ref} placeholder="Default branch on GitHub" onChange={event => setRef(event.target.value.replace(/\s/g, ''))} /></label>
    <small>Runs on Claude Code in the cloud and spends your cloud credit. It starts from GitHub, so local commits that are not pushed are not in it.</small>
    {error && <div className="cloud-error" role="alert">{error}</div>}
    <div className="launcher-cloud-actions">
      <button type="button" disabled={busy || !prompt.trim()} onClick={start}><Cloud size={12} /> Start cloud session</button>
      <button type="button" disabled={busy} onClick={onDone}>Cancel</button>
    </div>
  </div>
}
