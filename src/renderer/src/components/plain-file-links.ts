import { useEffect, useMemo, useState } from 'react'
import { resolveFileLinkTarget, type FileLinkProjectRoot, type ResolvedFileLink } from './file-link-target'
import { fileMachineId, isRemoteFileMachine, statMachineFile } from '../remote-files'

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[]; data?: Record<string, unknown> }
export interface PlainFileLink extends ResolvedFileLink { raw: string; key: string; machineId?: string }
interface Candidate extends PlainFileLink { start: number }

/** Deliberately narrow: paths need a separator or filename extension, so prose identifiers never
 * become filesystem probes. The final existence check is authoritative. */
const PATH = /(?:[A-Za-z]:[\\/][^<>"'`]*?\.[A-Za-z][A-Za-z0-9]{0,11}(?::\d+(?::\d+)?|#L\d+)?(?=[\s),;!?\]}]|\.(?=\s|$)|$)|(?:\.\.?[\\/])?(?:[A-Za-z0-9_@.-]+[\\/])+[A-Za-z0-9_@. -]+\.[A-Za-z][A-Za-z0-9]{0,11}|\b[A-Za-z0-9_@.-]+\.[A-Za-z][A-Za-z0-9]{0,11})(?::\d+(?::\d+)?|#L\d+)?/g
const MAX_CANDIDATES = 96

function trimPunctuation(value: string): string {
  return value.replace(/[),.;!?\]}]+$/, '')
}

const candidateKey = (machineId: string | undefined, owner: string, path: string): string => isRemoteFileMachine(machineId)
  ? fileMachineId(machineId) + '\u0000' + owner + '\u0000' + path
  : owner + '\u0000' + path
function findCandidates(value: string, cwd: string, projectId: string | undefined, projects: FileLinkProjectRoot[], machineId?: string): Candidate[] {
  const links: Candidate[] = []
  for (const match of value.matchAll(PATH)) {
    if (links.length === MAX_CANDIDATES) break
    const raw = trimPunctuation(match[0]!)
    const target = resolveFileLinkTarget(raw, cwd, projects, fileMachineId(machineId))
    const owner = target?.projectId ?? projectId
    if (!target || !owner || !raw) continue
    links.push({ ...target, raw, key: candidateKey(machineId, owner, target.path), ...(isRemoteFileMachine(machineId) ? { machineId: fileMachineId(machineId) } : {}), start: match.index! })
  }
  return links
}
export function findPlainFileLinks(value: string, cwd: string, projectId: string | undefined, projects: FileLinkProjectRoot[], machineId?: string): PlainFileLink[] {
  return findCandidates(value, cwd, projectId, projects, machineId).map(({ start: _start, ...link }) => link)
}
/** Inline code has an unambiguous boundary supplied by Markdown itself, so a full spaced filename
 * such as `CR5 model.blend` can be checked as one candidate without teaching prose scanning to
 * consume arbitrary words. */
