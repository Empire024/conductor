/** Stable renderer/main-process identity for the one browser surface owned by a project.
 * The value is deliberately not a workspace tab id: the browser lives in the left surface and
 * remains mounted while hidden, so model tools never need to create or focus a workspace tab. */
export function projectBrowserViewId(projectId: string | null | undefined): string | null {
  const id = projectId?.trim()
  if (!id || id.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(id)) return null
  return `project-browser:${id}`
}
