import { PromptImageThumbnail } from '../components/PromptImageUpload'
import { Children, isValidElement, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, FileCode2, Link2, Maximize2, X } from 'lucide-react'
import type { ContextAttachment, AgentEventData, DiffArtifact, FileChange, InputQuestion, Json, PendingInteraction, TimelineItem } from '../../../shared/structured-agent'
import { stripMemoryDirectives } from '../../../shared/memory-directive'
import { languageForPath, SyntaxCode } from './SyntaxCode'
import { fileTypeStyle } from '../file-types'
import { copyText } from '../clipboard'
import { runFileLinkAction } from '../components/file-link-actions'
import { buildFileLinkMenuEntries, FILE_LINK_MENU_ICONS, type FileLinkMenuAction } from '../components/file-link-menu'
import { resolveFileLinkTarget, useFileLinkProjectRoots, type ResolvedFileLink } from '../components/file-link-target'
import { openWorkspaceFile } from '../components/workspace-files-state'
import './StructuredAgentActivity.css'
import './StructuredFileLinkMenu.css'

/** Claude's CLI keeps a long-running tool visible by re-emitting it under a synthetic
 *  `<toolUseId>-heartbeat-N` item that carries no input and repeats its parent's name. Those
 *  are liveness pings rather than activity, and a single skill can produce dozens of them. */
export function isRuntimeHeartbeat(item: TimelineItem): boolean {
  if (item.data.type !== 'tool' || !item.nativeItemId || !item.parentId) return false
  const suffix = item.nativeItemId.slice((item.parentId + '-heartbeat-').length)
  return item.nativeItemId.startsWith(item.parentId + '-heartbeat-') && /^\d+$/.test(suffix)
}
/** Ids of the activities that should carry the "Within X" heading: only the first of each run
 *  of consecutive items sharing a parent, so a nested run reads as one block instead of
 *  repeating the same heading above every row. */
export function parentLabelAnchors(items: TimelineItem[]): Set<string> {
  const anchors = new Set<string>()
  let previous = ''
  for (const item of items) {
    const key = item.parentId ? item.runtimeId + ':' + item.parentId : ''
    if (key && key !== previous) anchors.add(item.id)
    previous = key
  }
  return anchors
}
/** Claude represents "ask the user a question" as both a real `AskUserQuestion` tool call and a
 *  separate interaction request, correlated by sharing the same native tool_use id. The tool
 *  call's own row only ever repeats the question and the provider's raw, unreadable echo of the
 *  answer, so once a sibling question interaction shares that id the bare tool call is a
 *  duplicate rather than new information. */
export function isAnsweredThroughInteraction(item: TimelineItem, items: TimelineItem[]): boolean {
  if (item.data.type !== 'tool' || !item.nativeItemId) return false
  return items.some((other) => other !== item && other.runtimeId === item.runtimeId && other.nativeItemId === item.nativeItemId && other.data.type === 'interaction' && other.data.interaction.kind === 'question')
}
/** Diagnostics remain in the event inspector, not the conversation timeline. `items` is only
 *  supplied when called through `Array.prototype.filter`, which passes it as the third argument. */
export function isConversationActivity(item: TimelineItem, _index?: number, items: TimelineItem[] = []): boolean {
  const data = item.data
  if (data.type === 'session' || data.type === 'usage') return false
  if (isRuntimeHeartbeat(item)) return false
  if (data.type === 'subagent') return ['failed', 'interrupted', 'rejected'].includes(data.status)
  if (isAnsweredThroughInteraction(item, items)) return false
  if (data.type !== 'notice') return true
  if (data.outputArtifactId) return true
  if (/^(?:Snapshot unavailable:|Unsupported .*control request:|Live retry stopped:|Incomplete tool input JSON;)/.test(data.message) || data.message.includes('Interruption requested;')) return true
  if (/^(?:Codex event:|Codex process diagnostic|Claude process diagnostic|Codex effective thread settings|Native Codex settings updated|Current turn diff \(provider aggregate\)|Codex live fixture isolation|Claude runtime capabilities|Claude reported a lower cumulative cost)/.test(data.message)) return false
  return data.payload === undefined
}

interface CoalesceTarget { key: string; path: string }
/** A normalized coalescing key for same-target edits: a single-file `changes` event, or an
 *  edit-kind tool call on a known path. Null means the activity has no stable target to merge by. */
