import { modelEfforts } from '../../../shared/model-effort'
import { ProviderIcon } from '../components/ProviderIcon'
import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, Search } from 'lucide-react'
import type { ProviderCapabilities, SessionSettings } from '../../../shared/structured-agent'
import './AgentPrompt.css'

export function StructuredComposerControls({ settings, capabilities, disabled, onChange, onDiscover }: {
  settings: SessionSettings
  capabilities?: ProviderCapabilities
  disabled: boolean
  onChange(change: Partial<SessionSettings>): void
  onDiscover(): Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const models = capabilities?.models ?? []
  const model = settings.model && settings.model !== 'default' ? settings.model : ''
  const label = models.find(option => option.id === model)?.label ?? (model || 'Default')
  const choices = [{ id: '', label: 'Default' }, ...models.filter(option => option.id !== 'default')]
    .filter(option => (option.label + ' ' + option.id).toLowerCase().includes(query.toLowerCase()))
  const supportedEfforts = modelEfforts(capabilities, settings.model)
  const efforts = ['', ...(supportedEfforts ?? []).filter(value => value && value !== 'auto')]
  const unavailableEffort = Boolean(capabilities && settings.effort && settings.effort !== 'auto' && !efforts.includes(settings.effort))
  const effortIndex = Math.max(0, efforts.indexOf(settings.effort ?? ''))
  const effortLabel = unavailableEffort ? 'Unavailable: ' + settings.effort : (efforts[effortIndex] || 'Auto').replace(/^./, char => char.toUpperCase())
  const close = (): void => { setOpen(false); setQuery(''); trigger.current?.focus() }
  const chooseModel = (id: string): void => {
    const supported = modelEfforts(capabilities, id)
    onChange({ model: id || undefined, ...(supported && settings.effort && !supported.includes(settings.effort) ? { effort: undefined } : {}) })
    close()
  }
  useEffect(() => {
    if (supportedEfforts?.length === 0 && settings.effort) onChange({ effort: undefined })
  }, [supportedEfforts, settings.effort, onChange])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const show = async (): Promise<void> => {
    if (open) { close(); return }
    setOpen(true); setQuery(''); setError('')
    if (models.length) return
    setLoading(true)
    try { await onDiscover() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }

  return <>
    <div className="sa-model-control" ref={host}>
      <button ref={trigger} type="button" role="combobox" aria-label="Model" aria-controls={listId} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} className="sa-model-trigger" title="Choose model" onClick={() => void show()} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); void show() } }}><ProviderIcon provider={capabilities?.provider} model={model} size={14} /><span>{label}</span><ChevronDown size={12} /></button>
      {open && <div className="sa-model-menu" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault(); event.stopPropagation()
          const option = choices[0]
          if (option) { chooseModel(option.id) }
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const options = [...host.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          const index = options.indexOf(document.activeElement as HTMLButtonElement)
          const next = index < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
          options[next]?.focus()
        }
      }}>
        <label className="sa-model-search"><Search size={13} /><input autoFocus aria-label="Search models" placeholder="Search models" value={query} onChange={event => setQuery(event.target.value)} /></label>
        {loading && <p className="sa-model-loading" role="status"><LoaderCircle size={13} className="spin" /> Loading models…</p>}
        {error && <p role="alert" className="sa-error">{error}</p>}
        <div id={listId} role="listbox" aria-label="Models">{choices.map(option => <button type="button" role="option" aria-selected={option.id === model} key={option.id} onClick={() => { chooseModel(option.id) }}><ProviderIcon provider={capabilities?.provider} model={option.id} size={14} /><span>{option.label}</span>{option.id === model && <Check size={13} />}</button>)}</div>
        {!loading && !error && !choices.length && <p className="sa-model-loading">No matching models</p>}
      </div>}
    </div>
    {efforts.length > 1 && unavailableEffort && <button className="sa-effort-unavailable" type="button" disabled={disabled} title="This saved effort is not in the current model catalog. Click to reset to Auto." onClick={() => onChange({ effort: undefined })}>{effortLabel}</button>}
    {efforts.length > 1 && !unavailableEffort && <label className="agent-prompt-effort sa-effort-control" title="Reasoning effort for your next message">
      <span className="agent-effort-heading"><span>Effort</span><output>{effortLabel}</output></span>
      <span className="agent-effort-slider" style={{ '--effort-progress': `${effortIndex / (efforts.length - 1) * 100}%` } as React.CSSProperties}>
        <span className="agent-effort-ticks" aria-hidden="true">{efforts.map((effort, index) => <i key={effort} className={index <= effortIndex ? 'active' : ''} />)}</span>
        <input type="range" min={0} max={efforts.length - 1} step={1} value={effortIndex} disabled={disabled} aria-label="Reasoning effort" aria-valuetext={effortLabel} onChange={event => onChange({ effort: efforts[Number(event.target.value)] || undefined })} />
      </span>
    </label>}
  </>
}
