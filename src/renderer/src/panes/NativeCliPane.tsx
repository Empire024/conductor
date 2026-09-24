import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ChevronDown, MessagesSquare, TerminalSquare } from 'lucide-react'
import type { RuntimeTerminalProps } from './RuntimeTerminal'
import type { AgentSpec } from '../../../shared/models'
/** The native CLI's PTY in the drawer under a conversation. `focusToken` changes each time the
 *  drawer is shown again, which refits and focuses the terminal the PTY never stopped writing to. */
export function NativeCliPane({ onChat, onHide, focusToken, ...props }: RuntimeTerminalProps & { onChat(): Promise<void>; onHide?(): void; focusToken?: number }): React.JSX.Element {
  const fitRef = useRef<FitAddon | null>(null)
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [exited, setExited] = useState(false)
  useEffect(() => {
    let disposed = false, attached = false, lastSequence = 0
    let buffered: Array<{ data: string; sequence: number }> = []
    const term = new Terminal({ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: { background: '#011627', foreground: '#d6deeb', cursor: '#80a4c2' } })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); terminal.current = term; fitRef.current = fit
    const resize = (): void => { if (!host.current?.clientWidth || !host.current.clientHeight) return; fit.fit(); window.conductor.nativeCli.resize(props.resourceId, term.cols, term.rows) }
    const observer = new ResizeObserver(resize); observer.observe(host.current!)
    const receive = ({ data, sequence }: { data: string; sequence: number }): void => { if (sequence > lastSequence) { term.write(data); lastSequence = sequence } }
    const offData = window.conductor.nativeCli.onData(({ id, data, sequence }) => { if (id !== props.resourceId) return; if (attached) receive({ data, sequence }); else buffered.push({ data, sequence }) })
    const offStatus = window.conductor.nativeCli.onStatus((state) => { if (state.id === props.resourceId) setExited(state.status === 'exited') })
    const input = term.onData((data) => window.conductor.nativeCli.write(props.resourceId, data))
    const selection = term.onSelectionChange(() => { const text = term.getSelection(); if (text) void copyText(text) })
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && ['e', 'w'].includes(event.key.toLowerCase())) return false
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'c' && term.hasSelection()) { void copyText(term.getSelection()); return false }
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'v') { void navigator.clipboard.readText().then((text) => term.paste(text)); return false }
      return true
    })
    const spec: AgentSpec = { id: props.resourceId, projectId: props.project.id, sessionId: props.session.id, title: props.title, cwd: props.project.path, provider: props.provider ?? 'codex', model: props.model, effort: props.effort }
    void window.conductor.agents.ensure(spec).then(() => window.conductor.nativeCli.ensure(props.resourceId)).then((result) => {
      if (disposed) return
      // Replay only chunks newer than the snapshot; an IPC reply can cross output events.
      term.write(result.transcript); lastSequence = result.sequence; buffered.forEach(receive)
      attached = true; buffered = []; resize(); term.focus()
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)) })
    const applyTheme = (): void => {
      const style = getComputedStyle(document.documentElement)
      term.options.theme = { background: style.getPropertyValue('--surface-0').trim() || '#011627', foreground: style.getPropertyValue('--text').trim() || '#d6deeb', cursor: style.getPropertyValue('--accent-muted').trim() || '#80a4c2' }
    }
    const theme = new MutationObserver(applyTheme); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-id'] }); applyTheme()
    return () => { disposed = true; observer.disconnect(); theme.disconnect(); offData(); offStatus(); input.dispose(); selection.dispose(); term.dispose(); terminal.current = null; fitRef.current = null }
  }, [props.resourceId, props.project.id, props.session.id])
  useEffect(() => {
    if (!focusToken) return
    requestAnimationFrame(() => {
      const term = terminal.current
      if (!term || !host.current?.clientWidth || !host.current.clientHeight) return
      fitRef.current?.fit(); window.conductor.nativeCli.resize(props.resourceId, term.cols, term.rows); term.focus()
    })
  }, [focusToken, props.resourceId])
  return <div className="native-cli-pane">
    <header><span className="sa-cli-title"><TerminalSquare size={13} aria-hidden="true" /> {props.provider === 'claude' ? 'Claude Code' : props.provider === 'grok' ? 'Grok' : 'Codex'} · {exited ? 'Exited' : 'Native CLI, holding this conversation'}</span><span className="sa-spacer" /><button type="button" title="Stop the CLI and continue this conversation in Chat" disabled={busy} onClick={() => { setBusy(true); setError(''); void onChat().catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false)) }}><MessagesSquare size={13} /> Continue in Chat</button>{onHide && <button type="button" aria-label="Hide CLI" title="Hide the CLI; it keeps running" onClick={onHide}><ChevronDown size={14} /></button>}</header>
    {error && <div className="sa-error-bar" role="alert">{error}</div>}
    <div className="native-cli-terminal" ref={host} onClick={() => terminal.current?.focus()} />
  </div>
}
