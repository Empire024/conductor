import { useEffect, useState } from 'react'

export interface FileLinkProjectRoot { id: string; path: string }
/** A link an agent wrote, resolved to the project that actually owns it. `projectId` is left
 *  undefined when the file belongs to the conversation's own workspace, so callers keep using
 *  the host's own project scope for the common case. */
export interface ResolvedFileLink { path: string; line?: number; projectId?: string }

const posix = (value: string): string => value.replaceAll('\\', '/')
const trimRoot = (root: string): string => posix(root).replace(/\/+$/, '')

/** An absolute Windows path reaches a markdown link in every shape a URL allows: `C:\x`, `C:/x`,
 *  `/C:/x` (what a URL parser makes of a drive path, and what Claude emits) and `file:///C:/x`,
 *  with `%20` wherever a folder has a space. All four name one file, so all four must normalize
 *  to the same path before it is matched against a project root. */
export function normalizeLinkPath(raw: string): { path: string; line?: number } | null {
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (/[\u0000-\u001f]/.test(decoded)) return null
  let path = posix(decoded)
  const fileUrl = /^file:\/\/([^/]*)(\/.*)$/i.exec(path)
  // A host between `file://` and the path is a UNC share, never a local project file.
  if (fileUrl) { if (fileUrl[1]) return null; path = fileUrl[2]! }
  path = path.replace(/^\/(?=[a-zA-Z]:(?:\/|$))/, '')
  const lineMatch = path.match(/(?::(\d+)(?::\d+)?|#L(\d+))$/)
  const line = lineMatch ? Number(lineMatch[1] ?? lineMatch[2]) : undefined
  if (lineMatch) path = path.slice(0, lineMatch.index)
  return { path, line: line && Number.isSafeInteger(line) && line > 0 ? line : undefined }
}

/** Resolve a link to `{ projectId, path }` inside whichever open project contains it: the
 *  conversation's own workspace, or a sibling project open in the same session. Containment is
 *  unchanged — traversal, UNC hosts, other URL schemes and anything outside every open project
 *  are still refused here, and the main process re-checks every path it is handed. */
export function resolveFileLinkTarget(raw: string, cwd: string, projects: FileLinkProjectRoot[] = []): ResolvedFileLink | null {
  const normalized = normalizeLinkPath(raw)
  if (!normalized) return null
  let path = normalized.path
  if (path.startsWith('//')) return null
  const roots = [{ id: undefined as string | undefined, root: trimRoot(cwd) }, ...projects.map((project) => ({ id: project.id, root: trimRoot(project.path) }))].filter((entry) => entry.root)
  // Longest root wins so a project checked out inside another resolves to the inner one, and the
  // conversation's own workspace leads so an equally long match stays with the current project.
  const owner = roots.filter((entry) => path.toLowerCase().startsWith(entry.root.toLowerCase() + '/')).sort((a, b) => b.root.length - a.root.length)[0]
  if (owner) path = path.slice(owner.root.length + 1)
  else if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path)) return null
  path = path.replace(/^\.\//, '')
  if (!path || path.split('/').some((part) => part === '..' || !part) || path.includes(':')) return null
  return { path, line: normalized.line, projectId: owner?.id }
}

const PROJECT_ROOT_TTL_MS = 10_000
let cachedRoots: FileLinkProjectRoot[] = []
let fetchedAt = 0
let inFlight = false
const subscribers = new Set<(roots: FileLinkProjectRoot[]) => void>()
function loadProjectRoots(): void {
  if (inFlight || Date.now() - fetchedAt < PROJECT_ROOT_TTL_MS) return
  const list = window.conductor?.projects?.list
  if (!list) return
  inFlight = true
  void window.conductor.projects.list().then((projects) => {
    cachedRoots = projects.map((project) => ({ id: project.id, path: project.path }))
    fetchedAt = Date.now()
    for (const notify of subscribers) notify(cachedRoots)
  }).catch(() => { /* A link still resolves inside its own workspace without the sibling list. */ })
    .finally(() => { inFlight = false })
}
/** Every rendered message asks the same question, so one shared, short-lived list of co-open
 *  projects serves them all instead of an IPC round trip per link. */
export function useFileLinkProjectRoots(): FileLinkProjectRoot[] {
  const [roots, setRoots] = useState(cachedRoots)
  useEffect(() => {
    subscribers.add(setRoots)
    loadProjectRoots()
    return () => { subscribers.delete(setRoots) }
  }, [])
  return roots
}
