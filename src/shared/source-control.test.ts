import { describe, expect, it } from 'vitest'
import {
  commitUrl,
  compareUrl,
  mergeFileStatuses,
  parseCommitLog,
  parseNameStatus,
  parseNumstat,
  parseRemoteUrl
} from './source-control'

const FIELD = String.fromCharCode(31)
const RECORD = String.fromCharCode(30)

describe('repository links for project tasks', () => {
  it('reads every remote form git prints and never keeps credentials', () => {
    expect(parseRemoteUrl('https://github.com/Empire024/conductor.git')).toMatchObject({ host: 'github', owner: 'Empire024', repo: 'conductor', webUrl: 'https://github.com/Empire024/conductor' })
    expect(parseRemoteUrl('git@github.com:Empire024/conductor.git')).toMatchObject({ host: 'github', webUrl: 'https://github.com/Empire024/conductor' })
    expect(parseRemoteUrl('ssh://git@github.com/Empire024/conductor')).toMatchObject({ host: 'github' })
    expect(parseRemoteUrl('https://token@github.com/Empire024/conductor.git')?.webUrl).toBe('https://github.com/Empire024/conductor')
    expect(parseRemoteUrl('https://gitlab.com/team/app.git')).toMatchObject({ host: 'other', webUrl: 'https://gitlab.com/team/app' })
    expect(parseRemoteUrl('')).toBeNull()
    expect(parseRemoteUrl('C:/local/repo')).toBeNull()
  })
  it('builds commit and comparison links only for real revisions on GitHub', () => {
    const github = parseRemoteUrl('git@github.com:Empire024/conductor.git')!
    const other = parseRemoteUrl('https://gitlab.com/team/app.git')!
    expect(commitUrl(github, 'a'.repeat(40))).toBe('https://github.com/Empire024/conductor/commit/' + 'a'.repeat(40))
    expect(commitUrl(github, 'not-a-sha')).toBeUndefined()
    expect(commitUrl(other, 'a'.repeat(40))).toBeUndefined()
    expect(compareUrl(github, 'b'.repeat(40), 'c'.repeat(40))).toBe('https://github.com/Empire024/conductor/compare/' + 'b'.repeat(40) + '...' + 'c'.repeat(40))
    expect(compareUrl(github, undefined, 'c'.repeat(40))).toContain('/commit/')
    expect(compareUrl(github, 'c'.repeat(40), 'c'.repeat(40))).toContain('/commit/')
    expect(compareUrl(github, 'b'.repeat(40), undefined)).toBeUndefined()
  })
  it('parses the commit log without splitting on subjects that contain punctuation', () => {
    const log = ['a'.repeat(40), 'Ada Lovelace', '2026-09-08T10:00:00+02:00', 'Fix: tabs, panes | menus'].join(FIELD) + RECORD +
      ['b'.repeat(40), 'Grace Hopper', '2026-09-07T09:00:00+02:00', 'Add ideas section'].join(FIELD) + RECORD
    const commits = parseCommitLog(log)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({ author: 'Ada Lovelace', subject: 'Fix: tabs, panes | menus' })
    expect(parseCommitLog('')).toEqual([])
    expect(parseCommitLog('garbage')).toEqual([])
  })
  it('counts changed files, follows renames, and keeps binary counts honest', () => {
    const files = parseNumstat(['12\t3\tsrc/main/index.ts', '-\t-\tbuild/icon.png', '4\t0\tsrc/{old => new}/file.ts', '1\t1\tdocs/a.md => docs/b.md'].join('\n'))
    expect(files.map((file) => file.path)).toEqual(['src/main/index.ts', 'build/icon.png', 'src/new/file.ts', 'docs/b.md'])
    expect(files[0]).toMatchObject({ additions: 12, deletions: 3 })
    expect(files[1]).toMatchObject({ additions: undefined, deletions: undefined })
    const statuses = parseNameStatus(['M\tsrc/main/index.ts', 'A\tbuild/icon.png', 'R096\tsrc/old/file.ts\tsrc/new/file.ts'].join('\n'))
    const merged = mergeFileStatuses(files, statuses)
    expect(merged.map((file) => file.status)).toEqual(['modified', 'added', 'renamed', 'modified'])
  })
})
