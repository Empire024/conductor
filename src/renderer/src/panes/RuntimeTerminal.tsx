import type { ConversationIdentity } from './conversation-tab'
import { NativeCliPane } from './NativeCliPane'
import { copyTextWithFeedback } from '../clipboard'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { AlertTriangle, CircleStop, ExternalLink, ListTree, MessagesSquare, MoreHorizontal, RefreshCw, ShieldCheck, TerminalSquare, TimerReset, X } from 'lucide-react'
import type {
  AgentActivityPhase,
  AgentEffort,
  AgentProviderId,
  AgentSpec,
  NormalizedAgentEvent,
  ProjectRecord,
  RuntimeEnsureResult,
  RuntimeStatusEvent,
  SessionRecord,
  TerminalSpec
} from '../../../shared/models'
import { AgentPrompt, type AgentPromptMode } from './AgentPrompt'
import { AgentConversation } from './AgentConversation'
import { runtimeModelLabel } from '../agent-models'
import { dispatchAgentContext, StructuredAgentPane } from './StructuredAgentPane'
import { extractAgentScreenSnapshot, joinWrappedTerminalRows } from './agent-screen'
import './AgentPrompt.css'

export interface RuntimeTerminalProps {
  mode: 'terminal' | 'agent'
  resourceId: string
  title: string
  provider?: AgentProviderId
  resume?: boolean
  model?: string
  effort?: AgentEffort
  continueOnLimit?: boolean
  viewMode?: 'visual' | 'cli'
  project: ProjectRecord
  session: SessionRecord
  onOpenFile?(path: string, line?: number): void
  onModelChange?(model: string): void
  onEffortChange?(effort: AgentEffort): void
  onViewModeChange?(viewMode: 'visual' | 'cli'): void
  onRequestCli?(id: string): void
  conversationId?: string
  onConversationChange?(conversation: ConversationIdentity): Promise<void>
}

const terminalTheme = {
  background: '#011627',
  foreground: '#d6deeb',
  cursor: '#80a4c2',
  cursorAccent: '#011627',
  selectionBackground: '#1d3b5359',
  black: '#011627',
  red: '#ef5350',
  green: '#addb67',
  yellow: '#ecc48d',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#7fdbca',
  white: '#d6deeb',
  brightBlack: '#637777',
  brightRed: '#ef5350',
  brightGreen: '#addb67',
  brightYellow: '#ffeb95',
  brightBlue: '#82aaff',
  brightMagenta: '#c792ea',
  brightCyan: '#7fdbca',
  brightWhite: '#ffffff'
}

const lightTerminalTheme = {
  background: '#f6f8fa',
  foreground: '#403f53',
  cursor: '#2aa298',
  cursorAccent: '#f6f8fa',
  selectionBackground: '#d9e7f7',
  black: '#403f53', red: '#d3423e', green: '#2aa298', yellow: '#a26b00',
  blue: '#4876d6', magenta: '#994cc3', cyan: '#08916a', white: '#f6f8fa',
  brightBlack: '#8991a5', brightRed: '#d3423e', brightGreen: '#2aa298', brightYellow: '#a26b00',
  brightBlue: '#4876d6', brightMagenta: '#994cc3', brightCyan: '#08916a', brightWhite: '#ffffff'
}

export function RuntimeTerminal(props: RuntimeTerminalProps): React.JSX.Element {
  if (props.mode === 'agent' && (props.provider === 'codex' || props.provider === 'claude' || !props.provider)) {
    return <StructuredRuntime {...props} />
  }
  return <TerminalRuntimePane {...props} />
}

