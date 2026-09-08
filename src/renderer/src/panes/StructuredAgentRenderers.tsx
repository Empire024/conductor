import { PromptImageThumbnail } from '../components/PromptImageUpload'
import { Children, isValidElement, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, FileCode2, Maximize2, X } from 'lucide-react'
import type { ContextAttachment, AgentEventData, DiffArtifact, FileChange, Json, PendingInteraction, TimelineItem } from '../../../shared/structured-agent'
import { languageForPath, SyntaxCode } from './SyntaxCode'

/** Diagnostics remain in the event inspector, not the conversation timeline. */
export function isConversationActivity(item: TimelineItem): boolean {
  const data = item.data
  if (data.type === 'session' || data.type === 'usage') return false
  if (data.type === 'subagent') return ['failed', 'interrupted', 'rejected'].includes(data.status)
  if (data.type !== 'notice') return true
  if (data.outputArtifactId) return true
  if (/^(?:Snapshot unavailable:|Unsupported .*control request:|Live retry stopped:|Incomplete tool input JSON;)/.test(data.message) || data.message.includes('Interruption requested;')) return true
  if (/^(?:Codex event:|Codex process diagnostic|Claude process diagnostic|Codex effective thread settings|Native Codex settings updated|Current turn diff \(provider aggregate\)|Codex live fixture isolation|Claude runtime capabilities|Claude reported a lower cumulative cost)/.test(data.message)) return false
  return data.payload === undefined
}

/** Preserve the timeline order while collecting only adjacent, successful tool results. */
export function groupConversationActivities(items: TimelineItem[]): TimelineItem[][] {
  const groups: TimelineItem[][] = []
  const completed = (item: TimelineItem): boolean => item.data.type === 'tool' && item.data.status === 'completed' && (item.data.exitCode === undefined || item.data.exitCode === 0)
  for (const item of items) {
    const previous = groups.at(-1)
    if (previous && completed(item) && completed(previous[0]!)) previous.push(item)
    else groups.push([item])
  }
  return groups
}

