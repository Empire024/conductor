import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename } from 'node:path'

/** Monaco holds a whole file in one string, so handing it a video or an
 * oversized log freezes the window before any error can be rendered. Text
 * reads are sniffed here instead, in the one place every reader goes through. */
export const TEXT_FILE_BYTE_LIMIT = 8 * 1024 * 1024
const SNIFF_BYTES = 8192

export class BinaryFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BinaryFileError'
  }
}

/** The size ceiling is what keeps the window alive, so unlike a binary sniff it cannot be
 *  overruled — callers must not offer "show as text anyway" for it. */
export class FileTooLargeError extends BinaryFileError {
  constructor(message: string) {
    super(message)
    this.name = 'FileTooLargeError'
  }
}

export const formatFileSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + ' MB'
    : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB'
      : bytes + ' bytes'

/** A NUL byte cannot appear in UTF-8 text, which covers every common container
 * (mp4, zip, exe, png). Replacement characters and stray control bytes catch
 * the rest without rejecting legacy single-byte encodings outright. */
export const looksBinary = (sample: Buffer): boolean => {
  if (!sample.length) return false
  if (sample.includes(0)) return true
  const text = sample.toString('utf8')
  let suspicious = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) suspicious++
  }
  return suspicious * 64 > text.length
}

const sniff = (path: string, size: number): Buffer => {
  const sample = Buffer.alloc(Math.min(SNIFF_BYTES, size))
  if (!sample.length) return sample
  const descriptor = openSync(path, 'r')
  try {
    const read = readSync(descriptor, sample, 0, sample.length, 0)
    return sample.subarray(0, read)
  } finally {
    closeSync(descriptor)
  }
}

/** Returns null only when the file does not exist, which the editor treats as
 * a new file. Everything else that cannot be shown as text throws a message
 * written for the person who clicked. */
export function readTextFile(path: string, { allowBinary = false } = {}): string | null {
  let size: number
  try {
    const info = statSync(path)
    if (info.isDirectory()) throw new BinaryFileError(basename(path) + ' is a folder, not a file.')
    size = info.size
  } catch (reason) {
    if (reason instanceof BinaryFileError) throw reason
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw reason
  }
  if (size > TEXT_FILE_BYTE_LIMIT) {
    throw new FileTooLargeError(
      `${basename(path)} is ${formatFileSize(size)}. Files larger than ${formatFileSize(TEXT_FILE_BYTE_LIMIT)} are not opened as text.`
    )
  }
  // The size ceiling is not negotiable: it is what keeps the window alive.
  // Whether a file is "really" text is a judgement the user may overrule.
  if (!allowBinary && looksBinary(sniff(path, size))) {
    throw new BinaryFileError(
      `${basename(path)} is a binary file, so it was not opened as text. Preview it, or open it with the default app.`
    )
  }
  try {
    return readFileSync(path, 'utf8')
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw reason
  }
}

/** The same guard for callers that must have content, such as previews and the
 * agent control protocol, where a missing file is a plain failure. */
export function readExistingTextFile(path: string): string {
  const content = readTextFile(path)
  if (content === null) throw new BinaryFileError(basename(path) + ' no longer exists.')
  return content
}
