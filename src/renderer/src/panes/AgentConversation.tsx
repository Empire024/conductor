import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  CircleEllipsis,
  FileCode2,
  MessageCircleQuestion,
  PackageCheck,
  SearchCode,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench
} from 'lucide-react'
import type { AgentActivityPhase, NormalizedAgentEvent, RuntimeEnsureResult } from '../../../shared/models'
import type { AgentVisualBlock } from '../../../shared/agent-visual'
import { buildAgentVisualTimeline } from './agent-event-blocks'
import './AgentConversation.css'

interface AgentConversationProps {
  providerName: string
  model: string
  projectPath: string
  events: NormalizedAgentEvent[]
  transcript: string
  liveResponse: string
  phase: AgentActivityPhase
  status: RuntimeEnsureResult['status']
  onRestart(): void
  workspaceTrusted?: boolean
  onQuestionResponse?(value: string): void
  onTrustWorkspace?(value: string): void
  onOpenFile?(path: string, line?: number): void
}

const timeLabel = (value: string): string => new Date(value).toLocaleTimeString([], {
  hour: '2-digit', minute: '2-digit'
})

const blockIcon = (block: AgentVisualBlock): typeof Bot => {
  if (block.kind === 'command') return TerminalSquare
  if (block.kind === 'file') return FileCode2
  if (block.kind === 'tool') return Wrench
  if (block.kind === 'question') return MessageCircleQuestion
  if (block.kind === 'error') return AlertTriangle
  if (block.kind === 'completion') return Check
  if (block.kind === 'artifact') return PackageCheck
  if (block.kind === 'finding') return SearchCode
  return CircleEllipsis
}

const inlineParts = (line: string): React.ReactNode[] => {
  const parts: React.ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let cursor = 0
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) parts.push(line.slice(cursor, index))
    const value = match[0]
    parts.push(value.startsWith('`')
      ? <code key={`${index}-${value}`}>{value.slice(1, -1)}</code>
      : <strong key={`${index}-${value}`}>{value.slice(2, -2)}</strong>)
    cursor = index + value.length
  }
  if (cursor < line.length) parts.push(line.slice(cursor))
  return parts
}

const readableBody = (body: string): string => {
  const seen = new Set<string>()
  return body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (/^[╭╮╰╯│─┌┐└┘═━┏┓┗┛┊┋]{3,}$/.test(trimmed)) return false
      if (!trimmed || trimmed.length > 180) return true
      if (seen.has(trimmed) && /^(Claude|Codex|Gemini|Qwen|Kimi|Model|Context|Tips?:)/i.test(trimmed)) return false
      seen.add(trimmed)
      return true
    })
    .join('\n')
    .replace(/\n{4,}/g, '\n\n')
    .trim()
}

