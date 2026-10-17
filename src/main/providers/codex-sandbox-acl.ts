import { execFile } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Codex's Windows sandbox runs a command as a CodexSandboxUsers account (or a restricted token)
 * and grants it the workspace through inheritable ACEs on the project folder. `pip install
 * --target .deps` on Python 3.13+ builds each package in a `tempfile.mkdtemp()` folder, which
 * Python now creates with a protected owner-only DACL (`D:P(A;OICI;FA;;;OW)(…;SY)(…;BA)`), and then
 * moves it into .deps. The moved folder keeps that DACL, inherits nothing, and the sandbox cannot
 * list or read it: `Get-ChildItem .deps/PIL` is denied and `from PIL import Image` finds an empty
 * namespace package (miron, 2026-10-17). Naming .deps as a writable root does not help: Codex
 * grants the root, and the protected folders below it block inheritance.
 *
 * The repair is to turn inheritance back on for such a top-level entry: it keeps every explicit
 * ACE and adds the parent's, which is exactly what any other file in the project has. Only the
 * project's own .deps/.cache entries are touched, never a link (icacls follows links) and never
 * anything outside the project.
 */
export interface IcaclsResult { code: number; stdout: string; stderr: string }
export type IcaclsRunner = (args: string[]) => Promise<IcaclsResult>

export const runIcacls: IcaclsRunner = args => new Promise(resolve => {
  execFile('icacls.exe', args, { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    const exit: unknown = error && (error as { code?: unknown }).code
    const code = !error ? 0 : typeof exit === 'number' ? exit : 1
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stdout ? error.message : '')) })
  })
})

/** At most this many protected entries are repaired in one pass; the rest get the owner command. */
export const MAX_ACL_REPAIRS = 64

/**
 * The names among `names` whose icacls listing (from `icacls "<root>\*"`) has ACEs and none of
 * them inherited: a protected DACL. A name is matched by its line prefix `<root>\<name> `, longest
 * name first, so names with spaces and names that prefix one another are told apart.
 */
export function protectedEntries(listing: string, root: string, names: readonly string[]): string[] {
  const base = root.replace(/[\\/]+$/, '').toLowerCase() + '\\'
  const ordered = [...names].sort((a, b) => b.length - a.length)
  const aces = new Map<string, string[]>()
  let current: string | undefined
  for (const raw of listing.split(/\r?\n/)) {
    if (!raw.trim()) { current = undefined; continue }
    if (/^\s/.test(raw)) { if (current !== undefined) aces.get(current)!.push(raw.trim()); continue }
    current = undefined
    const lower = raw.toLowerCase()
    if (!lower.startsWith(base)) continue
    const rest = lower.slice(base.length)
    const name = ordered.find(candidate => rest.startsWith(candidate.toLowerCase() + ' '))
    if (name === undefined) continue
    current = name
    aces.set(name, [raw.slice(base.length + name.length).trim()])
  }
  return names.filter(name => {
    const list = (aces.get(name) ?? []).filter(Boolean)
    return list.length > 0 && !list.some(ace => ace.includes('(I)'))
  })
}

export interface AclRepairResult {
  /** Entries whose inheritance was turned back on, as absolute paths. */
  repaired: string[]
  /** One sentence each, without the "Codex sandbox:" prefix or a final period. */
  problems: string[]
}

const quoteArg = (path: string): string => `"${path}"`
const ownerCommand = (root: string): string => `icacls ${quoteArg(join(root, '*'))} /inheritance:e /C`

/**
 * Turns inheritance back on for the protected top-level entries of one project dependency folder
 * (see the module comment). `root` must be a real folder inside the project; links among its
 * entries are skipped.
 */
export async function repairSandboxReadAccess(root: string, run: IcaclsRunner = runIcacls): Promise<AclRepairResult> {
  const repaired: string[] = [], problems: string[] = []
  try { const entry = lstatSync(root); if (!entry.isDirectory() || entry.isSymbolicLink()) return { repaired, problems } } catch { return { repaired, problems } }
  let names: string[]
  try { names = readdirSync(root, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink()).map(entry => entry.name) } catch { return { repaired, problems } }
  if (!names.length) return { repaired, problems }
  const listing = await run([join(root, '*')])
  if (!listing.stdout.trim()) {
    problems.push(`the permissions of ${root} could not be read (${(listing.stderr || `icacls exit ${listing.code}`).trim()}), so folders a pip install moved in from %TEMP% may stay unreadable to the sandbox; if they do, run once: ${ownerCommand(root)}`)
    return { repaired, problems }
  }
  const found = protectedEntries(listing.stdout, root, names)
  const failed: string[] = []
  for (const name of found.slice(0, MAX_ACL_REPAIRS)) {
    const path = join(root, name)
    // Re-checked just before the change: an entry replaced by a link meanwhile is left alone.
    try { if (lstatSync(path).isSymbolicLink()) continue } catch { continue }
    const result = await run([path, '/inheritance:e', '/C', '/Q'])
    if (result.code === 0) repaired.push(path)
    else failed.push(`${name} (${(result.stderr || result.stdout || `icacls exit ${result.code}`).trim().split(/\r?\n/)[0]})`)
  }
  const left = found.length - Math.min(found.length, MAX_ACL_REPAIRS)
  if (failed.length || left) {
    const what = [...failed, ...left ? [`${left} more`] : []].join(', ')
    problems.push(`${what} in ${root} keep an owner-only permission list, so the sandbox cannot read them and Conductor could not repair them; run once: ${ownerCommand(root)}`)
  }
  return { repaired, problems }
}

/** The once-per-change notice for entries that were repaired. */
export function aclRepairNotice(root: string, repaired: readonly string[]): string {
  const names = repaired.map(path => path.slice(root.length).replace(/^[\\/]+/, ''))
  const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ')
  return `${shown} in ${root} had an owner-only permission list (a pip install on Python 3.13+ moves packages in from a private %TEMP% folder), so sandboxed commands could not read them; Conductor turned inheritance from ${root} back on`
}
