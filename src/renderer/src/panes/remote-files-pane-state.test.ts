import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteFileEntry, RemoteFileIdentity } from '../../../shared/remote-files'
import type { AgentFileChange } from '../../../shared/agent-control'
import {
  CoalescedRefresh, REMOTE_TREE_REFRESH_MS, acceptRemoteTreeResponse, parentRemoteDirectory,
  remoteChangeAffectsDirectory, remoteChangeMatches, remotePreviewKind, remotePromptFileAttachment,
  remoteTreeKey, shouldRelistRemoteDirectory
} from './remote-files-pane-state'

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

describe('following a host that is still changing its own files', () => {
  const scope = { machineId: 'main-box', projectId: 'project_9' }
  const change = (patch: Partial<AgentFileChange> = {}): AgentFileChange =>
    ({ projectId: 'local-project', path: 'src/app.ts', machineId: 'main-box', remoteProjectId: 'project_9', ...patch })

  it('matches a host change by the host’s project id, which is how such a pane is keyed', () => {
    expect(remoteChangeMatches(change(), scope)).toBe(true)
  })

  it('matches a paired project by this computer’s id, which is how that pane is keyed', () => {
    expect(remoteChangeMatches(change(), { machineId: 'main-box', projectId: 'local-project' })).toBe(true)
  })

  it('never repaints a host pane from a change on this computer', () => {
    // A local change carries no machineId. Two computers hold two working copies, and a local edit
    // to a paired project says nothing about the host's copy.
    expect(remoteChangeMatches({ projectId: 'local-project' }, scope)).toBe(false)
    expect(remoteChangeMatches(change({ machineId: undefined }), scope)).toBe(false)
  })

  it('never repaints from a different machine or a different project', () => {
    expect(remoteChangeMatches(change({ machineId: 'studio' }), scope)).toBe(false)
    expect(remoteChangeMatches(change({ projectId: 'other', remoteProjectId: 'other' }), scope)).toBe(false)
    expect(remoteChangeMatches(change(), { machineId: '', projectId: 'project_9' })).toBe(false)
  })

  it('re-lists for a file in the directory on screen', () => {
    expect(remoteChangeAffectsDirectory('src/app.ts', 'src')).toBe(true)
    expect(remoteChangeAffectsDirectory('README.md', '')).toBe(true)
    expect(remoteChangeAffectsDirectory('src\\nested\\app.ts', 'src/nested')).toBe(true)
  })

  it('re-lists for a file deeper down, because the folders on the way may be new', () => {
    // A build writing dist/assets/app.js is how a missing `dist` appears in the root listing.
    expect(remoteChangeAffectsDirectory('dist/assets/app.js', '')).toBe(true)
    expect(remoteChangeAffectsDirectory('src/deep/nested/app.ts', 'src')).toBe(true)
  })

  it('ignores a change that cannot alter what is on screen', () => {
    expect(remoteChangeAffectsDirectory('docs/guide.md', 'src')).toBe(false)
    expect(remoteChangeAffectsDirectory('src-other/app.ts', 'src')).toBe(false)
    expect(remoteChangeAffectsDirectory('src', 'src')).toBe(false)
    expect(remoteChangeAffectsDirectory('', 'src')).toBe(false)
  })

  it('asks both questions together', () => {
    expect(shouldRelistRemoteDirectory(change(), scope, 'src')).toBe(true)
    expect(shouldRelistRemoteDirectory(change({ machineId: 'studio' }), scope, 'src')).toBe(false)
    expect(shouldRelistRemoteDirectory(change({ path: 'docs/guide.md' }), scope, 'src')).toBe(false)
  })
})

describe('collapsing a burst of host changes into one re-list', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-lists once after the burst settles, not once per notice', () => {
    const run = vi.fn()
    const refresh = new CoalescedRefresh(REMOTE_TREE_REFRESH_MS, run)
    // What `npm install` or a branch switch looks like from here.
    for (let index = 0; index < 400; index++) { refresh.schedule(); vi.advanceTimersByTime(5) }
    expect(run).not.toHaveBeenCalled()
    expect(refresh.pending).toBe(true)
    vi.advanceTimersByTime(REMOTE_TREE_REFRESH_MS)
    expect(run).toHaveBeenCalledTimes(1)
    expect(refresh.pending).toBe(false)
  })

  it('still re-lists promptly for a single saved file', () => {
    const run = vi.fn()
    new CoalescedRefresh(REMOTE_TREE_REFRESH_MS, run).schedule()
    vi.advanceTimersByTime(REMOTE_TREE_REFRESH_MS - 1)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('fires again for the next burst', () => {
    const run = vi.fn()
    const refresh = new CoalescedRefresh(REMOTE_TREE_REFRESH_MS, run)
    refresh.schedule(); vi.advanceTimersByTime(REMOTE_TREE_REFRESH_MS)
    refresh.schedule(); vi.advanceTimersByTime(REMOTE_TREE_REFRESH_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never fires for a pane that has gone, or for what it used to point at', () => {
    const run = vi.fn()
    const refresh = new CoalescedRefresh(REMOTE_TREE_REFRESH_MS, run)
    refresh.schedule()
    refresh.cancel()
    vi.advanceTimersByTime(REMOTE_TREE_REFRESH_MS * 4)
    expect(run).not.toHaveBeenCalled()
    expect(refresh.pending).toBe(false)
    // Cancelling twice, or with nothing pending, is not an error.
    expect(() => { refresh.cancel(); refresh.cancel() }).not.toThrow()
  })
})
