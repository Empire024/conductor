import { mkdir, open, readdir, stat, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The checkout this script lives in (scripts/overseer/util.mjs -> repo root). */
export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const sleep = (ms) => new Promise(done => setTimeout(done, ms))

const pad = (value, width = 2) => String(value).padStart(width, '0')

/** Local wall-clock stamp for run directory names: YYYYMMDD-HHMMSS. */
export function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function createLogger(write = line => process.stdout.write(line + '\n')) {
  return (message) => {
    const now = new Date()
    write(`[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] ${message}`)
  }
}

/** Write JSON through a temporary file and rename, so a reader following along never sees half a file. */
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
}

/** Last `lines` lines of a text file, reading at most `maxBytes` from its end. Null when absent. */
export async function tailFile(path, lines = 200, maxBytes = 512 * 1024) {
  let handle
  try { handle = await open(path, 'r') } catch { return null }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    const all = text.split(/\r?\n/)
    if (all.length && all[all.length - 1] === '') all.pop()
    return all.slice(-lines).join('\n')
  } finally { await handle.close() }
}

/** Newest modification time of any file under `root` (0 when empty or absent). */
export async function newestMtime(root, skip = new Set(['node_modules', '.git'])) {
  let newest = 0
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(path, skip))
    else if (entry.isFile()) {
      try { newest = Math.max(newest, (await stat(path)).mtimeMs) } catch { /* vanished */ }
    }
  }
  return newest
}

/** Case- and separator-insensitive path identity for Windows paths. */
export const samePath = (a, b) => normalizePath(a) === normalizePath(b)
export function normalizePath(path) {
  return resolve(String(path)).replaceAll('/', sep).replace(/[\\/]+$/, '').toLowerCase()
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent, child) {
  const p = normalizePath(parent), c = normalizePath(child)
  return c === p || c.startsWith(p + sep)
}

export const clip = (text, max) => {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + `… [${value.length - max} more chars]` : value
}
