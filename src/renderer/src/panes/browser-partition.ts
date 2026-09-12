/** Never fall back to the legacy shared profile, including while a project is loading. */
export function browserPartition(projectId: string | null | undefined): string | null {
  return typeof projectId === 'string' && projectId.trim().length > 0
    ? `persist:conductor-browser-${projectId}`
    : null
}
