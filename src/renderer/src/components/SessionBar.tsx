import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bell, Check, Command, LayoutPanelTop, LayoutTemplate, Plus, Save, TimerReset, Undo2, X } from 'lucide-react'
import type { LayoutTemplateRecord, SessionRecord } from '../../../shared/models'
import { WorkspaceSessionMenu } from './WorkspaceSessionMenu'

interface SessionBarProps {
  sessions: SessionRecord[]
  activeId: string
  canReopen: boolean
  canRestoreWorkspace: boolean
  onRestoreWorkspace(): void
  templates: LayoutTemplateRecord[]
  onSelect(id: string): void
  onNew(): void
  onClose(id: string): void | Promise<void>
  onRename(id: string, name: string): void
  onReopen(): void
  onPalette(): void
  onSaveTemplate(name: string): void
  onApplyTemplate(template: LayoutTemplateRecord): void
  continueOnLimit: boolean
  attentionIds: ReadonlySet<string>
  saveStatus: 'saved' | 'saving' | 'unsaved' | 'error'
  lastSavedAt: number | null
  onSave(): void
  onContinuation(enabled: boolean): void
}

const TAB_ANIMATION_MS = 110

export function SessionBar(props: SessionBarProps): React.JSX.Element {
  const [workspaceMenu, setWorkspaceMenu] = useState<{ session?: SessionRecord; x: number; y: number } | null>(null)
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const layoutsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!layoutsOpen) return
    const outside = (event: PointerEvent): void => { if (!layoutsRef.current?.contains(event.target as Node)) setLayoutsOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setLayoutsOpen(false) } }
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true) }
  }, [layoutsOpen])
  const [layoutName, setLayoutName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [closingIds, setClosingIds] = useState<Set<string>>(() => new Set())
  const [openingIds, setOpeningIds] = useState<Set<string>>(() => new Set())
  const knownIdsRef = useRef(new Set(props.sessions.map((session) => session.id)))
  const renameInputRef = useRef<HTMLInputElement>(null)
  const lastSavedLabel = props.lastSavedAt
    ? new Date(props.lastSavedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })
    : 'Not saved in this window yet'
  const saveLabel = props.saveStatus === 'saving'
    ? 'saving'
    : props.saveStatus === 'unsaved'
      ? 'unsaved'
      : props.saveStatus === 'error' ? 'retry save' : 'autosaved'
  const saveTooltip = props.saveStatus === 'error'
    ? 'Save failed. Click to retry.'
    : `${props.saveStatus === 'saving' ? 'Saving now' : `Last saved ${lastSavedLabel}`}. Click to save now.`

  const startRename = (session: SessionRecord): void => {
    setEditingId(session.id)
    setEditingName(session.name)
  }

  const finishRename = (save: boolean): void => {
    if (!editingId) return
    const session = props.sessions.find((item) => item.id === editingId)
    const nextName = editingName.trim()
    if (save && session && nextName && nextName !== session.name) props.onRename(editingId, nextName)
    setEditingId(null)
  }

  useEffect(() => {
    if (!editingId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [editingId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F2' || editingId) return
      const active = props.sessions.find((session) => session.id === props.activeId)
      if (!active) return
      event.preventDefault()
      startRename(active)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editingId, props.activeId, props.sessions])

  useLayoutEffect(() => {
    const nextIds = new Set(props.sessions.map((session) => session.id))
    const addedIds = props.sessions
      .map((session) => session.id)
      .filter((id) => !knownIdsRef.current.has(id))
    knownIdsRef.current = nextIds
    setOpeningIds((current) => addedIds.length || current.size ? new Set(addedIds) : current)
    if (addedIds.length === 0) return
    const timer = window.setTimeout(() => setOpeningIds(new Set()), TAB_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [props.sessions])

  const requestClose = (id: string): void => {
    if (closingIds.has(id)) return
    setClosingIds((current) => new Set(current).add(id))
    window.setTimeout(() => { void Promise.resolve(props.onClose(id)).finally(() => setClosingIds((current) => { const next = new Set(current); next.delete(id); return next })) }, TAB_ANIMATION_MS)
  }
  return (
    <div className="session-bar">{workspaceMenu && <WorkspaceSessionMenu x={workspaceMenu.x} y={workspaceMenu.y} canRestore={props.canRestoreWorkspace} onRename={workspaceMenu.session ? () => startRename(workspaceMenu.session!) : undefined} onNew={props.onNew} onRestore={props.onRestoreWorkspace} onCloseWorkspace={workspaceMenu.session ? () => requestClose(workspaceMenu.session!.id) : undefined} onDismiss={() => setWorkspaceMenu(null)} />}
      <div className="session-tabs" onContextMenu={event => { event.preventDefault(); setWorkspaceMenu({ x: event.clientX, y: event.clientY }) }}>
        {props.sessions.map((session) => (
          <button
            key={session.id}
            className={`session-tab ${session.id === props.activeId ? 'active' : ''} ${props.attentionIds.has(session.id) ? 'needs-attention' : ''} ${session.continueOnLimit ? 'limit-active' : ''} ${openingIds.has(session.id) ? 'opening' : ''} ${closingIds.has(session.id) ? 'closing' : ''}`}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setWorkspaceMenu({ session, x: event.clientX, y: event.clientY }) }}
            onClick={() => props.onSelect(session.id)}
            onDoubleClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              startRename(session)
            }}
            onPointerDown={(event) => {
              if (event.button !== 1) return
              event.preventDefault()
              event.stopPropagation()
              requestClose(session.id)
            }}
            onAuxClick={(event) => event.preventDefault()}
            data-autoscroll="off"
          >
            <span className="session-tab-glyph"><LayoutPanelTop size={14} strokeWidth={1.8} /></span>
            {editingId === session.id ? (
              <input
                ref={renameInputRef}
                className="session-tab-rename"
                value={editingName}
                aria-label="Workspace name"
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(event) => setEditingName(event.target.value)}
                onBlur={() => finishRename(true)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') finishRename(true)
                  if (event.key === 'Escape') finishRename(false)
                }}
              />
            ) : <span className="session-tab-name">{session.name}</span>}
            {props.attentionIds.has(session.id) && (
              <span className="session-attention-badge" title="An agent in this workspace needs your attention">
                <Bell size={11} strokeWidth={1.7} />
              </span>
            )}
            {session.continueOnLimit && (
              <span className="session-limit-badge" title="Agents auto-continue when limits reset">
                <TimerReset size={13} />
              </span>
            )}
            {session.id === props.activeId && <span className="unsaved-indicator" />}
            <i
              className="session-tab-close"
              role="button"
              title="Close workspace"
              onClick={(event) => {
                event.stopPropagation()
                requestClose(session.id)
              }}
            ><X size={11} /></i>
          </button>
        ))}
        <button className="session-add" onClick={props.onNew} title="New workspace">
          <Plus size={14} />
        </button>
      </div>
      <div className="session-actions">
        <div className="layout-selector" ref={layoutsRef}>
          <button onClick={() => setLayoutsOpen((value) => !value)} title="Named layouts">
            <LayoutTemplate size={13} /> Layouts
          </button>
          {layoutsOpen && (
            <div className="layout-popover">
              <strong>Named layouts</strong>
              <div className="layout-save-row">
                <input
                  value={layoutName}
                  onChange={(event) => setLayoutName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && layoutName.trim()) {
                      props.onSaveTemplate(layoutName)
                      setLayoutName('')
                    }
                  }}
                  placeholder="Save current as..."
                />
                <button
                  disabled={!layoutName.trim()}
                  onClick={() => { props.onSaveTemplate(layoutName); setLayoutName('') }}
                ><Save size={12} /></button>
              </div>
              <div className="layout-list">
                {props.templates.length === 0 && <span>No saved layouts yet</span>}
                {props.templates.map((template) => (
                  <button key={template.id} onClick={() => { props.onApplyTemplate(template); setLayoutsOpen(false) }}>
                    <LayoutTemplate size={13} /><span>{template.name}</span><Check size={11} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <button
          className={props.continueOnLimit ? 'continuation-toggle active' : 'continuation-toggle'}
          disabled={!props.activeId}
          onClick={() => props.onContinuation(!props.continueOnLimit)}
          title={props.continueOnLimit ? 'Limit continuation is on for this workspace' : 'Continue agents when their usage limit resets'}
          aria-label={props.continueOnLimit ? 'Disable automatic limit continuation' : 'Enable automatic limit continuation'}
          aria-pressed={props.continueOnLimit}
        >
          <TimerReset size={16} />
        </button>
        <button disabled={!props.canReopen} onClick={props.onReopen} title="Reopen closed tab">
          <Undo2 size={14} />
        </button>
        <button
          className={`persist-state ${props.saveStatus}`}
          data-tooltip={saveTooltip}
          onClick={props.onSave}
          aria-label={saveTooltip}
        ><Save size={12} /> {saveLabel}</button>
        <button className="command-button" onClick={props.onPalette}>
          <Command size={13} /> Commands <kbd>Ctrl Shift P</kbd>
        </button>
      </div>
    </div>
  )
}
