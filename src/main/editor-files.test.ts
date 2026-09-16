import { fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUntitledEditorFile, readEditorFile, saveEditorCopy, writeEditorFile } from './editor-files'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }
})
const roots: string[] = []
function fixture(content = 'original') {
  const root = mkdtempSync(join(tmpdir(), 'conductor-editor-save-'))
  roots.push(root)
  const path = join(root, 'file.ts')
  writeFileSync(path, content)
  return { root, path }
}
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('editor disk conflict protection', () => {
  it('saves exact text atomically only against its original contents', () => {
    const f = fixture()
    expect(writeEditorFile(f.path, 'Unicode: caf? \r\nnew text', 'original')).toEqual({ status: 'saved' })
    expect(readFileSync(f.path, 'utf8')).toBe('Unicode: caf? \r\nnew text')
    expect(readdirSync(f.root)).toEqual(['file.ts'])
  })
  it('preserves an agent change made after the editor loaded or a close dialog opened', () => {
    const f = fixture()
    writeFileSync(f.path, 'new agent work')
    expect(writeEditorFile(f.path, 'old local edit', 'original').status).toBe('conflict')
    expect(readFileSync(f.path, 'utf8')).toBe('new agent work')
  })
  it('rechecks the file after preparing a replacement, preserving an external edit during save', async () => {
    const f = fixture()
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fsyncSync).mockImplementationOnce((fd) => { actual.fsyncSync(fd); writeFileSync(f.path, 'changed during save') })
    expect(writeEditorFile(f.path, 'local edit', 'original').status).toBe('conflict')
    expect(readFileSync(f.path, 'utf8')).toBe('changed during save')
    expect(readdirSync(f.root)).toEqual(['file.ts'])
  })
  it('allows only one of two windows saving different edits from the same baseline', async () => {
    const f = fixture()
    const results = await Promise.all([
      Promise.resolve().then(() => writeEditorFile(f.path, 'first window', 'original')),
      Promise.resolve().then(() => writeEditorFile(f.path, 'second window', 'original'))
    ])
    expect(results.map((result) => result.status)).toEqual(['saved', 'conflict'])
    expect(readFileSync(f.path, 'utf8')).toBe('first window')
    expect(writeEditorFile(f.path, 'latest edit', 'first window').status).toBe('saved')
    expect(readFileSync(f.path, 'utf8')).toBe('latest edit')
  })
  it('does not recreate a deleted file from an old buffer', () => {
    const f = fixture()
    unlinkSync(f.path)
    expect(readEditorFile(f.path)).toBeNull()
    expect(writeEditorFile(f.path, 'stale edit', 'original').status).toBe('conflict')
    expect(readEditorFile(f.path)).toBeNull()
    expect(writeEditorFile(f.path, 'intentional new file', null).status).toBe('saved')
  })
  it('refuses a legacy draft without a baseline and preserves both versions via a unique recovery copy', () => {
    const f = fixture('current disk content')
    expect(writeEditorFile(f.path, 'legacy draft').status).toBe('conflict')
    const copy = saveEditorCopy(f.path, 'legacy draft')
    const second = saveEditorCopy(f.path, 'other draft')
    expect(copy).not.toBe(second)
    expect(readFileSync(copy, 'utf8')).toBe('legacy draft')
    expect(readFileSync(second, 'utf8')).toBe('other draft')
    expect(readFileSync(f.path, 'utf8')).toBe('current disk content')
  })
  it('accepts an already persisted exact buffer without overwriting it again', () => {
    const f = fixture('same submitted edit')
    expect(writeEditorFile(f.path, 'same submitted edit', 'older baseline').status).toBe('saved')
    expect(vi.mocked(fsyncSync)).not.toHaveBeenCalled()
  })
})

describe('inline new editor files', () => {
  it('creates usable Markdown files and chooses a new name without replacing an existing draft', () => {
    const f = fixture()
    const first = createUntitledEditorFile(f.root, 'md')
    expect(first).toBe(join(f.root, 'untitled.md'))
    writeFileSync(first, 'existing notes')
    const second = createUntitledEditorFile(f.root, 'md')
    expect(second).toBe(join(f.root, 'untitled-2.md'))
    expect(readFileSync(first, 'utf8')).toBe('existing notes')
    expect(readFileSync(second, 'utf8')).toBe('')
    expect(createUntitledEditorFile(f.root, 'test.ts')).toBe(join(f.root, 'untitled.test.ts'))
  })
  it('rejects path-like extensions before creating anything', () => {
    const f = fixture()
    expect(() => createUntitledEditorFile(f.root, '../secret')).toThrow('valid file extension')
    expect(readdirSync(f.root)).toEqual(['file.ts'])
  })
})
