import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPromptImportSize, importPromptAttachment, importPromptAttachmentPath, projectPromptAttachment, promptContextLimits } from './prompt-context'

const roots: string[] = []
const workspace = (): string => { const root = mkdtempSync(join(tmpdir(), 'conductor-prompt-context-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

describe('prompt file context', () => {
  it('classifies project text and opaque media without decoding binary bytes', async () => {
    const root = workspace()
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'notes', 'idea.md'), '# Large idea\nQuestion everything.\n')
    writeFileSync(join(root, 'clip.mp4'), Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0xff, 0, 0x81]))
    await expect(projectPromptAttachment(root, 'notes/idea.md')).resolves.toMatchObject({ kind: 'file', name: 'notes/idea.md', path: 'notes/idea.md', content: '# Large idea\nQuestion everything.\n' })
    const media = await projectPromptAttachment(root, 'clip.mp4')
    expect(media).toMatchObject({ kind: 'media', name: 'clip.mp4', path: 'clip.mp4', mimeType: 'video/mp4', size: 11 })
    expect(media).not.toHaveProperty('content')
  })

  it('rejects an escaped project symlink before reading any target bytes', async () => {
    const root = workspace(), outside = workspace()
    writeFileSync(join(outside, 'secret.md'), 'outside')
    try { symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir') }
    catch { return }
    await expect(projectPromptAttachment(root, 'escape/secret.md')).rejects.toThrow(/outside|leaves/i)
  })

  it('keeps external text in draft context and stores opaque bytes exactly once without collision', async () => {
    const root = workspace()
    const text = await importPromptAttachment(root, '../notes.md', 'text/markdown', new TextEncoder().encode('hello\n'))
    expect(text).toMatchObject({ kind: 'file', name: '.._notes.md', content: 'hello\n', size: 6, mimeType: 'text/markdown' })
    expect(text).not.toHaveProperty('path')
    const bytes = Uint8Array.from([0, 1, 2, 3, 0xff])
    const first = await importPromptAttachment(root, 'movie.mp4', 'video/mp4', bytes)
    const second = await importPromptAttachment(root, 'movie.mp4', 'video/mp4', bytes)
    expect(first).toMatchObject({ kind: 'media', name: 'movie.mp4', mimeType: 'video/mp4', size: bytes.length })
    expect(second.path).not.toBe(first.path)
    expect(readFileSync(join(root, first.path!))).toEqual(Buffer.from(bytes))
    expect(readFileSync(join(root, second.path!))).toEqual(Buffer.from(bytes))
    expect(readFileSync(join(root, '.conductor/prompt-files/.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
  })

  it('bounds renderer-provided bytes before creating an import directory', async () => {
    const root = workspace()
    expect(() => assertPromptImportSize(promptContextLimits.importBytes + 1)).toThrow('100 MB')
    await expect(importPromptAttachment(root, 'invalid.bin', 'application/octet-stream', { byteLength: 1 })).rejects.toThrow('100 MB')
    expect(() => readFileSync(join(root, '.conductor/prompt-files/.gitignore'))).toThrow()
  })

  it('resolves OS drop paths in main and distinguishes project files from external snapshots', async () => {
    const root = workspace(), outside = workspace()
    writeFileSync(join(root, 'inside.md'), 'inside\n')
    writeFileSync(join(outside, 'outside.md'), 'outside\n')
    await expect(importPromptAttachmentPath(root, join(root, 'inside.md'))).resolves.toMatchObject({ kind: 'file', path: 'inside.md', content: 'inside\n' })
    const external = await importPromptAttachmentPath(root, join(outside, 'outside.md'), 'renamed.md', 'text/markdown')
    expect(external).toMatchObject({ kind: 'file', name: 'renamed.md', content: 'outside\n' })
    expect(external).not.toHaveProperty('path')
  })
})
