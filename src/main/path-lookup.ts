import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * `where.exe <command>` / `which <command>` without starting a process. Provider availability is
 * read on main for every catalog (phone access recomputes one after agent events), and each
 * where.exe was a CreateProcess on main's thread: with coworkers streaming, main spent most of a
 * minute blocked in them and every keystroke waited behind it (typing-lag-long-conversation,
 * scripts/perf-input.mjs --background). Same order as where.exe on Windows: the current directory,
 * then PATH, and in each directory the bare name first, then the name with each PATHEXT extension.
 * POSIX: the first executable file on PATH, as `which`.
 */
export interface PathLookupOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cwd?: string
  isFile?: (path: string) => boolean
  isExecutable?: (path: string) => boolean
}

const fileExists = (path: string): boolean => {
  try { return statSync(path).isFile() } catch { return false }
}
const executable = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

export function lookupOnPath(command: string, options: PathLookupOptions = {}): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isFile = options.isFile ?? fileExists
  const windows = platform === 'win32'
  const pathValue = (windows ? env.Path ?? env.PATH : env.PATH) ?? ''
  const { delimiter, join } = windows ? win32 : posix
  const directories = pathValue.split(delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  if (windows) {
    const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(extension => extension.trim()).filter(Boolean)
    for (const directory of [options.cwd ?? process.cwd(), ...directories]) {
      for (const candidate of [command, ...extensions.map(extension => command + extension.toLowerCase())]) {
        const path = join(directory, candidate)
        if (isFile(path)) return path
      }
    }
    return null
  }
  const canRun = options.isExecutable ?? executable
  for (const directory of directories) {
    const path = join(directory, command)
    if (isFile(path) && canRun(path)) return path
  }
  return null
}

const CACHE_MS = 30_000
const cache = new Map<string, { path: string | null; at: number }>()

/** lookupOnPath, remembered for 30 s per command and PATH: a CLI installed while Conductor runs is
 *  found within that, and a catalog read in a burst of agent events costs nothing. */
export function cachedLookupOnPath(command: string, now = Date.now(), options: PathLookupOptions = {}): string | null {
  const env = options.env ?? process.env
  const key = command + '\0' + (env.Path ?? env.PATH ?? '') + '\0' + (env.PATHEXT ?? '')
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.path
  const path = lookupOnPath(command, options)
  cache.set(key, { path, at: now })
  return path
}

export function clearPathLookupCache(): void { cache.clear() }
