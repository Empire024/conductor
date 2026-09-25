import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, canonicalRelative, isCanonicallyWithin } from './canonical-path.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

/** A real temp root and a link to it (a junction on Windows, which needs no privilege). */
function linkedRoot(): { real: string; link: string } {
  const created = mkdtempSync(join(tmpdir(), 'conductor-canonical-'))
  const real = realpathSync.native(created)
  const link = `${created}-link`
  symlinkSync(real, link, 'junction')
  cleanup.push(() => { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }) })
  mkdirSync(join(real, 'src'))
  writeFileSync(join(real, 'src', 'a.ts'), 'export {}\n')
  return { real, link }
}

describe('canonicalPath', () => {
  it('spells an existing path through a link the same as its real path', () => {
    const { real, link } = linkedRoot()
    expect(canonicalPath(link)).toBe(real)
    expect(canonicalPath(join(link, 'src', 'a.ts'))).toBe(join(real, 'src', 'a.ts'))
  })

  it('canonicalizes the nearest existing ancestor of a path that does not exist yet', () => {
    const { real, link } = linkedRoot()
    expect(canonicalPath(join(link, 'docs', 'new', 'report.md'))).toBe(join(real, 'docs', 'new', 'report.md'))
    expect(canonicalPath(join(link, 'src', 'b.ts'))).toBe(join(real, 'src', 'b.ts'))
  })
})

describe('canonicalRelative and isCanonicallyWithin', () => {
  it('relativizes a real file against a linked root', () => {
    const { real, link } = linkedRoot()
    expect(canonicalRelative(link, join(real, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(isCanonicallyWithin(link, join(real, 'src', 'a.ts'))).toBe(true)
  })

  it('relativizes a linked file against a real root', () => {
    const { real, link } = linkedRoot()
    expect(canonicalRelative(real, join(link, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(canonicalRelative(real, join(link, 'docs', 'report.md'))).toBe('docs/report.md')
    expect(isCanonicallyWithin(real, join(link, 'docs', 'report.md'))).toBe(true)
  })

  it('names the root itself as empty and keeps outside paths outside', () => {
    const { real, link } = linkedRoot()
    expect(canonicalRelative(link, real)).toBe('')
    expect(isCanonicallyWithin(link, real)).toBe(true)
    expect(canonicalRelative(join(real, 'src'), join(link, 'other.ts'))).toBe('../other.ts')
    expect(isCanonicallyWithin(join(real, 'src'), join(link, 'other.ts'))).toBe(false)
    expect(isCanonicallyWithin(join(real, 'src'), `${join(real, 'src')}-sibling`)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('ignores drive-letter and name case on Windows', () => {
    const { real } = linkedRoot()
    const flipped = real.charAt(0) === real.charAt(0).toUpperCase() ? real.charAt(0).toLowerCase() + real.slice(1) : real.charAt(0).toUpperCase() + real.slice(1)
    expect(canonicalRelative(flipped, join(real, 'SRC', 'A.ts'))).toBe('src/a.ts')
    expect(isCanonicallyWithin(flipped.toUpperCase(), join(real, 'src', 'a.ts'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('treats a Windows 8.3 short alias and its long name as one directory', () => {
    const { real } = linkedRoot()
    const long = join(real, 'a directory with a long name')
    mkdirSync(long)
    writeFileSync(join(long, 'notes.txt'), 'x')
    const short = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${long}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim()
    // 8.3 names can be turned off per volume; there is nothing to compare then.
    if (!short || short.toLowerCase() === long.toLowerCase()) return
    expect(canonicalRelative(short, join(long, 'notes.txt'))).toBe('notes.txt')
    expect(canonicalRelative(long, join(short, 'notes.txt'))).toBe('notes.txt')
    expect(canonicalRelative(short, join(short, 'new', 'file.md'))).toBe('new/file.md')
  })
})
