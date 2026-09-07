import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, FileCode2, Maximize2, X } from 'lucide-react'
import type { AgentEventData, DiffArtifact, FileChange, Json, PendingInteraction, TimelineItem } from '../../../shared/structured-agent'

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
function record(value: Json | undefined): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function field(input: Record<string, Json>, ...names: string[]): string | undefined {
  for (const name of names) if (typeof input[name] === 'string') return input[name] as string
  return undefined
}
export function toolPresentation(tool: ToolData): { kind: ToolRendererKind; title: string; input: string; path?: string; cwd?: string } {
  const kind = rendererKind(tool.name)
  const data = record(tool.input)
  const command = field(data, 'command', 'cmd', 'script')
  const path = field(data, 'file_path', 'path', 'filePath')
  const query = field(data, 'pattern', 'query')
  const fallback = command ? 'Run ' + command.split(/\r?\n/)[0]!.slice(0, 110) : path ? (kind === 'edit' ? 'Edit ' : 'Open ') + path : query ? 'Search for ' + query : tool.name
  const input = command ?? (kind === 'read' ? [path, data.offset !== undefined ? 'Offset: ' + data.offset : '', data.limit !== undefined ? 'Limit: ' + data.limit : ''].filter(Boolean).join('\n') : kind === 'search' ? [query, path].filter(Boolean).join('\n') : undefined)
  return { kind, title: tool.description || field(data, 'description') || fallback, input: tool.inputDelta || input || (tool.input !== undefined ? JSON.stringify(tool.input, null, 2) : ''), path, cwd: field(data, 'cwd', 'workdir', 'working_directory') }
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
export const StructuredMarkdown = memo(function StructuredMarkdown({ text, cwd, onOpenFile }: { text: string; cwd: string; onOpenFile(path: string, line?: number): void }): React.JSX.Element {
  return <div className="sa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => safeExternalLink(url) || safeFileTarget(url, cwd) ? url : ''} components={{
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>
      const external = safeExternalLink(href)
      const target = external ? null : safeFileTarget(href, cwd)
      return <a href={external ? href : '#'} onClick={(event) => { event.preventDefault(); if (external) void window.conductor.system.openExternal(href); else if (target) onOpenFile(target.path, target.line) }}>{children}</a>
    },
    img: ({ alt }) => <span className="sa-muted">{alt ? '[Image: ' + alt + ']' : '[Image omitted]'}</span>,
    pre: ({ children }) => <div className="sa-code-block"><button type="button" className="sa-copy-code" aria-label="Copy code" onClick={(event) => void navigator.clipboard.writeText(event.currentTarget.parentElement?.querySelector('pre')?.textContent ?? '')}><Copy size={12} /></button><pre>{children}</pre></div>
  }}>{text}</ReactMarkdown></div>
})