export function activityCoalesceTarget(item: TimelineItem): CoalesceTarget | null {
  if (item.data.type === 'tool') {
    if (item.data.status !== 'completed' || (item.data.exitCode !== undefined && item.data.exitCode !== 0)) return null
    const presentation = toolPresentation(item.data)
    return presentation.kind === 'edit' && presentation.path ? { key: 'edit:' + presentation.path.toLowerCase(), path: presentation.path } : null
  }
  if (item.data.type === 'changes' && item.data.changes.length === 1) { const path = item.data.changes[0]!.path; return { key: 'changes:' + path.toLowerCase(), path } }
  return null
}
/** Preserve the timeline order while collecting adjacent, successful tool results, and separately
 *  runs of edits that repeat the same target with no commentary between them (four small edits to
 *  one file should not read as four near-identical rows). */
export function groupConversationActivities(items: TimelineItem[]): TimelineItem[][] {
  const groups: TimelineItem[][] = []
  const completed = (item: TimelineItem): boolean => item.data.type === 'tool' && item.data.status === 'completed' && (item.data.exitCode === undefined || item.data.exitCode === 0)
  for (const item of items) {
    const previous = groups.at(-1)
    const head = previous?.[0]
    const itemTarget = activityCoalesceTarget(item)
    const sameTarget = head ? itemTarget !== null && itemTarget.key === activityCoalesceTarget(head)?.key : false
    if (previous && ((completed(item) && completed(head!)) || sameTarget)) previous.push(item)
    else groups.push([item])
  }
  return groups
}
/** Aggregate stats for a coalesced same-target run; null unless the whole group truly shares one target. */
export function coalescedEditSummary(group: TimelineItem[]): { path: string; count: number; additions?: number; deletions?: number } | null {
  if (group.length < 2) return null
  const target = activityCoalesceTarget(group[0]!)
  if (!target || group.some(item => activityCoalesceTarget(item)?.key !== target.key)) return null
  let additions: number | undefined, deletions: number | undefined
  for (const item of group) if (item.data.type === 'changes' && item.data.changes.length === 1) {
    const change = item.data.changes[0]!
    if (change.additions !== undefined) additions = (additions ?? 0) + change.additions
    if (change.deletions !== undefined) deletions = (deletions ?? 0) + change.deletions
  }
  return { path: target.path, count: group.length, additions, deletions }
}
export function coalescedEditLabel(summary: { path: string; count: number; additions?: number; deletions?: number }): string {
  const stats = summary.additions !== undefined || summary.deletions !== undefined ? ` · +${summary.additions ?? 0} −${summary.deletions ?? 0}` : ''
  return `Edited ${summary.path} · ${summary.count} edits${stats}`
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
/** Same icon/color the explorer, file tabs and Ctrl+E picker use for this name, so an agent's
 *  file references match everywhere rather than always showing a generic file icon. */
function attachmentIcon(name: string): React.JSX.Element {
  const { icon: Icon, colorClass } = fileTypeStyle(name)
  return <Icon size={12} className={colorClass} />
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
/** Last resort so an unfamiliar tool never renders as a bare name: its first short,
 *  single-line string argument. */
function firstArgumentSummary(input: Record<string, Json>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value !== 'string') continue
    const line = value.split(/\r?\n/)[0]!.trim()
    if (line && line.length <= 110) return line
  }
  return undefined
}
export function toolPresentation(tool: ToolData): { kind: ToolRendererKind; title: string; input: string; path?: string; cwd?: string } {
  const kind = rendererKind(tool.name)
  const data = record(tool.input)
  const command = field(data, 'command', 'cmd', 'script')
  const path = field(data, 'file_path', 'path', 'filePath')
  const query = field(data, 'pattern', 'query')
  const named = field(data, 'skill', 'url', 'subagent_type', 'notebook_path')
  const fallback = command ? 'Run ' + commandSummary(command)
    : path ? (kind === 'edit' ? 'Edit ' : 'Open ') + path
    : query ? 'Search for ' + query
    : named ? [named, field(data, 'args')].filter(Boolean).join(' ').slice(0, 110)
    : firstArgumentSummary(data) ?? tool.name
  const suppliedDescription = tool.description || field(data, 'description')
  const generatedCommandDescription = command && suppliedDescription && [110, 120].some((length) => suppliedDescription === 'Run ' + command.split(/\r?\n/)[0]!.slice(0, length))
  const input = command ?? (kind === 'read' ? [path, data.offset !== undefined ? 'Offset: ' + data.offset : '', data.limit !== undefined ? 'Limit: ' + data.limit : ''].filter(Boolean).join('\n') : kind === 'search' ? [query, path].filter(Boolean).join('\n') : undefined)
  return { kind, title: generatedCommandDescription ? fallback : suppliedDescription || fallback, input: tool.inputDelta || input || (tool.input !== undefined ? JSON.stringify(tool.input, null, 2) : ''), path, cwd: field(data, 'cwd', 'workdir', 'working_directory') }
}
/** A link addressed to this conversation's own workspace. Callers that can also act on another
 *  open project's file use resolveFileLinkTarget directly, which reports the owning project too. */
