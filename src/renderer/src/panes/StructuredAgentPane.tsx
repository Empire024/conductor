import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowDown, ArrowLeft, CircleStop, FilePlus2, History, ListTree, Send, Settings2, X } from 'lucide-react'
import type { AgentSpec, AgentActivityPhase } from '../../../shared/models'
import type { AgentEvent, ContextAttachment, FileChange, Json, SessionProjection, SessionSettings, TimelineItem } from '../../../shared/structured-agent'
import { emptyProjection, projectAgentEvent } from '../../../shared/structured-agent-reducer'
import type { RuntimeTerminalProps } from './RuntimeTerminal'
import { AgentDialog, ImmutableDiff, isConversationActivity, safeFileTarget, StructuredActivity } from './StructuredAgentRenderers'
import { StructuredComposerControls } from './StructuredComposerControls'
import { StructuredUsageDetails } from './StructuredUsageDetails'
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
  const connection = useRef<{ sessionId: string; promise: Promise<void> } | null>(null)
  const metadataConnectionId = useRef<string | null>(null)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const lastConversationItems = useRef<TimelineItem[]>([])
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
    lastConversationItems.current = []
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
    const next = projection.items.filter(isConversationActivity)
    if (next.length === lastConversationItems.current.length && next.every((item, index) => item === lastConversationItems.current[index])) return
    lastConversationItems.current = next
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
      const next = { ...current, [id]: !current[id] }
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
    const connectingMetadata = projection.phase === 'starting' && metadataConnectionId.current === activeId
    if (!text || submitLock.current || !ready || historical || (activePhases.has(projection.phase) && !connectingMetadata) || projection.archived) return
    submitLock.current = true
    setSubmitting(true)
    setError('')
    try {
      // A user can press Send while the model catalog is loading. Await that
      // owned handshake once; do not drop the click or dispatch a duplicate turn.
      if (connection.current?.sessionId === activeId) await connection.current.promise
      if (activeIdRef.current !== activeId) return
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
    if (projection.capabilities?.models.length) return
    if (historical || projection.phase === 'disconnected') throw new Error('Resume this conversation to load models.')
    if (connection.current?.sessionId === activeId) return connection.current.promise
    metadataConnectionId.current = activeId
    const pending = window.conductor.structured.connect(activeId).then(async () => {
      const snapshot = await window.conductor.structured.snapshot(activeId)
      if (snapshot && activeIdRef.current === activeId) setProjection(current => current.sessionId === snapshot.sessionId && snapshot.sequence >= current.sequence ? snapshot : current)
    })
    connection.current = { sessionId: activeId, promise: pending }
    try { await pending } finally { if (connection.current?.promise === pending) connection.current = null }
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
  const canSubmit = ready && !historical && (!activePhases.has(projection.phase) || (projection.phase === 'starting' && metadataConnectionId.current === activeId)) && !projection.archived && projection.phase !== 'disconnected'
  const capabilities = projection.capabilities
  const pending = projection.items.filter((item) => item.data.type === 'interaction' && item.data.interaction.status === 'pending').length
  const conversationItems = useMemo(() => projection.items.filter(isConversationActivity), [projection.items])
  const visibleItems = useMemo(() => {
    if (!readingWindow) return conversationItems.slice(-visibleCount)
    const latest = new Map(projection.items.map((item) => [item.id, item]))
    // Keep a bounded reading window; reconcile existing statuses without adding rows.
    return readingWindow.map((item) => latest.get(item.id) ?? item)
  }, [projection.items, conversationItems, visibleCount, readingWindow])
  useLayoutEffect(() => { lastVisibleItems.current = visibleItems }, [visibleItems])
  const earlierCount = readingWindow ? conversationItems.filter((item) => item.sequence < (readingWindow[0]?.sequence ?? 0)).length : Math.max(0, conversationItems.length - visibleCount)
  const showEarlier = (): void => {
    const el = timeline.current
    const height = el?.scrollHeight ?? 0
    if (readingWindow) {
      const earlier = conversationItems.filter((item) => item.sequence < (readingWindow[0]?.sequence ?? 0)).slice(-250)
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
  const parentLabels = useMemo(() => new Map(projection.items.flatMap(item => item.nativeItemId && (item.data.type === 'tool' || item.data.type === 'subagent') ? [[item.runtimeId + ':' + item.nativeItemId, item.data.name] as const] : [])), [projection.items])
  const updateSettings = (change: Partial<SessionSettings>): void => setSettings((current) => ({ ...current, ...change }))

  return <section className="structured-agent-pane" data-provider={provider} data-structured-session={activeId} onFocusCapture={() => { focusedAgent = { sessionId: activeId, projectId: props.project.id } }} onPointerDown={() => { focusedAgent = { sessionId: activeId, projectId: props.project.id } }}>
    <header className="sa-session-bar">
      <strong title={projection.title || name}>{projection.title || 'New conversation'}</strong>
      {activePhases.has(projection.phase) && <span className="sa-session-phase" role="status"><span className={'sa-session-dot status-' + projection.phase} />{projection.phase === 'starting' ? 'Connecting…' : projection.phase === 'running' ? 'Working' : displayPhase(projection.phase)}</span>}
      {pending > 0 && <span className="sa-attention-badge" aria-label={pending + ' pending requests'}>{pending}</span>}
      <span className="sa-spacer" />
      <button aria-label="Conversation history" title="History" onClick={() => setHistoryOpen(true)}><History size={15} /></button>
      <button aria-label="Session settings" title="Conversation settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></button>
      {activePhases.has(projection.phase) && !historical && <button aria-label="Stop agent" title="Stop" disabled={projection.phase === 'interrupting'} onClick={() => void window.conductor.structured.interrupt(activeId).catch((reason: unknown) => setError(String(reason)))}><CircleStop size={15} /></button>}
    </header>
    {settingsOpen && <AgentDialog title="Conversation settings" onClose={() => setSettingsOpen(false)}>
      <div className="sa-settings">
        <p className="sa-detail-hint">Changes apply to your next message.</p>
        <section className="sa-settings-section"><h3>Permissions</h3>
          {capabilities?.provider !== 'codex' && Boolean(capabilities?.permissions?.length) && <label>Edits<select aria-label="Permission policy" value={settings.permission} onChange={event => updateSettings({ permission: event.target.value as SessionSettings['permission'] })}>{capabilities?.permissions?.map(permission => <option key={permission} value={permission}>{permission === 'default' ? 'Ask before editing' : permission === 'accept-edits' ? 'Allow edits' : 'Read only'}</option>)}</select></label>}
          {Boolean(capabilities?.sandboxModes?.length) && <label>Workspace access<select aria-label="Execution sandbox" value={settings.sandbox ?? 'inherit'} onChange={event => updateSettings({ sandbox: event.target.value as SessionSettings['sandbox'] })}>{capabilities?.sandboxModes?.map(mode => <option key={mode} value={mode}>{mode === 'inherit' ? 'Use saved settings' : mode === 'workspace-write' ? 'Workspace files' : 'Read only'}</option>)}</select></label>}
          {Boolean(capabilities?.approvalPolicies?.length) && <label>Approvals<select aria-label="Approval policy" value={settings.approvalPolicy ?? 'inherit'} onChange={event => updateSettings({ approvalPolicy: event.target.value as SessionSettings['approvalPolicy'] })}>{capabilities?.approvalPolicies?.map(policy => <option key={policy} value={policy}>{policy === 'inherit' ? 'Use saved settings' : policy === 'untrusted' ? 'Ask before commands' : policy === 'on-request' ? 'Ask when needed' : 'Never ask'}</option>)}</select></label>}
          {capabilities?.plans && <label>Plan before making changes<input type="checkbox" checked={settings.plan} onChange={event => updateSettings({ plan: event.target.checked })} /></label>}
          {!capabilities && <p className="sa-detail-hint">Choose a model or start typing to load available settings.</p>}
          {provider === 'claude' && projection.nativeSessionId && settings.effort !== projection.settings.effort && <p className="sa-detail-hint">Reconnect below to apply the changed effort.</p>}
        </section>
        <section className="sa-settings-section"><h3>Conversation</h3><div className="sa-detail-actions">
          <button onClick={() => { setSettingsOpen(false); setRename(projection.title || props.title) }}>Rename</button>
          {capabilities?.fork && <button disabled={activePhases.has(projection.phase)} onClick={() => void fork()}>Fork conversation</button>}
          <button onClick={() => void window.conductor.structured.archive(activeId, !projection.archived).catch((reason: unknown) => setError(String(reason)))}><Archive size={13} />{projection.archived ? 'Unarchive' : 'Archive'}</button>
          {capabilities?.resume && projection.nativeSessionId && <button disabled={activePhases.has(projection.phase)} onClick={() => void resume()}>Resume connection</button>}
        </div></section>
        <StructuredUsageDetails items={projection.items} />
        <details className="sa-diagnostics"><summary>Advanced & diagnostics</summary>
          <dl><dt>Connection</dt><dd>{name} {capabilities?.runtimeVersion ?? ''}</dd><dt>Sign-in</dt><dd>{capabilities?.authentication === 'cli' ? 'Existing local sign-in' : capabilities?.authentication ?? 'Not connected'}</dd></dl>
          <div className="sa-detail-actions"><button aria-label="Inspect provider events" onClick={() => { setSettingsOpen(false); setEventsOpen(true) }}><ListTree size={13} /> Event log</button><button onClick={() => { setSettingsOpen(false); void discover() }}>Skills & connections</button></div>
          <details><summary>Connection details</summary><p>Conversation: <code>{activeId}</code></p><p>Session: <code>{projection.nativeSessionId ?? 'Not started'}</code></p><p>Workspace: <code>{props.project.path}</code></p>{Boolean(capabilities?.limitations.length) && <ul>{capabilities?.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>}<p>Work continues while panes are hidden. Closing the app disconnects the session.</p></details>
          {capabilities?.effectiveSettings && <details><summary>Effective settings</summary><pre>{JSON.stringify(capabilities.effectiveSettings, null, 2)}</pre></details>}
        </details>
      </div>
    </AgentDialog>}
    {error && <div className="sa-error-bar" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={13} /></button></div>}
    {historical && <div className="sa-history-banner"><span>Viewing saved history</span><button onClick={() => { setActiveId(props.resourceId); setHistorical(false) }}><ArrowLeft size={13} /> Back to current</button>{capabilities?.resume && projection.nativeSessionId && <button onClick={() => void resume()}>Resume this conversation</button>}</div>}
    {(projection.phase === 'disconnected' || projection.phase === 'interrupted') && !historical && <div className="sa-history-banner"><span>{projection.phase === 'disconnected' ? 'Runtime disconnected. The last operation may be incomplete.' : 'Runtime interrupted.'}</span>{capabilities?.resume && projection.nativeSessionId && <button onClick={() => void resume()}>Resume conversation</button>}</div>}
    <div className="sa-timeline-wrap"><div className="sa-timeline" ref={timeline} role="region" aria-label={name + ' conversation'} tabIndex={0} onScroll={() => {
      const el = timeline.current
      nearBottom.current = Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight < 80)
      if (!nearBottom.current) setReadingWindow((current) => current ?? lastVisibleItems.current)
      else if (!newOutput && !window.getSelection()?.toString()) { setReadingWindow(null); setNewOutput(false) }
    }}>
      {!conversationItems.length && <div className="sa-empty"><strong>{ready ? 'What are we working on?' : 'Opening conversation…'}</strong>{ready && <p>Ask {name} about your code, or describe a change.</p>}</div>}
      {earlierCount > 0 && <button className="sa-load-earlier" onClick={showEarlier}>Show earlier activities ({earlierCount})</button>}
      {projection.truncated && <button className="sa-load-earlier" onClick={() => setHistoryOpen(true)}>Open conversation history</button>}
      {visibleItems.map((item) => <StructuredActivity key={item.id} item={item} sessionId={activeId} cwd={props.project.path} expanded={expansion[item.id] ?? false} interactive={!historical && item.runtimeId === projection.runtimeId} parentLabel={item.parentId ? parentLabels.get(item.runtimeId + ':' + item.parentId) : undefined} onExpand={onExpand} onOpenFile={onOpenFile} onDiff={setDiff} onRespond={onRespond} />)}
      {(projection.phase === 'running' || projection.phase === 'starting') && <div className="sa-working" role="status"><i />{projection.phase === 'starting' ? 'Connecting…' : 'Working…'}</div>}
    </div>{newOutput && <button className="sa-jump" onClick={jumpToLatest}><ArrowDown size={13} /> New output · Jump to latest</button>}</div>
    <form className="sa-composer agent-prompt-surface" onSubmit={event => { event.preventDefault(); void submit() }}>
      {attachments.length > 0 && <div className="sa-context-chips">{attachments.map(attachment => <span key={attachment.id}><button type="button" title="Inspect attached context" onClick={() => setInspectAttachment(attachment)}>{attachment.name}{attachment.startLine ? ':' + attachment.startLine + (attachment.endLine ? '–' + attachment.endLine : '') : ''}</button><button type="button" aria-label={'Remove context ' + attachment.name} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}><X size={11} /></button></span>)}</div>}
      <textarea aria-label={'Message ' + name} placeholder={historical ? 'Resume this conversation to send a message' : projection.archived ? 'Unarchive this conversation to send a message' : 'Message ' + name} value={message} disabled={!ready || historical || projection.archived} rows={2} onFocus={() => { if (ready && !historical && !projection.nativeSessionId && !activePhases.has(projection.phase)) void connect().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
      <footer className="agent-prompt-controls">
        <button type="button" aria-label="Attach file context" title="Attach context" disabled={historical} onClick={() => setAddFileOpen(open => !open)}><FilePlus2 size={15} /></button>
        <StructuredComposerControls key={activeId} settings={settings} capabilities={capabilities} disabled={historical || !ready} onChange={updateSettings} onDiscover={connect} />
        <span className="sa-spacer" />
        <button className="sa-send agent-send-button" type="submit" aria-label="Send message" title="Send message · Enter" disabled={!canSubmit || !message.trim() || submitting}><Send size={15} /></button>
      </footer>
      {addFileOpen && <div className="sa-file-attach"><input aria-label="Context file path" placeholder="Workspace-relative file path" value={filePath} onChange={event => setFilePath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void addFile() } }} /><button type="button" onClick={() => void addFile()}>Attach</button></div>}
    </form>
    {diff && <ImmutableDiff sessionId={activeId} change={diff} onOpenFile={onOpenFile} onClose={() => setDiff(null)} />}
    {inspectAttachment && <AgentDialog title={'Context · ' + inspectAttachment.name} onClose={() => setInspectAttachment(null)}><p className="sa-notice">{inspectAttachment.kind === 'image' ? 'This workspace image path will be submitted using the native image attachment mechanism. The provider reads the file when the turn is submitted.' : 'This content will be submitted with your message. File content is captured when attached.'}</p>{inspectAttachment.kind === 'image' && imagePreviews[inspectAttachment.id] && <img className="sa-context-image" alt={inspectAttachment.name} src={imagePreviews[inspectAttachment.id]} />}<pre className="sa-expanded-output">{inspectAttachment.content ?? inspectAttachment.path ?? 'No content'}</pre></AgentDialog>}
    {eventsOpen && <AgentDialog title="Event log" onClose={() => setEventsOpen(false)}><p className="sa-notice">Diagnostics only. Showing the latest {rawEvents.length} events.</p><div className="sa-diff-toolbar"><button onClick={() => void navigator.clipboard.writeText(JSON.stringify(rawEvents, null, 2))}>Copy events</button><button onClick={() => void window.conductor.structured.events(activeId).then((events) => setRawEvents(events.slice(-200)))}>Refresh</button></div><div className="sa-event-list">{rawEvents.map((event) => <details key={event.id}><summary>#{event.sequence} · {event.data.type} · {event.native?.method ?? event.itemId ?? event.requestId ?? ''}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</div></AgentDialog>}
    {historyOpen && <AgentDialog title="Conversation history" onClose={() => setHistoryOpen(false)}><input className="sa-history-search" aria-label="Search conversation history" placeholder="Search conversations" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /><div className="sa-history-list">{historyItems.map((item) => <button key={item.id} onClick={() => { setActiveId(item.id); setHistorical(item.id !== props.resourceId); setHistoryOpen(false) }}><strong>{item.title || 'Untitled conversation'}</strong><small>{item.provider} · {displayPhase(item.phase)}{item.archived ? ' · archived' : ''}</small></button>)}{!historyItems.length && <p>No saved conversations match.</p>}</div></AgentDialog>}
    {discovery !== undefined && <AgentDialog title={name + ' configuration'} onClose={() => setDiscovery(undefined)}><p className="sa-notice">Read-only details of configured skills, commands and connections. Nothing here runs a command or changes your configuration.</p><div className="sa-event-list">{discovery && typeof discovery === 'object' && !Array.isArray(discovery) ? Object.entries(discovery).map(([category, value]) => <details key={category}><summary>{category.replaceAll('_', ' ')}</summary><pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></details>) : <pre>{JSON.stringify(discovery, null, 2)}</pre>}</div></AgentDialog>}
    {rename !== null && <AgentDialog title="Rename conversation" onClose={() => setRename(null)}><form className="sa-rename" onSubmit={(event) => { event.preventDefault(); const title = rename.trim(); if (!title) return; void window.conductor.structured.rename(activeId, title).then(() => { setProjection((current) => ({ ...current, title })); setRename(null) }).catch((reason: unknown) => setError(String(reason))) }}><input autoFocus aria-label="Conversation title" maxLength={160} value={rename} onChange={(event) => setRename(event.target.value)} /><button type="submit">Save name</button></form></AgentDialog>}
  </section>
}