export function AgentDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.showModal()
    return () => { ref.current?.close(); focused?.focus() }
  }, [])
  return <dialog ref={ref} className="sa-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose() }}><header><strong>{title}</strong><button aria-label={'Close ' + title} onClick={onClose}><X size={16} /></button></header>{children}</dialog>
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
function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return ({ js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', py: 'python', ps1: 'powershell', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[ext] ?? 'plaintext'
}

interface ActivityProps {
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
function ToolCard({ item, expanded, onExpand, onOpenFile, sessionId }: ActivityProps): React.JSX.Element | null {
  if (item.data.type !== 'tool') return null
  const tool = item.data
  const presentation = toolPresentation(tool)
  const status = tool.exitCode !== undefined && tool.exitCode !== 0 ? 'failed' : tool.status
  return <section className={'sa-tool sa-tool-' + presentation.kind} aria-label={tool.name + ': ' + status}><header><button className="sa-tool-heading" aria-expanded={expanded} onClick={() => onExpand(item.id)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{tool.name}</strong><span>{presentation.title !== tool.name ? presentation.title : ''}</span></button><small className={'sa-status status-' + status}>{status.replaceAll('_', ' ')}</small></header>{expanded && <><div className="sa-io"><span>IN</span><div>{presentation.cwd && <small className="sa-cwd">{presentation.cwd}</small>}{presentation.kind === 'custom' || presentation.kind === 'edit' ? <details><summary>Inspect tool input</summary><pre>{presentation.input || 'Input has not arrived.'}</pre></details> : <pre>{presentation.input || 'Input has not arrived.'}</pre>}{presentation.path && <button className="sa-file-link" onClick={() => onOpenFile(presentation.path!)}>{presentation.path}</button>}</div></div><div className="sa-io sa-output"><span>OUT</span><div>{tool.output !== undefined ? <OutputPreview value={tool.output} artifactId={tool.outputArtifactId} sessionId={sessionId} /> : <span className="sa-muted">{status === 'preparing' ? 'Tool declared; execution is not yet confirmed.' : status === 'awaiting_approval' ? 'Awaiting approval before execution.' : status === 'running' ? 'Running. Output will appear when the runtime supplies it.' : 'No output supplied by the runtime.'}</span>}{tool.stderr && <><small className="sa-stream-name">stderr</small><OutputPreview value={tool.stderr} sessionId={sessionId} /></>}</div></div>{(tool.exitCode !== undefined || tool.durationMs !== undefined) && <footer>{tool.exitCode !== undefined && <span>Exit {tool.exitCode}</span>}{tool.durationMs !== undefined && <span>{(tool.durationMs / 1000).toFixed(2)} s</span>}</footer>}</>}</section>
}
function OutputPreview({ value, sessionId, artifactId }: { value: string; sessionId: string; artifactId?: string }): React.JSX.Element {
  const [full, setFull] = useState<string | null>(null)
  const [error, setError] = useState('')
  const expanded = async (): Promise<void> => {
    try { setFull(artifactId ? await window.conductor.structured.output(sessionId, artifactId) : value) } catch (reason) { setError(String(reason)) }
  }
  return <><pre>{value.slice(0, 8000)}</pre><div className="sa-output-actions"><button aria-label="Copy output" onClick={() => void navigator.clipboard.writeText(value)}><Copy size={12} /> Copy</button>{(value.length > 8000 || artifactId) && <button onClick={() => void expanded()}><Maximize2 size={12} /> Expand output</button>}</div>{error && <p role="alert">{error}</p>}{full !== null && <AgentDialog title="Tool output" onClose={() => setFull(null)}><div className="sa-diff-toolbar"><button onClick={() => void navigator.clipboard.writeText(full)}><Copy size={13} /> Copy full output</button><small>{full.length.toLocaleString()} characters</small></div><pre className="sa-expanded-output">{full}</pre></AgentDialog>}</>
}
function InteractionCard({ item, interactive, onRespond }: ActivityProps): React.JSX.Element | null {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (item.data.type !== 'interaction') return null
  const request: PendingInteraction = item.data.interaction
  const pending = request.status === 'pending' && interactive
  const respond = async (decision?: string): Promise<void> => {
    if (busy || !pending) return
    setBusy(true)
    try { await onRespond(item, decision, request.kind === 'question' ? Object.fromEntries((request.questions ?? []).map((question) => [question.id, custom[question.id]?.trim() ? [custom[question.id]!.trim()] : answers[question.id] ?? []])) : undefined) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }
  return <section className={'sa-interaction ' + (pending ? 'needs-attention' : '')} aria-label={request.kind + ': ' + request.title}><header><strong>{request.title}</strong><small>{request.status === 'resolved' ? request.outcome ?? 'Resolved' : pending ? 'Your response is required' : request.status === 'expired' ? 'Expired' : 'Historical request'}</small></header><details><summary>Inspect exact request and scope</summary><pre>{JSON.stringify(request.input, null, 2)}</pre></details>{request.questions?.map((question) => <fieldset key={question.id} disabled={!pending || busy}><legend>{question.header && <small>{question.header} · </small>}{question.question}</legend>{question.options.map((option) => <label className="sa-question-option" key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={item.id + '-' + question.id} checked={(answers[question.id] ?? []).includes(option.label)} onChange={(event) => { setCustom((value) => ({ ...value, [question.id]: '' })); setAnswers((value) => ({ ...value, [question.id]: question.multiSelect ? event.target.checked ? [...(value[question.id] ?? []), option.label] : (value[question.id] ?? []).filter((label) => label !== option.label) : [option.label] })) }} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}{question.allowCustom !== false && <label className="sa-custom-answer"><span>{question.options.length ? 'Or type an answer' : 'Your answer'}</span><input type={question.isSecret ? 'password' : 'text'} value={custom[question.id] ?? ''} onChange={(event) => setCustom((value) => ({ ...value, [question.id]: event.target.value }))} /></label>}</fieldset>)}{pending && <div className="sa-interaction-actions">{request.kind === 'question' ? <button disabled={busy || (request.questions ?? []).some((question) => !(answers[question.id]?.length || custom[question.id]?.trim()))} onClick={() => void respond()}>Submit answers</button> : request.choices.map((choice) => <button key={choice.id} disabled={busy} onClick={() => void respond(choice.id)}>{choice.label}</button>)}</div>}{error && <p role="alert" className="sa-error">{error}</p>}</section>
}
export const StructuredActivity = memo(function StructuredActivity(props: ActivityProps): React.JSX.Element | null {
  const { data } = props.item
  let body: ReactNode
  switch (data.type) {
    case 'text': body = <><span className="sa-role">{data.role === 'user' ? 'You' : data.role === 'status' ? 'Activity' : 'Assistant'}</span><StructuredMarkdown text={data.text} cwd={props.cwd} onOpenFile={props.onOpenFile} /></>; break
    case 'tool': body = <ToolCard {...props} />; break
    case 'interaction': body = <InteractionCard {...props} />; break
    case 'changes': body = <section className="sa-changes" aria-label="File changes">{data.changes.map((change, index) => <div className="sa-file-change" key={change.path + '-' + index}><header><button className="sa-file-link" onClick={() => props.onOpenFile(change.path)}><FileCode2 size={13} /><code>{change.oldPath ? change.oldPath + ' → ' : ''}{change.path}</code></button><span className="sa-diff-count">{change.additions !== undefined && <b>+{change.additions}</b>}{change.deletions !== undefined && <em>−{change.deletions}</em>}</span><small>{change.status}</small></header>{change.patch && <pre className="sa-patch-preview">{change.patch.split('\n').slice(0, 12).map((line, lineIndex) => <span key={lineIndex} className={line.startsWith('+') && !line.startsWith('+++') ? 'addition' : line.startsWith('-') && !line.startsWith('---') ? 'deletion' : ''}>{line}{'\n'}</span>)}</pre>}{change.limitation && <small className="sa-muted">{change.limitation}</small>}{(change.patch || change.artifactId) && <button className="sa-expand-diff" onClick={() => props.onDiff(change)}><Maximize2 size={12} /> Click to expand diff</button>}</div>)}</section>; break
    case 'plan': body = <section className="sa-plan"><strong>Plan</strong>{data.explanation && <StructuredMarkdown text={data.explanation} cwd={props.cwd} onOpenFile={props.onOpenFile} />}<ol>{data.steps.map((step, index) => <li key={index} className={'status-' + step.status}><span>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'}</span><span>{step.text}</span><small>{step.status.replace('_', ' ')}</small></li>)}</ol></section>; break
    case 'subagent': body = <section className="sa-subagent"><strong>{data.name}</strong><small>{data.status.replaceAll('_', ' ')}</small>{data.nativeSessionId && <code>{data.nativeSessionId}</code>}</section>; break
    case 'error': body = <p className="sa-error" role="alert">{data.message}{data.code && <small> ({data.code})</small>}</p>; break
    case 'notice': body = <div className="sa-notice"><details><summary>{data.message}</summary>{data.payload && <pre>{JSON.stringify(data.payload, null, 2)}</pre>}</details>{data.outputArtifactId && <OutputPreview sessionId={props.sessionId} artifactId={data.outputArtifactId} value="Saved terminal output from before structured integration. Native conversation identity was not recorded." />}</div>; break
    case 'review': body = <p className="sa-muted">{data.outcome === 'kept' ? 'Edit marked reviewed.' : 'Edit reverted.'}</p>; break
    case 'usage': body = <small className="sa-usage">{data.source === 'estimate' ? 'Estimated usage' : 'Provider usage'}{data.inputTokens !== undefined && ' · ' + data.inputTokens.toLocaleString() + ' input tokens'}{data.outputTokens !== undefined && ' · ' + data.outputTokens.toLocaleString() + ' output tokens'}{data.costUsd !== undefined && ' · $' + data.costUsd.toFixed(4) + ' provider-reported cost (billing route unknown)'}{data.limits && <details><summary>Available limits</summary><pre>{JSON.stringify(data.limits, null, 2)}</pre></details>}</small>; break
    case 'session': return null
  }
  return <article className={'sa-activity sa-' + data.type + (data.type === 'text' ? ' sa-' + data.role : '') + (props.item.parentId ? ' sa-child' : '')} data-item-id={props.item.id} data-native-item-id={props.item.nativeItemId} data-parent-id={props.item.parentId}><span className="sa-marker" aria-hidden="true" />{props.item.parentId && <small className="sa-parent-label">Within {props.parentLabel ?? props.item.parentId}</small>}{body}</article>
})
