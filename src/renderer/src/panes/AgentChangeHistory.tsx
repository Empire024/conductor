/** The pre-git safety net, made visible: every file this conversation wrote, the diff of each
 *  write, and a way to put any of it back — without the owner having committed anything. */
import { useCallback, useEffect, useState } from 'react'
import { FileCode2, FilePlus2, FileX2, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react'
import type { AgentChangeHistory, ChangeHistoryEdit, ChangeHistoryFile, RevertOutcome, RevertPlan, RevertScope } from '../../../shared/agent-change-history'
import type { FileChange } from '../../../shared/structured-agent'
import { AgentDialog, ImmutableDiff } from './StructuredAgentRenderers'
import { cleanIpcError } from '../ipc-errors'
import './AgentChangeHistory.css'

const time = (value: string): string => { const at = new Date(value); return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const diskNote: Record<NonNullable<ChangeHistoryFile['disk']>, string> = {
  'matches-snapshot': 'On disk exactly as this conversation left it',
  'changed-since-snapshot': 'Changed on disk after this conversation last wrote it',
  missing: 'No longer on disk',
  unreadable: 'Cannot be read as text right now'
}
const asFileChange = (edit: ChangeHistoryEdit): FileChange => ({ path: edit.path, oldPath: edit.oldPath, kind: edit.kind, status: edit.status, artifactId: edit.artifactId, additions: edit.additions, deletions: edit.deletions, limitation: edit.limitation })
/** Only ever offer a button that will actually do something, and say why when it will not. */
function revertability(plan: RevertPlan): { enabled: boolean; title: string } {
  if (plan.restore.length) return { enabled: true, title: `Restore ${plan.restore.length} file${plan.restore.length === 1 ? '' : 's'} to the version before this change` }
  return { enabled: false, title: plan.blocked[0]?.reason ?? 'Nothing here can be restored.' }
}

export function AgentChangeHistoryView({ sessionId, title, busy, onClose, onOpenFile }: {
  sessionId: string
  title: string
  /** A running agent may still be writing; restoring underneath it would race its own edits. */
  busy: boolean
  onClose(): void
  onOpenFile(path: string, line?: number): void
}): React.JSX.Element {
  const [history, setHistory] = useState<AgentChangeHistory | null>(null)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<RevertOutcome | null>(null)
  const [grouping, setGrouping] = useState<'file' | 'turn'>('file')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<{ scope: RevertScope; plan: RevertPlan; label: string } | null>(null)
  const [reverting, setReverting] = useState(false)
  const [diff, setDiff] = useState<FileChange | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try { setHistory(await window.conductor.structured.changeHistory(sessionId)); setError('') }
    catch (reason) { setError(cleanIpcError(reason)) }
  }, [sessionId])
  useEffect(() => { void load() }, [load])

  const revert = async (scope: RevertScope): Promise<void> => {
    setReverting(true)
    try {
      const result = await window.conductor.structured.revertChanges(sessionId, scope)
      setOutcome(result)
      setConfirming(null)
      await load()
    } catch (reason) { setError(cleanIpcError(reason)) } finally { setReverting(false) }
  }
  const ask = (scope: RevertScope, plan: RevertPlan, label: string): void => { setOutcome(null); setError(''); setConfirming({ scope, plan, label }) }

  /** `blockedReason` is the file-level refusal, so a single edit is never offered a restore
   *  the surrounding file has already ruled out. */
  const editRow = (edit: ChangeHistoryEdit, showPath: boolean, blockedReason?: string): React.JSX.Element => {
    const single = { kind: 'edit' as const, itemId: edit.itemId, index: edit.index }
    return <li key={edit.itemId + ':' + edit.index} className="ach-edit">
      <span className="ach-when">{time(edit.timestamp)}</span>
      {showPath && <code className="ach-inline-path">{edit.path}</code>}
      <span className="sa-diff-count">{edit.additions !== undefined && <b>+{edit.additions}</b>}{edit.deletions !== undefined && <em>−{edit.deletions}</em>}</span>
      <span className="ach-kind">{edit.reverted ? 'restored' : edit.status === 'applied' ? edit.kind : edit.status}</span>
      <span className="sa-spacer" />
      <button disabled={!edit.artifactId && !edit.limitation} onClick={() => setDiff(asFileChange(edit))}>View diff</button>
      <button disabled={busy || edit.reverted || !edit.artifactId || Boolean(blockedReason)} title={blockedReason ?? (edit.reverted ? 'Already restored' : 'Restore this single edit')} onClick={() => ask(single, { restore: [], blocked: [] }, `this edit to ${edit.path}`)}><RotateCcw size={12} /> Revert</button>
    </li>
  }

  return <AgentDialog title={'Local change history · ' + title} onClose={onClose}>
    <div className="sa-diff-toolbar">
      <span className="sa-diff-count"><b>+{history?.totals.additions ?? 0}</b><em>−{history?.totals.deletions ?? 0}</em></span>
      <span>{history ? `${history.totals.files} file${history.totals.files === 1 ? '' : 's'} · ${history.totals.edits} edit${history.totals.edits === 1 ? '' : 's'}` : 'Reading snapshots…'}</span>
      <span className="sa-spacer" />
      <button aria-pressed={grouping === 'file'} onClick={() => setGrouping('file')}>By file</button>
      <button aria-pressed={grouping === 'turn'} onClick={() => setGrouping('turn')}>By turn</button>
      <button onClick={() => void load()}>Refresh</button>
    </div>
    <p className="sa-diff-caption">Snapshots Conductor took before each write, kept on this machine. Nothing here needs a commit, and reverting only ever writes files this conversation changed.</p>
    {busy && <p className="sa-notice">This conversation is still working. Restoring is disabled until it finishes.</p>}
    {history?.note && <p className="sa-notice">{history.note}</p>}
    {error && <p role="alert" className="sa-notice ach-alert"><TriangleAlert size={13} /> {error}</p>}
    {outcome && <div role="status" className="ach-outcome">
      <p>{outcome.message}</p>
      {Boolean(outcome.blocked.length) && <ul>{outcome.blocked.map(blocked => <li key={blocked.path}><code>{blocked.path}</code> — {blocked.reason}</li>)}</ul>}
    </div>}

    {!history && !error && <p className="sa-notice"><LoaderCircle size={13} className="spin" /> Loading this conversation&rsquo;s snapshots…</p>}

    {history && grouping === 'file' && <ul className="ach-list">{history.files.map(file => {
      const state = revertability(file.revert)
      const open = expanded[file.path] ?? false
      return <li key={file.path} className="ach-group" data-disk={file.disk ?? 'unknown'}>
        <header>
          {file.kind === 'add' ? <FilePlus2 size={13} /> : file.kind === 'delete' ? <FileX2 size={13} /> : <FileCode2 size={13} />}
          <button className="sa-file-link" onClick={() => onOpenFile(file.path)}><code>{file.path}</code></button>
          <span className="sa-diff-count"><b>+{file.additions}</b><em>−{file.deletions}</em></span>
          <span className="sa-spacer" />
          {file.disk && file.disk !== 'matches-snapshot' && <span className="ach-warn" title={diskNote[file.disk]}><TriangleAlert size={12} /> {file.disk === 'missing' ? 'gone' : file.disk === 'unreadable' ? 'unreadable' : 'changed outside'}</span>}
          <button onClick={() => setExpanded(current => ({ ...current, [file.path]: !open }))}>{open ? 'Hide' : `${file.edits.length} edit${file.edits.length === 1 ? '' : 's'}`}</button>
          <button disabled={busy || !state.enabled} title={state.title} onClick={() => ask({ kind: 'file', path: file.path }, file.revert, file.path)}><RotateCcw size={12} /> Revert file</button>
        </header>
        {file.disk && file.disk !== 'matches-snapshot' ? <p className="sa-muted">{diskNote[file.disk]}. Restoring would discard that; the file is left alone.</p>
          : !state.enabled && Boolean(file.revert.blocked.length) && <p className="sa-muted">{file.revert.blocked[0]!.reason}</p>}
        {open && <ul className="ach-edits">{file.edits.map(edit => editRow(edit, false, state.enabled ? undefined : state.title))}</ul>}
      </li>
    })}{!history.files.length && <li className="sa-notice">No files were written by this conversation.</li>}</ul>}

    {history && grouping === 'turn' && <ul className="ach-list">{history.turns.map(turn => {
      const state = revertability(turn.revert)
      return <li key={turn.key} className="ach-group">
        <header>
          <strong className="ach-turn-label" title={turn.label}>{turn.label}</strong>
          <span className="sa-spacer" />
          <span className="ach-when">{time(turn.startedAt)}</span>
          <button disabled={busy || !state.enabled} title={state.title} onClick={() => ask({ kind: 'turn', turnKey: turn.key }, turn.revert, `this turn (${turn.revert.restore.length} file${turn.revert.restore.length === 1 ? '' : 's'})`)}><RotateCcw size={12} /> Revert turn</button>
        </header>
        {Boolean(turn.revert.blocked.length) && <ul className="ach-blocked">{turn.revert.blocked.map(blocked => <li key={blocked.path}><TriangleAlert size={11} /> <code>{blocked.path}</code> — {blocked.reason}</li>)}</ul>}
        <ul className="ach-edits">{turn.edits.map(edit => editRow(edit, true, turn.revert.blocked.find(blocked => blocked.path === edit.path)?.reason))}</ul>
      </li>
    })}{!history.turns.length && <li className="sa-notice">No turn in this conversation has written a file.</li>}</ul>}

    {confirming && <AgentDialog title="Restore files" onClose={() => setConfirming(null)}>
      <p className="sa-notice">Conductor will overwrite {confirming.scope.kind === 'edit' ? 'this file' : `${confirming.plan.restore.length || 'the selected'} file${confirming.plan.restore.length === 1 ? '' : 's'}`} with the bytes saved before {confirming.label}. Files that changed since the snapshot are left untouched and reported back.</p>
      {Boolean(confirming.plan.restore.length) && <ul className="ach-confirm-list">{confirming.plan.restore.map(entry => <li key={entry.path}><code>{entry.path}</code></li>)}</ul>}
      {Boolean(confirming.plan.blocked.length) && <ul className="ach-blocked">{confirming.plan.blocked.map(blocked => <li key={blocked.path}><TriangleAlert size={11} /> <code>{blocked.path}</code> — will be skipped: {blocked.reason}</li>)}</ul>}
      <footer className="ach-confirm-actions">
        <button onClick={() => setConfirming(null)}>Cancel</button>
        <button className="ach-danger" disabled={reverting} onClick={() => void revert(confirming.scope)}>{reverting ? 'Restoring…' : 'Restore now'}</button>
      </footer>
    </AgentDialog>}
    {diff && <ImmutableDiff sessionId={sessionId} change={diff} onOpenFile={onOpenFile} onClose={() => { setDiff(null); void load() }} />}
  </AgentDialog>
}