function findInlineCodeLink(value: string, cwd: string, projectId: string | undefined, projects: FileLinkProjectRoot[], machineId?: string): PlainFileLink | null {
  if (!/^(?:[A-Za-z]:[\\/]|\.\.?[\\/])?(?:[A-Za-z0-9_@. -]+[\\/])*[A-Za-z0-9_@. -]+\.[A-Za-z][A-Za-z0-9]{0,11}(?::\d+(?::\d+)?|#L\d+)?$/.test(value)) return null
  const target = resolveFileLinkTarget(value, cwd, projects, fileMachineId(machineId))
  const owner = target?.projectId ?? projectId
  return target && owner ? { ...target, raw: value, key: candidateKey(machineId, owner, target.path), ...(isRemoteFileMachine(machineId) ? { machineId: fileMachineId(machineId) } : {}) } : null
}
export function findInlineCodeFileLinks(text: string, cwd: string, projectId: string | undefined, projects: FileLinkProjectRoot[], machineId?: string): PlainFileLink[] {
  const links: PlainFileLink[] = []
  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
    if (links.length === MAX_CANDIDATES) break
    const link = findInlineCodeLink(match[1]!, cwd, projectId, projects, machineId)
    if (link) links.push(link)
  }
  return links
}
/** One bounded verification queue per message. Inline spans are exact Markdown-bounded values,
 * so they lead; their full spaced names must not be crowded out by partial prose matches. */
export function collectFileLinkCandidates(text: string, cwd: string, projectId: string | undefined, projects: FileLinkProjectRoot[], machineId?: string): PlainFileLink[] {
  const result: PlainFileLink[] = []
  const seen = new Set<string>()
  for (const link of [...findInlineCodeFileLinks(text, cwd, projectId, projects, machineId), ...findPlainFileLinks(text, cwd, projectId, projects, machineId)]) {
    if (seen.has(link.key)) continue
    seen.add(link.key)
    result.push(link)
    if (result.length === MAX_CANDIDATES) break
  }
  return result
}

const CHECK_TTL = 15_000
const checked = new Map<string, { exists: boolean; expires: number }>()
const pending = new Map<string, PlainFileLink>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
function notify(): void { for (const listener of listeners) listener() }
function flushChecks(): void {
  timer = undefined
  const batch = [...pending.values()].slice(0, 24)
  for (const link of batch) pending.delete(link.key)
  for (const link of batch) {
    inFlight.add(link.key)
    const owner = link.projectId ?? link.key.split('\u0000')[isRemoteFileMachine(link.machineId) ? 1 : 0]!
    void statMachineFile(link.machineId, owner, link.path)
      .then((info) => Boolean(info.isFile))
      .catch(() => false)
      .then((exists) => { cacheResult(link.key, exists); inFlight.delete(link.key); notify() })
  }
  if (pending.size) timer = setTimeout(flushChecks, 40)
}
function cacheResult(key: string, exists: boolean, now = Date.now()): void {
  checked.set(key, { exists, expires: now + CHECK_TTL })
  while (checked.size > 512) checked.delete(checked.keys().next().value!)
}
/** Deterministic cache seam: verifies expiry and eviction policy without rendering a window. */
export const plainFileLinkCacheForTest = {
  clear: (): void => { checked.clear(); pending.clear(); inFlight.clear() },
  put: (key: string, exists: boolean, now: number): void => cacheResult(key, exists, now),
  get: (key: string, now: number): boolean => Boolean(checked.get(key)?.exists && checked.get(key)!.expires > now),
  size: (): number => checked.size,
  observe: (links: PlainFileLink[]): void => requestChecks(links),
  pendingKeys: (): string[] => [...pending.keys()],
  clearPending: (): void => pending.clear(),
  settle: (key: string, exists: boolean, now: number): void => { inFlight.delete(key); cacheResult(key, exists, now) }
}
function requestChecks(links: PlainFileLink[]): void {
  const now = Date.now()
  for (const link of links) {
    if ((!checked.get(link.key) || checked.get(link.key)!.expires <= now) && !inFlight.has(link.key)) pending.set(link.key, link)
  }
  if (pending.size && !timer) timer = setTimeout(flushChecks, 40)
}

/** Stat only the bounded set of path-shaped text fragments. A shared debounced queue means a
 * streaming conversation cannot turn every render into IPC traffic or a directory walk. */
export function useVerifiedPlainFileLinks(text: string, cwd: string, projectId: string | undefined, projects: FileLinkProjectRoot[], machineId?: string): Set<string> {
  const [, rerender] = useState(0)
  const links = useMemo(() => collectFileLinkCandidates(text, cwd, projectId, projects, machineId), [text, cwd, projectId, projects, machineId])
  useEffect(() => {
    const listener = (): void => rerender(value => value + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  useEffect(() => { requestChecks(links) }, [links])
  // A completed message stays clickable while mounted. TTL controls its next mount/text-change
  // re-stat, not whether a once-verified local file suddenly turns into plain prose.
  return new Set(links.filter(link => checked.get(link.key)?.exists).map(link => link.key))
}

function splitText(value: string, links: Candidate[], verified: Set<string>): MarkdownNode[] {
  const matches = links.filter(link => verified.has(link.key))
  if (!matches.length) return [{ type: 'text', value }]
  const result: MarkdownNode[] = []
  let cursor = 0
  for (const link of matches) {
    const start = link.start
    if (start > cursor) result.push({ type: 'text', value: value.slice(cursor, start) })
    result.push({ type: 'link', url: link.raw, data: { hProperties: { className: ['sa-plain-file-link'] } }, children: [{ type: 'text', value: link.raw }] })
    cursor = start + link.raw.length
  }
  if (cursor < value.length) result.push({ type: 'text', value: value.slice(cursor) })
  return result
}

/** Runs after Markdown parsing: explicit links, autolink URLs and fenced code are already their
 * own nodes and remain untouched. Inline code is retained as code inside a verified file link. */
export function plainFileLinkRemarkPlugin(verified: Set<string>, cwd: string, projectId: string | undefined, projects: FileLinkProjectRoot[], machineId?: string): () => (tree: MarkdownNode) => void {
  return () => (tree) => {
    const visit = (node: MarkdownNode): void => {
      if (!node.children || node.type === 'link' || node.type === 'code') return
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value) return splitText(child.value, findCandidates(child.value, cwd, projectId, projects, machineId), verified)
        if (child.type === 'inlineCode' && child.value) {
          const link = findInlineCodeLink(child.value, cwd, projectId, projects, machineId)
          return link && verified.has(link.key) ? [{ type: 'link', url: link.raw, data: { hProperties: { className: ['sa-plain-file-link'] } }, children: [child] }] : [child]
        }
        visit(child)
        return [child]
      })
    }
    visit(tree)
  }
}
