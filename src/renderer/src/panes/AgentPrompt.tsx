import { useEffect, useRef, useState } from 'react'
import { Bot, Check, ChevronUp, Hand, ListTree, Mic, PencilLine, Send, Sparkles, Zap } from 'lucide-react'
import type { AgentEffort } from '../../../shared/models'

export type AgentPromptMode = 'manual' | 'edit' | 'plan' | 'auto'

interface AgentPromptProps {
  resourceId: string
  providerId: string
  providerName: string
  disabled?: boolean
  disabledReason?: string
  limitedUntil?: string
  model: string
  models: Array<{ id: string; label: string }>
  effort: AgentEffort
  efforts: Array<{ id: AgentEffort; label: string }>
  onModel(model: string): void | Promise<void>
  onEffort(effort: AgentEffort): void | Promise<void>
  onSubmit(message: string, mode: AgentPromptMode): void | Promise<void>
  onVoiceInput?(): void
}

const modes: Array<{ id: AgentPromptMode; label: string; detail: string; icon: typeof Hand }> = [
  { id: 'manual', label: 'Manual', detail: 'Ask before edits or commands', icon: Hand },
  { id: 'edit', label: 'Edit', detail: 'Implement with runtime approvals', icon: PencilLine },
  { id: 'plan', label: 'Plan', detail: 'Explore and plan without editing', icon: ListTree },
  { id: 'auto', label: 'Auto', detail: 'Proceed within granted permissions', icon: Zap }
]

export function AgentPrompt(props: AgentPromptProps): React.JSX.Element {
  // A user's preferred working mode is a provider habit, not a conversation
  // detail. New tabs of the same provider should inherit it immediately.
  const storageKey = `conductor.agentPromptMode.provider.${props.providerId}`
  const [mode, setMode] = useState<AgentPromptMode>(() => {
    const saved = localStorage.getItem(storageKey)
    return modes.some((item) => item.id === saved) ? saved as AgentPromptMode : 'edit'
  })
  const [message, setMessage] = useState('')
  const [modeOpen, setModeOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const effortOptions = props.efforts.length > 0
    ? props.efforts
    : [{ id: 'auto' as AgentEffort, label: 'Provider default' }]
  const selectedEffortIndex = Math.max(0, effortOptions.findIndex((option) => option.id === props.effort))
  const [effortIndex, setEffortIndex] = useState(selectedEffortIndex)
  const effortIndexRef = useRef(selectedEffortIndex)
  const committedEffortRef = useRef(props.effort)
  const selectedMode = modes.find((item) => item.id === mode) ?? modes[1]!
  const selectedEffort = effortOptions[effortIndex] ?? effortOptions[0]!
  const effortProgress = effortOptions.length > 1 ? effortIndex / (effortOptions.length - 1) * 100 : 0

  useEffect(() => {
    effortIndexRef.current = selectedEffortIndex
    committedEffortRef.current = props.effort
    setEffortIndex(selectedEffortIndex)
  }, [props.effort, selectedEffortIndex])

  useEffect(() => {
    if (!modeOpen) return
    const close = (event: MouseEvent): void => {
      if (!hostRef.current?.contains(event.target as Node)) setModeOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [modeOpen])

  const submit = async (): Promise<void> => {
    const normalized = message.trim()
    if (!normalized || props.disabled || submitting) return
    setSubmitting(true)
    try {
      await props.onSubmit(normalized, mode)
      setMessage('')
    } catch (error) {
      window.dispatchEvent(new CustomEvent('conductor:toast', {
        detail: error instanceof Error ? error.message : 'The message could not be submitted'
      }))
    } finally {
      setSubmitting(false)
    }
  }

  const previewEffort = (index: number): void => {
    effortIndexRef.current = index
    setEffortIndex(index)
  }

  const commitEffort = (): void => {
    const option = effortOptions[effortIndexRef.current]
    if (option && option.id !== committedEffortRef.current) {
      committedEffortRef.current = option.id
      void props.onEffort(option.id)
    }
  }

  return (
    <div className="agent-prompt" ref={hostRef}>
      {props.limitedUntil && (
        <div className="agent-prompt-limit">
          <Sparkles size={13} /> Usage window reopens {new Date(props.limitedUntil).toLocaleString()}
        </div>
      )}
      <div className="agent-prompt-surface">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={props.disabledReason ?? `Message ${props.providerName}`}
          aria-label={`Message ${props.providerName}`}
          disabled={props.disabled}
          rows={1}
        />
        <div className="agent-prompt-controls">
          <div className="agent-mode-control">
            <button className={`agent-mode-button mode-${mode}`} onClick={() => setModeOpen((value) => !value)} title="Choose how the agent should approach this message">
              <selectedMode.icon size={15} />
              <span>{selectedMode.label}</span>
              <ChevronUp className={modeOpen ? 'open' : ''} size={13} />
            </button>
            {modeOpen && (
              <div className="agent-mode-menu">
                <header><Bot size={14} /> Message mode</header>
                {modes.map(({ id, label, detail, icon: Icon }) => (
                  <button key={id} className={id === mode ? 'active' : ''} onClick={() => {
                    setMode(id)
                    localStorage.setItem(storageKey, id)
                    setModeOpen(false)
                  }}>
                    <Icon size={16} />
                    <span><strong>{label}</strong><small>{detail}</small></span>
                    {id === mode && <Check size={15} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="agent-prompt-model" title="Changing model restarts this provider session">
            <span>Model</span>
            <select value={props.model} onChange={(event) => void props.onModel(event.target.value)}>
              {!props.models.some((model) => model.id === props.model) && <option value={props.model}>{props.model}</option>}
              {props.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
          <label className="agent-prompt-effort" title={`Reasoning effort: ${selectedEffort.label}. Changing it restarts this provider session.`}>
            <span className="agent-effort-heading"><span>Effort</span><output>{selectedEffort.label}</output></span>
            <span
              className="agent-effort-slider"
              style={{ '--effort-progress': `${effortProgress}%` } as React.CSSProperties}
            >
              <span className="agent-effort-ticks" aria-hidden="true">
                {effortOptions.map((option, index) => <i className={index <= effortIndex ? 'active' : ''} key={option.id} />)}
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0, effortOptions.length - 1)}
                step={1}
                value={effortIndex}
                disabled={effortOptions.length < 2}
                aria-label="Reasoning effort"
                aria-valuetext={selectedEffort.label}
                onChange={(event) => previewEffort(Number(event.target.value))}
                onPointerUp={commitEffort}
                onKeyUp={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitEffort()
                }}
                onBlur={commitEffort}
              />
            </span>
          </label>
          <span className="agent-prompt-spacer" />
          <button className="agent-voice-button" disabled={!props.onVoiceInput} onClick={props.onVoiceInput} title={props.onVoiceInput ? 'Dictate message' : 'Voice input unavailable'}><Mic size={17} /></button>
          <button className="agent-send-button" disabled={!message.trim() || props.disabled || submitting} onClick={() => void submit()} title="Send message (Enter)"><Send size={17} /></button>
        </div>
      </div>
    </div>
  )
}
