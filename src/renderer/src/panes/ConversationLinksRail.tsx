import { useDeferredValue, useMemo, useState } from 'react'
import { ExternalLink, FileText, Globe, MessageCircleQuestion, PackageCheck, Paperclip, PencilLine, X } from 'lucide-react'
import type { TimelineItem } from '../../../shared/structured-agent'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { isRemoteOpenableDocument } from '../../../shared/remote-files'
import { useFileLinkProjectRoots } from '../components/file-link-target'
import { useVerifiedFileLinkKeys } from '../components/plain-file-links'
import { openWorkspaceFile } from '../components/workspace-files-state'
import { classifyExplorerFile } from '../components/workspace-sidebar-types'
import { conversationLinks, deliveredLinks, deliveredSignature, type ConversationLink } from './conversation-links'
import './ConversationLinksRail.css'

/**
 * The files the agent handed over in its latest delivering turn (feature-list
 * delivered-outputs-highlight), for the rail's Delivered group and the dot on its toggle. Computed
 * while the rail is closed too, so it reads only the last few turns, from the per-item cache.
 */
export function useDeliveredOutputs(items: readonly TimelineItem[], cwd: string, projectId: string, machineId?: string): { links: ConversationLink[]; signature: string } {
  const projects = useFileLinkProjectRoots()
  const deferredItems = useDeferredValue(items)
  const context = useMemo(() => ({ cwd, projectId, projects, machineId }), [cwd, projectId, projects, machineId])
  const candidates = useMemo(() => deliveredLinks(deferredItems, context).candidates, [deferredItems, context])
  const verified = useVerifiedFileLinkKeys(candidates)
  return useMemo(() => {
    const links = deliveredLinks(deferredItems, context, link => !link.candidate || verified.has(link.candidate.key)).links
    return { links, signature: deliveredSignature(links) }
  }, [deferredItems, context, verified])
}

/**
 * The conversation's links and files in one list beside the timeline, newest first, plus the
 * question the agent ended its turn with when nobody has answered it yet (feature-list e90b679f),
 * and the files its latest turn delivered at the top. Mounted only while open: a closed rail costs
 * nothing, and the list is derived from the items already in the renderer, deferred so it never
 * competes with typing or streaming.
 */
export function ConversationLinksRail({ items, cwd, projectId, machineId, asked, delivered, onDismissAsked, onJump, onOpenFile, onClose }: {
  items: readonly TimelineItem[]
  cwd: string
  projectId: string
  machineId?: string
  asked: { itemId: string; text: string } | null
  delivered: readonly ConversationLink[]
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
  const deliveredKeys = new Set(delivered.map(link => link.key))
  const shown = links.filter(link => (!link.candidate || verified.has(link.candidate.key)) && !deliveredKeys.has(link.key))
  const [error, setError] = useState('')
  // A PDF, an archive or anything else no Conductor view reads goes to the computer's default app;
  // files.open is for text files only.
  const external = (link: ConversationLink): boolean => Boolean(link.path) && (!link.machineId || link.machineId === LOCAL_MACHINE_ID) && ['pdf', 'external'].includes(classifyExplorerFile(link.path!))
  // The same for a conversation running on another machine: the document is fetched to a
  // read-only copy here and opened with this computer's default app (main: RemoteOpenCache).
  const remoteDocument = (link: ConversationLink): boolean => Boolean(link.path) && Boolean(link.machineId) && link.machineId !== LOCAL_MACHINE_ID && isRemoteOpenableDocument(link.path!)
  const open = (link: ConversationLink): void => {
    setError('')
    if (link.url) void window.conductor.system.openExternal(link.url)
    else if (link.path && remoteDocument(link)) void window.conductor.remote.files.openLocal({ machineId: link.machineId!, projectId: link.projectId ?? projectId, path: link.path }).catch((reason: unknown) => setError('Cannot open ' + link.label + ': ' + (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')))
    else if (link.path && external(link)) void window.conductor.files.openExternal(link.projectId ?? projectId, link.path).catch((reason: unknown) => setError('Cannot open ' + link.label + ': ' + (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')))
    else if (link.path && link.projectId && link.projectId !== projectId) openWorkspaceFile(link.projectId, link.path, 'auto', link.line, undefined, link.machineId)
    else if (link.path) onOpenFile(link.path, link.line)
  }
  const row = (link: ConversationLink): React.JSX.Element => {
    const Icon = link.kind === 'url' ? Globe : link.source === 'edit' ? PencilLine : link.source === 'attachment' ? Paperclip : FileText
    const detail = link.url ?? ((link.absolutePath ?? link.path!) + (link.line ? ':' + link.line : ''))
    return <li key={link.key}>
      <button type="button" className="sa-links-item" title={'Show where this came from: ' + detail} onClick={() => onJump(link.itemId)}>
        <Icon size={12} aria-hidden="true" /><span>{link.label}</span><small>{link.kind === 'url' ? detail.replace(/^https?:\/\//, '') : link.path!.includes('/') ? link.path!.slice(0, link.path!.lastIndexOf('/')) : link.source === 'edit' ? 'edited' : ''}</small>
      </button>
      <button type="button" className="sa-links-open" aria-label={'Open ' + link.label} title={link.kind === 'url' ? 'Open in the browser' : external(link) ? 'Open with the default app' : remoteDocument(link) ? 'Open a copy with the default app' : 'Open the file'} onClick={() => open(link)}><ExternalLink size={12} /></button>
    </li>
  }
  return <aside className="sa-links-rail" aria-label="Links and files in this conversation">
    <header><strong>Links &amp; files</strong><small>{shown.length + delivered.length || ''}</small><button type="button" aria-label="Close links and files" title="Close" onClick={onClose}><X size={13} /></button></header>
    {asked && <section className="sa-links-asked" aria-label="Question you have not answered">
      <h4><MessageCircleQuestion size={12} aria-hidden="true" /> Asked you</h4>
      <button type="button" className="sa-links-asked-text" title="Show this message" onClick={() => onJump(asked.itemId)}>{asked.text}</button>
      <button type="button" className="sa-links-asked-dismiss" onClick={() => onDismissAsked(asked.itemId)}>Dismiss</button>
    </section>}
    {error && <p className="sa-links-error" role="alert">{error}</p>}
    {delivered.length > 0 && <section className="sa-links-delivered" aria-label="Delivered files">
      <h4><PackageCheck size={12} aria-hidden="true" /> Delivered</h4>
      <ul>{delivered.map(row)}</ul>
    </section>}
    {shown.length === 0
      ? delivered.length ? null : <p className="sa-links-empty">No links or files yet. URLs and files the agent mentions, edits or is given show up here.</p>
      : <ul>{shown.map(row)}</ul>}
  </aside>
}