function StructuredRuntime(props: RuntimeTerminalProps): React.JSX.Element {
  const [view, setView] = useState(props.viewMode ?? 'visual')
  const [conversation, setConversation] = useState(props.resourceId)
  const changeView = (next: 'visual' | 'cli'): void => { setView(next); props.onViewModeChange?.(next) }
  useEffect(() => {
    const off = window.conductor.structured.onEvents((events) => {
      const event = events.filter((item) => item.sessionId === conversation && item.data.type === 'session' && item.data.view).at(-1)
      if (event?.data.type === 'session' && event.data.view) changeView(event.data.view)
    })
    void window.conductor.structured.snapshot(conversation).then((state) => { if (state?.view) changeView(state.view) })
    return off
  }, [conversation])
  return view === 'cli' ? <NativeCliPane {...props} resourceId={conversation} onChat={async () => { await window.conductor.nativeCli.chat(conversation); changeView('visual') }} />
    : <StructuredAgentPane {...props} conversationId={conversation} onConversationChange={async identity => {
      await props.onConversationChange?.(identity)
      setConversation(identity.id)
    }} onRequestCli={(id) => {
      setConversation(id)
      void window.conductor.nativeCli.ensure(id).then(() => changeView('cli')).catch((reason: unknown) => window.dispatchEvent(new CustomEvent('conductor:toast', { detail: String(reason) })))
    }} />
}

