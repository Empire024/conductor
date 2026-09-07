import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowDown, ArrowLeft, CircleStop, FilePlus2, History, ListTree, Send, Settings2, X } from 'lucide-react'
import type { AgentSpec, AgentActivityPhase } from '../../../shared/models'
import type { AgentEvent, ContextAttachment, FileChange, Json, SessionProjection, SessionSettings, TimelineItem } from '../../../shared/structured-agent'
import { emptyProjection, projectAgentEvent } from '../../../shared/structured-agent-reducer'
import type { RuntimeTerminalProps } from './RuntimeTerminal'
import { AgentDialog, ImmutableDiff, safeFileTarget, StructuredActivity } from './StructuredAgentRenderers'
import './StructuredAgentPane.css'

let focusedAgent: { sessionId: string; projectId: string } | null = null
export function dispatchAgentContext(projectId: string, attachment: ContextAttachment): boolean {
  if (!focusedAgent || focusedAgent.projectId !== projectId) {
    window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Focus a Claude or Codex conversation in this project, then attach context.' }))
    return false
  }
  window.dispatchEvent(new CustomEvent('conductor:agent-context', { detail: { projectId, sessionId: focusedAgent.sessionId, attachment } }))
  return true
}
function storedExpansion(id: string): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem('conductor.structured.expansion.' + id) ?? '{}') as Record<string, boolean> } catch { return {} }
}
const activePhases = new Set(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
const displayPhase = (phase: string): string => phase === 'waiting_approval' ? 'Waiting for approval' : phase === 'waiting_input' ? 'Waiting for your answer' : phase.replaceAll('_', ' ')

export function StructuredAgentPane(props: RuntimeTerminalProps): React.JSX.Element {
  const [activeId, setActiveId] = useState(props.resourceId)
  const [historical, setHistorical] = useState(false)
  const [projection, setProjection] = useState<SessionProjection>(() => emptyProjection(props.resourceId))
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [settings, setSettings] = useState<SessionSettings>({ permission: 'default', plan: false, model: props.model, effort: props.effort === 'auto' ? undefined : props.effort })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expansion, setExpansion] = useState<Record<string, boolean>>(() => storedExpansion(props.resourceId))
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({})
  const [inspectAttachment, setInspectAttachment] = useState<ContextAttachment | null>(null)
  const [addFileOpen, setAddFileOpen] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [diff, setDiff] = useState<FileChange | null>(null)
  const [eventsOpen, setEventsOpen] = useState(false)
  const [rawEvents, setRawEvents] = useState<AgentEvent[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyItems, setHistoryItems] = useState<Awaited<ReturnType<typeof window.conductor.structured.history>>>([])
  const [rename, setRename] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<Json | undefined>(undefined)
  const [newOutput, setNewOutput] = useState(false)
  const [visibleCount, setVisibleCount] = useState(250)
  const [readingWindow, setReadingWindow] = useState<TimelineItem[] | null>(null)
  const lastVisibleItems = useRef<TimelineItem[]>([])
  const timeline = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const priorSequence = useRef(0)
  const submitLock = useRef(false)
  const provider = props.provider === 'claude' ? 'claude' : 'codex'
  const name = (projection.capabilities?.provider ?? provider) === 'claude' ? 'Claude Code' : 'Codex'
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    let disposed = false
    let initialized = false
    let queue: AgentEvent[] = []
    let frame = 0
    setReady(false)
    setError('')
    setProjection(emptyProjection(activeId))
    setExpansion(storedExpansion(activeId))
    setVisibleCount(250)
    setReadingWindow(null)
    lastVisibleItems.current = []
    priorSequence.current = 0
    nearBottom.current = true
    const flush = (): void => {
      frame = 0
      if (!initialized || disposed) return
      const events = queue
      queue = []
      setProjection((current) => events.reduce(projectAgentEvent, current))
    }
    // Subscribe first, then merge events received while reading the durable snapshot.
    const off = window.conductor.structured.onEvents((events) => {
      if (disposed) return
      queue.push(...events.filter((event) => event.sessionId === activeId))
      if (initialized && queue.length && !frame) frame = requestAnimationFrame(flush)
    })
    const initialize = async (): Promise<void> => {
      if (activeId === propsRef.current.resourceId) {
        const current = propsRef.current
        const spec: AgentSpec = { id: activeId, projectId: current.project.id, sessionId: current.session.id, title: current.title, cwd: current.project.path, provider, model: current.model ?? 'default', effort: current.effort ?? 'auto', continueOnLimit: current.continueOnLimit }
        await window.conductor.agents.ensure(spec)
      }
      const snapshot = await window.conductor.structured.snapshot(activeId)
      if (disposed) return
      const state = queue.reduce(projectAgentEvent, snapshot ?? emptyProjection(activeId))
      queue = []
      initialized = true
      setProjection(state)
      if (snapshot) setSettings(snapshot.settings)
      setReady(true)
    }
    void initialize().catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true; off(); if (frame) cancelAnimationFrame(frame) }
  }, [activeId, provider])

  useEffect(() => {
    const phase: AgentActivityPhase = projection.phase === 'waiting_approval' || projection.phase === 'waiting_input' ? 'waiting_input' : projection.phase === 'running' || projection.phase === 'starting' || projection.phase === 'interrupting' ? 'working' : projection.phase === 'failed' || projection.phase === 'disconnected' ? 'error' : projection.phase === 'completed' ? 'complete' : 'idle'
    window.dispatchEvent(new CustomEvent('conductor:agent-activity', { detail: { id: activeId, phase } }))
  }, [activeId, projection.phase])

  useLayoutEffect(() => {
    const selection = window.getSelection()
    if (selection?.toString() && !readingWindow && lastVisibleItems.current.length) {
      // Pin the committed window before a new batch can evict selected DOM nodes.
      setReadingWindow(lastVisibleItems.current)
    }
    if (nearBottom.current && !selection?.toString() && !readingWindow) {
      if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight
    } else if (projection.sequence > priorSequence.current) setNewOutput(true)
    priorSequence.current = projection.sequence
  }, [projection.sequence])

  useEffect(() => {
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId: string; sessionId: string; attachment: ContextAttachment }>).detail
      if (detail.projectId !== props.project.id || detail.sessionId !== activeId || historical) return
      setAttachments((current) => [...current.filter((item) => item.id !== detail.attachment.id), detail.attachment].slice(-20))
    }
    window.addEventListener('conductor:agent-context', receive)
    return () => window.removeEventListener('conductor:agent-context', receive)
  }, [activeId, props.project.id, historical])

  useEffect(() => {
    const pinSelection = (): void => {
      const selection = window.getSelection()
      if (!selection?.toString() || !timeline.current?.contains(selection.anchorNode)) return
      setReadingWindow((current) => current ?? lastVisibleItems.current)
    }
    document.addEventListener('selectionchange', pinSelection)
    return () => document.removeEventListener('selectionchange', pinSelection)
  }, [activeId])

  useEffect(() => {
    if (!historyOpen) return
    let disposed = false
    const timer = window.setTimeout(() => void window.conductor.structured.history(props.project.id, historyQuery).then((items) => { if (!disposed) setHistoryItems(items) }).catch((reason: unknown) => { if (!disposed) setError(String(reason)) }), 120)
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [historyOpen, historyQuery, props.project.id, projection.title, projection.archived])

  useEffect(() => {
    if (!eventsOpen) return
    void window.conductor.structured.events(activeId).then((events) => setRawEvents(events.slice(-200))).catch((reason: unknown) => setError(String(reason)))
  }, [activeId, eventsOpen, projection.phase])

  const onOpenFile = useCallback((raw: string, line?: number): void => {
    const current = propsRef.current
    const target = safeFileTarget(raw, current.project.path)
    if (!target) { setError('The file link is outside this workspace or has an invalid path.'); return }
    void window.conductor.files.read(current.project.id, target.path).then(() => current.onOpenFile?.(target.path, line ?? target.line)).catch((reason: unknown) => setError('Cannot open current file: ' + (reason instanceof Error ? reason.message : String(reason))))
  }, [])
  const onExpand = useCallback((id: string): void => {
    setExpansion((current) => {
      const next = { ...current, [id]: current[id] === false }
      const retained = Object.fromEntries(Object.entries(next).slice(-500))
      localStorage.setItem('conductor.structured.expansion.' + activeId, JSON.stringify(retained))
      return retained
    })
  }, [activeId])
  const onRespond = useCallback(async (item: TimelineItem, decision?: string, answers?: Record<string, string[]>): Promise<void> => {
    if (item.data.type !== 'interaction') return
    await window.conductor.structured.respond({ sessionId: activeId, runtimeId: item.runtimeId, requestId: item.data.interaction.id, decision, answers })
  }, [activeId])
  const submit = async (): Promise<void> => {
    const text = message.trim()
    if (!text || submitLock.current || !ready || historical || activePhases.has(projection.phase) || projection.archived) return
    submitLock.current = true
    setSubmitting(true)
    setError('')
    try {
      await window.conductor.structured.submit(activeId, text, settings, attachments)
      setMessage('')
      setAttachments([])
      setImagePreviews({})
      setReadingWindow(null)
      nearBottom.current = true
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { submitLock.current = false; setSubmitting(false) }
  }
  const resume = async (): Promise<void> => {
    setError('')
    try { await window.conductor.structured.resume(activeId, settings); setHistorical(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const connect = async (): Promise<void> => {
    setError('')
    try { await window.conductor.structured.connect(activeId) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const fork = async (): Promise<void> => {
    setError('')
    try { const id = await window.conductor.structured.fork(activeId); setActiveId(id); setHistorical(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const discover = async (): Promise<void> => {
    setError('')
    try { setDiscovery(await window.conductor.structured.discover(activeId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const addFile = async (): Promise<void> => {
    const target = safeFileTarget(filePath.trim(), props.project.path)
    if (!target) { setError('Choose a file within this workspace.'); return }
    try {
      if (/\.(png|jpe?g|gif|webp)$/i.test(target.path)) {
        if (!projection.capabilities?.imageAttachments) throw new Error('This provider connection does not currently support local image attachments.')
        const image = await window.conductor.files.readDataUrl(props.project.id, target.path)
        const id = crypto.randomUUID()
        setAttachments((current) => [...current, { id, kind: 'image' as const, name: target.path, path: target.path }].slice(-20))
        setImagePreviews((current) => Object.fromEntries([...Object.entries(current), [id, image.dataUrl]].slice(-20)))
        setFilePath('')
        setAddFileOpen(false)
        return
      }
      const content = await window.conductor.files.read(props.project.id, target.path)
      if (content.length > 160_000) throw new Error('This file is too large to attach. Select a relevant range in the editor.')
      setAttachments((current) => [...current, { id: crypto.randomUUID(), kind: 'file' as const, name: target.path, path: target.path, content }].slice(-20))
      setFilePath('')
      setAddFileOpen(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const canSubmit = ready && !historical && !activePhases.has(projection.phase) && !projection.archived && projection.phase !== 'disconnected'
  const capabilities = projection.capabilities
  const pending = projection.items.filter((item) => item.data.type === 'interaction' && item.data.interaction.status === 'pending').length
  const visibleItems = useMemo(() => {
    if (!readingWindow) return projection.items.slice(-visibleCount)
    const latest = new Map(projection.items.map((item) => [item.id, item]))
    // Keep a bounded reading window; reconcile existing statuses without adding rows.
    return readingWindow.map((item) => latest.get(item.id) ?? item)
  }, [projection.items, visibleCount, readingWindow])
  useLayoutEffect(() => { lastVisibleItems.current = visibleItems }, [visibleItems])
  const earlierCount = readingWindow ? projection.items.filter((item) => item.sequence < (readingWindow[0]?.sequence ?? 0)).length : Math.max(0, projection.items.length - visibleCount)
  const showEarlier = (): void => {
    const el = timeline.current
    const height = el?.scrollHeight ?? 0
    if (readingWindow) {
      const earlier = projection.items.filter((item) => item.sequence < (readingWindow[0]?.sequence ?? 0)).slice(-250)
      setReadingWindow([...earlier, ...readingWindow].slice(-2000))
      setVisibleCount((count) => Math.min(2000, count + earlier.length))
    } else setVisibleCount((count) => Math.min(2000, count + 250))
    requestAnimationFrame(() => { if (el) el.scrollTop += el.scrollHeight - height })
  }
  const jumpToLatest = (): void => {
    setReadingWindow(null)
    nearBottom.current = true
    setNewOutput(false)
    requestAnimationFrame(() => { if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight })
  }
  const parentLabels = useMemo(() => new Map(projection.items.filter((item) => item.nativeItemId).map((item) => [item.runtimeId + ':' + item.nativeItemId, item.data.type === 'tool' || item.data.type === 'subagent' ? item.data.name : item.nativeItemId!])), [projection.items])
  const updateSettings = (change: Partial<SessionSettings>): void => setSettings((current) => ({ ...current, ...change }))

  return <section className="structured-agent-pane" data-structured-session={activeId} onFocusCapture={() => { focusedAgent = { sessionId: activeId, projectId: props.project.id } }} onPointerDown={() => { focusedAgent = { sessionId: activeId, projectId: props.project.id } }}>
    <header className="sa-session-bar"><span className={'sa-session-dot status-' + projection.phase} /><strong title={projection.title || name}>{projection.title || name}</strong><span className="sa-provider-label">{name}</span><span className="sa-session-phase" role="status">{displayPhase(projection.phase)}</span>{pending > 0 && <span className="sa-attention-badge" aria-label={pending + ' pending requests'}>{pending}</span>}<span className="sa-spacer" /><button aria-label="Conversation history" title="Conversation history" onClick={() => setHistoryOpen(true)}><History size={15} /></button><button aria-label="Inspect provider events" title="Inspect provider events (not a terminal)" onClick={() => setEventsOpen(true)}><ListTree size={15} /></button><button aria-label="Session settings" title="Session settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={15} /></button>{activePhases.has(projection.phase) && !historical && <button aria-label="Stop agent" title="Stop agent" disabled={projection.phase === 'interrupting'} onClick={() => void window.conductor.structured.interrupt(activeId).catch((reason: unknown) => setError(String(reason)))}><CircleStop size={15} /></button>}</header>
    {settingsOpen && <section className="sa-settings"><div><strong>{name}</strong><small>{capabilities ? 'Runtime ' + capabilities.runtimeVersion + ' · adapter v' + capabilities.adapterVersion + ' · ' + capabilities.authentication + ' authentication' : 'Capabilities will be detected by the backend.'}</small></div><p>{capabilities?.provider === 'claude' && projection.nativeSessionId ? 'Settings apply to the next turn. Apply a changed reasoning effort with Resume connection first.' : 'Settings below apply to the next submitted turn.'}</p><label>Model{capabilities?.models.length ? <select aria-label="Model" value={settings.model ?? ''} onChange={(event) => updateSettings({ model: event.target.value || undefined })}><option value="">Provider default</option>{capabilities.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select> : <input aria-label="Model" value={settings.model ?? ''} placeholder="Provider default" onChange={(event) => updateSettings({ model: event.target.value || undefined })} />}</label>{Boolean(capabilities?.effort.length) && <label>Reasoning effort<select aria-label="Reasoning effort" value={settings.effort ?? ''} onChange={(event) => updateSettings({ effort: event.target.value || undefined })}><option value="">Provider default</option>{capabilities?.effort.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>}{capabilities?.provider !== 'codex' && (capabilities?.permissions?.length ? <label>Permission policy<select aria-label="Permission policy" value={settings.permission} onChange={(event) => updateSettings({ permission: event.target.value as SessionSettings['permission'] })}>{capabilities.permissions.map((permission) => <option value={permission} key={permission}>{permission}</option>)}</select></label> : <small>Permission policy: {settings.permission}</small>)}{capabilities?.plans && <label><input type="checkbox" checked={settings.plan} onChange={(event) => updateSettings({ plan: event.target.checked })} /> Planning mode</label>}<details><summary>Session identity and capability limits</summary><p>Conductor: <code>{activeId}</code></p><p>Native conversation: <code>{projection.nativeSessionId ?? 'Not started'}</code></p><p>Workspace: <code>{props.project.path}</code></p><ul>{capabilities?.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul><p>Hidden panes continue receiving events while the application is running. Exiting the application interrupts owned runtimes.</p></details><div><button onClick={() => setRename(projection.title || props.title)}>Rename</button><button onClick={() => void window.conductor.structured.archive(activeId, !projection.archived).catch((reason: unknown) => setError(String(reason)))}><Archive size={13} />{projection.archived ? 'Unarchive' : 'Archive'}</button></div></section>}
    {settingsOpen && <section className="sa-settings">{Boolean(capabilities?.sandboxModes?.length) && <label>Execution sandbox<select aria-label="Execution sandbox" value={settings.sandbox ?? 'inherit'} onChange={(event) => updateSettings({ sandbox: event.target.value as SessionSettings['sandbox'] })}>{capabilities?.sandboxModes?.map((mode) => <option key={mode} value={mode}>{mode === 'inherit' ? 'Inherit provider configuration' : mode}</option>)}</select></label>}{Boolean(capabilities?.approvalPolicies?.length) && <label>Approval policy<select aria-label="Approval policy" value={settings.approvalPolicy ?? 'inherit'} onChange={(event) => updateSettings({ approvalPolicy: event.target.value as SessionSettings['approvalPolicy'] })}>{capabilities?.approvalPolicies?.map((policy) => <option key={policy} value={policy}>{policy === 'inherit' ? 'Inherit provider configuration' : policy}</option>)}</select></label>}{capabilities?.effectiveSettings && <details><summary>Effective provider settings</summary><pre>{JSON.stringify(capabilities.effectiveSettings, null, 2)}</pre></details>}</section>}
    {settingsOpen && <div className="sa-connection-actions"><button onClick={() => void discover()}>Provider commands and configuration</button>{!activePhases.has(projection.phase) && (!projection.nativeSessionId ? <button onClick={() => void connect()}>Connect provider · discover models</button> : <>{capabilities?.resume && <button onClick={() => void resume()}>Resume connection</button>}{capabilities?.fork && <button onClick={() => void fork()}>Fork conversation</button>}</>)}</div>}
    {error && <div className="sa-error-bar" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={13} /></button></div>}
    {historical && <div className="sa-history-banner"><span>Viewing saved history</span><button onClick={() => { setActiveId(props.resourceId); setHistorical(false) }}><ArrowLeft size={13} /> Back to current</button>{capabilities?.resume && projection.nativeSessionId && <button onClick={() => void resume()}>Resume this conversation</button>}</div>}
    {(projection.phase === 'disconnected' || projection.phase === 'interrupted') && !historical && <div className="sa-history-banner"><span>{projection.phase === 'disconnected' ? 'Runtime disconnected. The last operation may be incomplete.' : 'Runtime interrupted.'}</span>{capabilities?.resume && projection.nativeSessionId && <button onClick={() => void resume()}>Resume conversation</button>}</div>}
    <div className="sa-timeline-wrap"><div className="sa-timeline" ref={timeline} role="region" aria-label={name + ' conversation'} tabIndex={0} onScroll={() => {
      const el = timeline.current
      nearBottom.current = Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight < 80)
      if (!nearBottom.current) setReadingWindow((current) => current ?? lastVisibleItems.current)
      else if (!newOutput && !window.getSelection()?.toString()) { setReadingWindow(null); setNewOutput(false) }
    }}>
      {!projection.items.length && <div className="sa-empty"><strong>{ready ? 'Start a conversation' : 'Opening saved conversation…'}</strong><p>{ready ? 'Send a message to start ' + name + ' in this workspace.' : 'Reading history does not start an agent.'}</p><code>{props.project.path}</code>{ready && !projection.nativeSessionId && !activePhases.has(projection.phase) && <button onClick={() => void connect()}>Connect provider · discover models</button>}{projection.nativeSessionId && <small>Connected · no prompt has been submitted.</small>}</div>}
      {earlierCount > 0 && <button className="sa-load-earlier" onClick={showEarlier}>Show earlier activities ({earlierCount})</button>}
      {projection.truncated && <p className="sa-muted">Older events remain in durable history; this view shows a bounded activity window.</p>}
      {visibleItems.map((item) => <StructuredActivity key={item.id} item={item} sessionId={activeId} cwd={props.project.path} expanded={expansion[item.id] !== false} interactive={!historical && item.runtimeId === projection.runtimeId} parentLabel={item.parentId ? parentLabels.get(item.runtimeId + ':' + item.parentId) : undefined} onExpand={onExpand} onOpenFile={onOpenFile} onDiff={setDiff} onRespond={onRespond} />)}
      {(projection.phase === 'running' || projection.phase === 'starting') && <div className="sa-working" role="status"><i />{projection.phase === 'starting' ? 'Starting runtime…' : 'Working…'}</div>}
    </div>{newOutput && <button className="sa-jump" onClick={jumpToLatest}><ArrowDown size={13} /> New output · Jump to latest</button>}</div>
    <form className="sa-composer" onSubmit={(event) => { event.preventDefault(); void submit() }}><div className="sa-context-chips">{attachments.map((attachment) => <span key={attachment.id}><button type="button" title="Inspect submitted context" onClick={() => setInspectAttachment(attachment)}>{attachment.kind} · {attachment.name}{attachment.startLine ? ':' + attachment.startLine + (attachment.endLine ? '–' + attachment.endLine : '') : ''}</button><button type="button" aria-label={'Remove context ' + attachment.name} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={11} /></button></span>)}</div><textarea aria-label={'Message ' + name} placeholder={historical ? 'Resume this conversation to send a message' : projection.archived ? 'Unarchive this conversation to send a message' : 'Message ' + name} value={message} disabled={!canSubmit || submitting} rows={2} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} /><footer><button type="button" aria-label="Attach file context" title="Attach a file (select editor text to attach a range)" disabled={historical} onClick={() => setAddFileOpen((open) => !open)}><FilePlus2 size={15} /></button><button type="button" className="sa-setting-summary" onClick={() => setSettingsOpen((open) => !open)}>{settings.model || 'Provider default'}{settings.effort && ' · ' + settings.effort}<span>{settings.permission}{settings.plan ? ' · plan' : ''}</span></button><span className="sa-spacer" /><small>Enter to send · Shift+Enter for newline</small><button className="sa-send" type="submit" aria-label="Send message" disabled={!canSubmit || !message.trim() || submitting}><Send size={15} /></button></footer>{addFileOpen && <div className="sa-file-attach"><input aria-label="Context file path" placeholder="Workspace-relative file path" value={filePath} onChange={(event) => setFilePath(event.target.value)} /><button type="button" onClick={() => void addFile()}>Attach</button></div>}</form>
    {diff && <ImmutableDiff sessionId={activeId} change={diff} onOpenFile={onOpenFile} onClose={() => setDiff(null)} />}
    {inspectAttachment && <AgentDialog title={'Context · ' + inspectAttachment.name} onClose={() => setInspectAttachment(null)}><p className="sa-notice">{inspectAttachment.kind === 'image' ? 'This workspace image path will be submitted using the native image attachment mechanism. The provider reads the file when the turn is submitted.' : 'This content will be submitted with your message. File content is captured when attached.'}</p>{inspectAttachment.kind === 'image' && imagePreviews[inspectAttachment.id] && <img className="sa-context-image" alt={inspectAttachment.name} src={imagePreviews[inspectAttachment.id]} />}<pre className="sa-expanded-output">{inspectAttachment.content ?? inspectAttachment.path ?? 'No content'}</pre></AgentDialog>}
    {eventsOpen && <AgentDialog title="Provider events" onClose={() => setEventsOpen(false)}><p className="sa-notice">Sanitized protocol events. This is an inspection view, not an interactive terminal. Showing the latest {rawEvents.length} events.</p><div className="sa-diff-toolbar"><button onClick={() => void navigator.clipboard.writeText(JSON.stringify(rawEvents, null, 2))}>Copy events</button><button onClick={() => void window.conductor.structured.events(activeId).then((events) => setRawEvents(events.slice(-200)))}>Refresh</button></div><div className="sa-event-list">{rawEvents.map((event) => <details key={event.id}><summary>#{event.sequence} · {event.data.type} · {event.native?.method ?? event.itemId ?? event.requestId ?? ''}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</div></AgentDialog>}
    {historyOpen && <AgentDialog title="Conversation history" onClose={() => setHistoryOpen(false)}><input className="sa-history-search" aria-label="Search conversation history" placeholder="Search conversations" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /><div className="sa-history-list">{historyItems.map((item) => <button key={item.id} onClick={() => { setActiveId(item.id); setHistorical(item.id !== props.resourceId); setHistoryOpen(false) }}><strong>{item.title || 'Untitled conversation'}</strong><small>{item.provider} · {displayPhase(item.phase)}{item.archived ? ' · archived' : ''}</small></button>)}{!historyItems.length && <p>No saved conversations match.</p>}</div></AgentDialog>}
    {discovery !== undefined && <AgentDialog title="Provider commands and configuration" onClose={() => setDiscovery(undefined)}><p className="sa-notice">Native provider discovery. Expand a category to inspect available commands, skills, configuration and integration status at their reported scopes. This inspector does not execute a command or alter configuration.</p><div className="sa-event-list">{discovery && typeof discovery === 'object' && !Array.isArray(discovery) ? Object.entries(discovery).map(([category, value]) => <details key={category}><summary>{category.replaceAll('_', ' ')}</summary><pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></details>) : <pre>{JSON.stringify(discovery, null, 2)}</pre>}</div></AgentDialog>}
    {rename !== null && <AgentDialog title="Rename conversation" onClose={() => setRename(null)}><form className="sa-rename" onSubmit={(event) => { event.preventDefault(); const title = rename.trim(); if (!title) return; void window.conductor.structured.rename(activeId, title).then(() => { setProjection((current) => ({ ...current, title })); setRename(null) }).catch((reason: unknown) => setError(String(reason))) }}><input autoFocus aria-label="Conversation title" maxLength={160} value={rename} onChange={(event) => setRename(event.target.value)} /><button type="submit">Save name</button></form></AgentDialog>}
  </section>
}