export function safeFileTarget(raw: string, cwd: string): { path: string; line?: number } | null {
  const target = resolveFileLinkTarget(raw, cwd)
  return target ? { path: target.path, line: target.line } : null
}
export function safeExternalLink(href: string): boolean {
  try { const url = new URL(href); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password } catch { return false }
}
export function safeConductorLink(href: string): boolean {
  try { const url = new URL(href); return url.protocol === 'conductor:' && Boolean(url.hostname) && !url.search && !url.hash && !url.port && !url.username && !url.password && /^\/(tab|file|workspace)\/[^/]+$/.test(url.pathname) } catch { return false }
}
export const StructuredMarkdown = memo(function StructuredMarkdown({ text, cwd, projectId, onOpenFile }: { text: string; cwd: string; projectId?: string; onOpenFile(path: string, line?: number): void }): React.JSX.Element {
  const [linkError, setLinkError] = useState('')
  // Right-click on a link that resolves to a project file explains the modifiers the plain
  // click already understands (Click = edit, Ctrl+Click = browser preview, Ctrl+Shift+Click =
  // default browser) and adds the two explorer reveal actions. External and conductor:// links
  // keep their plain click-only behaviour, matching what they already do.
  const [menu, setMenu] = useState<{ target: ResolvedFileLink; x: number; y: number } | null>(null)
  const projects = useFileLinkProjectRoots()
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onEscape)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('resize', close); window.removeEventListener('keydown', onEscape) }
  }, [menu])
  const showMenu = (event: React.MouseEvent, target: ResolvedFileLink): void => {
    event.preventDefault(); event.stopPropagation()
    setMenu({ target, x: Math.min(event.clientX, window.innerWidth - 226), y: Math.max(6, Math.min(event.clientY, window.innerHeight - 250)) })
  }
  // A file that belongs to another open project cannot go through the pane's onOpenFile: that
  // resolves paths inside this conversation's workspace. It opens as its own project's file tab,
  // in the same type-aware view the explorer would pick, so a PNG previews and a .blend is
  // described rather than loaded into the text editor.
  const editTarget = (target: ResolvedFileLink, path: string, line?: number): void => {
    if (target.projectId && target.projectId !== projectId) openWorkspaceFile(target.projectId, path, 'auto', line)
    else onOpenFile(path, line)
  }
  const runLinkAction = (action: FileLinkMenuAction, target: ResolvedFileLink): void => {
    const owner = target.projectId ?? projectId
    if (!owner) return
    runFileLinkAction(action, { projectId: owner, path: target.path, line: target.line }, (path, line) => editTarget(target, path, line), (message) => setLinkError(message))
  }
  const runMenuAction = (action: FileLinkMenuAction): void => {
    if (!menu) return
    const target = menu.target
    setMenu(null)
    runLinkAction(action, target)
  }
  return <div className="sa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => safeConductorLink(url) || safeExternalLink(url) || resolveFileLinkTarget(url, cwd, projects) ? url : ''} components={{
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>
      const internal = safeConductorLink(href)
      const external = safeExternalLink(href)
      const target = external || internal ? null : resolveFileLinkTarget(href, cwd, projects)
      const sibling = Boolean(target?.projectId && target.projectId !== projectId)
      return <a href={external ? href : '#'}
        onClick={(event) => { event.preventDefault(); if (internal) void window.conductor.agentControl.openUri(href).catch(reason => setLinkError(reason instanceof Error ? reason.message : String(reason))); else if (external) void window.conductor.system.openExternal(href); else if (target) { if (sibling) runLinkAction(event.ctrlKey || event.metaKey ? event.shiftKey ? 'default-browser' : 'live-preview' : 'edit', target); else if (event.ctrlKey || event.metaKey) window.dispatchEvent(new CustomEvent('conductor:agent-file', { detail: { cwd, path: target.path, line: target.line, mode: event.shiftKey ? 'external' : 'browser' } })); else onOpenFile(target.path, target.line) } }}
        onContextMenu={target && (target.projectId ?? projectId) ? (event) => showMenu(event, target) : undefined}
      >{children}</a>
    },
    img: ({ alt }) => <span className="sa-muted">{alt ? '[Image: ' + alt + ']' : '[Image omitted]'}</span>,
    pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>
  }}>{text}</ReactMarkdown>{linkError && <span className="sa-error" role="alert">{linkError}</span>}
  {menu && createPortal(
    <div className="cursor-context-menu sa-file-link-menu" role="menu" aria-label={'Actions for ' + menu.target.path} style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="context-menu-label">{menu.target.path.split('/').pop()}</div>
      {buildFileLinkMenuEntries().map((entry) => { const Icon = FILE_LINK_MENU_ICONS[entry.action]; return <button key={entry.action} role="menuitem" onClick={() => runMenuAction(entry.action)}><Icon size={14} /> {entry.label}{entry.shortcut && <span className="context-shortcut">{entry.shortcut}</span>}</button> })}
    </div>,
    document.body
  )}</div>
})
function MarkdownCodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const child = Children.toArray(children)[0]
  const props = isValidElement<{ children?: ReactNode; className?: string }>(child) ? child.props : {}
  const value = typeof props.children === 'string' ? props.children : Children.toArray(props.children).filter((entry) => typeof entry === 'string').join('')
  const language = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? '')?.[1]
  return <div className="sa-code-block">{language && <span className="sa-code-language" aria-hidden="true">{language}</span>}<button type="button" className="sa-copy-code" aria-label="Copy code" onClick={() => void copyText(value)}><Copy size={12} /></button><pre><SyntaxCode value={value} language={language} /></pre></div>
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
    <div className="sa-diff-toolbar"><span className="sa-diff-count"><b>+{artifact?.additions ?? change.additions ?? '?'}</b><em>−{artifact?.deletions ?? change.deletions ?? '?'}</em></span><span>{change.status}</span><span className="sa-spacer" />{hasVersions && <><button aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>Inline</button><button aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>Side by side</button><button aria-label="Previous change" onClick={() => navigate(-1)}><ArrowUp size={13} /></button><button aria-label="Next change" onClick={() => navigate(1)}><ArrowDown size={13} /></button></>}<button disabled={!patch} onClick={() => void copyText(patch ?? '')}><Copy size={13} /> Copy patch</button><button onClick={() => onOpenFile(change.path, editor.current?.getModifiedEditor().getPosition()?.lineNumber)}><FileCode2 size={13} /> Open current file</button></div>
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
  parentLabel?: { name: string; colorIndex?: number }
  onExpand(id: string): void
  onOpenFile(path: string, line?: number): void
  onDiff(change: FileChange): void
  onRespond(item: TimelineItem, decision?: string, answers?: Record<string, string[]>): Promise<void>
}
/** A short, truncated head-of-output hint so a collapsed row shows a bit of what actually happened,
 *  not just the tool name. The full stream stays behind the expand toggle. */
