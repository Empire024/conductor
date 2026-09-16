import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Eye, Hand, ListTree, PencilLine, ShieldCheck, Zap } from 'lucide-react'
import type { SessionSettings } from '../../../shared/structured-agent'
import type { conversationModes } from './composer-settings'
import './ConversationModeControl.css'

const descriptions: Record<string, string> = {
  default: 'Ask before actions that require permission.',
  auto: 'Let Claude evaluate which actions can proceed automatically.',
  'accept-edits': 'Allow file edits; ask for other actions when needed.',
  'read-only': 'Inspect the workspace without making changes.',
  edit: 'Work on the task and make changes.',
  plan: 'Explore and plan before implementing changes.'
}
const modeIcons: Record<string, typeof ShieldCheck> = { default: Hand, auto: Zap, 'accept-edits': PencilLine, 'read-only': Eye, edit: PencilLine, plan: ListTree }
export function ConversationModeControl({ modes, value, disabled, onChange }: {
  modes: ReturnType<typeof conversationModes>; value: string; disabled: boolean
  onChange(change: Partial<SessionSettings>): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const selected = modes.find(mode => mode.id === value)
  const SelectedIcon = modeIcons[value] ?? ShieldCheck
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    host.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const outside = (event: PointerEvent): void => { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <div className="sa-mode-picker" ref={host} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={trigger} type="button" className="sa-mode-trigger" aria-label="Conversation mode" aria-haspopup="menu" aria-controls={id} aria-expanded={open} disabled={disabled} title={descriptions[value]} onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}><SelectedIcon size={14} aria-hidden="true" /><span>{selected?.label ?? 'Choose mode'}</span><ChevronDown size={11} /></button>
    {open && <div className="sa-mode-menu" id={id} role="menu" aria-label="Conversation mode" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = [...host.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
        buttons[next]?.focus()
      }
    }}><p>Mode for your next message</p>{modes.map(mode => { const Icon = modeIcons[mode.id] ?? ShieldCheck; return <button key={mode.id} type="button" role="menuitemradio" aria-checked={value === mode.id} onClick={() => { onChange(mode.change); close() }}><Icon size={16} aria-hidden="true" /><span><strong>{mode.label}</strong><small>{descriptions[mode.id]}</small></span><span className="sa-mode-check" aria-hidden="true">{value === mode.id && <Check size={14} />}</span></button> })}</div>}
  </div>
}