function RichText({ body }: { body: string }): React.JSX.Element {
  const lines = readableBody(body).split('\n')
  const rendered: React.ReactNode[] = []
  let code: string[] | null = null
  let language = ''
  let bullets: string[] = []
  const flushBullets = (): void => {
    if (!bullets.length) return
    rendered.push(<ul key={`list-${rendered.length}`}>{bullets.map((line, index) => <li key={index}>{inlineParts(line)}</li>)}</ul>)
    bullets = []
  }
  const flushCode = (): void => {
    if (!code) return
    const codeText = code.join('\n')
    rendered.push(<pre key={`code-${rendered.length}`}><header><span>{language || 'code'}</span><button onClick={() => {
      void navigator.clipboard.writeText(codeText)
      window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Code copied' }))
    }}>Copy</button></header><code>{codeText}</code></pre>)
    code = null
    language = ''
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushBullets()
      if (code) flushCode()
      else {
        language = line.trim().slice(3).trim()
        code = []
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/)
    if (bullet) {
      bullets.push(bullet[1]!)
      continue
    }
    flushBullets()
    if (!line.trim()) continue
    const heading = line.match(/^\s*#{1,4}\s+(.+)$/)
    if (heading) rendered.push(<h3 key={`heading-${rendered.length}`}>{inlineParts(heading[1]!)}</h3>)
    else rendered.push(<p key={`paragraph-${rendered.length}`}>{inlineParts(line)}</p>)
  }
  flushBullets()
  flushCode()
  return <div className="agent-rich-text">{rendered}</div>
}

export function AgentConversation(props: AgentConversationProps): React.JSX.Element {
  const streamRef = useRef<HTMLDivElement>(null)
  const [showLatest, setShowLatest] = useState(false)
  const timeline = useMemo(() => buildAgentVisualTimeline(props.events, {
    rawTranscript: props.transcript,
    projectPath: props.projectPath
  }), [props.events, props.projectPath, props.transcript])
  const visibleBlocks = timeline.blocks.filter((block) => {
    if (block.metadata?.presentation === 'quiet') return false
    if (props.workspaceTrusted && block.kind === 'question' && block.metadata?.kind === 'directory_trust') return false
    if (block.kind !== 'message') return true
    return block.metadata?.role === 'user' || block.metadata?.source === 'terminal_screen'
  })

  useEffect(() => {
    const stream = streamRef.current
    if (!stream || showLatest) return
    requestAnimationFrame(() => stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' }))
  }, [props.events, props.liveResponse, props.phase, showLatest])

  const jumpToLatest = (): void => {
    const stream = streamRef.current
    if (!stream) return
    stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' })
    setShowLatest(false)
  }

  return (
    <div className="agent-conversation">
      <div
        ref={streamRef}
        className="agent-conversation-scroll"
        onScroll={(event) => {
          const target = event.currentTarget
          setShowLatest(target.scrollHeight - target.scrollTop - target.clientHeight > 120)
        }}
      >
        <div className="agent-conversation-column">
          {visibleBlocks.length === 0 && (
            <div className="agent-conversation-empty">
              <span><Sparkles size={24} /></span>
              <strong>{props.providerName} is ready</strong>
              <small>{props.model === 'default' ? 'Account default model' : props.model}</small>
            </div>
          )}
          {visibleBlocks.map((block) => {
            const role = block.metadata?.role
            if (block.kind === 'message') {
              return role === 'user' ? (
                <article className="agent-turn user" key={block.id}>
                  <header><strong>You</strong><time>{timeLabel(block.createdAt)}</time></header>
                  <RichText body={block.body} />
                  <footer>{typeof block.metadata?.mode === 'string' && <span>{block.metadata.mode} mode</span>}</footer>
                </article>
              ) : (
                <article className="agent-turn assistant" key={block.id}>
                  <header><span><Sparkles size={14} /></span><strong>{props.providerName}</strong><time>{timeLabel(block.createdAt)}</time></header>
                  <RichText body={block.body} />
                  {block.files.length > 0 && <footer>{block.files.map((file) => (
                    <button key={`${file.path}:${file.line ?? ''}`} onClick={() => props.onOpenFile?.(file.path, file.line)}><FileCode2 size={12} />{file.path}{file.line ? `:${file.line}` : ''}</button>
                  ))}</footer>}
                </article>
              )
            }
            const Icon = blockIcon(block)
            return (
              <article className={`agent-event-card ${block.kind} ${block.tone}`} key={block.id}>
                <span className="agent-event-icon"><Icon size={15} /></span>
                <div>
                  <header><strong>{block.title}</strong><time>{timeLabel(block.createdAt)}</time></header>
                  {block.body && block.body !== block.title && <p>{block.body}</p>}
                  {block.command && <code>{block.command}</code>}
                  {block.files.length > 0 && <footer>{block.files.map((file) => (
                    <button key={`${file.path}:${file.line ?? ''}`} onClick={() => props.onOpenFile?.(file.path, file.line)}><FileCode2 size={12} />{file.path}{file.line ? `:${file.line}` : ''}</button>
                  ))}</footer>}
                  {block.kind === 'question' && block.metadata?.kind === 'directory_trust' && (
                    <footer className="agent-question-actions">
                      <button onClick={() => props.onQuestionResponse?.(typeof block.metadata?.acceptInput === 'string' ? block.metadata.acceptInput : '\r')}><Check size={12} /> Trust and continue</button>
                      <button onClick={() => props.onTrustWorkspace?.(typeof block.metadata?.acceptInput === 'string' ? block.metadata.acceptInput : '\r')}><ShieldCheck size={12} /> Always trust this workspace</button>
                      <button className="danger" onClick={() => props.onQuestionResponse?.(typeof block.metadata?.rejectInput === 'string' ? block.metadata.rejectInput : '\u001b[B\r')}>Don&apos;t trust — quit</button>
                    </footer>
                  )}
                </div>
                <ChevronRight size={13} />
              </article>
            )
          })}
          {props.liveResponse && (
            <article className="agent-turn assistant live" key="live-response">
              <header><span><Sparkles size={14} /></span><strong>{props.providerName}</strong><small>live</small></header>
              <RichText body={props.liveResponse} />
            </article>
          )}
          {props.phase === 'working' && (
            <div className="agent-working-row" role="status">
              <span className="agent-working-mark"><i /><i /><i /></span>
            <div><strong>{props.providerName} is working</strong></div>
            </div>
          )}
          {props.status === 'exited' && (
            <div className="agent-session-ended">
              <div><TerminalSquare size={16} /><span><strong>Provider session ended</strong><small>Your conversation history is still here.</small></span></div>
              <button onClick={props.onRestart}>Restart session</button>
            </div>
          )}
        </div>
      </div>
      {showLatest && <button className="agent-jump-latest" onClick={jumpToLatest}><ArrowDown size={14} /> Latest</button>}
    </div>
  )
}
