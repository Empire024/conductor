import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Link2 } from 'lucide-react'
import type { AgentEventData, Json } from '../../../shared/structured-agent'
import { conversationLabel, findConversationRefs, focusDirectoryEntry, useConversationDirectory, type ConversationDirectory, type DirectoryEntry } from '../conversation-directory'

/**
 * Tab-to-tab messages as compact cards: "→ sent to <tab>" in the sender, "← from <tab>" in the
 * receiver, text collapsed until opened. Everything here is drawn from what the timelines already
 * store — a user turn's `origin`, a Conductor MCP tool call, the sender notice control-activity.ts
 * writes — and none of it is sent to any model.
 */
export interface MessagePeer { agentSessionId?: string; tabId?: string; title: string }
type ToolData = Extract<AgentEventData, { type: 'tool' }>

const record = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const str = (value: Json | undefined): string | undefined => typeof value === 'string' && value ? value : undefined

/** The Conductor messaging tools as each runtime names them: `mcp__conductor__send_message`
 *  (Claude), `conductor.send_message` or `conductor/send_message` (Codex, Grok). */
const MESSAGE_TOOL = /^(?:mcp__)?conductor(?:__|\.|\/|:)(send_message|submit_task|report|handoff)$/i
const METHODS: Record<string, string> = { send_message: 'agents.steer', submit_task: 'agents.submit', report: 'agents.report', handoff: 'agents.handoff' }

/** The id a tool's result names, from its JSON or, when the runtime wrapped it, from the text. */
function resultAgentId(output: string | undefined): string | undefined {
  if (!output) return undefined
  return /"agentSessionId"\s*:\s*"([A-Za-z0-9_-]{4,160})"/.exec(output)?.[1]
}

/** A successful Conductor MCP call that delivered text to another conversation, or null. */
export function mcpAgentMessageOf(tool: ToolData): { method: string; to: MessagePeer; text: string } | null {
  const kind = MESSAGE_TOOL.exec(tool.name)?.[1]?.toLowerCase()
  if (!kind || tool.status !== 'completed' || tool.exitCode !== undefined && tool.exitCode !== 0) return null
  const input = record(tool.input)
  const text = kind === 'handoff' ? str(input.handoff) : str(input.text)
  if (!text) return null
  // Report and handoff name no target: the controller, or the new tab, comes back in the result.
  const agentSessionId = kind === 'send_message' || kind === 'submit_task' ? str(input.agentSessionId) : resultAgentId(tool.output)
  if (tool.output && /"error"\s*:|^\s*(?:Error|MCP error)\b/i.test(tool.output) && !/"agentSessionId"/.test(tool.output)) return null
  return { method: METHODS[kind]!, to: { ...(agentSessionId ? { agentSessionId } : {}), title: kind === 'report' ? 'the controller' : kind === 'handoff' ? str(input.title) ?? 'the successor tab' : 'another tab' }, text }
}

/** A user turn that another conversation, or Conductor itself, sent; null for the owner's own. */
export function receivedMessagePeer(data: Extract<AgentEventData, { type: 'text' }>): MessagePeer | null {
  if (data.role !== 'user') return null
  if (data.origin) return data.origin.agentSessionId === 'owner' ? { title: data.origin.label } : { agentSessionId: data.origin.agentSessionId, title: data.origin.label }
  // Conductor's own relays (approvals, restarts) carry no origin, only this prefix.
  return /^\[Conductor\]\s/.test(data.text) ? { title: 'Conductor' } : null
}

export function peerEntry(directory: ConversationDirectory, peer: MessagePeer): DirectoryEntry | null {
  return (peer.agentSessionId ? directory.byAgent.get(peer.agentSessionId) : undefined) ?? (peer.tabId ? directory.byTab.get(peer.tabId) : undefined) ?? null
}

const reportFocusError = (reason: unknown): void => console.warn('The linked tab could not be shown', reason)

/** The name of another tab, as a control that brings it into view; plain text when it is not open. */
export function ConversationLink({ peer, projectId, onFocusOrigin }: { peer: MessagePeer; projectId?: string; onFocusOrigin?(origin: { agentSessionId: string; label: string }): void }): React.JSX.Element {
  const directory = useConversationDirectory()
  const entry = peerEntry(directory, peer)
  const label = entry ? conversationLabel(entry, projectId) : peer.title
  // A tab closed since the message still has a durable id, which can restore it.
  const origin = peer.agentSessionId
  const focus = entry ? () => void focusDirectoryEntry(entry).catch(reportFocusError) : origin ? () => onFocusOrigin ? onFocusOrigin({ agentSessionId: origin, label: peer.title }) : void window.conductor.agentControl.focusOrigin(origin).catch(reportFocusError) : null
  if (!focus) return <span className="sa-conversation-name">{label}</span>
  return <button type="button" className="sa-role-coordinated sa-conversation-link" title={'Show ' + label + ' tab'} aria-label={'Show ' + (entry?.title ?? peer.title) + ' tab'} data-agent-session={peer.agentSessionId} onClick={event => { event.preventDefault(); event.stopPropagation(); focus() }}><Link2 size={11} />{label}</button>
}

const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/).find(entry => entry.trim())?.trim() ?? ''
  return line.length > 140 ? line.slice(0, 139) + '…' : line
}

export function AgentMessageCard({ direction, peer, text, method, characters, projectId, onFocusOrigin, children }: { direction: 'sent' | 'received'; peer: MessagePeer; text: string; method?: string; characters?: number; projectId?: string; onFocusOrigin?(origin: { agentSessionId: string; label: string }): void; children: ReactNode }): React.JSX.Element {
  const Arrow = direction === 'sent' ? ArrowRight : ArrowLeft
  const truncated = characters !== undefined && characters > text.length
  return <details className={'sa-agent-message sa-agent-message-' + direction} data-direction={direction} data-peer={peer.agentSessionId ?? peer.title}>
    <summary>
      <span className="sa-agent-message-head"><Arrow size={12} aria-hidden="true" />{direction === 'sent' ? 'sent to' : 'from'} <ConversationLink peer={peer} projectId={projectId} onFocusOrigin={onFocusOrigin} />{method && <small>{method}</small>}</span>
      <span className="sa-agent-message-preview">{firstLine(text)}</span>
    </summary>
    <div className="sa-agent-message-body">{children}{truncated && <p className="sa-muted">First {text.length.toLocaleString()} of {characters!.toLocaleString()} characters; the receiving tab holds the whole message.</p>}</div>
  </details>
}

/** Plain text (a notice, a one-line tool preview) with every id of an open tab made a link. */
export function LinkedText({ text, projectId }: { text: string; projectId?: string }): React.JSX.Element {
  const directory = useConversationDirectory()
  const refs = findConversationRefs(text, directory)
  if (!refs.length) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  for (const ref of refs) {
    if (ref.start < cursor) continue
    if (ref.start > cursor) parts.push(text.slice(cursor, ref.start))
    const entry = ref.entry
    parts.push(<a key={ref.start} href="#" className="sa-conversation-ref" title={'Show ' + conversationLabel(entry, projectId)} onClick={event => { event.preventDefault(); event.stopPropagation(); void focusDirectoryEntry(entry).catch(reportFocusError) }}>{ref.raw}</a>)
    cursor = ref.start + ref.raw.length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

