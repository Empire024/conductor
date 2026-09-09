import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BinaryFileError, formatFileSize, looksBinary, readTextFile, TEXT_FILE_BYTE_LIMIT } from './text-files'

const roots: string[] = []
const root = (): string => { const path = mkdtempSync(join(tmpdir(), 'conductor-text-files-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('text file guard', () => {
  it('accepts real source text, including UTF-8 and CRLF', () => {
    expect(looksBinary(Buffer.from('const value = "héllo — ok"\r\n\tif (value) return\n', 'utf8'))).toBe(false)
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })

  it('rejects container bytes that would reach the editor as mojibake', () => {
    // A real mp4 header: NUL bytes inside the ftyp box.
    expect(looksBinary(Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe(true)
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  })

  it('reads a text file and reports a missing file as null', () => {
    const directory = root()
    writeFileSync(join(directory, 'notes.md'), '# Title\n')
    expect(readTextFile(join(directory, 'notes.md'))).toBe('# Title\n')
    expect(readTextFile(join(directory, 'absent.md'))).toBeNull()
  })

  it('refuses a binary file instead of decoding it into the editor', () => {
    const directory = root()
    const video = join(directory, 'clip.mp4')
    writeFileSync(video, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(4096)]))
    expect(() => readTextFile(video)).toThrow(BinaryFileError)
    expect(() => readTextFile(video)).toThrow(/binary file/)
  })

  it('refuses a file too large for one editor buffer', () => {
    const directory = root()
    const huge = join(directory, 'huge.log')
    writeFileSync(huge, 'a'.repeat(TEXT_FILE_BYTE_LIMIT + 1))
    expect(() => readTextFile(huge)).toThrow(/larger than/)
  })

  it('refuses a directory rather than throwing a raw errno at the user', () => {
    expect(() => readTextFile(root())).toThrow(/is a folder/)
  })

  it('formats sizes the way the preview header reports them', () => {
    expect(formatFileSize(512)).toBe('512 bytes')
    expect(formatFileSize(2048)).toBe('2 KB')
    expect(formatFileSize(1536 * 1024)).toBe('1.5 MB')
    expect(formatFileSize(64 * 1024 * 1024)).toBe('64 MB')
  })
})
