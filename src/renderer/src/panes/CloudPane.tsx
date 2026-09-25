import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Cloud, CloudDownload, ExternalLink, Hand, MessagesSquare, Plug, Square } from 'lucide-react'
import { copyText } from '../clipboard'
import { CLOUD_MODELS, type CloudFetchResult, type CloudRunSummary, type CloudTranscriptEntry } from '../../../shared/cloud'
import './CloudPane.css'

const openExternal = (url: string): void => { void window.conductor.system.openExternal(url) }
const tokens = (value: number): string => value >= 10_000 ? `${Math.round(value / 1000)}k` : String(value)

/**
 * One Claude Code cloud session: its status, link and model, what it pushed (branch, head,
 * pull request), its transcript as the CLI's teleport pulled it, and the output of the client
 * Conductor ran for it (live where the account allows attaching). "Fetch for verification"
 * checks the result out into a worktree of its own; nothing here merges or pushes.
 */
export function CloudPane({ projectId, runId }: { projectId: string; runId: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const [run, setRun] = useState<CloudRunSummary | null>(null)
  const [entries, setEntries] = useState<CloudTranscriptEntry[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fetched, setFetched] = useState<CloudFetchResult | null>(null)

  useEffect(() => {
    let disposed = false, attached = false, lastSequence = 0
    let buffered: Array<{ data: string; sequence: number }> = []
    const term = new Terminal({ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: { background: '#011627', foreground: '#d6deeb', cursor: '#80a4c2' } })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); terminal.current = term
    const resize = (): void => { if (!host.current?.clientWidth || !host.current.clientHeight) return; fit.fit(); window.conductor.cloud.resize(runId, term.cols, term.rows) }
    const observer = new ResizeObserver(resize); observer.observe(host.current!)
    const receive = ({ data, sequence }: { data: string; sequence: number }): void => { if (sequence > lastSequence) { term.write(data); lastSequence = sequence } }
    const offData = window.conductor.cloud.onData(event => { if (event.id !== runId) return; if (attached) receive(event); else buffered.push(event) })
    let transcriptAt: number | null = null
    const loadTranscript = (): void => { void window.conductor.cloud.transcript(projectId, runId, false).then(list => { if (!disposed) setEntries(list) }).catch(() => undefined) }
    const offChanged = window.conductor.cloud.onChanged(summary => {
      if (summary.id !== runId) return
      setRun(summary)
      // A new client (a live view after creation) starts its own stream.
      if (summary.attached && lastSequence > 0 && !attached) lastSequence = 0
      if (summary.transcriptAt !== transcriptAt) { transcriptAt = summary.transcriptAt; loadTranscript() }
    })
    const input = term.onData(data => window.conductor.cloud.write(runId, data))
    const selection = term.onSelectionChange(() => { const text = term.getSelection(); if (text) void copyText(text) })
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && ['e', 'w'].includes(event.key.toLowerCase())) return false
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'c' && term.hasSelection()) { void copyText(term.getSelection()); return false }
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'v') { void navigator.clipboard.readText().then(text => term.paste(text)); return false }
      return true
    })
    void window.conductor.cloud.ensure(projectId, runId).then(result => {
      if (disposed) return
      setRun(result.summary); transcriptAt = result.summary.transcriptAt
      term.write(result.transcript); lastSequence = result.sequence; buffered.forEach(receive)
      attached = true; buffered = []; resize()
      loadTranscript()
    }).catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    const applyTheme = (): void => {
      const style = getComputedStyle(document.documentElement)
      term.options.theme = { background: style.getPropertyValue('--surface-0').trim() || '#011627', foreground: style.getPropertyValue('--text').trim() || '#d6deeb', cursor: style.getPropertyValue('--accent-muted').trim() || '#80a4c2' }
    }
    const theme = new MutationObserver(applyTheme); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-id'] }); applyTheme()
    return () => { disposed = true; observer.disconnect(); theme.disconnect(); offData(); offChanged(); input.dispose(); selection.dispose(); term.dispose(); terminal.current = null }
  }, [projectId, runId])

  const act = (label: string, action: () => Promise<unknown>): void => {
    setBusy(true); setError('')
    void action().catch((reason: unknown) => setError(`${label}: ${reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)}`)).finally(() => setBusy(false))
  }
  const model = CLOUD_MODELS.find(entry => entry.id === run?.model)?.label ?? run?.model ?? ''
  const following = run && run.status !== 'stopped' && run.status !== 'failed'
  const live = Boolean(run?.attached && run.liveView !== false && run.status !== 'starting')
  return <div className="cloud-pane" data-cloud-run={runId} data-cloud-status={run?.status ?? ''}>
    <header>
      <Cloud size={13} aria-hidden="true" />
      <strong title={run?.prompt}>{run?.title ?? 'Cloud session'}</strong>
      {run && <span className={`cloud-status status-${run.status}`}>{run.status}</span>}
      {model && <span title={run?.confirmedModel ? `The session reports ${run.confirmedModel}` : undefined}>{model}{run?.effort ? ` · ${run.effort}` : ''}</span>}
      {run?.sessionUrl && <a href={run.sessionUrl} onClick={event => { event.preventDefault(); openExternal(run.sessionUrl!) }} title="Open the session on claude.ai/code">{run.sessionId} <ExternalLink size={10} /></a>}
      {run?.usage && <span className="cloud-usage" title="Tokens the session's messages report (input · output · cache read)">{tokens(run.usage.inputTokens + run.usage.cacheCreationTokens)} in · {tokens(run.usage.outputTokens)} out · {tokens(run.usage.cacheReadTokens)} cached</span>}
      <span className="cloud-spacer" />
      {live && <button type="button" disabled={busy} title="Stop the cloud agent's current turn (Esc)" onClick={() => act('Interrupt', () => window.conductor.cloud.interrupt(projectId, runId))}><Hand size={12} /> Interrupt</button>}
      {run && !run.attached && run.sessionId && run.liveView !== false && following && <button type="button" disabled={busy} title="Open a live client on this session" onClick={() => act('Attach', () => window.conductor.cloud.attach(projectId, runId))}><Plug size={12} /> Attach</button>}
      {run?.sessionId && <button type="button" disabled={busy} title="Pull the session's messages from the cloud now" onClick={() => act('Transcript', async () => setEntries(await window.conductor.cloud.transcript(projectId, runId, true)))}><MessagesSquare size={12} /> Pull transcript</button>}
      {run?.branch && <button type="button" disabled={busy} title="Fetch the session's branch into a worktree of its own; nothing is merged" onClick={() => act('Fetch', async () => setFetched(await window.conductor.cloud.fetch(projectId, runId)))}><CloudDownload size={12} /> Fetch for verification</button>}
      {following && <button type="button" disabled={busy} title="Stop following this run here" onClick={() => act('Stop', () => window.conductor.cloud.stop(projectId, runId))}><Square size={12} /> Stop</button>}
    </header>
    {(run?.branch || run?.prUrl || fetched || run?.worktreePath || run?.liveView === false) && <div className="cloud-result">
      {run?.branch && <span>Branch <code>{run.branch}</code>{run.headCommit && <> at <code>{run.headCommit.slice(0, 10)}</code></>}</span>}
      {run?.prUrl && <a href={run.prUrl} onClick={event => { event.preventDefault(); openExternal(run.prUrl!) }}>{run.prUrl.replace(/^https:\/\/github\.com\//, '')} <ExternalLink size={10} /></a>}
      {(fetched?.worktreePath ?? run?.worktreePath) && <span>Worktree <code>{fetched?.worktreePath ?? run?.worktreePath}</code> at <code>{(fetched?.commit ?? run?.fetchedCommit ?? '').slice(0, 10)}</code></span>}
      {run?.liveView === false && <small>This account cannot attach a live client to a cloud session, so it is followed through GitHub and its transcript; steer or stop it on claude.ai.</small>}
      {fetched?.diffStat && <pre>{fetched.diffStat}</pre>}
    </div>}
    {(error || run?.error) && <div className="cloud-error" role="alert">{error || run?.error}</div>}
    {entries.length > 0 && <ol className="cloud-transcript" aria-label="Session transcript">
      {entries.map((entry, index) => <li key={index} className={`cloud-entry role-${entry.role}`}><span>{entry.role}</span><p>{entry.text}</p></li>)}
    </ol>}
    <div className={`cloud-terminal${entries.length ? ' compact' : ''}`} ref={host} onClick={() => terminal.current?.focus()} />
  </div>
}
