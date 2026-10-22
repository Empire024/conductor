import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { PendingSteering, QueuedPrompt } from '../../../shared/structured-agent'
import { messageSenderOf } from '../../../shared/message-sender'
import { ConversationLink, SenderBadge, type MessagePeer } from './AgentMessageCards'

/** The owner's own queued messages; what other conversations or Conductor queued is drawn apart. */
export const ownQueued = <T extends QueuedPrompt>(prompts: T[]): T[] => prompts.filter(prompt => messageSenderOf(prompt).kind === 'owner')
export const incomingQueued = <T extends QueuedPrompt>(prompts: T[]): T[] => prompts.filter(prompt => messageSenderOf(prompt).kind !== 'owner')

export function queuedShortcutTarget(event: Pick<KeyboardEvent, 'key' | 'altKey'>, prompts: QueuedPrompt[]): QueuedPrompt | null {
  return event.altKey && event.key === 'Backspace' ? ownQueued(prompts).at(-1) ?? null : null
}

export function QueuedMessageList(props: { prompts: QueuedPrompt[]; onRemove(prompt: QueuedPrompt): void }): React.JSX.Element | null {
  useEffect(() => {
    const removeLast = (event: KeyboardEvent): void => {
      const prompt = queuedShortcutTarget(event, props.prompts)
      if (!prompt) return
      event.preventDefault()
      props.onRemove(prompt)
    }
    window.addEventListener('keydown', removeLast)
    return () => window.removeEventListener('keydown', removeLast)
  }, [props.prompts, props.onRemove])

  const own = ownQueued(props.prompts)
  if (!own.length) return null
  return <div className="sa-queue-list" aria-label="Queued messages">{own.map((prompt, index) => <div className="sa-queue" key={prompt.id}>
    <strong>Queued {index + 1}</strong><span title={prompt.text}>{prompt.text}</span>{prompt.attachments.length > 0 && <small>{prompt.attachments.length} attached</small>}
    <button type="button" title="Return queued message to draft" aria-label={'Remove queued message ' + (index + 1)} onClick={() => props.onRemove(prompt)}><X size={12} /></button>
  </div>)}</div>
}

const incomingStatus = (prompt: QueuedPrompt | PendingSteering): string => {
  if (!('status' in prompt)) return 'Arrives when this turn ends'
  if (prompt.status === 'sending') return 'Being delivered into the running turn'
  if (prompt.status === 'accepted') return 'Reaches the agent after its next tool use'
  if (prompt.status === 'cancelled') return 'The turn stopped before the agent took it; not delivered'
  return 'Delivery was never confirmed'
}

/** Messages from other conversations, Conductor or a paired machine that wait for this
 *  conversation: never numbered with, styled like, or restored into the owner's queue. Removing
 *  one drops it; it never lands in the owner's draft. */
export function IncomingMessageList(props: { prompts: Array<QueuedPrompt | PendingSteering>; projectId?: string; onDismiss(prompt: QueuedPrompt | PendingSteering): void; onFocusOrigin?(origin: { agentSessionId: string; label: string }): void }): React.JSX.Element | null {
  if (!props.prompts.length) return null
  return <div className="sa-incoming-list" aria-label="Incoming messages from agents">{props.prompts.map(prompt => {
    const sender = messageSenderOf(prompt)
    const kind = sender.kind === 'owner' ? 'agent' : sender.kind
    const peer: MessagePeer = { ...(sender.agentSessionId ? { agentSessionId: sender.agentSessionId } : {}), title: sender.label, kind }
    return <div className={'sa-incoming-pending sa-incoming-card-' + kind} key={prompt.id} data-sender-kind={kind}>
      <div className="sa-incoming-pending-head"><SenderBadge kind={kind} /><span className="sa-incoming-from">from</span> <ConversationLink peer={peer} projectId={props.projectId} onFocusOrigin={props.onFocusOrigin} /><small role="status">{incomingStatus(prompt)}</small>
        {(!('status' in prompt) || prompt.status === 'cancelled' || prompt.status === 'uncertain') && <button type="button" title="Drop this incoming message (it is not put in your draft)" aria-label={'Drop incoming message from ' + sender.label} onClick={() => props.onDismiss(prompt)}><X size={12} /></button>}
      </div>
      <span className="sa-incoming-pending-text" title={prompt.text}>{prompt.text}</span>
    </div>
  })}</div>
}
