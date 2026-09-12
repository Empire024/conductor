export type BrowserPresentation = import('../../../shared/browser-surface').BrowserPresentation

export const browserPresentationKey = (projectId: string): string => `conductor.browserPresentation.${projectId}`
export const mountedBrowserProjectsKey = 'conductor.browserMountedProjects'

export function savedBrowserPresentation(projectId: string, storage: Pick<Storage, 'getItem'> = localStorage): BrowserPresentation {
  const saved = storage.getItem(browserPresentationKey(projectId))
  return saved === 'expanded' || saved === 'background' || saved === 'detached' ? saved : 'pane'
}

export function persistBrowserPresentation(projectId: string, presentation: BrowserPresentation, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(browserPresentationKey(projectId), presentation)
}

export function savedMountedBrowserProjects(storage: Pick<Storage, 'getItem'> = localStorage): Set<string> {
  try {
    const parsed = JSON.parse(storage.getItem(mountedBrowserProjectsKey) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\r\n\0]/.test(id)))
  } catch { return new Set() }
}

export function persistMountedBrowserProjects(projectIds: Iterable<string>, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(mountedBrowserProjectsKey, JSON.stringify([...new Set(projectIds)]))
}
