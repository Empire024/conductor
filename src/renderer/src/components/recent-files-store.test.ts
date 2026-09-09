import { describe, expect, it } from 'vitest'
import { recentFiles, recordRecentFile, type RecentFilesStore } from './recent-files-store'

function box(): RecentFilesStore {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } }
}

describe('recent files store', () => {
  it('lists files most-recent-first for a project', () => {
    const disk = box()
    recordRecentFile('a', 'one.ts', disk, 1)
    recordRecentFile('a', 'two.ts', disk, 2)
    expect(recentFiles(['a'], disk)).toEqual([{ projectId: 'a', path: 'two.ts' }, { projectId: 'a', path: 'one.ts' }])
  })
  it('moves a reopened file back to the front instead of duplicating it', () => {
    const disk = box()
    recordRecentFile('a', 'one.ts', disk, 1)
    recordRecentFile('a', 'two.ts', disk, 2)
    recordRecentFile('a', 'one.ts', disk, 3)
    expect(recentFiles(['a'], disk)).toEqual([{ projectId: 'a', path: 'one.ts' }, { projectId: 'a', path: 'two.ts' }])
  })
  it('caps the stored history at 20 entries', () => {
    const disk = box()
    for (let index = 0; index < 25; index++) recordRecentFile('a', 'file' + index + '.ts', disk, index)
    const files = recentFiles(['a'], disk)
    expect(files).toHaveLength(20)
    expect(files[0]).toEqual({ projectId: 'a', path: 'file24.ts' })
    expect(files.find((file) => file.path === 'file0.ts')).toBeUndefined()
  })
  it('keeps projects independent so one project cannot evict another\'s history', () => {
    const disk = box()
    recordRecentFile('a', 'one.ts', disk, 1)
    recordRecentFile('b', 'two.ts', disk, 2)
    expect(recentFiles(['a'], disk)).toEqual([{ projectId: 'a', path: 'one.ts' }])
    expect(recentFiles(['a', 'b'], disk)).toEqual([{ projectId: 'b', path: 'two.ts' }, { projectId: 'a', path: 'one.ts' }])
  })
  it('merges recency across every requested project by timestamp', () => {
    const disk = box()
    recordRecentFile('a', 'old.ts', disk, 1)
    recordRecentFile('b', 'newer.ts', disk, 5)
    recordRecentFile('a', 'newest.ts', disk, 10)
    expect(recentFiles(['a', 'b'], disk)).toEqual([{ projectId: 'a', path: 'newest.ts' }, { projectId: 'b', path: 'newer.ts' }, { projectId: 'a', path: 'old.ts' }])
  })
  it('ignores a missing, corrupt or malformed record without throwing', () => {
    expect(recentFiles(['a'], box())).toEqual([])
    const corrupt = box(); corrupt.setItem('conductor.recentFiles.a', 'not json')
    expect(recentFiles(['a'], corrupt)).toEqual([])
    const wrongShape = box(); wrongShape.setItem('conductor.recentFiles.a', JSON.stringify({ path: 'x' }))
    expect(recentFiles(['a'], wrongShape)).toEqual([])
    const stray = box(); stray.setItem('conductor.recentFiles.a', JSON.stringify([{ path: 'ok.ts', at: 1 }, { path: 42, at: 2 }, 'nope']))
    expect(recentFiles(['a'], stray)).toEqual([{ projectId: 'a', path: 'ok.ts' }])
  })
  it('ignores a blank project id or path instead of recording junk', () => {
    const disk = box()
    recordRecentFile('', 'one.ts', disk, 1)
    recordRecentFile('a', '', disk, 1)
    expect(recentFiles(['a', ''], disk)).toEqual([])
  })
  it('survives a blocked or full store instead of breaking the picker', () => {
    const blocked: RecentFilesStore = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    expect(() => recordRecentFile('a', 'one.ts', blocked, 1)).not.toThrow()
    expect(recentFiles(['a'], blocked)).toEqual([])
    expect(() => recordRecentFile('a', 'one.ts', undefined, 1)).not.toThrow()
  })
})
