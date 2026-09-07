export type FileViewMode = 'editor' | 'preview' | 'browser'
export interface WorkspaceFile { id: string; projectId: string; path: string; mode: FileViewMode; line?: number }
export interface OpenWorkspaceFile { projectId: string; path: string; mode: FileViewMode; line?: number }
export function openWorkspaceFile(projectId: string, path: string, mode: FileViewMode = 'editor', line?: number): void {
  window.dispatchEvent(new CustomEvent<OpenWorkspaceFile>('conductor:open-file', { detail: { projectId, path, mode, line } }))
}
export function changeWorkspacePath(projectId: string, previousPath: string, nextPath: string | null, kind: 'file' | 'directory'): void {
  const update = (files: WorkspaceFile[]): WorkspaceFile[] => files.flatMap((file) => {
    if (file.projectId !== projectId || !(file.path === previousPath || (kind === 'directory' && file.path.startsWith(previousPath + '/')))) return [file]
    return nextPath === null ? [] : [{ ...file, path: nextPath + file.path.slice(previousPath.length) }]
  })
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith('conductor.workspaceFiles.')) continue
    try { const stored = JSON.parse(localStorage.getItem(key) ?? '{}'); stored.files = update(stored.files ?? []); localStorage.setItem(key, JSON.stringify(stored)) } catch { /* stale record */ }
  }
  window.dispatchEvent(new CustomEvent('conductor:files-path-changed', { detail: { projectId, previousPath, nextPath, kind } }))
}
export function loadWorkspaceFiles(workspaceId: string): { files: WorkspaceFile[]; activeId: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem('conductor.workspaceFiles.' + workspaceId) ?? 'null')
    if (saved && Array.isArray(saved.files)) return { files: saved.files.filter((file: WorkspaceFile) => typeof file.id === 'string' && typeof file.projectId === 'string' && typeof file.path === 'string' && ['editor', 'preview', 'browser'].includes(file.mode)), activeId: saved.activeId }
    const legacy = JSON.parse(localStorage.getItem('conductor.workspaceDocument.' + workspaceId) ?? 'null')
    if (legacy?.path) { const id = 'document:' + workspaceId + ':' + legacy.path; return { files: [{ ...legacy, id }], activeId: id } }
  } catch { /* an invalid UI record must not prevent opening the workspace */ }
  return { files: [], activeId: null }
}

export function workspaceFileIds(projectId?: string, workspaceId?: string): string[] {
  const ids = new Set<string>()
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith('conductor.workspaceFiles.') || workspaceId && key !== 'conductor.workspaceFiles.' + workspaceId) continue
    try { const record = JSON.parse(localStorage.getItem(key) ?? '{}'); for (const file of record.files ?? []) if ((!projectId || file.projectId === projectId) && typeof file.id === 'string') ids.add(file.id) } catch { /* stale UI record */ }
  }
  return [...ids]
}
