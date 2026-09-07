import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import type { EditorFileWriteResult } from '../shared/models'

export const EDITOR_CONFLICT_MESSAGE = 'This file changed on disk since these edits began. Your edits are preserved. Save a copy or reload the current file before saving.'

export function readEditorFile(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw reason
  }
}

/** The final comparison and replacement run in one main-process turn, so saves
 * from different windows cannot both commit against the same old contents. */
export function writeEditorFile(path: string, content: string, expectedContent?: string | null): EditorFileWriteResult {
  const current = readEditorFile(path)
  if (current === content) return { status: 'saved' }
  if (expectedContent === undefined || current !== expectedContent) return { status: 'conflict', message: EDITOR_CONFLICT_MESSAGE }
  const target = current === null ? join(realpathSync(dirname(path)), basename(path)) : realpathSync(path)
  const temporary = join(dirname(target), '.conductor-save-' + randomUUID() + '.tmp')
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', current === null ? undefined : statSync(target).mode)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    // An agent may have changed the file while the temporary copy was written.
    if (readEditorFile(target) !== expectedContent) return { status: 'conflict', message: EDITOR_CONFLICT_MESSAGE }
    if (current === null) {
      // Exclusive creation protects a file created between the last read and
      // this write. Existing files use atomic replacement to avoid truncation.
      try { linkSync(temporary, target) } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'conflict', message: EDITOR_CONFLICT_MESSAGE }
        throw reason
      }
    } else renameSync(temporary, target)
    return { status: 'saved' }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Recovery never overwrites either version, including drafts from old builds
 * whose original disk contents were not recorded. */
export function saveEditorCopy(path: string, content: string): string {
  const extension = extname(path)
  const copy = join(realpathSync(dirname(path)), basename(path, extension) + '.recovered-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + randomUUID().slice(0, 8) + extension)
  writeFileSync(copy, content, { encoding: 'utf8', flag: 'wx' })
  return copy
}

/** Create the actual file first, so canceling inline naming always leaves a
 * usable editor. Exclusive creation protects existing and concurrently created names. */
export function createUntitledEditorFile(directory: string, extension: string): string {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(extension) || extension.length > 32) throw new Error('Choose a valid file extension')
  for (let suffix = 1; suffix < 10_000; suffix++) {
    const path = join(directory, 'untitled' + (suffix === 1 ? '' : '-' + suffix) + '.' + extension)
    try { writeFileSync(path, '', { encoding: 'utf8', flag: 'wx' }); return path } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
    }
  }
  throw new Error('Too many untitled files in this folder. Rename an existing file first.')
}