function TerminalRuntimePane(props: RuntimeTerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const specRef = useRef<TerminalSpec | AgentSpec | null>(null)
  const openFileRef = useRef(props.onOpenFile)
  const phaseRef = useRef<AgentActivityPhase>('idle')
  const lastSubmittedMessageRef = useRef('')
  const lastScreenResponseRef = useRef('')
  const autoTrustRespondedRef = useRef(false)
  const trustStorageKey = `conductor.directoryTrust.${props.project.id}`
  const [workspaceTrusted, setWorkspaceTrusted] = useState(() => localStorage.getItem(trustStorageKey) === 'true')
  const workspaceTrustedRef = useRef(workspaceTrusted)
  workspaceTrustedRef.current = workspaceTrusted
  openFileRef.current = props.onOpenFile
  const [runtime, setRuntime] = useState<RuntimeEnsureResult | null>(null)
  const [phase, setPhase] = useState<AgentActivityPhase>('idle')
  const [activityOpen, setActivityOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [blockingInteraction, setBlockingInteraction] = useState<'directory_trust' | null>(null)
  const [events, setEvents] = useState<NormalizedAgentEvent[]>([])
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof window.conductor.agents.listProviders>>>([])
  const [modelDraft, setModelDraft] = useState(props.model ?? 'default')
  const [liveResponse, setLiveResponse] = useState('')
  const [reconfiguring, setReconfiguring] = useState(false)
  const reconfiguringRef = useRef(false)
  phaseRef.current = phase

  const makeSpec = useCallback((): TerminalSpec | AgentSpec => {
    const base = {
      id: props.resourceId,
      projectId: props.project.id,
      sessionId: props.session.id,
      title: props.title,
      cwd: props.project.path
    }
    if (props.mode === 'agent') {
      return {
        ...base,
        provider: props.provider ?? 'codex',
        resume: props.resume,
        model: props.model ?? 'default',
        effort: props.effort ?? 'auto',
        continueOnLimit: props.continueOnLimit
      } satisfies AgentSpec
    }
    return { ...base, shell: undefined } satisfies TerminalSpec
  }, [
    props.mode,
    props.effort,
    props.model,
    props.project.id,
    props.project.path,
    props.provider,
    props.resourceId,
    props.resume,
    props.continueOnLimit,
    props.session.id,
    props.title
  ])
  const makeSpecRef = useRef(makeSpec)
  makeSpecRef.current = makeSpec

  const fit = useCallback(() => {
    try {
      fitRef.current?.fit()
      const terminal = terminalRef.current
      if (!terminal) return
      if (props.mode === 'agent') {
        window.conductor.agents.resize(props.resourceId, terminal.cols, terminal.rows)
      } else {
        window.conductor.terminals.resize(props.resourceId, terminal.cols, terminal.rows)
      }
    } catch {
      // Hidden tab containers can briefly have zero width.
    }
  }, [props.mode, props.resourceId])

  useEffect(() => {
    const syncTrust = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId: string; trusted: boolean }>).detail
      if (detail.projectId !== props.project.id) return
      workspaceTrustedRef.current = detail.trusted
      setWorkspaceTrusted(detail.trusted)
    }
    window.addEventListener('conductor:directory-trust-changed', syncTrust)
    return () => window.removeEventListener('conductor:directory-trust-changed', syncTrust)
  }, [props.project.id])

  useEffect(() => {
    if (!workspaceTrusted || autoTrustRespondedRef.current || props.mode !== 'agent') return
    const terminal = terminalRef.current
    if (!terminal) return
    const rows: Array<{ text: string; wrapped: boolean }> = []
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      const line = terminal.buffer.active.getLine(index)
      rows.push({ text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false })
    }
    if (extractAgentScreenSnapshot(joinWrappedTerminalRows(rows), props.provider ?? 'codex').interaction !== 'directory_trust') return
    autoTrustRespondedRef.current = true
    window.conductor.agents.respond(props.resourceId, props.provider === 'claude' ? '\u001b[B\r' : '\r')
  }, [props.mode, props.provider, props.resourceId, workspaceTrusted])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.34,
      letterSpacing: 0.1,
      scrollback: 12000,
      theme: document.documentElement.dataset.theme === 'light' ? lightTerminalTheme : terminalTheme
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fitAddon
    let replayingTranscript = true

    terminal.attachCustomKeyEventHandler((event) => {
      if (props.mode !== 'agent' || event.type !== 'keydown' || !event.ctrlKey || event.key.toLowerCase() !== 'c') return true
      const selection = terminal.getSelection()
      if (selection) {
        void copyTextWithFeedback(selection, `Copied ${selection.length.toLocaleString()} characters`)
      } else window.conductor.agents.interrupt(props.resourceId)
      return false
    })
    const selection = terminal.onSelectionChange(() => {
      const text = terminal.getSelection()
      if (!text) return
      void copyTextWithFeedback(text, `Copied ${text.length.toLocaleString()} characters`)
    })

    const linkRegistration = openFileRef.current
      ? terminal.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const text = terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? ''
            const pattern = /((?:[A-Za-z]:[\\/])?(?:[\w@.+-]+[\\/])+[\w@.+-]+\.[A-Za-z0-9]+)(?::(\d+))?/g
            const links = [...text.matchAll(pattern)].flatMap((match) => {
              const rawPath = match[1]!
              let normalized = rawPath.replaceAll('\\', '/')
              const projectPrefix = `${props.project.path.replaceAll('\\', '/')}/`
              if (normalized.toLowerCase().startsWith(projectPrefix.toLowerCase())) {
                normalized = normalized.slice(projectPrefix.length)
              } else if (/^[A-Za-z]:\//.test(normalized)) {
                return []
              }
              normalized = normalized.replace(/^\.\//, '')
              const start = (match.index ?? 0) + 1
              return [{
                range: {
                  start: { x: start, y: bufferLineNumber },
                  end: { x: start + rawPath.length - 1, y: bufferLineNumber }
                },
                text: match[0],
                activate: () => openFileRef.current?.(normalized, match[2] ? Number(match[2]) : undefined)
              }]
            })
            callback(links)
          }
        })
      : null

    let screenCaptureTimer = 0
    const captureScreen = (force = false): void => {
      screenCaptureTimer = 0
      if (props.mode !== 'agent') return
      const buffer = terminal.buffer.active
      const rows: Array<{ text: string; wrapped: boolean }> = []
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index)
        rows.push({ text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false })
      }
      const snapshot = extractAgentScreenSnapshot(
        joinWrappedTerminalRows(rows),
        props.provider ?? 'codex',
        lastSubmittedMessageRef.current
      )
      if (snapshot.interaction === 'directory_trust') {
        if (workspaceTrustedRef.current) {
          if (!autoTrustRespondedRef.current) {
            autoTrustRespondedRef.current = true
            window.conductor.agents.respond(props.resourceId, props.provider === 'claude' ? '\u001b[B\r' : '\r')
            window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Trusted workspace automatically' }))
          }
        } else window.conductor.agents.reportInteraction(props.resourceId, snapshot.interaction)
        return
      }
      if (!force && phaseRef.current !== 'working') return
      if (snapshot.body && snapshot.body !== lastScreenResponseRef.current) {
        lastScreenResponseRef.current = snapshot.body
        setLiveResponse(snapshot.body)
      }
      window.conductor.agents.captureVisual(
        props.resourceId,
        snapshot.settled ? snapshot.body : '',
        snapshot.active,
        snapshot.settled
      )
    }
    const scheduleScreenCapture = (): void => {
      if (props.mode !== 'agent' || screenCaptureTimer) return
      screenCaptureTimer = window.setTimeout(captureScreen, 650)
    }
    const offData =
      props.mode === 'agent'
        ? window.conductor.agents.onData(({ id, data }) => {
            if (id === props.resourceId) terminal.write(data, scheduleScreenCapture)
          })
        : window.conductor.terminals.onData(({ id, data }) => {
            if (id === props.resourceId) terminal.write(data)
          })
    const onStatus = (event: RuntimeStatusEvent): void => {
      if (event.id !== props.resourceId) return
      setRuntime((current) =>
        current ? { ...current, status: event.status, message: event.message, resumeAt: event.resumeAt, model: event.model ?? current.model } : current
      )
      if (props.mode === 'agent') {
        const nextPhase: AgentActivityPhase = event.phase ?? (
          event.status === 'waiting_input' || event.status === 'limited' || event.status === 'complete'
            ? event.status
            : event.status === 'error' ? 'failed' : 'idle'
        )
        setPhase(nextPhase)
        if (nextPhase !== 'waiting_input') setBlockingInteraction(null)
        window.dispatchEvent(new CustomEvent('conductor:agent-activity', {
          detail: { id: props.resourceId, phase: nextPhase, resumeAt: event.resumeAt }
        }))
      }
    }
    const offStatus =
      props.mode === 'agent'
        ? window.conductor.agents.onStatus(onStatus)
        : window.conductor.terminals.onStatus(onStatus)

    const input = terminal.onData((data) => {
      // Restored ANSI transcripts can contain device-status queries. Their xterm replies
      // belong to the old process and must never be sent into the newly resumed shell.
      if (replayingTranscript) return
      if (props.mode === 'agent') {
        if (/[\r\n]/.test(data)) {
          lastSubmittedMessageRef.current = ''
          lastScreenResponseRef.current = ''
          setLiveResponse('')
        }
        window.conductor.agents.write(props.resourceId, data)
      }
      else window.conductor.terminals.write(props.resourceId, data)
    })

    const spec = makeSpecRef.current()
    specRef.current = spec
    const ensure =
      props.mode === 'agent'
        ? window.conductor.agents.ensure(spec as AgentSpec)
        : window.conductor.terminals.ensure(spec as TerminalSpec)
    void ensure.then((result) => {
      setRuntime(result)
      if (props.mode === 'agent') {
        const nextPhase: AgentActivityPhase = result.status === 'running' || result.status === 'starting' || result.status === 'exited' ? 'idle' :
          // The CLI could not be found or the run errored: both are failures to report, not idleness.
          result.status === 'unavailable' || result.status === 'error' ? 'failed' : result.status
        setPhase(nextPhase)
        window.dispatchEvent(new CustomEvent('conductor:agent-activity', {
          detail: { id: props.resourceId, phase: nextPhase, resumeAt: result.resumeAt }
        }))
      }
      if (result.transcript) {
        terminal.write(result.transcript, () => {
          replayingTranscript = false
          requestAnimationFrame(fit)
          screenCaptureTimer = window.setTimeout(() => captureScreen(true), 850)
        })
      } else {
        replayingTranscript = false
        requestAnimationFrame(fit)
      }
    }).catch((error: unknown) => {
      replayingTranscript = false
      const message = error instanceof Error ? error.message : 'Runtime connection failed'
      setRuntime({ id: props.resourceId, available: false, status: 'error', transcript: '', message })
      // Reaching the runtime failed outright, which is a disconnection rather than a failed run.
      setPhase('disconnected')
      if (props.mode === 'agent') {
        window.dispatchEvent(new CustomEvent('conductor:agent-activity', {
          detail: { id: props.resourceId, phase: 'disconnected' }
        }))
      }
    })

    const observer = new ResizeObserver(() => fit())
    observer.observe(host)
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = document.documentElement.dataset.theme === 'light' ? lightTerminalTheme : terminalTheme
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    requestAnimationFrame(fit)

    return () => {
      observer.disconnect()
      if (screenCaptureTimer) window.clearTimeout(screenCaptureTimer)
      themeObserver.disconnect()
      selection.dispose()
      input.dispose()
      offData()
      offStatus()
      linkRegistration?.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [fit, props.mode, props.resourceId])

  useEffect(() => {
    if (props.mode !== 'agent') return
    void window.conductor.agents.listProviders().then(setProviders)
  }, [props.mode])

  useEffect(() => setModelDraft(props.model ?? 'default'), [props.model])

  useEffect(() => {
    if (props.mode !== 'agent') return
    void window.conductor.agents.listEvents(props.resourceId).then((stored) => {
      setEvents((current) => {
        const merged = new Map([...stored, ...current].map((event) => [event.id, event]))
        return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-160)
      })
    })
    return window.conductor.agents.onEvent((event) => {
      if (event.agentSessionId !== props.resourceId) return
      setEvents((current) => [...current.filter((item) => item.id !== event.id), event].slice(-160))
      if (event.type === 'question' && event.metadata?.kind === 'directory_trust') setBlockingInteraction('directory_trust')
      if (event.type === 'text' && event.metadata?.source === 'terminal_screen') setLiveResponse('')
    })
  }, [props.mode, props.resourceId])

  const restart = async (): Promise<void> => {
    const spec = specRef.current
    if (!spec) return
    autoTrustRespondedRef.current = false
    terminalRef.current?.clear()
    if (props.mode === 'agent') setPhase('idle')
    const result =
      props.mode === 'agent'
        ? await window.conductor.agents.restart(spec as AgentSpec)
        : await window.conductor.terminals.restart(spec as TerminalSpec)
    setRuntime(result)
    terminalRef.current?.focus()
  }

  const changeModel = async (requestedModel = modelDraft): Promise<void> => {
    if (props.mode !== 'agent' || reconfiguringRef.current) return
    const model = requestedModel.trim() || 'default'
    const currentSpec = specRef.current as AgentSpec | null
    if (model === (currentSpec?.model ?? props.model ?? 'default')) return
    const spec = { ...(currentSpec ?? makeSpec()), model } as AgentSpec
    reconfiguringRef.current = true
    setReconfiguring(true)
    setModelDraft(model)
    try {
      const result = await window.conductor.agents.restart(spec)
      if (!result.available || result.status === 'error' || result.status === 'exited') {
        throw new Error(result.message ?? `Could not switch to ${model}`)
      }
      specRef.current = spec
      autoTrustRespondedRef.current = false
      setPhase('idle')
      setRuntime(result)
      props.onModelChange?.(model)
    } catch (error) {
      setModelDraft(currentSpec?.model ?? props.model ?? 'default')
      window.dispatchEvent(new CustomEvent('conductor:toast', {
        detail: error instanceof Error ? error.message : 'The model could not be changed'
      }))
    } finally {
      reconfiguringRef.current = false
      setReconfiguring(false)
    }
  }

  const changeEffort = async (effort: AgentEffort): Promise<void> => {
    if (props.mode !== 'agent' || reconfiguringRef.current) return
    const currentSpec = specRef.current as AgentSpec | null
    if (effort === (currentSpec?.effort ?? props.effort ?? 'auto')) return
    const spec = { ...(currentSpec ?? makeSpec()), effort } as AgentSpec
    reconfiguringRef.current = true
    setReconfiguring(true)
    try {
      const result = await window.conductor.agents.restart(spec)
      if (!result.available || result.status === 'error' || result.status === 'exited') {
        throw new Error(result.message ?? 'The reasoning effort could not be changed')
      }
      specRef.current = spec
      autoTrustRespondedRef.current = false
      setPhase('idle')
      setRuntime(result)
      props.onEffortChange?.(effort)
    } catch (error) {
      window.dispatchEvent(new CustomEvent('conductor:toast', {
        detail: error instanceof Error ? error.message : 'The reasoning effort could not be changed'
      }))
      throw error
    } finally {
      reconfiguringRef.current = false
      setReconfiguring(false)
    }
  }

  const providerInfo = providers.find((item) => item.id === props.provider)
  const modelLabel = runtimeModelLabel(modelDraft, providerInfo?.models, runtime?.model)
  const viewMode = props.mode === 'agent' ? props.viewMode ?? 'visual' : 'cli'

  const switchView = (next: 'visual' | 'cli'): void => {
    props.onViewModeChange?.(next)
    if (next === 'cli') {
      requestAnimationFrame(() => {
        fit()
        terminalRef.current?.focus()
      })
    }
  }

  return (
    <div className={`runtime-pane ${props.mode === 'agent' ? `agent-${viewMode}` : 'terminal-cli'}`}>
      <div className="runtime-strip">
        <div className="runtime-state">
          <i className={`runtime-dot ${runtime?.status ?? 'starting'}`} />
          {props.mode === 'agent' ? <><strong>{providerInfo?.displayName ?? props.title}</strong><small>{modelLabel}</small><span>{phase === 'working' ? 'working' : runtime?.status === 'running' ? 'ready' : runtime?.status ?? 'connecting'}</span></> : <span>{runtime?.status ?? 'connecting'}</span>}
          {props.mode === 'terminal' && runtime?.executable && <small>{runtime.executable}</small>}
          {runtime?.resumeAt && <small className="limit-time"><TimerReset size={11} /> resumes {new Date(runtime.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
        </div>
        <div className="runtime-actions">
          {props.mode === 'agent' && (
            <>
              <div className="agent-view-switch" aria-label="Agent view">
                <button className={viewMode === 'visual' ? 'active' : ''} onClick={() => switchView('visual')} title="Visual conversation"><MessagesSquare size={14} /><span>Chat</span></button>
                <button className={viewMode === 'cli' ? 'active' : ''} onClick={() => switchView('cli')} title="Raw provider CLI"><TerminalSquare size={14} /><span>CLI</span></button>
              </div>
              <div className="runtime-menu-wrap">
                <button className={actionsOpen ? 'runtime-menu-button active' : 'runtime-menu-button'} onClick={() => setActionsOpen((value) => !value)} title="Agent actions">
                  <MoreHorizontal size={19} />
                </button>
                {actionsOpen && (
                  <div className="conductor-menu runtime-action-menu">
                    <button onClick={() => { setActivityOpen((value) => !value); setActionsOpen(false) }}><ListTree size={15} /> Activity</button>
                    <button onClick={() => { window.conductor.agents.interrupt(props.resourceId); setActionsOpen(false) }}><CircleStop size={15} /> Interrupt agent</button>
                    <button onClick={() => { void restart(); setActionsOpen(false) }}><RefreshCw size={15} /> Restart runtime</button>
                    {workspaceTrusted && <button onClick={() => {
                      localStorage.removeItem(trustStorageKey)
                      setWorkspaceTrusted(false)
                      workspaceTrustedRef.current = false
                      window.dispatchEvent(new CustomEvent('conductor:directory-trust-changed', { detail: { projectId: props.project.id, trusted: false } }))
                      setActionsOpen(false)
                      window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Workspace trust will be requested next time' }))
                    }}><ShieldCheck size={15} /> Forget workspace trust</button>}
                  </div>
                )}
              </div>
            </>
          )}
          {props.mode === 'terminal' && <><button className="runtime-menu-button" onClick={() => {
            const content = terminalRef.current?.getSelection()
            if (!content) { window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Select terminal output to attach to an agent.' })); return }
            if (content.length > 160_000) { window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Select a smaller output range (maximum 160,000 characters).' })); return }
            dispatchAgentContext(props.project.id, { id: crypto.randomUUID(), kind: 'terminal', name: props.title, content })
          }} title="Attach selected terminal output to the last focused agent"><MessagesSquare size={15} /></button><button className="runtime-menu-button" onClick={() => void restart()} title="Restart runtime"><RefreshCw size={17} /></button></>}
        </div>
      </div>
      <div className={`xterm-host ${props.mode === 'agent' && viewMode === 'visual' ? 'agent-terminal-hidden' : ''}`} ref={hostRef} onClick={() => terminalRef.current?.focus()} />
      {props.mode === 'agent' && (
        <div className={`agent-visual-surface ${viewMode === 'visual' ? 'active' : 'hidden'}`} aria-hidden={viewMode !== 'visual'}>
          <AgentConversation
          providerName={providerInfo?.displayName ?? props.title}
          model={modelLabel}
          projectPath={props.project.path}
          events={events}
          transcript={runtime?.transcript ?? ''}
          liveResponse={liveResponse}
          phase={phase}
          status={runtime?.status ?? 'starting'}
          onRestart={() => void restart()}
          workspaceTrusted={workspaceTrusted}
          onQuestionResponse={(value) => {
            setBlockingInteraction(null)
            window.conductor.agents.respond(props.resourceId, value)
          }}
          onTrustWorkspace={(value) => {
            localStorage.setItem(trustStorageKey, 'true')
            workspaceTrustedRef.current = true
            autoTrustRespondedRef.current = true
            setWorkspaceTrusted(true)
            setBlockingInteraction(null)
            window.dispatchEvent(new CustomEvent('conductor:directory-trust-changed', { detail: { projectId: props.project.id, trusted: true } }))
            window.conductor.agents.respond(props.resourceId, value)
            window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'This workspace will be trusted automatically' }))
          }}
          onOpenFile={props.onOpenFile}
          />
          <AgentPrompt
          resourceId={props.resourceId}
          providerId={props.provider ?? 'codex'}
          providerName={providerInfo?.displayName ?? props.title}
          disabled={Boolean(blockingInteraction) || !runtime?.available || ['starting', 'exited', 'unavailable', 'error'].includes(runtime.status)}
          settingsDisabled={reconfiguring}
          disabledReason={blockingInteraction === 'directory_trust' ? 'Resolve directory trust above' : undefined}
          limitedUntil={runtime?.status === 'limited' ? runtime.resumeAt : undefined}
          model={modelDraft}
          modelLabel={modelLabel}
          models={providerInfo?.models ?? []}
          effort={props.effort ?? 'auto'}
          efforts={providerInfo?.efforts ?? [{ id: 'auto', label: 'Provider default' }]}
          onModel={(model) => changeModel(model)}
          onEffort={(effort) => changeEffort(effort)}
          onSubmit={(message, mode: AgentPromptMode) => {
            lastSubmittedMessageRef.current = message
            lastScreenResponseRef.current = ''
            setLiveResponse('')
            setPhase('working')
            window.dispatchEvent(new CustomEvent('conductor:agent-activity', {
              detail: { id: props.resourceId, phase: 'working' }
            }))
            return window.conductor.agents.submit(props.resourceId, message, mode)
          }}
          />
        </div>
      )}
      {runtime && !runtime.available && (
        <div className="runtime-error">
          <AlertTriangle size={18} />
          <div><strong>Runtime unavailable</strong><span>{runtime.message}</span></div>
          <button onClick={() => void restart()}>Try again</button>
          {providerInfo && !providerInfo.available && <button onClick={() => void window.conductor.system.openExternal(providerInfo.installUrl)}>Get {providerInfo.displayName} <ExternalLink size={13} /></button>}
        </div>
      )}
      {props.mode === 'agent' && activityOpen && (
        <aside className="agent-activity">
          <header>
            <div><ListTree size={13} /><span>Normalized activity</span></div>
            <button onClick={() => setActivityOpen(false)}><X size={12} /></button>
          </header>
          <div className="activity-events">
            {events.length === 0 && <div className="activity-empty">Provider events will appear here.</div>}
            {[...events].reverse().map((event) => (
              <article key={event.id}>
                <div>
                  <span className={`event-type ${event.type}`}>{event.type.replace('_', ' ')}</span>
                  <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <p>{event.message}</p>
              </article>
            ))}
          </div>
        </aside>
      )}
    </div>
  )
}