type ToolData = Extract<AgentEventData, { type: 'tool' }>
export type ToolRendererKind = 'command' | 'read' | 'search' | 'edit' | 'custom'
/** Native tool names select presentation only. Renderers never execute tools. */
export const toolRendererRegistry: Array<{ kind: ToolRendererKind; matches: (name: string) => boolean }> = [
  { kind: 'command', matches: (name) => /^(bash|powershell|shell|command|commandExecution|exec_command|shell_command|terminal|run_command)$/i.test(name) },
  { kind: 'read', matches: (name) => /^(read|read_file|readFile|open_file)$/i.test(name) },
  { kind: 'search', matches: (name) => /^(glob|grep|search|fileSearch|list_files)$/i.test(name) },
  { kind: 'edit', matches: (name) => /^(edit|write|multiedit|apply_patch|file ?change)$/i.test(name) }
]
export function rendererKind(name: string): ToolRendererKind {
  return toolRendererRegistry.find((renderer) => renderer.matches(name))?.kind ?? 'custom'
}
function openAgentFile(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, cwd: string, path: string, open: (path: string, line?: number) => void): void {
  const target = safeFileTarget(path, cwd)
  if (!target) return
  if (event.ctrlKey || event.metaKey) window.dispatchEvent(new CustomEvent('conductor:agent-file', { detail: { cwd, ...target, mode: event.shiftKey ? 'external' : 'browser' } }))
  else open(target.path, target.line)
}
function record(value: Json | undefined): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function field(input: Record<string, Json>, ...names: string[]): string | undefined {
  for (const name of names) if (typeof input[name] === 'string') return input[name] as string
  return undefined
}
/** Display-only removal of a known launcher; never used for execution or approval. */
export function commandSummary(command: string): string {
  const wrapper = /^(?:"[^"\r\n]*(?:powershell|pwsh)(?:\.exe)?"|'[^'\r\n]*(?:powershell|pwsh)(?:\.exe)?'|(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+)*-Command\s+([\s\S]+)$/i.exec(command.trim())
  let display = wrapper?.[1]?.trim() ?? command
  if (wrapper && display.length >= 2 && ((display[0] === "'" && display.at(-1) === "'") || (display[0] === '"' && display.at(-1) === '"'))) {
    const singleQuoted = display[0] === "'"
    display = display.slice(1, -1)
    if (singleQuoted) display = display.replaceAll("''", "'")
  }
  if (/^@['"]\r?\n/.test(display)) return /['"]@\s*\|\s*python(?:\s|$)/i.test(display) ? 'Python script' : 'PowerShell script'
  return display.split(/\r?\n/)[0]!.trim().slice(0, 110)
}
export function toolPresentation(tool: ToolData): { kind: ToolRendererKind; title: string; input: string; path?: string; cwd?: string } {
  const kind = rendererKind(tool.name)
  const data = record(tool.input)
  const command = field(data, 'command', 'cmd', 'script')
  const path = field(data, 'file_path', 'path', 'filePath')
  const query = field(data, 'pattern', 'query')
  const fallback = command ? 'Run ' + commandSummary(command) : path ? (kind === 'edit' ? 'Edit ' : 'Open ') + path : query ? 'Search for ' + query : tool.name
  const suppliedDescription = tool.description || field(data, 'description')
  const generatedCommandDescription = command && suppliedDescription && [110, 120].some((length) => suppliedDescription === 'Run ' + command.split(/\r?\n/)[0]!.slice(0, length))
  const input = command ?? (kind === 'read' ? [path, data.offset !== undefined ? 'Offset: ' + data.offset : '', data.limit !== undefined ? 'Limit: ' + data.limit : ''].filter(Boolean).join('\n') : kind === 'search' ? [query, path].filter(Boolean).join('\n') : undefined)
  return { kind, title: generatedCommandDescription ? fallback : suppliedDescription || fallback, input: tool.inputDelta || input || (tool.input !== undefined ? JSON.stringify(tool.input, null, 2) : ''), path, cwd: field(data, 'cwd', 'workdir', 'working_directory') }
}
export function safeFileTarget(raw: string, cwd: string): { path: string; line?: number } | null {
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (/[\u0000-\u001f]/.test(decoded)) return null
  let path = decoded.replaceAll('\\', '/')
  const lineMatch = path.match(/(?::(\d+)(?::\d+)?|#L(\d+))$/)
  const line = lineMatch ? Number(lineMatch[1] ?? lineMatch[2]) : undefined
  if (lineMatch) path = path.slice(0, lineMatch.index)
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '')
  if (path.toLowerCase().startsWith(root.toLowerCase() + '/')) path = path.slice(root.length + 1)
  else if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(path)) return null
  path = path.replace(/^\.\//, '')
  if (!path || path.split('/').some((part) => part === '..' || !part) || path.includes(':')) return null
  return { path, line: line && Number.isSafeInteger(line) && line > 0 ? line : undefined }
}
export function safeExternalLink(href: string): boolean {
  try { const url = new URL(href); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password } catch { return false }
}
export function safeConductorLink(href: string): boolean {
  try { const url = new URL(href); return url.protocol === 'conductor:' && Boolean(url.hostname) && !url.search && !url.hash && !url.port && !url.username && !url.password && /^\/(tab|file|workspace)\/[^/]+$/.test(url.pathname) } catch { return false }
}
export const StructuredMarkdown = memo(function StructuredMarkdown({ text, cwd, onOpenFile }: { text: string; cwd: string; onOpenFile(path: string, line?: number): void }): React.JSX.Element {
  const [linkError, setLinkError] = useState('')
  return <div className="sa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => safeConductorLink(url) || safeExternalLink(url) || safeFileTarget(url, cwd) ? url : ''} components={{
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>
      const internal = safeConductorLink(href)
      const external = safeExternalLink(href)
      const target = external || internal ? null : safeFileTarget(href, cwd)
      return <a href={external ? href : '#'} onClick={(event) => { event.preventDefault(); if (internal) void window.conductor.agentControl.openUri(href).catch(reason => setLinkError(reason instanceof Error ? reason.message : String(reason))); else if (external) void window.conductor.system.openExternal(href); else if (target) { if (event.ctrlKey || event.metaKey) window.dispatchEvent(new CustomEvent('conductor:agent-file', { detail: { cwd, path: target.path, line: target.line, mode: event.shiftKey ? 'external' : 'browser' } })); else onOpenFile(target.path, target.line) } }}>{children}</a>
    },
    img: ({ alt }) => <span className="sa-muted">{alt ? '[Image: ' + alt + ']' : '[Image omitted]'}</span>,
    pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>
  }}>{text}</ReactMarkdown>{linkError && <span className="sa-error" role="alert">{linkError}</span>}</div>
})
function MarkdownCodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const child = Children.toArray(children)[0]
  const props = isValidElement<{ children?: ReactNode; className?: string }>(child) ? child.props : {}
  const value = typeof props.children === 'string' ? props.children : Children.toArray(props.children).filter((entry) => typeof entry === 'string').join('')
  const language = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? '')?.[1]
  return <div className="sa-code-block">{language && <span className="sa-code-language" aria-hidden="true">{language}</span>}<button type="button" className="sa-copy-code" aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(value)}><Copy size={12} /></button><pre><SyntaxCode value={value} language={language} /></pre></div>
}

