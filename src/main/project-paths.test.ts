import { describe, expect, it } from 'vitest'
import { isProjectRoot, resolveWithinProject, safeEntryName } from './project-paths'

describe('safeEntryName', () => {
  it('accepts ordinary file and folder names', () => {
    expect(safeEntryName('readme.md')).toBe('readme.md')
    expect(safeEntryName('src components')).toBe('src components')
  })

  it.each(['', '.', '..', '../escape', 'a/b', 'a\\b', 'bad:name', 'trailing.', ' padded ', 'NUL', 'com1.txt'])(
    'rejects unsafe leaf name %j',
    (name) => expect(() => safeEntryName(name)).toThrow()
  )
})

describe('resolveWithinProject', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project'

  it('resolves children and the project root', () => {
    expect(resolveWithinProject(root, 'src/index.ts')).toContain('src')
    expect(isProjectRoot(root, '')).toBe(true)
  })

  it('rejects traversal out of the project', () => {
    expect(() => resolveWithinProject(root, '../secret.txt')).toThrow('outside the project')
    expect(() => resolveWithinProject(root, '../../project-copy/file.txt')).toThrow('outside the project')
  })
})
