import { describe, expect, it } from 'vitest'
import { CONDUCTOR_FILE_DRAG, decodeConductorFileDrag, encodeConductorFileDrag, isComposerFileDrag } from './composer-file-drop'

describe('composer file drag envelope', () => {
  it('round-trips a bounded project file identity', () => {
    const value = { projectId: 'project-1', path: 'notes/idea.md', kind: 'file' as const }
    expect(decodeConductorFileDrag(encodeConductorFileDrag(value))).toEqual(value)
    expect(isComposerFileDrag([CONDUCTOR_FILE_DRAG])).toBe(true)
    expect(isComposerFileDrag(['Files'])).toBe(true)
  })

  it('fails closed for foreign or malformed payloads', () => {
    for (const value of ['', '{}', '{bad', JSON.stringify({ projectId: '', path: 'x', kind: 'file' }), JSON.stringify({ projectId: 'p', path: '', kind: 'file' }), JSON.stringify({ projectId: 'p', path: 'x\0y', kind: 'file' }), JSON.stringify({ projectId: 'p', path: 'x', kind: 'link' })]) {
      expect(decodeConductorFileDrag(value)).toBeNull()
    }
    expect(isComposerFileDrag(['text/plain'])).toBe(false)
  })
})
