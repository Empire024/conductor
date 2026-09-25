import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * One spelling per directory, so a root and a file inside it relativize to `src/a.ts` rather than
 * `../../../runneradmin/...`. The same folder can be named several ways: a Windows 8.3 alias
 * (`C:\Users\RUNNER~1`) and its long name, a macOS `/var/folders/...` and its target under
 * `/private/var`, a junction or any other symlinked ancestor. `realpathSync.native` expands all of
 * them. A path that does not exist yet keeps its missing tail and canonicalizes its nearest
 * existing ancestor, so a file about to be written compares like one already on disk.
 *
 * This is for comparing and naming paths, not a containment guard: a caller that must refuse a
 * symlink escape still resolves and checks the real target itself.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  for (let current = absolute; ;) {
    try {
      const real = realpathSync.native(current)
      return missing.length ? join(real, ...missing.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

/** `path` relative to `root`, both canonicalized first, with forward slashes. `''` for the root
 *  itself; a path outside the root keeps its `..` form so callers can still refuse it. */
export function canonicalRelative(root: string, path: string): string {
  return relative(canonicalPath(root), canonicalPath(path)).split(sep).join('/')
}

/** True when `path` is `root` or inside it once both are canonicalized. Case follows the platform:
 *  `path.relative` already compares case-insensitively on Windows. */
export function isCanonicallyWithin(root: string, path: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
