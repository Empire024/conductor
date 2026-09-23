import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { runDir } from './config.ts'

const MAX_OWNER = 32 * 1024 * 1024
const MAX_TOTAL = 256 * 1024 * 1024
const ownerKey = (owner: string): string => createHash('sha256').update(owner).digest('hex')
const ENTRY = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.artifact$/
/** Private runtime storage, never mounted into the model's container or written to the repo.
 * Handles are recoverable after restart from the same project/task identity. */
export class LocalResultStore {
  constructor(private readonly directory?: string, private readonly quota = { ownerBytes: MAX_OWNER, totalBytes: MAX_TOTAL, entries: 2048 }) {}
  private root(): string { return this.directory ?? join(runDir(), 'result-artifacts') }
  save(owner: string, value: string): string {
    const bytes = Buffer.from(value), id = randomUUID(), key = ownerKey(owner), root = this.root()
    if (bytes.length > this.quota.ownerBytes || bytes.length > this.quota.totalBytes) throw new Error('Result exceeds artifact storage limit')
    mkdirSync(root, { recursive: true })
    const entries = readdirSync(root).filter(name => ENTRY.test(name)).map(name => ({ name, ...statSync(join(root, name)) })).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    let owned = entries.filter(entry => entry.name.startsWith(key + '.')).reduce((sum, entry) => sum + entry.size, 0)
    let count = entries.length
    for (const entry of entries) {
      const mine = entry.name.startsWith(key + '.')
      if (count < this.quota.entries && total + bytes.length <= this.quota.totalBytes && (!mine || owned + bytes.length <= this.quota.ownerBytes)) continue
      unlinkSync(join(root, entry.name)); total -= entry.size; count--
      if (mine) owned -= entry.size
    }
    writeFileSync(join(root, `${key}.${id}.artifact`), bytes, { flag: 'wx', mode: 0o600 })
    return id
  }
  read(owner: string, id: string, offset = 0, limit = 4096): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid artifact handle')
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Artifact byte offset must be nonnegative; limit positive')
    const path = join(this.root(), `${ownerKey(owner)}.${id}.artifact`)
    let fd: number
    try { fd = openSync(path, 'r') } catch { throw new Error('Unknown, expired, or differently owned result artifact; rerun the originating command if expired') }
    try {
      const size = statSync(path).size, bytes = Buffer.alloc(Math.min(limit, 16384))
      const count = readSync(fd, bytes, 0, bytes.length, offset), end = offset + count
      return `[result_artifact: id=${id}; size_bytes=${size}; byte_range=${offset}-${end}; end_exclusive=true; truncated=${offset > 0 || end < size}; next_byte_offset=${end}]\n${bytes.subarray(0, count).toString('utf8')}`
    } finally { closeSync(fd) }
  }
}
export const defaultResultStore = new LocalResultStore()
export const saveResultArtifact = (owner: string, value: string): string => defaultResultStore.save(owner, value)
export const readResultArtifact = (owner: string, id: string, offset = 0, limit = 4096): string => defaultResultStore.read(owner, id, offset, limit)
