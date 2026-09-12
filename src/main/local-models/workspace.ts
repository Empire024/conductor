import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Containment refusal for anything a local model asked for outside its workspace. */
export class WorkspaceBoundaryError extends Error {}
/** A path the policy hides from local models even though it sits inside the workspace. */
export class SecretPathError extends Error {}

/** The mount point the sandbox container sees. Model output routinely carries these paths
 *  back (a grep hit, a stack trace), so they are accepted and mapped onto the real root
 *  instead of being refused as "absolute". No other absolute path is ever accepted. */
export const CONTAINER_WORKSPACE = '/workspace'

/** Files that must never reach a local model or its sandbox even when they are tracked in the
 *  project. Matched per path segment and per basename, so `packages/api/.env` is covered too.
 *  Example/template envs are deliberately allowed: they exist to be read. */
const SECRET_SEGMENTS = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.gcloud', '.kube', '.docker', '.local-models', '.conductor', 'node_modules/.cache'])
const SECRET_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', 'credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.env'])
const SECRET_PATTERNS = [/^\.env\./i, /\.pem$/i, /\.pfx$/i, /\.p12$/i, /\.kdbx$/i, /\.keystore$/i, /(^|[-_.])secret(s)?([-_.]|$)/i, /^id_(rsa|dsa|ecdsa|ed25519)/i]
const SECRET_ALLOW = [/^\.env\.(example|sample|template|dist)$/i, /\.secrets?\.(md|txt)$/i]

/** True when this workspace-relative path is one the local-model policy withholds. Shared by
 *  the host-side file tools and by the container mask list, so a file hidden from `read_file`
 *  is also masked inside the sandbox rather than merely absent from one of the two. */
export function isSecretPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/).filter(part => part && part !== '.')
  if (!parts.length) return false
  // A withheld directory withholds its descendants too. Apply the same name policy to
  // every ancestor, both before and after realpath resolves a public-looking alias.
  return parts.some(name => {
    if (SECRET_SEGMENTS.has(name.toLowerCase())) return true
    if (SECRET_ALLOW.some(pattern => pattern.test(name))) return false
    return SECRET_NAMES.has(name.toLowerCase()) || SECRET_PATTERNS.some(pattern => pattern.test(name))
  })
}

/** Git metadata is readable so the agent can inspect history, but never writable: a local model
 *  must not be able to install a hook or rewrite config in the owner's repository. */
export const isGitMetadata = (relativePath: string): boolean => relativePath.split(/[\\/]+/)[0] === '.git'

const inside = (root: string, candidate: string): boolean => {
  const part = relative(root, candidate)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** Strip the container's view of the workspace, refuse every other absolute or device path.
 *  Windows drive paths, UNC shares, WSL paths and NUL bytes are rejected before any fs call. */
export function normalizeRequestedPath(requested: string): string {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw new WorkspaceBoundaryError('A workspace-relative path is required')
  let value = requested.trim().replace(/\\/g, '/')
  if (value === CONTAINER_WORKSPACE) return '.'
  if (value.startsWith(CONTAINER_WORKSPACE + '/')) value = value.slice(CONTAINER_WORKSPACE.length + 1)
  if (/^[a-z]:/i.test(value) || value.startsWith('/') || value.startsWith('//') || value.startsWith('~')) throw new WorkspaceBoundaryError(`Path outside workspace: only paths under ${CONTAINER_WORKSPACE} are addressable`)
  return value
}

/** Canonicalizing containment check. The lexical result is resolved with `realpath` so a
 *  symlink, junction or `..` chain that leaves the workspace is refused on the real path,
 *  never on a string prefix. Missing files are allowed only when their existing parent is
 *  itself inside the workspace. */
export async function resolveInWorkspace(root: string, requested: string, allowMissing = false): Promise<{ path: string; relative: string }> {
  const value = normalizeRequestedPath(requested)
  // Policy first, filesystem second: a withheld path is refused as policy whether or not it
  // exists, so a missing .env never comes back as a confusing ENOENT.
  if (isSecretPath(value)) throw new SecretPathError('Path is withheld from local models by policy')
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, value)
  if (!inside(canonicalRoot, target) && target !== canonicalRoot) throw new WorkspaceBoundaryError('Path outside workspace')
  let path: string
  try {
    path = await realpath(target)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // New nested files need an existing ancestor, not an already-existing immediate parent.
    // Validate each missing component against that canonical ancestor before mkdir runs.
    let ancestor = dirname(target)
    let parent: string
    for (;;) {
      try { parent = await realpath(ancestor); break }
      catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === dirname(ancestor)) throw parentError
        ancestor = dirname(ancestor)
      }
    }
    if (!inside(canonicalRoot, parent) && parent !== canonicalRoot) throw new WorkspaceBoundaryError('Parent directory leaves the workspace')
    path = resolve(parent, relative(ancestor, target))
  }
  if (!inside(canonicalRoot, path) && path !== canonicalRoot) throw new WorkspaceBoundaryError('Symlink or junction leaves the workspace')
  const rel = relative(canonicalRoot, path).replace(/\\/g, '/')
  if (isSecretPath(rel)) throw new SecretPathError('Path is withheld from local models by policy')
  return { path, relative: rel || '.' }
}

/** Write-side containment: everything `resolveInWorkspace` enforces, plus the read-only
 *  treatment of `.git` so repository metadata cannot be rewritten from a sandboxed turn. */
export async function resolveWritablePath(root: string, requested: string): Promise<{ path: string; relative: string }> {
  if (isGitMetadata(normalizeRequestedPath(requested))) throw new SecretPathError('Git metadata is read-only for local models')
  const resolved = await resolveInWorkspace(root, requested, true)
  if (isGitMetadata(resolved.relative)) throw new SecretPathError('Git metadata is read-only for local models')
  return resolved
}
