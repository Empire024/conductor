import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializePastedText, pastedTextFilePath } from './pasted-text-files'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
const project = (): string => { const root = mkdtempSync(join(tmpdir(), 'conductor-pasted-')); roots.push(root); return root }

describe('pasted text opens as a file (21b9a1d6)', () => {
  it('names a file under .conductor/pasted-text only for a pasted-text attachment id', () => {
    expect(pastedTextFilePath('pasted-text:0f1e-2d3c')).toBe('.conductor/pasted-text/0f1e-2d3c.txt')
    expect(() => pastedTextFilePath('selection')).toThrow(/not a pasted text/)
    expect(() => pastedTextFilePath('pasted-text:../../etc/passwd')).toThrow(/not a pasted text/)
    expect(() => pastedTextFilePath('pasted-text:')).toThrow(/not a pasted text/)
  })

  it('writes the text once into a folder that ignores itself in git, and rewrites it if it changed', async () => {
    const cwd = project()
    const path = await materializePastedText(cwd, 'pasted-text:abc', 'first\nsecond\n')
    expect(path).toBe('.conductor/pasted-text/abc.txt')
    expect(readFileSync(join(cwd, path), 'utf8')).toBe('first\nsecond\n')
    expect(readFileSync(join(cwd, '.conductor/pasted-text/.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
    writeFileSync(join(cwd, path), 'edited')
    await materializePastedText(cwd, 'pasted-text:abc', 'first\nsecond\n')
    expect(readFileSync(join(cwd, path), 'utf8')).toBe('first\nsecond\n')
  })

  it('refuses missing or oversized text and a redirected folder', async () => {
    const cwd = project()
    await expect(materializePastedText(cwd, 'pasted-text:abc', undefined)).rejects.toThrow(/no longer available/)
    await expect(materializePastedText(cwd, 'pasted-text:abc', 'x'.repeat(128_001))).rejects.toThrow(/holds up to/)
    const outside = project()
    mkdirSync(join(cwd, '.conductor'))
    symlinkSync(outside, join(cwd, '.conductor/pasted-text'), 'junction')
    await expect(materializePastedText(cwd, 'pasted-text:abc', 'text')).rejects.toThrow()
  })
})
