import { describe, expect, it } from 'vitest'
import { classifyExplorerFile, defaultExplorerOpenMode, defaultFileViewMode } from './workspace-sidebar-types'

describe('explorer file actions', () => {
  it.each([
    ['README.md', 'markdown', 'preview', 'editor'],
    ['assets/hero.PNG', 'image', 'preview', 'preview'],
    ['src/main.tsx', 'text', 'editor', 'editor'],
    ['Dockerfile', 'text', 'editor', 'editor'],
    ['clips/demo.mp4', 'media', 'preview', 'preview'],
    ['archive.zip', 'external', 'preview', 'preview'],
    ['bin/tool.exe', 'external', 'preview', 'preview'],
    ['fonts/Inter.woff2', 'external', 'preview', 'preview']
  ] as const)('classifies %s', (path, kind, explorerMode, tabMode) => {
    expect(classifyExplorerFile(path)).toBe(kind)
    expect(defaultExplorerOpenMode(path)).toBe(explorerMode)
    expect(defaultFileViewMode(path)).toBe(tabMode)
  })

  it('never sends an unrecognised file to the editor on its own', () => {
    for (const path of ['clip.mp4', 'song.mp3', 'photo.png', 'db.sqlite', 'archive.tar.gz', 'video.MP4']) {
      expect(defaultFileViewMode(path)).toBe('preview')
      expect(defaultExplorerOpenMode(path)).toBe('preview')
    }
  })
})