export function toolInlinePreview(tool: ToolData): string {
  const source = tool.output ?? tool.stderr
  if (!source) return ''
  const line = source.split(/\r?\n/).find(text => text.trim())?.trim() ?? ''
  return line.length > 160 ? line.slice(0, 159) + '…' : line
}
function ToolCard({ item, expanded, onExpand, onOpenFile, sessionId, cwd }: ActivityProps): React.JSX.Element | null {
  if (item.data.type !== 'tool') return null
  const tool = item.data
  const presentation = toolPresentation(tool)
  const status = tool.exitCode !== undefined && tool.exitCode !== 0 ? 'failed' : tool.status
  const preview = !expanded ? toolInlinePreview(tool) : ''
  const input = <pre><SyntaxCode value={presentation.input || 'Input pending…'} language={presentation.kind === 'command' ? commandLanguage(tool.name) : presentation.kind === 'custom' || presentation.kind === 'edit' ? 'json' : undefined} /></pre>
  const actions = record(tool.input).actions
  const sourcePath = presentation.path ?? (Array.isArray(actions) ? actions.map((action) => record(action)).find((action) => action.type === 'read')?.path : undefined)
  const outputLanguage = typeof sourcePath === 'string' ? languageForPath(sourcePath) : undefined
  return <section className={'sa-tool sa-tool-' + presentation.kind} aria-label={tool.name + ': ' + status}>
    <header><button className="sa-tool-heading" aria-expanded={expanded} onClick={() => onExpand(item.id)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{tool.name}</strong><span>{presentation.title !== tool.name ? presentation.title : ''}</span></button><small className={'sa-status status-' + status}>{status.replaceAll('_', ' ')}</small></header>
    {preview && <p className="sa-tool-preview">{preview}</p>}
    {expanded && <>
      <div className="sa-io"><span>IN</span><div>{presentation.cwd && <small className="sa-cwd">{presentation.cwd}</small>}{presentation.kind === 'custom' || presentation.kind === 'edit' ? <details><summary>Inspect tool input</summary>{input}</details> : input}{presentation.path && (() => { const { icon: PathIcon, colorClass } = fileTypeStyle(presentation.path!); return <button className="sa-file-link" onClick={(event) => openAgentFile(event, cwd, presentation.path!, onOpenFile)}><PathIcon size={12} className={colorClass} />{presentation.path}</button> })()}</div></div>
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
  return <><pre><SyntaxCode value={value.slice(0, 8000)} language={language} /></pre><div className="sa-output-actions"><button aria-label="Copy output" onClick={() => void copyText(value)}><Copy size={12} /> Copy</button>{(value.length > 8000 || artifactId) && <button onClick={() => void expanded()}><Maximize2 size={12} /> Expand output</button>}</div>{error && <p role="alert">{error}</p>}{full !== null && <AgentDialog title="Tool output" onClose={() => setFull(null)}><div className="sa-diff-toolbar"><button onClick={() => void copyText(full)}><Copy size={13} /> Copy full output</button><small>{full.length.toLocaleString()} characters</small></div><pre className="sa-expanded-output"><SyntaxCode value={full} language={language} /></pre></AgentDialog>}</>
}
export function interactionOutcome(outcome?: string): string {
  if (!outcome) return 'Resolved'
  return ({ accept: 'Accepted', acceptForSession: 'Accepted for session', decline: 'Declined', cancel: 'Cancelled', allow: 'Allowed', 'allow-session': 'Allowed for session', 'auto-mode': 'Auto-mode enabled', deny: 'Denied', abort: 'Cancelled', answered: 'Answered' } as Record<string, string>)[outcome] ?? outcome
}
const MAX_ANSWER_VALUE_LENGTH = 72
/** Claude can offer a raw, percent-encoded path as an answer choice (a disambiguating
 *  `file:///…` URI). Shown verbatim these are unreadable, and naive truncation used to cut them
 *  off mid-word; decoding first and, once too long, keeping the meaningful tail (the filename)
 *  reads the way the owner actually chose it. */
export function readableAnswerValue(value: string): string {
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { /* Not percent-encoded, or malformed; show it verbatim. */ }
  if (decoded.length <= MAX_ANSWER_VALUE_LENGTH) return decoded
  const segments = decoded.replaceAll('\\', '/').split('/').filter(Boolean)
  const tail = segments.length > 1 ? segments.at(-1)! : ''
  if (tail && tail.length <= MAX_ANSWER_VALUE_LENGTH - 2) return '…/' + tail
  const truncated = decoded.slice(0, MAX_ANSWER_VALUE_LENGTH)
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > MAX_ANSWER_VALUE_LENGTH * 0.6 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + '…'
}
function InteractionCard({ item, interactive, onRespond }: ActivityProps): React.JSX.Element | null {
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string[]> | null>(null)
  if (item.data.type !== 'interaction') return null
  const request: PendingInteraction = item.data.interaction
  if (request.status === 'pending' && interactive) return <PendingInteractionForm item={item} request={request} onRespond={async (target, decision, answers) => {
    if (answers) setSubmittedAnswers(answers)
    await onRespond(target, decision, answers)
  }} />
  const questions = request.questions ?? []
  // A question's own row IS the interaction: once answered, its collapsed heading names the
  // question that was actually asked instead of repeating the generic, now-stale "needs your
  // input" prompt, and its body reads as question/answer text instead of a raw request dump.
  const heading = request.kind === 'question' && questions.length ? (questions.length === 1 ? questions[0]!.question : `${questions.length} questions`) : request.title
  const status = request.kind === 'question' && request.status === 'resolved' ? 'Answered' : request.status === 'resolved' ? interactionOutcome(request.outcome) : request.status === 'expired' ? 'Expired' : 'Unavailable'
  return <details className="sa-interaction sa-interaction-resolved" aria-label={request.kind + ': ' + request.title}>
    <summary><span>{heading}</span><small>{status}</small></summary>
    <div className="sa-interaction-detail">
      {request.status === 'expired' && request.outcome && <p>{request.outcome}</p>}
      {request.kind === 'question' && questions.length
        ? <dl className="sa-question-answers">{questions.map((question) => {
          // The provider records answers by question text on the resolved interaction, so a
          // conversation reloaded from history still reads back what was chosen.
          const recorded = request.answers?.[question.question]
          const chosen = submittedAnswers?.[question.id] ?? (recorded === undefined ? undefined : Array.isArray(recorded) ? recorded : [recorded])
          return <div key={question.id}><dt>{question.question}</dt><dd>{chosen?.length ? chosen.map((value) => readableAnswerValue(value)).join(', ') : 'No recorded answer'}</dd></div>
        })}</dl>
        : <pre><SyntaxCode value={JSON.stringify(request.input, null, 2)} language="json" /></pre>}
      {request.kind === 'question' && questions.length > 0 && <details className="sa-request-details"><summary title="Inspect exact request and scope">Request details</summary><pre>{JSON.stringify(request.input, null, 2)}</pre></details>}
    </div>
  </details>
}
/** A question's free-text answer used to sit in its own textbox next to the real options, so an
 *  option could stay checked while text was also typed: two answers looked chosen at once.
 *  "Custom"/"Other" is a selectable entry itself; only after picking it does its text field
 *  matter, and picking a normal option clears it. Multi-select keeps custom as one more entry in
 *  the checked set, combined with whatever normal options are also checked. */
export function combinedQuestionAnswer(question: InputQuestion, selected: string[], customSelected: boolean, customText: string): string[] {
  const text = customText.trim()
  if (question.options.length === 0) return text ? [text] : []
  if (!customSelected || !text) return selected
  return question.multiSelect ? [...selected, text] : [text]
}
/** A live request asks one question at a time rather than stacking them all, and pins itself to
 *  the bottom of the conversation while the pane is tall enough to still read the transcript
 *  behind it; on a short pane it stays inline where it was written. */
function PendingInteractionForm({ item, request, onRespond }: { item: TimelineItem; request: PendingInteraction; onRespond: ActivityProps['onRespond'] }): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [customSelected, setCustomSelected] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState(0)
  const [pinned, setPinned] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const questions = request.questions ?? []
  const stepped = request.kind === 'question' && questions.length > 1
  const current = Math.min(step, Math.max(0, questions.length - 1))
  const finalAnswer = (question: InputQuestion): string[] => combinedQuestionAnswer(question, answers[question.id] ?? [], Boolean(customSelected[question.id]), custom[question.id] ?? '')
  const answered = (question: InputQuestion): boolean => finalAnswer(question).length > 0
  const unanswered = questions.some((question) => !answered(question))
  const lastStep = !stepped || current === questions.length - 1
  useLayoutEffect(() => {
    const element = form.current
    const scroller = element?.closest('.sa-timeline')
    if (!element || !(scroller instanceof HTMLElement)) return
    const measure = (): void => setPinned(element.offsetHeight <= scroller.clientHeight * 0.62)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [current, questions.length])
  const respond = async (decision?: string): Promise<void> => {
    if (busy || request.kind === 'question' && unanswered) return
    setBusy(true)
    try { await onRespond(item, decision, request.kind === 'question' ? Object.fromEntries(questions.map((question) => [question.id, finalAnswer(question)])) : undefined) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }
  const proceed = (): void => {
    if (lastStep) { void respond(); return }
    if (answered(questions[current]!)) setStep(current + 1)
  }
  return <form ref={form} className={'sa-interaction needs-attention' + (pinned ? ' sa-interaction-pinned' : '')} aria-label={request.kind + ': ' + request.title} onSubmit={event => { event.preventDefault(); proceed() }} onKeyDown={event => {
    if (request.kind !== 'question' || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement)) return
    event.preventDefault(); event.stopPropagation(); proceed()
  }}>
    <header><strong>{request.title}</strong><small>{stepped ? 'Question ' + (current + 1) + ' of ' + questions.length : request.kind === 'question' ? 'Choose an answer' : 'Review and continue'}</small></header>
    {stepped && <ol className="sa-question-steps" aria-hidden="true">{questions.map((question, index) => <li key={question.id} className={index === current ? 'current' : answered(question) ? 'done' : ''} />)}</ol>}
    {request.kind === 'approval' && <p className="sa-request-summary">{typeof record(request.input).description === 'string' ? String(record(request.input).description) : typeof record(request.input).command === 'string' ? commandSummary(String(record(request.input).command)) : typeof record(request.input).file_path === 'string' ? String(record(request.input).file_path) : ''}</p>}
    {(stepped ? questions.slice(current, current + 1) : questions).map((question) => <fieldset key={question.id} disabled={busy}>
      <legend>{question.header && <small>{question.header}</small>}{question.question}</legend>
      <div className="sa-question-options">{question.options.map((option) => {
        const checked = (answers[question.id] ?? []).includes(option.label)
        return <label className={'sa-question-option' + (checked ? ' selected' : '')} key={option.label}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={item.id + '-' + question.id} checked={checked} onChange={(event) => {
            if (!question.multiSelect) { setCustomSelected((value) => ({ ...value, [question.id]: false })); setCustom((value) => ({ ...value, [question.id]: '' })) }
            setAnswers((value) => ({ ...value, [question.id]: question.multiSelect ? event.target.checked ? [...(value[question.id] ?? []), option.label] : (value[question.id] ?? []).filter((label) => label !== option.label) : [option.label] }))
          }} />
          <span className="sa-choice-indicator" aria-hidden="true">{checked && <Check size={12} />}</span>
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>
      })}
      {question.options.length > 0 && question.allowCustom !== false && <label className={'sa-question-option' + (customSelected[question.id] ? ' selected' : '')}>
        <input type={question.multiSelect ? 'checkbox' : 'radio'} name={item.id + '-' + question.id} checked={Boolean(customSelected[question.id])} onChange={(event) => {
          const selected = question.multiSelect ? event.target.checked : true
          setCustomSelected((value) => ({ ...value, [question.id]: selected }))
          if (!question.multiSelect) setAnswers((value) => ({ ...value, [question.id]: [] }))
          if (!selected) setCustom((value) => ({ ...value, [question.id]: '' }))
        }} />
        <span className="sa-choice-indicator" aria-hidden="true">{customSelected[question.id] && <Check size={12} />}</span>
        <span><strong>Other</strong></span>
      </label>}
      </div>
      {question.allowCustom !== false && (question.options.length === 0 || customSelected[question.id]) && <label className="sa-custom-answer"><span>Your answer</span><input type={question.isSecret ? 'password' : 'text'} value={custom[question.id] ?? ''} onChange={(event) => setCustom((value) => ({ ...value, [question.id]: event.target.value }))} /></label>}
    </fieldset>)}
    <div className="sa-interaction-actions">{request.kind === 'question'
      ? <>
        {stepped && current > 0 && <button type="button" className="sa-step-back" disabled={busy} onClick={() => setStep(current - 1)}>Back</button>}
        {lastStep
          ? <button type="submit" disabled={busy || unanswered}>Submit answers</button>
          : <button type="submit" disabled={busy || !answered(questions[current]!)}>Next question</button>}
      </>
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
function MessageText({ data, cwd, projectId, onOpenFile }: { data: Extract<AgentEventData, { type: 'text' }>; cwd: string; projectId?: string; onOpenFile(path: string, line?: number): void }): React.JSX.Element {
  // The memory-write directive is a control instruction for Conductor, not something the user
  // asked to read; it is captured elsewhere and must never surface in the rendered reply.
  const text = data.role === 'assistant' ? stripMemoryDirectives(data.text) : data.text
  const legacy = data.role === 'user' && !data.attachments?.length ? legacyAttachedContext(data.text) : null
  return <><StructuredMarkdown text={legacy?.prompt ?? text} cwd={cwd} projectId={projectId} onOpenFile={onOpenFile} />{legacy && <details className="sa-legacy-context"><summary>Attached context</summary><StructuredMarkdown text={legacy.context} cwd={cwd} projectId={projectId} onOpenFile={onOpenFile} /></details>}</>
}

export const StructuredActivity = memo(function StructuredActivity(props: ActivityProps): React.JSX.Element | null {
  if (!isConversationActivity(props.item)) return null
  const { data } = props.item
  let body: ReactNode
  switch (data.type) {
    // "You" is reserved for what the owner actually sent; a coordinated prompt names its tab.
    case 'text': body = <>{data.role === 'user' && (data.origin ? <span className="sa-role sa-role-coordinated" title={'Sent by ' + data.origin.label + ' through Conductor app control'}><Link2 size={11} />{data.origin.label}</span> : <span className="sa-role">You</span>)}<MessageText data={data} cwd={props.cwd} projectId={props.projectId} onOpenFile={props.onOpenFile} />{Boolean(data.attachments?.length) && <div className="sa-message-attachments" aria-label="Attached context">{data.attachments?.map(attachment => attachment.kind === 'image' && props.projectId && props.onInspectAttachment ? <button key={attachment.id} className="sa-sent-image" aria-label={'View image ' + attachment.name} title={'View ' + attachment.name} onClick={() => props.onInspectAttachment?.(attachment)}><PromptImageThumbnail projectId={props.projectId} attachment={attachment} /><span>{attachment.name}</span></button> : attachment.path ? <button key={attachment.id} className="sa-file-link" title={attachment.name} onClick={event => openAgentFile(event, props.cwd, attachment.path!, props.onOpenFile)}>{attachmentIcon(attachment.name)}{attachment.name}{attachment.startLine ? ':' + attachment.startLine : ''}</button> : <span key={attachment.id}>{attachmentIcon(attachment.name)}{attachment.name}</span>)}</div>}</>; break
    case 'tool': body = <ToolCard {...props} />; break
    case 'interaction': body = <InteractionCard {...props} />; break
    case 'changes': body = <section className="sa-changes" aria-label="File changes">{data.changes.map((change, index) => <div className="sa-file-change" key={change.path + '-' + index}>
      <header><button className="sa-file-link" onClick={(event) => openAgentFile(event, props.cwd, change.path, props.onOpenFile)}>{attachmentIcon(change.path)}<code>{change.oldPath ? change.oldPath + ' → ' : ''}{change.path}</code></button><span className="sa-diff-count">{change.additions !== undefined && <b>+{change.additions}</b>}{change.deletions !== undefined && <em>−{change.deletions}</em>}</span><small>{change.status}</small></header>
      {change.patch && <PatchPreview change={change} />}
      {(change.patch || change.artifactId) ? <button className="sa-expand-diff" onClick={() => props.onDiff(change)}><Maximize2 size={12} /> Click to expand diff</button> : change.limitation && <details className="sa-change-limitation"><summary>Diff unavailable</summary><p>{change.limitation}</p></details>}
    </div>)}</section>; break
    case 'plan': body = <section className="sa-plan"><strong>Plan</strong>{data.explanation && <StructuredMarkdown text={data.explanation} cwd={props.cwd} projectId={props.projectId} onOpenFile={props.onOpenFile} />}<ol>{data.steps.map((step, index) => <li key={index} className={'status-' + step.status}><span>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'}</span><span>{step.text}</span><small>{step.status.replace('_', ' ')}</small></li>)}</ol></section>; break
    case 'subagent': body = <section className="sa-subagent"><strong>{data.name}</strong><small>{data.status.replaceAll('_', ' ')}</small></section>; break
    case 'error': body = <p className="sa-error" role="alert">{data.message}{data.code && <small> ({data.code})</small>}</p>; break
    case 'notice': body = <div className="sa-notice">{data.message}{data.outputArtifactId && <OutputPreview sessionId={props.sessionId} artifactId={data.outputArtifactId} value="Saved terminal output from before structured integration. Native conversation identity was not recorded." />}</div>; break
    case 'review': body = <p className="sa-muted">{data.outcome === 'kept' ? 'Edit marked reviewed.' : 'Edit reverted.'}</p>; break
    case 'usage': return null
    case 'session': return null
  }
  return <article className={'sa-activity sa-kind-' + data.type + (data.type === 'text' ? ' sa-' + data.role : '') + (props.item.parentId ? ' sa-child' : '')} data-item-id={props.item.id} data-native-item-id={props.item.nativeItemId} data-parent-id={props.item.parentId}><span className="sa-marker" aria-hidden="true" />{props.item.parentId && props.parentLabel && <small className={'sa-parent-label' + (props.parentLabel.colorIndex !== undefined ? ' sa-agent-hue-' + props.parentLabel.colorIndex : '')} title={'Nested activity reported by ' + props.parentLabel.name}>Within {props.parentLabel.name}</small>}{body}</article>
})
