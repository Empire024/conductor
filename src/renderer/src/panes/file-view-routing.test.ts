import { describe, expect, it, vi } from 'vitest'
import { formatBytes, previewKindFor } from './FilePreviewPane'
import { isCancellation } from '../debug-log'
import { cleanIpcError, isBinaryFileRefusal, isOverridableFileRefusal } from '../ipc-errors'
import { openWorkspaceFile, type OpenWorkspaceFile } from '../components/workspace-files-state'

// The suite runs on node, so stand in for the one browser global the opener uses.
const host = new EventTarget()
vi.stubGlobal('window', host)

const opened = (path: string, mode?: 'editor' | 'preview' | 'browser' | 'auto', allowBinary?: boolean): OpenWorkspaceFile => {
  const listener = vi.fn()
  host.addEventListener('conductor:open-file', listener)
  openWorkspaceFile('project', path, mode, undefined, allowBinary)
  host.removeEventListener('conductor:open-file', listener)
  return (listener.mock.calls[0]![0] as CustomEvent<OpenWorkspaceFile>).detail
}

describe('file view routing', () => {
  it('sends a clicked video to the preview, not the text editor', () => {
    expect(opened('clips/demo.mp4').mode).toBe('preview')
    expect(opened('clips/demo.mp4').path).toBe('clips/demo.mp4')
    expect(previewKindFor('clips/demo.mp4')).toBe('video')
  })

  it('keeps source and markdown in the editor', () => {
    expect(opened('src/App.tsx').mode).toBe('editor')
    expect(opened('README.md').mode).toBe('editor')
  })

  it('honours an explicitly requested view, including a deliberate text open', () => {
    expect(opened('clips/demo.mp4', 'editor').mode).toBe('editor')
    expect(opened('README.md', 'preview').mode).toBe('preview')
    expect(opened('index.html', 'browser').mode).toBe('browser')
  })

  it('carries a deliberate text open so the editor does not bounce it back to the preview', () => {
    const request = opened('clips/demo.mp4', 'editor', true)
    expect(request.mode).toBe('editor')
    expect(request.allowBinary).toBe(true)
    expect(opened('clips/demo.mp4').allowBinary).toBeUndefined()
  })

  it('describes unrenderable files instead of decoding them', () => {
    expect(previewKindFor('vendor/tool.exe')).toBe('binary')
    expect(previewKindFor('data/db.sqlite')).toBe('binary')
    expect(previewKindFor('song.mp3')).toBe('audio')
    expect(previewKindFor('notes.txt')).toBe('text')
    expect(formatBytes(48 * 1024 * 1024)).toBe('48 MB')
  })
})

describe('failure classification', () => {
  it('recognises the main process refusing a binary read, through Electron serialisation', () => {
    const wrapped = new Error("Error invoking remote method 'files:read-for-editor': BinaryFileError: clip.mp4 is a binary file, so it was not opened as text. Preview it, or open it with the default app.")
    expect(isBinaryFileRefusal(wrapped)).toBe(true)
    expect(cleanIpcError(wrapped)).toBe('clip.mp4 is a binary file, so it was not opened as text. Preview it, or open it with the default app.')
    expect(isBinaryFileRefusal(new Error('Project not found'))).toBe(false)
  })

  it('offers the text override for a binary sniff but never for the size ceiling', () => {
    const binary = new Error("Error invoking remote method 'files:read-for-editor': BinaryFileError: clip.mp4 is a binary file, so it was not opened as text.")
    const oversized = new Error("Error invoking remote method 'files:read-for-editor': FileTooLargeError: huge.log is 42 MB. Files larger than 8 MB are not opened as text.")
    // Both route to the friendly view, so preview and open-with stay available for either.
    expect(isBinaryFileRefusal(binary)).toBe(true)
    expect(isBinaryFileRefusal(oversized)).toBe(true)
    // Only the sniff is a judgement the reader may overrule; forcing an oversized read is a no-op.
    expect(isOverridableFileRefusal(binary)).toBe(true)
    expect(isOverridableFileRefusal(oversized)).toBe(false)
  })

  it('treats editor cancellation as noise rather than a reportable error', () => {
    const canceled = new Error('Canceled')
    canceled.name = 'Canceled'
    expect(isCancellation(canceled)).toBe(true)
    expect(isCancellation({ name: 'AbortError' })).toBe(true)
    expect(isCancellation(new Error('Failed to execute writeText on Clipboard'))).toBe(false)
    expect(isCancellation(undefined)).toBe(false)
  })
})
