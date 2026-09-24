import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ChevronDown, TerminalSquare } from 'lucide-react'
import { copyText } from '../clipboard'
import { NativeCliPane } from './NativeCliPane'
import type { RuntimeTerminalProps } from './RuntimeTerminal'
import { createLiveLogState, formatLiveEvents } from './cli-live-log'

const HEIGHT_KEY = 'conductor.cli-drawer.height'
/** Percent of the conversation's height the drawer takes; the owner's last drag is remembered. */
export function storedDrawerHeight(): number {
  const value = Number(localStorage.getItem(HEIGHT_KEY))
  return Number.isFinite(value) && value >= 15 && value <= 85 ? value : 42
}
/** How much of the recent journal the live view replays when it opens. */
const LIVE_BACKLOG = 300

const productName = (provider: RuntimeTerminalProps['provider']): string => provider === 'claude' ? 'Claude Code' : provider === 'grok' ? 'Grok' : provider === 'local' ? 'Local model' : 'Codex'
function themeFromDocument(): { background: string; foreground: string; cursor: string } {
  const style = getComputedStyle(document.documentElement)
  return { background: style.getPropertyValue('--surface-0').trim() || '#011627', foreground: style.getPropertyValue('--text').trim() || '#d6deeb', cursor: style.getPropertyValue('--accent-muted').trim() || '#80a4c2' }
}

/** The running turn, written as a terminal would show it, straight from the event stream. */
function LiveActivityTerminal({ sessionId, since, visible }: { sessionId: string; since: number; visible: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  useEffect(() => {
    let disposed = false, attached = false, lastSequence = 0
    let buffered: Parameters<typeof formatLiveEvents>[0] = []
    const state = createLiveLogState()
    const term = new Terminal({ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12.5, lineHeight: 1.15, cursorBlink: false, disableStdin: true, scrollback: 5000, convertEol: false, theme: themeFromDocument() })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); fitRef.current = fit
    const resize = (): void => { if (host.current?.clientWidth && host.current.clientHeight) fit.fit() }
    const observer = new ResizeObserver(resize); observer.observe(host.current!)
    const write = (events: typeof buffered): void => {
      const fresh = events.filter(event => event.sequence > lastSequence)
      if (!fresh.length) return
      lastSequence = fresh.at(-1)!.sequence
      term.write(formatLiveEvents(fresh, state))
    }
    const off = window.conductor.structured.onEvents(events => {
      const mine = events.filter(event => event.sessionId === sessionId)
      if (!mine.length) return
      if (attached) write(mine); else buffered.push(...mine)
    })
    // The journal read is bounded to the tail: `events(id, after)` walks the primary key from there.
    void window.conductor.structured.events(sessionId, Math.max(0, since - LIVE_BACKLOG)).then(backlog => {
      if (disposed) return
      if (!backlog.length) term.write('\x1b[2mWaiting for activity. This view follows the conversation live; answer approvals in Chat.\x1b[22m\r\n')
      write(backlog); write(buffered.sort((a, b) => a.sequence - b.sequence)); buffered = []; attached = true; resize()
    }).catch((reason: unknown) => { if (!disposed) term.write('\x1b[31m' + String(reason) + '\x1b[39m\r\n') })
    const selection = term.onSelectionChange(() => { const text = term.getSelection(); if (text) void copyText(text) })
    const theme = new MutationObserver(() => { term.options.theme = themeFromDocument() }); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-id'] })
    return () => { disposed = true; off(); observer.disconnect(); theme.disconnect(); selection.dispose(); term.dispose(); fitRef.current = null }
  }, [sessionId, since])
  useEffect(() => { if (visible) requestAnimationFrame(() => { if (host.current?.clientWidth) fitRef.current?.fit() }) }, [visible])
  return <div className="native-cli-terminal" ref={host} />
}

export interface CliDrawerProps {
  runtime: RuntimeTerminalProps
  conversation: string
  /** The native CLI holds the conversation (its PTY is live); otherwise the drawer shows Chat's live activity. */
  owned: boolean
  open: boolean
  /** Chat's turn has settled, so the conversation can move to the native CLI. */
  idle: boolean
  starting: boolean
  since: number
  height: number
  onHeight(percent: number): void
  onHide(): void
  onOpenNative(): void
  onReturnToChat(): Promise<void>
}
/**
 * The CLI under a Chat conversation, like an editor's terminal panel. It is only ever hidden,
 * never torn down, while the native CLI holds the conversation, so showing and hiding it never
 * restarts the process or its PTY. While Chat runs a turn it shows that turn's live activity
 * read-only; a local model has no native CLI, so for it that view is the CLI.
 */
export function CliDrawer(props: CliDrawerProps): React.JSX.Element {
  const drawer = useRef<HTMLDivElement>(null)
  const [focusToken, setFocusToken] = useState(0)
  useEffect(() => { if (props.open) setFocusToken(token => token + 1) }, [props.open])
  const name = productName(props.runtime.provider)
  const native = props.runtime.provider !== 'local'
  const drag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const container = drawer.current?.parentElement
    if (!container || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => {
      const box = container.getBoundingClientRect()
      props.onHeight(Math.min(85, Math.max(15, (box.bottom - next.clientY) / box.height * 100)))
    }
    const up = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up) }
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up)
  }
  return <div ref={drawer} className="sa-cli-drawer" hidden={!props.open} style={{ flexBasis: props.height + '%' }} aria-label={name + ' CLI'} role="region">
    <div className="sa-cli-resize" role="separator" aria-orientation="horizontal" aria-label="Resize CLI" onPointerDown={drag} onDoubleClick={() => props.onHeight(42)} />
    {props.owned
      ? <NativeCliPane {...props.runtime} resourceId={props.conversation} focusToken={focusToken} onHide={props.onHide} onChat={props.onReturnToChat} />
      : <div className="native-cli-pane sa-cli-live">
        <header>
          <span className="sa-cli-title"><TerminalSquare size={13} aria-hidden="true" /> {name} · {props.starting ? 'Opening the native CLI…' : native ? 'Live activity, read-only while Chat has this conversation' : 'Live activity (a local model has no native CLI)'}</span>
          <span className="sa-spacer" />
          {native && <button type="button" disabled={!props.idle || props.starting} title={props.idle ? 'Continue this conversation in the native CLI, here under the chat' : 'Available once the running turn settles'} onClick={props.onOpenNative}><TerminalSquare size={13} /> Open native CLI</button>}
          <button type="button" aria-label="Hide CLI" title="Hide the CLI" onClick={props.onHide}><ChevronDown size={14} /></button>
        </header>
        <LiveActivityTerminal sessionId={props.conversation} since={props.since} visible={props.open} />
      </div>}
  </div>
}