export function AgentDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.showModal()
    ref.current?.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([disabled]), textarea:not([disabled])')?.focus()
    return () => { ref.current?.close(); focused?.focus() }
  }, [])
  return <dialog ref={ref} className="sa-dialog" aria-label={title} onMouseDown={(event) => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose() }} onCancel={(event) => { event.preventDefault(); onClose() }}><header><strong>{title}</strong><button aria-label={'Close ' + title} onClick={onClose}><X size={16} /></button></header>{children}</dialog>
}

export function ImmutableDiff({ sessionId, change, onClose, onOpenFile }: { sessionId: string; change: FileChange; onClose(): void; onOpenFile(path: string, line?: number): void }): React.JSX.Element {
  const [artifact, setArtifact] = useState<DiffArtifact | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [sideBySide, setSideBySide] = useState(false)
  const editor = useRef<Parameters<DiffOnMount>[0] | null>(null)
  const currentChange = useRef(-1)
  useLayoutEffect(() => () => {
    // The installed React wrapper disposes models before detaching the diff editor.
    // Detach our private models first so Monaco cannot observe disposed live models.
    const instance = editor.current
    const models = instance?.getModel()
    instance?.setModel(null)
    models?.original.dispose()
    models?.modified.dispose()
    editor.current = null
  }, [])
  useEffect(() => {
    let active = true
    if (change.artifactId) void window.conductor.structured.artifact(sessionId, change.artifactId).then((result) => { if (active) setArtifact(result) }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [sessionId, change.artifactId])
  const navigate = (delta: number): void => {
    const changes = editor.current?.getLineChanges() ?? []
    if (!changes.length) return
    currentChange.current = (currentChange.current + delta + changes.length) % changes.length
    const target = changes[currentChange.current]!
    editor.current?.getModifiedEditor().revealLineInCenter(Math.max(1, target.modifiedStartLineNumber))
    editor.current?.getOriginalEditor().revealLineInCenter(Math.max(1, target.originalStartLineNumber))
  }
  const review = async (action: 'keep' | 'undo'): Promise<void> => {
    if (!artifact || busy) return
    setBusy(true)
    try {
      const result = await window.conductor.structured.review(sessionId, artifact.id, action)
      setMessage(result.message ?? (result.outcome === 'kept' ? 'Marked reviewed. File bytes were not changed.' : result.outcome === 'reverted' ? 'Change reverted.' : 'The file changed since this activity. Undo requires conflict resolution.'))
      if (result.outcome === 'reverted') setArtifact({ ...artifact, canUndo: false })
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const patch = artifact?.patch ?? change.patch
  const hasVersions = Boolean(artifact && (artifact.before !== null || artifact.after !== null))
  return <AgentDialog title={'Historical diff · ' + change.path} onClose={onClose}>
    <div className="sa-diff-toolbar"><span className="sa-diff-count"><b>+{artifact?.additions ?? change.additions ?? '?'}</b><em>−{artifact?.deletions ?? change.deletions ?? '?'}</em></span><span>{change.status}</span><span className="sa-spacer" />{hasVersions && <><button aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>Inline</button><button aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>Side by side</button><button aria-label="Previous change" onClick={() => navigate(-1)}><ArrowUp size={13} /></button><button aria-label="Next change" onClick={() => navigate(1)}><ArrowDown size={13} /></button></>}<button disabled={!patch} onClick={() => void navigator.clipboard.writeText(patch ?? '')}><Copy size={13} /> Copy patch</button><button onClick={() => onOpenFile(change.path, editor.current?.getModifiedEditor().getPosition()?.lineNumber)}><FileCode2 size={13} /> Open current file</button></div>
    <p className="sa-diff-caption">Immutable versions from this activity. Open current file navigates to the workspace.</p>
    {(error || message || artifact?.limitation || change.limitation) && <p role={error ? 'alert' : 'status'} className="sa-notice">{error || message || artifact?.limitation || change.limitation}</p>}
    {hasVersions && artifact ? <div className="sa-diff-editor"><DiffEditor original={artifact.before ?? ''} modified={artifact.after ?? ''} language={languageForPath(change.path)} theme={document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark'} onMount={(instance) => { editor.current = instance }} options={{ readOnly: true, originalEditable: false, renderSideBySide: sideBySide, automaticLayout: true, fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on', renderIndicators: true, ignoreTrimWhitespace: false }} /></div> : patch ? <pre className="sa-expanded-output">{patch}</pre> : <p className="sa-notice">{change.artifactId && !error ? 'Loading immutable versions…' : 'The runtime did not expose a historical patch or file versions for this activity.'}</p>}
    {artifact && change.status === 'applied' && <footer><button disabled={busy} onClick={() => void review('keep')}><Check size={13} /> Keep / mark reviewed</button>{artifact.canUndo && <button disabled={busy} onClick={() => void review('undo')}>Undo this change</button>}<small>Undo compares current bytes with this edit before writing.</small></footer>}
  </AgentDialog>
}
function commandLanguage(name: string): string {
  return /powershell|pwsh/i.test(name) ? 'powershell' : /bash|shell/i.test(name) ? 'shell' : 'plaintext'
}
function PatchPreview({ change }: { change: FileChange }): React.JSX.Element {
  const language = languageForPath(change.path)
  return <pre className="sa-patch-preview">{change.patch?.split('\n').slice(0, 12).map((line, index) => {
    const changed = /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line)
    const context = line.startsWith(' ')
    return <span key={index} className={changed ? line[0] === '+' ? 'sa-diff-added' : 'sa-diff-removed' : ''}>{changed || context ? <><span className="sa-diff-line-prefix">{line[0]}</span><SyntaxCode value={line.slice(1)} language={language} /></> : line}{'\n'}</span>
  })}</pre>
}

interface ActivityProps {
  projectId?: string
  onInspectAttachment?(attachment: ContextAttachment): void
  item: TimelineItem
  sessionId: string
  cwd: string
  expanded: boolean
  interactive: boolean
  parentLabel?: string
  onExpand(id: string): void
  onOpenFile(path: string, line?: number): void
  onDiff(change: FileChange): void
  onRespond(item: TimelineItem, decision?: string, answers?: Record<string, string[]>): Promise<void>
}
function ToolCard({ item, expanded, onExpand, onOpenFile, sessionId, cwd }: ActivityProps): React.JSX.Element | null {
  if (item.data.type !== 'tool') return null
  const tool = item.data
  const presentation = toolPresentation(tool)
  const status = tool.exitCode !== undefined && tool.exitCode !== 0 ? 'failed' : tool.status
  const input = <pre><SyntaxCode value={presentation.input || 'Input pending…'} language={presentation.kind === 'command' ? commandLanguage(tool.name) : presentation.kind === 'custom' || presentation.kind === 'edit' ? 'json' : undefined} /></pre>
  const actions = record(tool.input).actions
  const sourcePath = presentation.path ?? (Array.isArray(actions) ? actions.map((action) => record(action)).find((action) => action.type === 'read')?.path : undefined)
  const outputLanguage = typeof sourcePath === 'string' ? languageForPath(sourcePath) : undefined
  return <section className={'sa-tool sa-tool-' + presentation.kind} aria-label={tool.name + ': ' + status}>
    <header><button className="sa-tool-heading" aria-expanded={expanded} onClick={() => onExpand(item.id)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{tool.name}</strong><span>{presentation.title !== tool.name ? presentation.title : ''}</span></button><small className={'sa-status status-' + status}>{status.replaceAll('_', ' ')}</small></header>
    {expanded && <>
      <div className="sa-io"><span>IN</span><div>{presentation.cwd && <small className="sa-cwd">{presentation.cwd}</small>}{presentation.kind === 'custom' || presentation.kind === 'edit' ? <details><summary>Inspect tool input</summary>{input}</details> : input}{presentation.path && <button className="sa-file-link" onClick={(event) => openAgentFile(event, cwd, presentation.path!, onOpenFile)}>{presentation.path}</button>}</div></div>
      <div className="sa-io sa-output"><span>OUT</span><div>{tool.output !== undefined ? <OutputPreview value={tool.output} artifactId={tool.outputArtifactId} sessionId={sessionId} language={outputLanguage} /> : <span className="sa-muted">{status === 'preparing' ? 'Preparing…' : status === 'awaiting_approval' ? 'Awaiting approval.' : status === 'running' ? 'Running…' : 'No output.'}</span>}{tool.stderr && <><small className="sa-stream-name">stderr</small><OutputPreview value={tool.stderr} sessionId={sessionId} /></>}</div></div>
      {(tool.exitCode !== undefined || tool.durationMs !== undefined) && <footer>{tool.exitCode !== undefined && <span>Exit {tool.exitCode}</span>}{tool.durationMs !== undefined && <span>{(tool.durationMs / 1000).toFixed(2)} s</span>}</footer>}
    </>}
  </section>
}
function OutputPreview({ value, sessionId, artifactId, language }: { value: string; sessionId: string; artifactId?: string; language?: string }): React.JSX.Element {
  const [full, setFull] = useState<string | null>(null)
  const [error, setError] = useState('')
  const expanded = async (): Promise<void> => {
    try { setFull(artifactId ? await window.conductor.structured.output(sessionId, artifactId) : value) } catch (reason) { setError(String(reason)) }
  }
  return <><pre><SyntaxCode value={value.slice(0, 8000)} language={language} /></pre><div className="sa-output-actions"><button aria-label="Copy output" onClick={() => void navigator.clipboard.writeText(value)}><Copy size={12} /> Copy</button>{(value.length > 8000 || artifactId) && <button onClick={() => void expanded()}><Maximize2 size={12} /> Expand output</button>}</div>{error && <p role="alert">{error}</p>}{full !== null && <AgentDialog title="Tool output" onClose={() => setFull(null)}><div className="sa-diff-toolbar"><button onClick={() => void navigator.clipboard.writeText(full)}><Copy size={13} /> Copy full output</button><small>{full.length.toLocaleString()} characters</small></div><pre className="sa-expanded-output"><SyntaxCode value={full} language={language} /></pre></AgentDialog>}</>
}
export function interactionOutcome(outcome?: string): string {
  if (!outcome) return 'Resolved'
  return ({ accept: 'Accepted', acceptForSession: 'Accepted for session', decline: 'Declined', cancel: 'Cancelled', allow: 'Allowed', 'allow-session': 'Allowed for session', 'auto-mode': 'Auto-mode enabled', deny: 'Denied', abort: 'Cancelled', answered: 'Answered' } as Record<string, string>)[outcome] ?? outcome
}
function InteractionCard({ item, interactive, onRespond }: ActivityProps): React.JSX.Element | null {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (item.data.type !== 'interaction') return null
  const request: PendingInteraction = item.data.interaction
  const pending = request.status === 'pending' && interactive
  const unanswered = (request.questions ?? []).some(question => !(answers[question.id]?.length || custom[question.id]?.trim()))
  const respond = async (decision?: string): Promise<void> => {
    if (busy || !pending || request.kind === 'question' && unanswered) return
    setBusy(true)
    try { await onRespond(item, decision, request.kind === 'question' ? Object.fromEntries((request.questions ?? []).map((question) => [question.id, custom[question.id]?.trim() ? [custom[question.id]!.trim()] : answers[question.id] ?? []])) : undefined) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }
  if (!pending) return <details className="sa-interaction sa-interaction-resolved" aria-label={request.kind + ': ' + request.title}>
    <summary><span>{request.title}</span><small>{request.status === 'resolved' ? interactionOutcome(request.outcome) : request.status === 'expired' ? 'Expired' : 'Unavailable'}</small></summary>
    <div className="sa-interaction-detail">{request.status === 'expired' && request.outcome && <p>{request.outcome}</p>}<pre><SyntaxCode value={JSON.stringify(request.input, null, 2)} language="json" /></pre>{request.questions?.map((question) => <p key={question.id}>{question.question}</p>)}</div>
  </details>
  return <form className="sa-interaction needs-attention" aria-label={request.kind + ': ' + request.title} onSubmit={event => { event.preventDefault(); void respond() }} onKeyDown={event => {
    if (request.kind !== 'question' || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement)) return
    event.preventDefault(); event.stopPropagation(); void respond()
  }}>
    <header><strong>{request.title}</strong><small>{request.kind === 'question' ? 'Choose an answer' : 'Review and continue'}</small></header>
    {request.kind === 'approval' && <p className="sa-request-summary">{typeof record(request.input).description === 'string' ? String(record(request.input).description) : typeof record(request.input).command === 'string' ? commandSummary(String(record(request.input).command)) : typeof record(request.input).file_path === 'string' ? String(record(request.input).file_path) : ''}</p>}
    {request.questions?.map((question) => <fieldset key={question.id} disabled={busy}>
      <legend>{question.header && <small>{question.header}</small>}{question.question}</legend>
      <div className="sa-question-options">{question.options.map((option) => {
        const checked = !custom[question.id]?.trim() && (answers[question.id] ?? []).includes(option.label)
        return <label className={'sa-question-option' + (checked ? ' selected' : '')} key={option.label}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={item.id + '-' + question.id} checked={checked} onChange={(event) => {
            setCustom((value) => ({ ...value, [question.id]: '' }))
            setAnswers((value) => ({ ...value, [question.id]: question.multiSelect ? event.target.checked ? [...(value[question.id] ?? []), option.label] : (value[question.id] ?? []).filter((label) => label !== option.label) : [option.label] }))
          }} />
          <span className="sa-choice-indicator" aria-hidden="true">{checked && <Check size={12} />}</span>
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>
      })}</div>
      {question.allowCustom !== false && <label className="sa-custom-answer"><span>{question.options.length ? 'Or type an answer' : 'Your answer'}</span><input type={question.isSecret ? 'password' : 'text'} value={custom[question.id] ?? ''} onChange={(event) => setCustom((value) => ({ ...value, [question.id]: event.target.value }))} /></label>}
    </fieldset>)}
    <div className="sa-interaction-actions">{request.kind === 'question'
      ? <button type="submit" disabled={busy || unanswered}>Submit answers</button>
      : request.choices.map((choice) => <button type="button" key={choice.id} disabled={busy || choice.disabled} title={choice.description} onClick={() => void respond(choice.id)}>{choice.label}</button>)}</div>
    {request.choices.filter(choice => choice.description).map(choice => <p className="sa-request-summary" key={choice.id}><strong>{choice.label}:</strong> {choice.description}</p>)}
    <details className="sa-request-details"><summary title="Inspect exact request and scope">Request details</summary><pre>{JSON.stringify(request.input, null, 2)}</pre></details>
    {error && <p role="alert" className="sa-error">{error}</p>}
  </form>
}
/** Legacy journals included expanded attachments in the user text. Collapse, never discard, that suffix. */
export function legacyAttachedContext(text: string): { prompt: string; context: string } | null {
  const match = /\r?\n\r?\n\[Attached (?:file|selection|editor|terminal|diagnostics|image): [^\]\r\n]+\]/.exec(text)
  if (!match || !text.slice(0, match.index).trim()) return null
  return { prompt: text.slice(0, match.index), context: text.slice(match.index).trimStart() }
}
function MessageText({ data, cwd, onOpenFile }: { data: Extract<AgentEventData, { type: 'text' }>; cwd: string; onOpenFile(path: string, line?: number): void }): React.JSX.Element {
  const legacy = data.role === 'user' && !data.attachments?.length ? legacyAttachedContext(data.text) : null
  return <><StructuredMarkdown text={legacy?.prompt ?? data.text} cwd={cwd} onOpenFile={onOpenFile} />{legacy && <details className="sa-legacy-context"><summary>Attached context</summary><StructuredMarkdown text={legacy.context} cwd={cwd} onOpenFile={onOpenFile} /></details>}</>
}

export const StructuredActivity = memo(function StructuredActivity(props: ActivityProps): React.JSX.Element | null {
  if (!isConversationActivity(props.item)) return null
  const { data } = props.item
  let body: ReactNode
  switch (data.type) {
    case 'text': body = <>{data.role === 'user' && <span className="sa-role">You</span>}<MessageText data={data} cwd={props.cwd} onOpenFile={props.onOpenFile} />{Boolean(data.attachments?.length) && <div className="sa-message-attachments" aria-label="Attached context">{data.attachments?.map(attachment => attachment.kind === 'image' && props.projectId && props.onInspectAttachment ? <button key={attachment.id} className="sa-sent-image" aria-label={'View image ' + attachment.name} title={'View ' + attachment.name} onClick={() => props.onInspectAttachment?.(attachment)}><PromptImageThumbnail projectId={props.projectId} attachment={attachment} /><span>{attachment.name}</span></button> : attachment.path ? <button key={attachment.id} className="sa-file-link" title={attachment.name} onClick={event => openAgentFile(event, props.cwd, attachment.path!, props.onOpenFile)}><FileCode2 size={12} />{attachment.name}{attachment.startLine ? ':' + attachment.startLine : ''}</button> : <span key={attachment.id}><FileCode2 size={12} />{attachment.name}</span>)}</div>}</>; break
    case 'tool': body = <ToolCard {...props} />; break
    case 'interaction': body = <InteractionCard {...props} />; break
    case 'changes': body = <section className="sa-changes" aria-label="File changes">{data.changes.map((change, index) => <div className="sa-file-change" key={change.path + '-' + index}>
      <header><button className="sa-file-link" onClick={(event) => openAgentFile(event, props.cwd, change.path, props.onOpenFile)}><FileCode2 size={13} /><code>{change.oldPath ? change.oldPath + ' → ' : ''}{change.path}</code></button><span className="sa-diff-count">{change.additions !== undefined && <b>+{change.additions}</b>}{change.deletions !== undefined && <em>−{change.deletions}</em>}</span><small>{change.status}</small></header>
      {change.patch && <PatchPreview change={change} />}
      {(change.patch || change.artifactId) ? <button className="sa-expand-diff" onClick={() => props.onDiff(change)}><Maximize2 size={12} /> Click to expand diff</button> : change.limitation && <details className="sa-change-limitation"><summary>Diff unavailable</summary><p>{change.limitation}</p></details>}
    </div>)}</section>; break
    case 'plan': body = <section className="sa-plan"><strong>Plan</strong>{data.explanation && <StructuredMarkdown text={data.explanation} cwd={props.cwd} onOpenFile={props.onOpenFile} />}<ol>{data.steps.map((step, index) => <li key={index} className={'status-' + step.status}><span>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'}</span><span>{step.text}</span><small>{step.status.replace('_', ' ')}</small></li>)}</ol></section>; break
    case 'subagent': body = <section className="sa-subagent"><strong>{data.name}</strong><small>{data.status.replaceAll('_', ' ')}</small></section>; break
    case 'error': body = <p className="sa-error" role="alert">{data.message}{data.code && <small> ({data.code})</small>}</p>; break
    case 'notice': body = <div className="sa-notice">{data.message}{data.outputArtifactId && <OutputPreview sessionId={props.sessionId} artifactId={data.outputArtifactId} value="Saved terminal output from before structured integration. Native conversation identity was not recorded." />}</div>; break
    case 'review': body = <p className="sa-muted">{data.outcome === 'kept' ? 'Edit marked reviewed.' : 'Edit reverted.'}</p>; break
    case 'usage': return null
    case 'session': return null
  }
  return <article className={'sa-activity sa-kind-' + data.type + (data.type === 'text' ? ' sa-' + data.role : '') + (props.item.parentId ? ' sa-child' : '')} data-item-id={props.item.id} data-native-item-id={props.item.nativeItemId} data-parent-id={props.item.parentId}><span className="sa-marker" aria-hidden="true" />{props.item.parentId && props.parentLabel && <small className="sa-parent-label">Within {props.parentLabel}</small>}{body}</article>
})
