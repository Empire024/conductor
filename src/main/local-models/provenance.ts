import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { LocalModelConfig } from './config.ts'
import { modelDir, modelFilePath, provenancePath, tempDir } from './config.ts'

/** What was downloaded, from where, and the bytes it hashed to. Recorded on first trusted
 *  download and re-checked on every start, so a model file that is later swapped underneath
 *  Conductor stops the stack instead of being served quietly. */
export interface ProvenanceRecord {
  id: string
  repo: string
  revision: string
  file: string
  quant: string
  url: string
  sizeBytes: number
  sha256: string
  /** `upstream-pinned` means the hash was published by the repository and is compared against;
   *  `first-download` means no upstream hash existed and this is the trust-on-first-use value. */
  sha256Source: 'upstream-pinned' | 'first-download'
  downloadedAt: string
  verifiedAt: string
}

export const downloadUrl = (model: LocalModelConfig): string => `https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.file}`

/** Rename when the move stays on one volume, copy when it does not: a migration off the system
 *  drive is always cross-volume, and the source is only removed once the copy is in place. */
export function moveFile(from: string, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true })
  try { renameSync(from, to) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

export interface MigrationResult { from: string; to: string; sha256: string; sizeBytes: number }

/** Move a GGUF that an earlier setup left somewhere else (typically the system drive) to its
 *  place under the local root. The bytes are verified at the destination before the old copy is
 *  removed, so a failed migration never costs a 20 GB re-download. */
export async function migrateModelFile(model: LocalModelConfig, from: string): Promise<MigrationResult> {
  const destination = modelFilePath(model)
  if (!existsSync(from)) throw new Error(`Nothing to migrate: ${from} is missing`)
  const size = statSync(from).size
  if (model.sizeBytes && size !== model.sizeBytes) throw new Error(`Refusing to migrate ${from}: size ${size} does not match the expected ${model.sizeBytes} bytes`)
  mkdirSync(modelDir(model), { recursive: true })
  moveFile(from, destination)
  const digest = await sha256File(destination)
  const expected = model.sha256 || readProvenance().find(record => record.id === model.id && record.file === model.file)?.sha256
  if (expected && digest.toLowerCase() !== expected.toLowerCase()) throw new Error(`GGUF checksum mismatch after moving ${model.file}; the file was left at ${destination} for inspection`)
  recordProvenance({
    id: model.id, repo: model.repo, revision: model.revision, file: model.file, quant: model.quant, url: downloadUrl(model),
    sizeBytes: statSync(destination).size, sha256: digest, sha256Source: model.sha256 ? 'upstream-pinned' : 'first-download',
    downloadedAt: readProvenance().find(record => record.id === model.id && record.file === model.file)?.downloadedAt ?? new Date().toISOString(),
    verifiedAt: new Date().toISOString()
  })
  return { from, to: destination, sha256: digest, sizeBytes: statSync(destination).size }
}

export function readProvenance(): ProvenanceRecord[] {
  const path = provenancePath()
  if (!existsSync(path)) return []
  try { return JSON.parse(readFileSync(path, 'utf8')) as ProvenanceRecord[] } catch { return [] }
}

export function writeProvenance(records: ProvenanceRecord[]): void {
  const path = provenancePath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(records, null, 2) + '\n', 'utf8')
}

export function recordProvenance(record: ProvenanceRecord): void {
  const records = readProvenance().filter(existing => !(existing.id === record.id && existing.file === record.file))
  records.push(record)
  writeProvenance(records)
}

export async function sha256File(path: string, onProgress?: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256')
  let seen = 0
  const stream = createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })
  stream.on('data', chunk => { seen += (chunk as Buffer).length; onProgress?.(seen) })
  await pipeline(stream, hash)
  return hash.digest('hex')
}

/** Download one GGUF at its pinned revision and refuse anything that is not the expected bytes.
 *  Nothing from the repository is ever executed: only this single file is fetched, and model
 *  code, conversion scripts and remote code loading are never involved. */
export async function downloadModel(model: LocalModelConfig, onProgress?: (received: number, total: number) => void): Promise<ProvenanceRecord> {
  const destination = modelFilePath(model)
  mkdirSync(modelDir(model), { recursive: true })
  // Staged on the local root, never in %TEMP%: a 20 GB part file must not touch the system drive.
  const temporary = join(tempDir(), model.file + '.part')
  const url = downloadUrl(model)
  rmSync(temporary, { force: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Model download failed for ${model.file}: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? model.sizeBytes)
  const hash = createHash('sha256')
  let received = 0
  const file = createWriteStream(temporary)
  await pipeline(
    (async function* () {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength
        hash.update(chunk)
        onProgress?.(received, total)
        yield chunk
      }
    })(),
    file
  )
  const digest = hash.digest('hex')
  if (model.sizeBytes && received !== model.sizeBytes) {
    rmSync(temporary, { force: true })
    throw new Error(`GGUF size mismatch for ${model.file}: expected ${model.sizeBytes} bytes, received ${received}`)
  }
  if (model.sha256 && digest.toLowerCase() !== model.sha256.toLowerCase()) {
    rmSync(temporary, { force: true })
    throw new Error(`GGUF checksum mismatch for ${model.file}; the download was discarded`)
  }
  moveFile(temporary, destination)
  const record: ProvenanceRecord = {
    id: model.id, repo: model.repo, revision: model.revision, file: model.file, quant: model.quant, url,
    sizeBytes: received, sha256: digest, sha256Source: model.sha256 ? 'upstream-pinned' : 'first-download',
    downloadedAt: new Date().toISOString(), verifiedAt: new Date().toISOString()
  }
  recordProvenance(record)
  return record
}

export interface VerifyResult { ok: boolean; reason?: string; sha256?: string }

/** Startup verification. `full` re-hashes the file; `size` only checks that the recorded size
 *  still matches, for a deliberately fast start. A missing provenance record is a failure: a
 *  model file that appeared without a recorded download is not trusted. */
export async function verifyModel(model: LocalModelConfig, mode: 'full' | 'size' = 'full'): Promise<VerifyResult> {
  const path = modelFilePath(model)
  if (!existsSync(path)) return { ok: false, reason: `Model file missing: ${path}` }
  const expected = model.sha256 || readProvenance().find(record => record.id === model.id && record.file === model.file)?.sha256
  if (!expected) return { ok: false, reason: `No recorded checksum for ${model.file}; run setup again` }
  const size = statSync(path).size
  if (model.sizeBytes && size !== model.sizeBytes) return { ok: false, reason: `GGUF size mismatch for ${model.file}` }
  if (mode === 'size') return { ok: true }
  const digest = await sha256File(path)
  if (digest.toLowerCase() !== expected.toLowerCase()) return { ok: false, reason: `GGUF checksum mismatch for ${model.file}`, sha256: digest }
  const records = readProvenance()
  const record = records.find(entry => entry.id === model.id && entry.file === model.file)
  if (record) { record.verifiedAt = new Date().toISOString(); writeProvenance(records) }
  return { ok: true, sha256: digest }
}
