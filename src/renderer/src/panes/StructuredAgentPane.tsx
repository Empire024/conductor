import { conversationIdentity } from './conversation-tab'
import { PromptImageUpload, PromptImageThumbnail } from '../components/PromptImageUpload'
import { ProviderIcon } from '../components/ProviderIcon'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowDown, ArrowLeft, FileDiff, FilePlus2, Globe2, History, ListTree, Pin, Play, PlugZap, Settings2, TerminalSquare, MessagesSquare, LoaderCircle, X } from 'lucide-react'
import type { AgentSpec, AgentActivityPhase, TurnMemoryRecall } from '../../../shared/models'
import { MAX_PROMPT_CHARS } from '../../../shared/structured-agent'
import type { AgentEvent, ContextAttachment, ConversationSearchResult, FileChange, Json, SessionProjection, SessionSettings, TimelineItem } from '../../../shared/structured-agent'
import { emptyProjection, projectAgentEvent } from '../../../shared/structured-agent-reducer'
import { coalesceTextDeltas } from './coalesce-stream-events'
import type { RuntimeTerminalProps } from './RuntimeTerminal'
import { AgentDialog, ImmutableDiff, coalescedEditLabel, coalescedEditSummary, groupConversationActivities, isConversationActivity, parentLabelAnchors, safeFileTarget, StructuredActivity, toolPresentation } from './StructuredAgentRenderers'
import { MemoryRecallStrip, recallsByItem } from './MemoryRecallStrip'
import { AgentChangeHistoryView } from './AgentChangeHistory'
import { StructuredComposerControls } from './StructuredComposerControls'
import { StructuredSendButton, sendButtonIntent } from './StructuredSendButton'
import { StructuredAgentTelemetry, StructuredLiveTokens, StructuredUsageSummary } from './StructuredAgentTelemetry'
import { distinguishSubagentLabels, subagentColorIndex, subagentIdentityId, summarizeSubagents } from './usage-summary'
import { followsBottomAfterScroll, hasTimelineSelection, latestOwnerPrompt, truncatePromptPreview } from './conversation-scroll'
import { ConversationFindBar } from './ConversationFindBar'
import { CLOSED_FIND, clearFindRanges, collectQueryRanges, conversationMatches, findReducer, paintFindRanges, type FindAction } from './conversation-find'
import { FileAttachmentInput } from '../components/FileAttachmentInput'
import { composerChildKey, composerSendBlock, nextComposerSettings, promptCharacterCount, resolvedComposerSettings } from './composer-settings'
import { activateBrowserMention, CommandAutocomplete } from './CommandAutocomplete'
import { browserTabOpen } from '../layout/browser-tab'
import { composerCommands, matchingComposerCommands, type ComposerCommand } from './composer-commands'
import { concreteModel } from '../../../shared/agent-model-selection'
import { localModelLabel } from '../../../shared/local-models'
import { useComposerDraft } from './use-composer-draft'
import { initialPermission, rememberPermission } from './permission-memory'
import { bannerAbsorbsError, runtimeBanner } from './runtime-banner'
import { cleanIpcError } from '../ipc-errors'
import { copyText } from '../clipboard'
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
  const [activeId, setActiveId] = useState(props.conversationId ?? props.resourceId)
  const [historical, setHistorical] = useState(false)
  const [projection, setProjection] = useState<SessionProjection>(() => emptyProjection(props.resourceId))
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const { draft, setMessage, setAttachments, clearSubmitted } = useComposerDraft(props.project.id, activeId)
  const { message, attachments } = draft
  const draftRef = useRef(draft); draftRef.current = draft
  const composer = useRef<HTMLTextAreaElement>(null)
  const pane = useRef<HTMLElement>(null)
  // Recall silently edits the prompt, so the ledger of what it injected is loaded alongside
  // the timeline and shown against the message it rode with.
  const [turnRecalls, setTurnRecalls] = useState<TurnMemoryRecall[]>([])
  const loadTurnRecalls = useCallback((): void => {
    void window.conductor.memory.turnRecalls(activeId).then(setTurnRecalls).catch(() => setTurnRecalls([]))
  }, [activeId])
  useEffect(loadTurnRecalls, [loadTurnRecalls, projection.sequence])
  const recallByItem = useMemo(() => recallsByItem(turnRecalls), [turnRecalls])
  const [workingWord, setWorkingWord] = useState(0)
  useEffect(() => { if (projection.phase !== 'running') return; const timer = window.setInterval(() => setWorkingWord((current) => (current + 1) % 4), 7000); return () => window.clearInterval(timer) }, [projection.phase])
  const [submitting, setSubmitting] = useState(false)
  const structuredProvider = props.provider === 'claude' || props.provider === 'local' ? props.provider : 'codex'
  const [settings, setSettings] = useState<SessionSettings>({ permission: initialPermission(structuredProvider), plan: false, model: concreteModel(structuredProvider, props.model), effort: props.effort === 'auto' ? undefined : props.effort })
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expansion, setExpansion] = useState<Record<string, boolean>>(() => storedExpansion(props.resourceId))
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({})
  const [inspectAttachment, setInspectAttachment] = useState<ContextAttachment | null>(null)
  const [addFileOpen, setAddFileOpen] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [diff, setDiff] = useState<FileChange | null>(null)
  const [changesOpen, setChangesOpen] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const [rawEvents, setRawEvents] = useState<AgentEvent[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [resuming, setResuming] = useState(false)
  const conversationSwitch = useRef(false)
  const [historyItems, setHistoryItems] = useState<Awaited<ReturnType<typeof window.conductor.structured.history>>>([])
  const [rename, setRename] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<Json | undefined>(undefined)
  const [commandDiscovery, setCommandDiscovery] = useState<Json | undefined>()
  const [commandLoading, setCommandLoading] = useState(false)
  const commandLoad = useRef<string | null>(null)
  const [commandDismissed, setCommandDismissed] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const commandListId = useId()
  const commands = matchingComposerCommands(message, composerCommands(projection.capabilities, commandDiscovery))
  const commandsOpen = !commandDismissed && !addFileOpen && !historical && commands.length > 0
  const [newOutput, setNewOutput] = useState(false)
  const [visibleCount, setVisibleCount] = useState(250)
  const [readingWindow, setReadingWindow] = useState<TimelineItem[] | null>(null)
  const [pendingPromptScroll, setPendingPromptScroll] = useState<string | null>(null)
  const [find, setFind] = useState(CLOSED_FIND)
  const dispatchFind = useCallback((action: FindAction): void => setFind(current => findReducer(current, action)), [])
  const [findFocus, setFindFocus] = useState(0)
  const [findResults, setFindResults] = useState<ConversationSearchResult | null>(null)
  const [findSearching, setFindSearching] = useState(false)
  const [findJump, setFindJump] = useState<string | null>(null)
  // Derived straight from the workspace layout the session already carries, so it can never
  // drift: true only when a browser pane tab exists in this workspace and is the tab actually
  // showing, whether it was opened from this button, the @browser mention, another tab's own
  // strip, or the agent's own browser tool.
  const browserPanelOpen = useMemo(() => browserTabOpen(props.session.layout), [props.session.layout])
  const findPainted = useRef(false)
  const findScrolled = useRef('')
  const findWidened = useRef('')
  const promptFlashTimer = useRef(0)
  const lastVisibleItems = useRef<TimelineItem[]>([])
  const timeline = useRef<HTMLDivElement>(null)
  const timelineContent = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const userScrollUntil = useRef(0)
  const presentedRequests = useRef(new Set<string>())
  const priorSequence = useRef(0)
  const submitLock = useRef(false)
  const connection = useRef<{ sessionId: string; promise: Promise<void> } | null>(null)
  const metadataConnectionId = useRef<string | null>(null)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const lastConversationItems = useRef<TimelineItem[]>([])
  const provider = structuredProvider
  // A local conversation is named by the model it is talking to; the two CLI providers are
  // named by the product, exactly as they were.
  const reportedProvider = projection.capabilities?.provider ?? provider
  const name = reportedProvider === 'claude' ? 'Claude Code' : reportedProvider === 'local' ? localModelLabel(settings.model) : 'Codex'
  // A runtime that never reached a native session exchanged nothing: startup notices and the
  // failure itself must not lock the composer, or a failed connect leaves no way to retry.
  const unstartedConversation = !projection.nativeSessionId && !projection.truncated && projection.items.every(item => (item.data.type === 'notice' || item.data.type === 'error') && !item.turnId)
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
    setPendingPromptScroll(null)
    window.clearTimeout(promptFlashTimer.current)
    lastVisibleItems.current = []
    priorSequence.current = 0
    lastConversationItems.current = []
    nearBottom.current = true
    userScrollUntil.current = 0
    presentedRequests.current.clear()
    commandLoad.current = null
    setCommandDiscovery(undefined)
    setCommandDismissed(false)
    const flush = (): void => {
      frame = 0
      if (!initialized || disposed) return
      const events = queue
      queue = []
      // A fast reply can queue many deltas for the same message before one frame; merging
      // them first keeps this a single O(items) reduce instead of one per delta.
      setProjection((current) => coalesceTextDeltas(events).reduce(projectAgentEvent, current))
      // A permission action changes the running provider mode in every pane.
      // Preserve any locally selected model/effort for the next message.
      const modeUpdate = events.filter(event => event.data.type === 'session' && event.data.settings).at(-1)
      if (modeUpdate?.data.type === 'session' && modeUpdate.data.settings) {
        const confirmed = modeUpdate.data.settings
        setSettings(current => ({ ...current, permission: confirmed.permission, plan: confirmed.plan, temporaryPermission: confirmed.temporaryPermission }))
      }
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
      // Trusting the backend's permission outright (over the initialPermission() seed above) is
      // safe: a brand-new session is registered on the owner's remembered mode for this provider
      // (structured-sessions.ts ensure()), and an existing one carries whatever was last saved for
      // it, so the snapshot is never a context-blind default that should lose to local storage.
      if (snapshot) setSettings({ ...state.settings, model: concreteModel(state.capabilities?.provider ?? provider, state.settings.model, state.capabilities) })
      setReady(true)
    }
    void initialize().catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true; off(); if (frame) cancelAnimationFrame(frame) }
  }, [activeId, provider])

  useEffect(() => {
    const phase: AgentActivityPhase = projection.phase === 'waiting_approval' || projection.phase === 'waiting_input' ? 'waiting_input' : projection.phase === 'running' || projection.phase === 'starting' || projection.phase === 'interrupting' ? 'working' : projection.phase === 'failed' ? 'failed' : projection.phase === 'disconnected' ? 'disconnected' : projection.phase === 'interrupted' ? 'stopped' : projection.phase === 'completed' ? 'complete' : 'idle'
    window.dispatchEvent(new CustomEvent('conductor:agent-activity', { detail: { id: activeId, phase } }))
  }, [activeId, projection.phase])

  useLayoutEffect(() => {
    const next = projection.items.filter(isConversationActivity)
    if (next.length === lastConversationItems.current.length && next.every((item, index) => item === lastConversationItems.current[index])) return
    lastConversationItems.current = next
    const selected = hasTimelineSelection(timeline.current, window.getSelection())
    if (selected && !readingWindow && lastVisibleItems.current.length) {
      // Pin the committed window before a new batch can evict selected DOM nodes.
      setReadingWindow(lastVisibleItems.current)
    }
    if (nearBottom.current && !selected && !readingWindow) {
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
      if (hasTimelineSelection(timeline.current, selection)) setReadingWindow((current) => current ?? lastVisibleItems.current)
      else if (nearBottom.current) { setReadingWindow(null); setNewOutput(false) }
    }
    document.addEventListener('selectionchange', pinSelection)
    return () => document.removeEventListener('selectionchange', pinSelection)
  }, [activeId])

  useEffect(() => {
    if (!historyOpen) return
    let disposed = false
    setHistoryLoading(true)
    const timer = window.setTimeout(() => void window.conductor.structured.history(props.project.id, historyQuery).then((items) => { if (!disposed) setHistoryItems(items) }).catch((reason: unknown) => { if (!disposed) setError(String(reason)) }).finally(() => { if (!disposed) setHistoryLoading(false) }), 120)
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [historyOpen, historyQuery, props.project.id, projection.title, projection.archived])

  useEffect(() => {
    if (!eventsOpen) return
    void window.conductor.structured.events(activeId).then((events) => setRawEvents(events.slice(-200))).catch((reason: unknown) => setError(String(reason)))
  }, [activeId, eventsOpen, projection.phase])

  useEffect(() => {
    setInspectAttachment(null)
    setImagePreviews({})
    setFilePath('')
    setAddFileOpen(false)
  }, [activeId])

  useEffect(() => {
    if (inspectAttachment?.kind !== 'image' || !inspectAttachment.path || imagePreviews[inspectAttachment.id]) return
    let disposed = false
    const attachment = inspectAttachment
    void window.conductor.files.readDataUrl(props.project.id, attachment.path!).then(image => {
      if (!disposed) setImagePreviews(current => ({ ...current, [attachment.id]: image.dataUrl }))
    }).catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true }
  }, [inspectAttachment, imagePreviews, props.project.id])

  const onOpenFile = useCallback((raw: string, line?: number): void => {
    const current = propsRef.current
    const target = safeFileTarget(raw, current.project.path)
    if (!target) { setError('The file link is outside this workspace or has an invalid path.'); return }
    // Confirming the path exists must not read the bytes: an agent can link a
    // video or a database dump, and loading one to answer "is it there?" stalls
    // the window before the file tab has decided how to show it.
    void window.conductor.files.stat(current.project.id, target.path).then(() => current.onOpenFile?.(target.path, line ?? target.line)).catch((reason: unknown) => setError('Cannot open current file: ' + (reason instanceof Error ? reason.message : String(reason))))
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
    nearBottom.current = true
    userScrollUntil.current = 0
    setReadingWindow(null)
    setNewOutput(false)
  }, [activeId])
  const submit = async (): Promise<void> => {
    const text = message.trim()
    const connectingMetadata = projection.phase === 'starting' && metadataConnectionId.current === activeId
    const queuing = ['running', 'waiting_input', 'waiting_approval'].includes(projection.phase)
    if (composerSendBlock(message, attachments) || submitLock.current || conversationSwitch.current || !ready || historical || (activePhases.has(projection.phase) && !connectingMetadata && !queuing) || projection.archived) return
    // Captured before the turn starts, and off actual user turns rather than
    // unstartedConversation: focusing the composer alone can already connect a runtime (to load
    // its model catalog) and set a native session id, well before anything is sent. This is the
    // one moment a tab is still eligible for its first-message auto-name (see
    // bindConversationTab); it is false for every later message.
    const firstMessage = !projection.items.some(item => item.data.type === 'text' && item.data.role === 'user')
    submitLock.current = true
    setSubmitting(true)
    setError('')
    try {
      // A user can press Send while the model catalog is loading. Await that
      // owned handshake once; do not drop the click or dispatch a duplicate turn.
      if (connection.current?.sessionId === activeId) await connection.current.promise
      if (activeIdRef.current !== activeId) return
      if (queuing && projection.capabilities?.steering) await window.conductor.structured.steer(activeId, text, settings, attachments)
      else if (queuing) await window.conductor.structured.queue(activeId, text, settings, attachments)
      else await window.conductor.structured.submit(activeId, text, settings, attachments)
      clearSubmitted(draft.revision)
      if (firstMessage) {
        const snapshot = await window.conductor.structured.snapshot(activeId)
        if (snapshot && activeIdRef.current === activeId) void propsRef.current.onConversationChange?.({ ...conversationIdentity(snapshot, provider), title: text, auto: true })
      }
      if (activeIdRef.current === activeId) {
        setImagePreviews({})
        setReadingWindow(null)
        nearBottom.current = true
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { submitLock.current = false; setSubmitting(false) }
  }
  const resume = async (): Promise<void> => {
    if (conversationSwitch.current) return
    conversationSwitch.current = true
    setError(''); setResuming(true)
    try {
      await window.conductor.structured.resume(activeId, settings)
      const snapshot = await window.conductor.structured.snapshot(activeId)
      if (activeIdRef.current !== activeId) return
      if (!snapshot) throw new Error('The resumed conversation is no longer available.')
      await propsRef.current.onConversationChange?.(conversationIdentity(snapshot, provider))
      if (activeIdRef.current !== activeId) return
      setProjection(current => snapshot.sequence >= current.sequence ? snapshot : current)
      setHistorical(false); nearBottom.current = true; setReadingWindow(null)
      requestAnimationFrame(() => composer.current?.focus())
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { conversationSwitch.current = false; setResuming(false) }
  }
  const connect = async (): Promise<void> => {
    if (projection.capabilities?.models.length) return
    if (historical || projection.phase === 'disconnected' && !unstartedConversation) throw new Error('Resume this conversation to load models.')
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
    if (conversationSwitch.current) return
    conversationSwitch.current = true
    setError(''); setResuming(true)
    try {
      const id = await window.conductor.structured.fork(activeId)
      const snapshot = await window.conductor.structured.snapshot(id)
      if (activeIdRef.current !== activeId) return
      if (!snapshot) throw new Error('The forked conversation is no longer available.')
      await propsRef.current.onConversationChange?.(conversationIdentity(snapshot, provider))
      if (activeIdRef.current !== activeId) return
      setActiveId(id); setHistorical(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { conversationSwitch.current = false; setResuming(false) }
  }

  const discover = async (): Promise<void> => {
    setError('')
    try { setDiscovery(await window.conductor.structured.discover(activeId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const addFile = async (requested = filePath): Promise<void> => {
    const target = safeFileTarget(requested.trim(), props.project.path)
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
        composer.current?.focus()
        return
      }
      const content = await window.conductor.files.read(props.project.id, target.path)
      if (content.length > 160_000) throw new Error('This file is too large to attach. Select a relevant range in the editor.')
      setAttachments((current) => [...current, { id: crypto.randomUUID(), kind: 'file' as const, name: target.path, path: target.path, content }].slice(-20))
      setFilePath('')
      setAddFileOpen(false)
      composer.current?.focus()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  useEffect(() => {
    if (!commandsOpen || commandLoad.current === activeId || !ready || historical) return
    commandLoad.current = activeId; setCommandLoading(true)
    void connect().then(() => window.conductor.structured.discover(activeId)).then(result => { if (activeIdRef.current === activeId) setCommandDiscovery(result) }).catch(() => { /* Local commands remain available if provider discovery fails. */ }).finally(() => { if (activeIdRef.current === activeId) setCommandLoading(false) })
  }, [commandsOpen, activeId, ready, historical])

  const stop = (expediteSubmittedInput = false): void => { void window.conductor.structured.interrupt(activeId, expediteSubmittedInput).catch((reason: unknown) => setError(String(reason))) }
  const needsResume = !historical && Boolean(projection.nativeSessionId) && ['interrupted', 'disconnected'].includes(projection.phase)
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open], [aria-modal="true"], .settings-scrim, .palette-backdrop') || addFileOpen) return
      if (!pane.current?.contains(document.activeElement) || !activePhases.has(projection.phase) || historical) return
      event.preventDefault(); event.stopPropagation(); stop(true)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [activeId, projection.phase, historical, addFileOpen])
  useEffect(() => {
    const openFind = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'f' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.defaultPrevented) return
      // A dialog's own search field, the attach-a-file input and other panes keep Ctrl+F.
      if (document.querySelector('dialog[open], [aria-modal="true"], .settings-scrim, .palette-backdrop') || addFileOpen || !pane.current) return
      const focused = document.activeElement
      // Every other text field in this pane is itself a search (model picker, file path), so it
      // keeps the shortcut; the composer is a textarea and still opens find while typing.
      if (focused instanceof HTMLInputElement && focused.type !== 'checkbox' && !focused.closest('.sa-find')) return
      const mine = pane.current.contains(focused)
      // Clicking a message focuses nothing focusable, so a pane that merely holds the last agent
      // focus still answers Ctrl+F - but never while an editor or another pane owns the caret.
      if (!mine && !(focusedAgent?.sessionId === activeId && (!focused || focused === document.body))) return
      event.preventDefault(); event.stopPropagation()
      dispatchFind({ type: 'open' })
      setFindFocus(token => token + 1)
    }
    window.addEventListener('keydown', openFind)
    return () => window.removeEventListener('keydown', openFind)
  }, [activeId, addFileOpen, dispatchFind])

  const promptChars = promptCharacterCount(message, attachments)
  const sendBlocked = composerSendBlock(message, attachments)
  const canSubmit = ready && !historical && !resuming && sendBlocked !== 'oversized' && (!activePhases.has(projection.phase) || ['running', 'waiting_input', 'waiting_approval'].includes(projection.phase) || (projection.phase === 'starting' && metadataConnectionId.current === activeId)) && !projection.archived && (projection.phase !== 'disconnected' || unstartedConversation)
  const steering = ['running', 'waiting_input', 'waiting_approval'].includes(projection.phase) && Boolean(projection.capabilities?.steering)
  const sendIntent = sendButtonIntent({ active: activePhases.has(projection.phase), interrupting: projection.phase === 'interrupting', draft: Boolean(message.trim()), needsResume, steering, historical, canSubmit, submitting })
  const pendingSteering = projection.pendingSteering ?? []
  const queuedPrompts = projection.queuedPrompts ?? (projection.queued ? [projection.queued] : [])
  const capabilities = projection.capabilities
  const banner = runtimeBanner({ phase: projection.phase, historical, unstarted: unstartedConversation, archived: projection.archived, ready, resuming, canResume: Boolean(capabilities?.resume && projection.nativeSessionId) })
  const shownError = bannerAbsorbsError(banner, error) ? '' : cleanIpcError(error)
  const pending = projection.items.filter((item) => item.data.type === 'interaction' && item.data.interaction.status === 'pending').length
  const conversationItems = useMemo(() => projection.items.filter(isConversationActivity), [projection.items])
  // Independent of the windowed/reading-view slice below: the pin must reflect the true latest
  // prompt even while the visible window only covers older or newer activity.
  const pinnedPrompt = useMemo(() => latestOwnerPrompt(conversationItems), [conversationItems])
  const visibleItems = useMemo(() => {
    if (!readingWindow) return conversationItems.slice(-visibleCount)
    const latest = new Map(projection.items.map((item) => [item.id, item]))
    // Keep a bounded reading window; reconcile existing statuses without adding rows.
    return readingWindow.map((item) => latest.get(item.id) ?? item)
  }, [projection.items, conversationItems, visibleCount, readingWindow])
  useLayoutEffect(() => { lastVisibleItems.current = visibleItems }, [visibleItems])
  // The scroll-to-pinned-prompt jump goes through the same reading-window pin as a deliberate
  // scroll up, rather than a raw scrollTop write, so it does not fight autoscroll afterwards.
  const scrollToPinnedPrompt = (): void => {
    if (!pinnedPrompt) return
    userScrollUntil.current = Date.now() + 800
    nearBottom.current = false
    setReadingWindow((current) => {
      if (current?.some((item) => item.id === pinnedPrompt.id)) return current
      const index = conversationItems.findIndex((item) => item.id === pinnedPrompt.id)
      return index === -1 ? (current ?? lastVisibleItems.current) : conversationItems.slice(Math.max(0, index - 5))
    })
    setPendingPromptScroll(pinnedPrompt.id)
  }
  useLayoutEffect(() => {
    if (!pendingPromptScroll) return
    const element = timeline.current
    const card = element?.querySelector<HTMLElement>('[data-item-id="' + CSS.escape(pendingPromptScroll) + '"]')
    if (!element || !card) return
    element.scrollTop += card.getBoundingClientRect().top - element.getBoundingClientRect().top - 12
    card.classList.add('sa-activity-flash')
    window.clearTimeout(promptFlashTimer.current)
    promptFlashTimer.current = window.setTimeout(() => card.classList.remove('sa-activity-flash'), 1400)
    setPendingPromptScroll(null)
  }, [pendingPromptScroll, visibleItems])
  useLayoutEffect(() => {
    if (nearBottom.current && !readingWindow && !hasTimelineSelection(timeline.current, window.getSelection()) && timeline.current) {
      timeline.current.scrollTop = timeline.current.scrollHeight
      setNewOutput(false)
    }
  }, [visibleItems, readingWindow, projection.phase])
  useEffect(() => {
    // Images, syntax highlighting and pane resizes can change height after React's commit.
    const follow = (): void => {
      if (nearBottom.current && !hasTimelineSelection(timeline.current, window.getSelection()) && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight
    }
    const observer = new ResizeObserver(follow)
    if (timelineContent.current) observer.observe(timelineContent.current)
    if (timeline.current) observer.observe(timeline.current)
    return () => observer.disconnect()
  }, [activeId])
  useLayoutEffect(() => {
    if (!ready || historical) return
    const pendingItems = conversationItems.filter(item => item.runtimeId === projection.runtimeId && item.data.type === 'interaction' && item.data.interaction.status === 'pending')
    const added = pendingItems.find(item => !presentedRequests.current.has(item.id))
    for (const item of pendingItems) presentedRequests.current.add(item.id)
    if (!added || !nearBottom.current || hasTimelineSelection(timeline.current, window.getSelection())) return
    const element = timeline.current
    const card = element?.querySelector<HTMLElement>('[data-item-id="' + CSS.escape(added.id) + '"]')
    if (!element || !card) return
    nearBottom.current = false
    setReadingWindow(conversationItems.slice(-visibleCount))
    element.scrollTop += card.getBoundingClientRect().top - element.getBoundingClientRect().top - 12
  }, [conversationItems, ready, historical, projection.runtimeId, visibleCount])
  const findMatches = useMemo(() => find.open ? conversationMatches(conversationItems, find.query) : [], [find.open, find.query, conversationItems])
  const currentMatch = findMatches[Math.min(find.index, findMatches.length - 1)]
  // Everything but this conversation is searched in the main process against the store, so no
  // other projection is ever shipped here; typing only costs one debounced call.
  useEffect(() => {
    if (!find.open || find.query.trim().length < 2) { setFindResults(null); setFindSearching(false); return }
    let disposed = false
    setFindSearching(true)
    const timer = window.setTimeout(() => void window.conductor.structured.searchMessages(props.project.id, find.query, activeId)
      .then(result => { if (!disposed) setFindResults(result) })
      .catch(() => { if (!disposed) setFindResults(null) })
      .finally(() => { if (!disposed) setFindSearching(false) }), 180)
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [find.open, find.query, props.project.id, activeId])
  // A result opened from another conversation selects its match once that projection has loaded.
  useEffect(() => {
    if (!findJump) return
    const index = findMatches.findIndex(match => match.itemId === findJump)
    if (index >= 0) dispatchFind({ type: 'select', index, count: findMatches.length })
  }, [findJump, findMatches, dispatchFind])
  useLayoutEffect(() => {
    if (!find.open || !currentMatch) { findScrolled.current = ''; return }
    const key = activeId + ':' + currentMatch.itemId
    if (findScrolled.current === key) return
    const element = timeline.current
    const card = element?.querySelector<HTMLElement>('[data-item-id="' + CSS.escape(currentMatch.itemId) + '"]')
    if (!element || !card) {
      // The match is older than the rendered window; widen it once and scroll on the next commit.
      const index = conversationItems.findIndex(item => item.id === currentMatch.itemId)
      if (index >= 0 && findWidened.current !== key) { findWidened.current = key; nearBottom.current = false; setReadingWindow(conversationItems.slice(Math.max(0, index - 5))) }
      return
    }
    findScrolled.current = key
    nearBottom.current = false
    userScrollUntil.current = Date.now() + 800
    element.scrollTop += card.getBoundingClientRect().top - element.getBoundingClientRect().top - 12
    if (findJump === currentMatch.itemId) setFindJump(null)
  }, [find.open, currentMatch, conversationItems, visibleItems, activeId, findJump])
  useLayoutEffect(() => {
    const element = timeline.current
    // Streaming output must not pay for find: with the bar closed and nothing painted, stop here.
    if (!element || (!find.open && !findPainted.current)) return
    for (const marked of element.querySelectorAll('.sa-find-hit, .sa-find-current')) marked.classList.remove('sa-find-hit', 'sa-find-current')
    if (!find.open || !findMatches.length) { clearFindRanges(props.resourceId); findPainted.current = false; return }
    const others: Range[] = []
    let current: Range[] = []
    for (const match of findMatches) {
      const card = element.querySelector<HTMLElement>('[data-item-id="' + CSS.escape(match.itemId) + '"]')
      if (!card) continue
      card.classList.add('sa-find-hit')
      const ranges = collectQueryRanges(card, find.query)
      if (match === currentMatch) { card.classList.add('sa-find-current'); current = ranges } else others.push(...ranges)
    }
    paintFindRanges(props.resourceId, others, current)
    findPainted.current = true
  }, [find.open, find.query, findMatches, currentMatch, visibleItems])
  // Each pane owns its own entry in the shared highlight registry, so a closing pane drops only
  // its own ranges and leaves any other open find bar still painted.
  useEffect(() => () => { clearFindRanges(props.resourceId) }, [props.resourceId])
  const openFindHit = (sessionId: string, itemId: string): void => {
    if (sessionId !== activeId) {
      setReady(false)
      setActiveId(sessionId)
      setHistorical(sessionId !== props.resourceId)
    }
    setFindJump(itemId)
  }
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
  // Same identity notion the subagent roster counts by: same color and disambiguated name
  // everywhere a given subagent shows up, not a second, independent labeling scheme.
  const subagentRoster = useMemo(() => summarizeSubagents(projection.items, projection.runtimeId, projection.phase, false), [projection.items, projection.runtimeId, projection.phase])
  const subagentLabels = useMemo(() => distinguishSubagentLabels(subagentRoster), [subagentRoster])
  const parentLabels = useMemo(() => new Map(projection.items.flatMap(item => {
    if (!item.nativeItemId) return []
    const key = item.runtimeId + ':' + item.nativeItemId
    if (item.data.type === 'subagent') { const id = subagentIdentityId(item.data, item.runtimeId, item.nativeItemId, item.id); return [[key, { name: subagentLabels.get(id) ?? item.data.name, colorIndex: subagentColorIndex(id) }] as const] }
    if (item.data.type === 'tool') { const title = toolPresentation(item.data).title; return [[key, { name: title === item.data.name ? item.data.name : item.data.name + ': ' + title }] as const] }
    return []
  })), [projection.items, subagentLabels])
  const labelAnchors = useMemo(() => parentLabelAnchors(visibleItems), [visibleItems])
  const activityGroups = useMemo(() => groupConversationActivities(visibleItems), [visibleItems])
  // A composer choice belongs to the conversation, not to this mounting of the pane: switching
  // project or restarting must reopen on the model and effort the user picked, so the change is
  // saved with the conversation instead of waiting for a message that may never be sent.
  const updateSettings = (change: Partial<SessionSettings>): void => {
    rememberPermission(provider, change.permission, capabilities)
    const next = nextComposerSettings(settingsRef.current, change)
    settingsRef.current = next
    setSettings(next)
    if (historical) return
    void window.conductor.structured.saveSettings(activeId, next).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  const chooseCommand = (command: ComposerCommand): void => {
    setCommandDismissed(true); setCommandIndex(0)
    setMessage(command.insert ?? '')
    if (command.insert) { composer.current?.focus(); return }
    if (command.name === 'attach') setAddFileOpen(true)
    else if (command.name === 'browser' && command.trigger === '@') activateBrowserMention()
    else if (command.name === 'settings') setSettingsOpen(true)
    else if (command.name === 'model') pane.current?.querySelector<HTMLButtonElement>('[aria-label="Model"]')?.click()
    else if (command.name === 'history') setHistoryOpen(true)
    else if (command.name === 'plan') updateSettings({ plan: true })
    else if (command.name === 'edit') updateSettings({ plan: false, ...(provider === 'claude' ? { permission: 'accept-edits' as const } : {}) })
    else if (command.name === 'stop' && activePhases.has(projection.phase)) stop()
    else if (command.name === 'resume' && !activePhases.has(projection.phase)) void resume()
    else if (command.name === 'fork' && !activePhases.has(projection.phase)) void fork()
  }

  return <section ref={pane} className="structured-agent-pane" data-provider={provider} data-structured-session={activeId} onFocusCapture={() => { focusedAgent = { sessionId: activeId, projectId: props.project.id } }} onPointerDown={() => { focusedAgent = { sessionId: activeId, projectId: props.project.id } }}>
    <header className="sa-session-bar">
      <ProviderIcon provider={provider} size={15} />
      {props.onRequestCli && <div className="agent-view-switch"><button className="active" aria-pressed title="Chat"><MessagesSquare size={13} /> Chat</button><button title="Continue the same conversation in the native CLI" disabled={!ready || historical || activePhases.has(projection.phase) || Boolean(projection.queued)} onClick={() => props.onRequestCli?.(activeId)}><TerminalSquare size={13} /> CLI</button></div>}
      {activePhases.has(projection.phase) && <span className="sa-session-phase" role="status"><span className={'sa-session-dot status-' + projection.phase} />{projection.phase === 'starting' ? 'Connecting…' : projection.phase === 'running' ? ['Thinking', 'Spelunking', 'Working', 'Considering'][workingWord] : displayPhase(projection.phase)}</span>}
      {pending > 0 && <span className="sa-attention-badge" aria-label={pending + ' pending requests'}>{pending}</span>}
      <span className="sa-spacer" />
      <button aria-label="Local change history" title="Files this conversation changed, with revert" onClick={() => setChangesOpen(true)}><FileDiff size={15} /></button>
      <button aria-label="Conversation history" title="History" onClick={() => setHistoryOpen(true)}><History size={15} /></button>
      <button aria-label="Session settings" title="Conversation settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></button>
    </header>
    {settingsOpen && <AgentDialog title="Conversation settings" onClose={() => setSettingsOpen(false)}>
      <div className="sa-settings">
        <p className="sa-detail-hint">Changes apply to your next message.</p>
        <section className="sa-settings-section"><h3>Permissions</h3>
          {Boolean(capabilities?.sandboxModes?.length) && <label>Workspace access<select aria-label="Execution sandbox" value={settings.sandbox ?? 'inherit'} onChange={event => updateSettings({ sandbox: event.target.value as SessionSettings['sandbox'] })}>{capabilities?.sandboxModes?.map(mode => <option key={mode} value={mode}>{mode === 'inherit' ? 'Use saved settings' : mode === 'workspace-write' ? 'Workspace files' : 'Read only'}</option>)}</select></label>}
          {Boolean(capabilities?.approvalPolicies?.length) && <label>Approvals<select aria-label="Approval policy" value={settings.approvalPolicy ?? 'inherit'} onChange={event => updateSettings({ approvalPolicy: event.target.value as SessionSettings['approvalPolicy'] })}>{capabilities?.approvalPolicies?.map(policy => <option key={policy} value={policy}>{policy === 'inherit' ? 'Use saved settings' : policy === 'untrusted' ? 'Ask before commands' : policy === 'on-request' ? 'Ask when needed' : 'Never ask'}</option>)}</select></label>}
          {!capabilities && <p className="sa-detail-hint">Choose a model or start typing to load available settings.</p>}
        </section>
        <section className="sa-settings-section"><h3>Conversation</h3><div className="sa-detail-actions">
          <button onClick={() => { setSettingsOpen(false); setRename(projection.title || props.title) }}>Rename</button>
          {capabilities?.fork && <button disabled={activePhases.has(projection.phase)} onClick={() => void fork()}>Fork conversation</button>}
          <button onClick={() => void window.conductor.structured.archive(activeId, !projection.archived).catch((reason: unknown) => setError(String(reason)))}><Archive size={13} />{projection.archived ? 'Unarchive' : 'Archive'}</button>
          {capabilities?.resume && projection.nativeSessionId && <button disabled={activePhases.has(projection.phase)} onClick={() => void resume()}>Resume connection</button>}
        </div></section>
        <details className="sa-diagnostics"><summary>Advanced & diagnostics</summary>
          <dl><dt>Connection</dt><dd>{name} {capabilities?.runtimeVersion ?? ''}</dd><dt>Sign-in</dt><dd>{capabilities?.authentication === 'cli' ? 'Existing local sign-in' : capabilities?.authentication ?? 'Not connected'}</dd></dl>
          <div className="sa-detail-actions"><button aria-label="Inspect provider events" onClick={() => { setSettingsOpen(false); setEventsOpen(true) }}><ListTree size={13} /> Event log</button><button onClick={() => { setSettingsOpen(false); void discover() }}>Skills & connections</button></div>
          <details><summary>Connection details</summary><p>Conversation: <code>{activeId}</code></p><p>Session: <code>{projection.nativeSessionId ?? 'Not started'}</code></p><p>Workspace: <code>{props.project.path}</code></p>{Boolean(capabilities?.limitations.length) && <ul>{capabilities?.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>}<p>Work continues while panes are hidden. Closing the app disconnects the session.</p></details>
          {capabilities?.effectiveSettings && <details><summary>Effective settings</summary><pre>{JSON.stringify(capabilities.effectiveSettings, null, 2)}</pre></details>}
        </details>
      </div>
    </AgentDialog>}
    {shownError && <div className="sa-error-bar" role="alert"><span>{shownError}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={13} /></button></div>}
    {historical && <div className="sa-history-banner" role="status"><span><strong>{resuming ? 'Reconnecting conversation...' : 'Previewing saved conversation'}</strong><small>{projection.title || 'Saved messages'} ? Resume to continue from here.</small></span><button disabled={resuming} onClick={() => { setReady(false); setActiveId(props.resourceId); setHistorical(false) }}><ArrowLeft size={13} /> Back to current</button>{capabilities?.resume && projection.nativeSessionId && <button disabled={!ready || resuming || projection.archived} onClick={() => void resume()}>{resuming ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}{resuming ? 'Reconnecting...' : 'Resume this conversation'}</button>}</div>}
    {banner && <div className="sa-runtime-banner" role="status"><PlugZap size={15} aria-hidden="true" /><span><strong>{banner.title}</strong><small>{banner.detail}</small></span>{banner.resume && <button className="sa-runtime-resume" disabled={banner.disabled} onClick={() => void resume()}>{resuming ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}{resuming ? 'Reconnecting...' : 'Resume conversation'}</button>}</div>}
    {find.open && <ConversationFindBar query={find.query} count={findMatches.length} index={find.index} results={findResults} searching={findSearching} focusToken={findFocus} onQuery={query => dispatchFind({ type: 'query', query })} onStep={direction => dispatchFind({ type: 'step', direction, count: findMatches.length })} onOpenHit={openFindHit} onClose={() => { dispatchFind({ type: 'close' }); if (composer.current && !composer.current.disabled) composer.current.focus(); else timeline.current?.focus() }} />}
    <div className="sa-timeline-wrap"><div className="sa-timeline" ref={timeline} role="region" aria-label={name + ' conversation'} tabIndex={0} onWheel={event => { userScrollUntil.current = Date.now() + 800; if (event.deltaY < 0) { nearBottom.current = false; setReadingWindow(current => current ?? lastVisibleItems.current) } }} onTouchMove={() => { userScrollUntil.current = Date.now() + 800 }} onPointerDown={event => { if (event.target === timeline.current) userScrollUntil.current = Date.now() + 2000 }} onKeyDown={event => { if (event.target === timeline.current && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) { userScrollUntil.current = Date.now() + 800; if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) nearBottom.current = false } }} onScroll={() => {
      const el = timeline.current
      // Layout and content growth can emit scroll events too. Only user input
      // should release automatic following while the view is pinned to the end.
      if (nearBottom.current && Date.now() > userScrollUntil.current) return
      nearBottom.current = Boolean(el && followsBottomAfterScroll(nearBottom.current, el))
      if (!nearBottom.current) setReadingWindow((current) => current ?? lastVisibleItems.current)
      else if (!hasTimelineSelection(el, window.getSelection())) { setReadingWindow(null); setNewOutput(false) }
    }}><div ref={timelineContent} className="sa-timeline-content">
      {pinnedPrompt && <button type="button" className="sa-pinned-prompt" title={pinnedPrompt.text} aria-label={'Scroll to your last message: ' + pinnedPrompt.text} onClick={scrollToPinnedPrompt}><Pin size={11} aria-hidden="true" /><span>{truncatePromptPreview(pinnedPrompt.text)}</span></button>}
      {(!ready || !conversationItems.length) && <div className="sa-empty"><strong>{ready ? 'What are we working on?' : 'Opening conversation…'}</strong>{ready && <p>Ask {name} about your code, or describe a change.</p>}</div>}
      {earlierCount > 0 && <button className="sa-load-earlier" onClick={showEarlier}>Show earlier activities ({earlierCount})</button>}
      {projection.truncated && <button className="sa-load-earlier" onClick={() => setHistoryOpen(true)}>Open conversation history</button>}
      {ready && activityGroups.map(group => {
        const activities = group.map(item => <StructuredActivity key={item.id} item={item} sessionId={activeId} projectId={props.project.id} onInspectAttachment={setInspectAttachment} cwd={props.project.path} expanded={expansion[item.id] ?? false} interactive={!historical && item.runtimeId === projection.runtimeId} parentLabel={item.parentId && labelAnchors.has(item.id) ? parentLabels.get(item.runtimeId + ':' + item.parentId) : undefined} onExpand={onExpand} onOpenFile={onOpenFile} onDiff={setDiff} onRespond={onRespond} />)
        // A recall belongs to the message it was injected with, so it renders directly under it.
        const recall = group.length === 1 && group[0]!.nativeItemId ? recallByItem.get(group[0]!.nativeItemId) : undefined
        if (recall) return <div className="sa-turn" key={group[0]!.id}>{activities[0]}<MemoryRecallStrip recall={recall} onChanged={loadTurnRecalls} /></div>
        if (group.length === 1) return activities[0]
        const coalesced = coalescedEditSummary(group)
        return <details className="sa-completed-group" key={group[0]!.id}><summary>{coalesced ? coalescedEditLabel(coalesced) : `${group.length} completed actions`}</summary><div>{activities}</div></details>
      })}
      {(projection.phase === 'running' || projection.phase === 'starting') && <div className="sa-working" role="status"><i />{projection.phase === 'starting' ? 'Connecting…' : ['Thinking…', 'Spelunking…', 'Working…', 'Considering…'][workingWord]}<StructuredLiveTokens items={projection.items} /></div>}
    </div></div>{newOutput && <button className="sa-jump" onClick={jumpToLatest}><ArrowDown size={13} /> New output · Jump to latest</button>}</div>
    <StructuredAgentTelemetry key={activeId} items={projection.items} runtimeId={projection.runtimeId} phase={projection.phase} truncated={projection.truncated} sessionId={activeId} cwd={props.project.path} projectId={props.project.id} interactive={!historical} onInspectAttachment={setInspectAttachment} onOpenFile={onOpenFile} onDiff={setDiff} onRespond={onRespond} />
    <form className="sa-composer agent-prompt-surface" onSubmit={event => { event.preventDefault(); void submit() }}>
      {pendingSteering.length > 0 && <div className="sa-queue-list" aria-label="Pending steering messages">{pendingSteering.map(input => <div className="sa-queue sa-steering-prompt" key={input.id}>
        <strong>{input.status === 'sending' ? 'Sending' : input.status === 'accepted' ? 'Received' : input.status === 'cancelled' ? 'Not sent' : 'Delivery uncertain'}</strong>
        <span title={input.text}>{input.text}</span>
        <small role="status">{input.status === 'sending' ? 'Waiting for the agent to acknowledge this message' : input.status === 'accepted' ? 'Message will be sent after the next tool use. Esc interrupts and sends now.' : input.status === 'cancelled' ? 'The agent cancelled this message before receiving it' : 'Check the conversation before resending'}</small>
        {['cancelled', 'uncertain'].includes(input.status) && <button type="button" aria-label="Return steering message to draft" title="Return this message to the composer" onClick={() => {
          void window.conductor.structured.cancelQueued(activeId, input.id).then(queued => { if (!queued) return; setMessage(draftRef.current.message ? draftRef.current.message + '\n\n' + queued.text : queued.text); setAttachments(current => [...current, ...queued.attachments].slice(-20)); composer.current?.focus() }).catch(reason => setError(String(reason)))
        }}><X size={12} /></button>}
      </div>)}</div>}
      {queuedPrompts.length > 0 && <div className="sa-queue-list" aria-label="Queued messages">{queuedPrompts.map((prompt, index) => <div className="sa-queue" key={prompt.id}><strong>Queued {index + 1}</strong><span title={prompt.text}>{prompt.text}</span>{prompt.attachments.length > 0 && <small>{prompt.attachments.length} attached</small>}<button type="button" title="Return queued message to draft" aria-label={'Remove queued message ' + (index + 1)} onClick={() => {
        void window.conductor.structured.cancelQueued(activeId, prompt.id).then((queued) => { if (!queued) return; setMessage(draftRef.current.message ? draftRef.current.message + '\n\n' + queued.text : queued.text); setAttachments((current) => [...current, ...queued.attachments].slice(-20)); composer.current?.focus() }).catch((reason: unknown) => setError(String(reason)))
      }}><X size={12} /></button></div>)}</div>}
      {attachments.length > 0 && <div className="sa-context-chips">{attachments.map(attachment => <span key={attachment.id}><button type="button" title="Inspect attached context" onClick={() => setInspectAttachment(attachment)}>{attachment.kind === 'image' && <PromptImageThumbnail projectId={props.project.id} attachment={attachment} />}{attachment.name}{attachment.startLine ? ':' + attachment.startLine + (attachment.endLine ? '–' + attachment.endLine : '') : ''}</button><button type="button" aria-label={'Remove context ' + attachment.name} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}><X size={11} /></button></span>)}</div>}
      {promptChars > MAX_PROMPT_CHARS * 0.9 && <p className={'sa-prompt-limit' + (sendBlocked === 'oversized' ? ' sa-prompt-limit-over' : '')} role="status">{sendBlocked === 'oversized' ? `Too large to send: ${promptChars.toLocaleString()} of ${MAX_PROMPT_CHARS.toLocaleString()} characters including attachments. Remove or shorten an attachment, or trim the message.` : `${promptChars.toLocaleString()} / ${MAX_PROMPT_CHARS.toLocaleString()} characters`}</p>}
      {commandsOpen && <CommandAutocomplete id={commandListId} commands={commands} selected={Math.min(commandIndex, commands.length - 1)} loading={commandLoading} onSelect={setCommandIndex} onChoose={chooseCommand} />}
      <textarea ref={composer} aria-autocomplete="list" aria-controls={commandsOpen ? commandListId : undefined} aria-expanded={commandsOpen} aria-activedescendant={commandsOpen ? commandListId + '-' + Math.min(commandIndex, commands.length - 1) : undefined} aria-label={'Message ' + name} placeholder={historical ? 'Resume this conversation to send a message' : projection.archived ? 'Unarchive this conversation to send a message' : steering ? 'Message after the next tool use' : activePhases.has(projection.phase) ? 'Queue a message after this turn' : 'Message ' + name} value={message} disabled={!ready || historical || resuming || projection.archived} rows={2} onFocus={() => { if (ready && !historical && !projection.nativeSessionId && !activePhases.has(projection.phase)) void connect().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }} onBlur={() => setCommandDismissed(true)} onChange={event => { setMessage(event.target.value); setCommandDismissed(false); setCommandIndex(0) }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (commandsOpen) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCommandDismissed(true); return }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex(current => (current + (event.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length); return }
          if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); chooseCommand(commands[Math.min(commandIndex, commands.length - 1)]!); return }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
      }} />
      <footer className="agent-prompt-controls">
        <PromptImageUpload key={composerChildKey('images', activeId)} projectId={props.project.id} disabled={historical || !capabilities?.imageAttachments} onError={setError} onAttach={(images) => setAttachments(current => { if (current.length + images.length > 20) { setError('A prompt can have up to 20 attachments. Remove some and attach these images again.'); return current }; return [...current, ...images] })} />
        <button type="button" aria-label="Attach file context" title="Attach context" disabled={historical} onClick={() => setAddFileOpen(open => !open)}><FilePlus2 size={15} /></button>
        <button type="button" className={browserPanelOpen ? 'active' : undefined} aria-pressed={browserPanelOpen} aria-label={browserPanelOpen ? 'Close browser tab' : 'Open browser tab'} title="Browser tab (the surface the browser tools drive)" onClick={activateBrowserMention}><Globe2 size={15} /></button>
        <StructuredComposerControls key={composerChildKey('controls', activeId)} settings={settings} capabilities={capabilities} disabled={historical || !ready} onChange={updateSettings} onDiscover={connect} />
        <StructuredUsageSummary key={composerChildKey('usage', activeId)} items={projection.items} runtimeId={projection.runtimeId} truncated={projection.truncated} modelLabel={resolvedComposerSettings(settings, capabilities).label} agentSessionId={activeId} workspaceId={props.session.id} />
        <span className="sa-spacer" />
        <StructuredSendButton {...sendIntent} busy={activePhases.has(projection.phase)} onActivate={() => { if (sendIntent.state === 'stop') stop(); else void resume() }} />
      </footer>
      {addFileOpen && <FileAttachmentInput projectId={props.project.id} value={filePath} onChange={setFilePath} onAttach={(path) => void addFile(path)} onClose={() => { setAddFileOpen(false); composer.current?.focus() }} />}
    </form>
    {diff && <ImmutableDiff sessionId={activeId} change={diff} onOpenFile={onOpenFile} onClose={() => setDiff(null)} />}
    {changesOpen && <AgentChangeHistoryView sessionId={activeId} title={projection.title || props.title} busy={activePhases.has(projection.phase)} onOpenFile={onOpenFile} onClose={() => setChangesOpen(false)} />}
    {inspectAttachment && <AgentDialog title={'Context · ' + inspectAttachment.name} onClose={() => setInspectAttachment(null)}><p className="sa-notice">{inspectAttachment.kind === 'image' ? 'This attached image stays available when you switch projects or reopen the conversation.' : 'This content will be submitted with your message. File content is captured when attached.'}</p>{inspectAttachment.kind === 'image' && imagePreviews[inspectAttachment.id] && <img className="sa-context-image" alt={inspectAttachment.name} src={imagePreviews[inspectAttachment.id]} />}{inspectAttachment.kind !== 'image' && <pre className="sa-expanded-output">{inspectAttachment.content ?? inspectAttachment.path ?? 'No content'}</pre>}</AgentDialog>}
    {eventsOpen && <AgentDialog title="Event log" onClose={() => setEventsOpen(false)}><p className="sa-notice">Diagnostics only. Showing the latest {rawEvents.length} events.</p><div className="sa-diff-toolbar"><button onClick={() => void copyText(JSON.stringify(rawEvents, null, 2))}>Copy events</button><button onClick={() => void window.conductor.structured.events(activeId).then((events) => setRawEvents(events.slice(-200)))}>Refresh</button></div><div className="sa-event-list">{rawEvents.map((event) => <details key={event.id}><summary>#{event.sequence} · {event.data.type} · {event.native?.method ?? event.itemId ?? event.requestId ?? ''}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</div></AgentDialog>}
    {historyOpen && <AgentDialog title="Conversation history" onClose={() => setHistoryOpen(false)}><input className="sa-history-search" aria-label="Search conversation history" placeholder="Search conversations" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /><p className="sa-history-help">Choose a conversation to preview its messages, then resume when you are ready to continue.</p>{historyLoading && <p className="sa-history-loading" role="status"><LoaderCircle size={13} className="spin" /> Loading conversations...</p>}<div className="sa-history-list" aria-busy={historyLoading}>{historyItems.map((item) => <button key={item.id} title="Preview saved conversation" onClick={() => { if (item.id !== activeId) setReady(false); setActiveId(item.id); setHistorical(item.id !== props.resourceId); setHistoryOpen(false) }}><strong>{item.title || 'Untitled conversation'}</strong><small>{item.provider} · {displayPhase(item.phase)}{item.archived ? ' · archived' : ''}</small></button>)}{!historyLoading && !historyItems.length && <p>No saved conversations match.</p>}</div></AgentDialog>}
    {discovery !== undefined && <AgentDialog title={name + ' configuration'} onClose={() => setDiscovery(undefined)}><p className="sa-notice">Read-only details of configured skills, commands and connections. Nothing here runs a command or changes your configuration.</p><div className="sa-event-list">{discovery && typeof discovery === 'object' && !Array.isArray(discovery) ? Object.entries(discovery).map(([category, value]) => <details key={category}><summary>{category.replaceAll('_', ' ')}</summary><pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></details>) : <pre>{JSON.stringify(discovery, null, 2)}</pre>}</div></AgentDialog>}
    {rename !== null && <AgentDialog title="Rename conversation" onClose={() => setRename(null)}><form className="sa-rename" onSubmit={(event) => { event.preventDefault(); const title = rename.trim(); if (!title) return; void window.conductor.structured.rename(activeId, title).then(() => { setProjection((current) => ({ ...current, title })); return propsRef.current.onConversationChange?.({ ...conversationIdentity(projection, provider), title, manual: true }) }).then(() => setRename(null)).catch((reason: unknown) => setError(String(reason))) }}><input autoFocus aria-label="Conversation title" maxLength={160} value={rename} onChange={(event) => setRename(event.target.value)} /><button type="submit">Save name</button></form></AgentDialog>}
  </section>
}
