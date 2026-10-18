import { useDeferredValue, useMemo } from 'react'
import { ExternalLink, FileText, Globe, MessageCircleQuestion, Paperclip, PencilLine, X } from 'lucide-react'
import type { TimelineItem } from '../../../shared/structured-agent'
import { useFileLinkProjectRoots } from '../components/file-link-target'
import { useVerifiedFileLinkKeys } from '../components/plain-file-links'
import { openWorkspaceFile } from '../components/workspace-files-state'
import { conversationLinks, type ConversationLink } from './conversation-links'
import './ConversationLinksRail.css'

/**
 * The conversation's links and files in one list beside the timeline, newest first, plus the
 * question the agent ended its turn with when nobody has answered it yet (feature-list e90b679f).
 * Mounted only while open: a closed rail costs nothing, and the list is derived from the items
 * already in the renderer, deferred so it never competes with typing or streaming.
 */
export function ConversationLinksRail({ items, cwd, projectId, machineId, asked, onDismissAsked, onJump, onOpenFile, onClose }: {
  items: readonly TimelineItem[]
  cwd: string
  projectId: string
  machineId?: string
  asked: { itemId: string; text: string } | null
  onDismissAsked(itemId: string): void
  onJump(itemId: string): void
  onOpenFile(path: string, line?: number): void
  onClose(): void
}): React.JSX.Element {
  const projects = useFileLinkProjectRoots()
  const deferredItems = useDeferredValue(items)
  const links = useMemo(() => conversationLinks(deferredItems, { cwd, projectId, projects, machineId }), [deferredItems, cwd, projectId, projects, machineId])
  const candidates = useMemo(() => links.flatMap(link => link.candidate ? [link.candidate] : []), [links])
  const verified = useVerifiedFileLinkKeys(candidates)
  const shown = links.filter(link => !link.candidate || verified.has(link.candidate.key))
  const open = (link: ConversationLink): void => {
    if (link.url) void window.conductor.system.openExternal(link.url)
    else if (link.path && link.projectId && link.projectId !== projectId) openWorkspaceFile(link.projectId, link.path, 'auto', link.line, undefined, link.machineId)
    else if (link.path) onOpenFile(link.path, link.line)
  }
  return <aside className="sa-links-rail" aria-label="Links and files in this conversation">
    <header><strong>Links &amp; files</strong><small>{shown.length ? shown.length : ''}</small><button type="button" aria-label="Close links and files" title="Close" onClick={onClose}><X size={13} /></button></header>
    {asked && <section className="sa-links-asked" aria-label="Question you have not answered">
      <h4><MessageCircleQuestion size={12} aria-hidden="true" /> Asked you</h4>
      <button type="button" className="sa-links-asked-text" title="Show this message" onClick={() => onJump(asked.itemId)}>{asked.text}</button>
      <button type="button" className="sa-links-asked-dismiss" onClick={() => onDismissAsked(asked.itemId)}>Dismiss</button>
    </section>}
    {shown.length === 0
      ? <p className="sa-links-empty">No links or files yet. URLs and files the agent mentions, edits or is given show up here.</p>
      : <ul>{shown.map(link => {
        const Icon = link.kind === 'url' ? Globe : link.source === 'edit' ? PencilLine : link.source === 'attachment' ? Paperclip : FileText
        const detail = link.url ?? (link.path! + (link.line ? ':' + link.line : ''))
        return <li key={link.key}>
          <button type="button" className="sa-links-item" title={'Show where this came from: ' + detail} onClick={() => onJump(link.itemId)}>
            <Icon size={12} aria-hidden="true" /><span>{link.label}</span><small>{link.kind === 'url' ? detail.replace(/^https?:\/\//, '') : link.path!.includes('/') ? link.path!.slice(0, link.path!.lastIndexOf('/')) : link.source === 'edit' ? 'edited' : ''}</small>
          </button>
          <button type="button" className="sa-links-open" aria-label={'Open ' + link.label} title={link.kind === 'url' ? 'Open in the browser' : 'Open the file'} onClick={() => open(link)}><ExternalLink size={12} /></button>
        </li>
      })}</ul>}
  </aside>
}
