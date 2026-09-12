import { describe, expect, it } from 'vitest'
import type { RemoteFileEntry, RemoteFileIdentity } from '../../../shared/remote-files'
import { acceptRemoteTreeResponse, parentRemoteDirectory, remotePreviewKind, remotePromptFileAttachment, remoteTreeKey } from './remote-files-pane-state'

const requested: RemoteFileIdentity = { machineId: 'host-a', projectId: 'project-a', path: 'renders' }
const entry = (overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry => ({
  file: { ...requested, path: 'renders/frame.png' }, name: 'frame.png', kind: 'file', ...overrides
})

describe('remote file tree state boundary', () => {
  it('accepts only direct children carrying the exact requested machine and project', () => {
    expect(acceptRemoteTreeResponse(requested, remoteTreeKey(requested), [
      entry(), entry({ file: { ...requested, path: 'renders/clips' }, name: 'clips', kind: 'directory' })
    ])).toHaveLength(2)
    expect(() => acceptRemoteTreeResponse(requested, remoteTreeKey(requested), [
      entry({ file: { ...requested, machineId: 'controller', path: 'renders/frame.png' } })
    ])).toThrow(/outside the requested directory/)
    expect(() => acceptRemoteTreeResponse(requested, remoteTreeKey(requested), [
      entry({ file: { ...requested, path: 'other/frame.png' } })
    ])).toThrow(/outside the requested directory/)
  })

  it('drops a delayed response after the pane changes machine or directory', () => {
    expect(acceptRemoteTreeResponse(requested, remoteTreeKey({ ...requested, machineId: 'host-b' }), [entry()])).toBeNull()
    expect(acceptRemoteTreeResponse(requested, remoteTreeKey({ ...requested, path: 'renders/clips' }), [entry()])).toBeNull()
  })

  it('allows only passive raster and video preview extensions and computes parents', () => {
    expect(remotePreviewKind('frame.PNG')).toBe('image')
    expect(remotePreviewKind('clips/render.webm')).toBe('video')
    expect(remotePreviewKind('active.svg')).toBeNull()
    expect(remotePreviewKind('page.html')).toBeNull()
    expect(parentRemoteDirectory('renders/clips/final')).toBe('renders/clips')
  })

  it('retains the exact remote identity in a prompt attachment without controller content or path', () => {
    expect(remotePromptFileAttachment(entry().file, 'frame.png', 'attachment-1')).toEqual({
      id: 'attachment-1', kind: 'file', name: 'frame.png', remoteFile: entry().file
    })
  })
})
