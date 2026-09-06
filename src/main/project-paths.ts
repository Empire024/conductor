import { isAbsolute, relative, resolve, sep } from 'node:path'

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/**
 * Validate a single filesystem path segment supplied by the renderer.
 * Keeping this separate from the IPC handlers makes the security boundary testable.
 */
export const safeEntryName = (requested: string): string => {
  const name = requested.trim()
  if (!name || name === '.' || name === '..') throw new Error('Enter a name')
  if (name !== requested) throw new Error('Names cannot start or end with spaces')
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error('The name contains unsupported characters')
  if (/[. ]$/.test(name)) throw new Error('Names cannot end with a dot or space')
  if (WINDOWS_DEVICE_NAME.test(name)) throw new Error('That name is reserved by Windows')
  return name
}

/** Resolve a renderer-supplied relative path without allowing it to escape the project. */
export const resolveWithinProject = (projectPath: string, requested = ''): string => {
  const root = resolve(projectPath)
  const target = resolve(root, requested)
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Path is outside the project')
  }
  return target
}

export const isProjectRoot = (projectPath: string, requested: string): boolean =>
  resolveWithinProject(projectPath, requested) === resolve(projectPath)
