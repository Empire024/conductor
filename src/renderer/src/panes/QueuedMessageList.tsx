import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { QueuedPrompt } from '../../../shared/structured-agent'

export function queuedShortcutTarget(event: Pick<KeyboardEvent, 'key' | 'altKey'>, prompts: QueuedPrompt[]): QueuedPrompt | null {
  return event.altKey && event.key === 'Backspace' ? prompts.at(-1) ?? null : null
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

  if (!props.prompts.length) return null
  return <div className="sa-queue-list" aria-label="Queued messages">{props.prompts.map((prompt, index) => <div className="sa-queue" key={prompt.id}>
    <strong>Queued {index + 1}</strong><span title={prompt.text}>{prompt.text}</span>{prompt.attachments.length > 0 && <small>{prompt.attachments.length} attached</small>}
    <button type="button" title="Return queued message to draft" aria-label={'Remove queued message ' + (index + 1)} onClick={() => props.onRemove(prompt)}><X size={12} /></button>
  </div>)}</div>
}
