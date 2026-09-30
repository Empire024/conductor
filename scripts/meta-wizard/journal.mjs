import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The meta-wizard's own record: journal.jsonl is append-only (rotated, never rewritten), state.json
// is what it remembers between ticks, service.json names the live supervisor.

export const JOURNAL = 'journal.jsonl'
const KEEP_ROTATED = 5

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export function createJournal(dir, { now = () => new Date(), maxBytes = 5 * 1024 * 1024, echo } = {}) {
  let chain = Promise.resolve()
  async function rotate() {
    const path = join(dir, JOURNAL)
    const size = await stat(path).then(s => s.size, () => 0)
    if (size < maxBytes) return
    await rename(path, join(dir, `journal-${stamp(now())}.jsonl`))
    const old = (await readdir(dir)).filter(name => /^journal-.*\.jsonl$/.test(name)).sort()
    for (const name of old.slice(0, Math.max(0, old.length - KEEP_ROTATED))) await rm(join(dir, name), { force: true })
  }
  /** Appends one event; never throws (a full disk must not stop the supervisor). */
  function write(event, data = {}) {
    const line = JSON.stringify({ at: now().toISOString(), event, ...data })
    echo?.(line)
    chain = chain.then(async () => { await mkdir(dir, { recursive: true }); await rotate(); await appendFile(join(dir, JOURNAL), line + '\n', 'utf8') }).catch(() => {})
    return chain
  }
  return { write, flush: () => chain }
}

export async function readJsonFile(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')) } catch { return fallback }
}

/** Write through a temporary file and rename, so a reader never sees half a file. */
export async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
}

export async function journalTail(dir, count = 20) {
  const text = await readFile(join(dir, JOURNAL), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).slice(-count).map(line => { try { return JSON.parse(line) } catch { return { raw: line } } })
}
