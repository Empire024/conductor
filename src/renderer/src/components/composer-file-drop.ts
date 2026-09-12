export const CONDUCTOR_FILE_DRAG = 'application/x-conductor-project-file'

export interface ConductorFileDrag {
  projectId: string
  path: string
  kind: 'file' | 'directory'
}

export function encodeConductorFileDrag(value: ConductorFileDrag): string {
  return JSON.stringify(value)
}

/** Drag payloads are renderer input, not authority. The backend still resolves project identity,
 * containment and symlinks before reading or moving anything. */
export function decodeConductorFileDrag(value: string): ConductorFileDrag | null {
  try {
    const parsed = JSON.parse(value) as Partial<ConductorFileDrag>
    if (!parsed || typeof parsed.projectId !== 'string' || !parsed.projectId || parsed.projectId.length > 160) return null
    if (typeof parsed.path !== 'string' || !parsed.path || parsed.path.length > 4096 || parsed.path.includes('\0')) return null
    if (parsed.kind !== 'file' && parsed.kind !== 'directory') return null
    return { projectId: parsed.projectId, path: parsed.path, kind: parsed.kind }
  } catch { return null }
}

export function isComposerFileDrag(types: readonly string[]): boolean {
  return types.includes(CONDUCTOR_FILE_DRAG) || types.includes('Files')
}
