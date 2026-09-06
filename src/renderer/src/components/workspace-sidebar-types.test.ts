import { describe, expect, it } from 'vitest'
import { classifyExplorerFile, defaultExplorerOpenMode } from './workspace-sidebar-types'

describe('explorer file actions', () => {
  it.each([
    ['README.md', 'markdown', 'preview'],
    ['assets/hero.PNG', 'image', 'preview'],
    ['src/main.tsx', 'text', 'editor'],
    ['Dockerfile', 'text', 'editor'],
    ['archive.zip', 'external', null]
  ] as const)('classifies %s', (path, kind, mode) => {
    expect(classifyExplorerFile(path)).toBe(kind)
    expect(defaultExplorerOpenMode(path)).toBe(mode)
  })
})
