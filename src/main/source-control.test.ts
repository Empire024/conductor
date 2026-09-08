import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConductorDatabase } from './database'
import { SourceControl } from './source-control'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-task-commits-')); roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--quiet')
  writeFileSync(join(root, 'example.txt'), 'before\n'); git('add', '.'); git('commit', '--quiet', '-m', 'Before task')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'example.txt'), 'after\n'); git('add', '.'); git('commit', '--quiet', '-m', 'During task')
  const head = git('rev-parse', 'HEAD')
  const database = { getProject: () => ({ path: root }), getSetting: () => undefined } as unknown as ConductorDatabase
  return { service: new SourceControl(database), base, head }
}
describe('task commit boundaries', () => {
  it('shows no previous commit or diff when a task starts and finishes at the same commit', async () => {
    const f = fixture()
    const result = await f.service.changes('project', 'task', f.head, f.head)
    expect(result).toMatchObject({ base: f.head, head: f.head, commits: [], files: [] })
    expect(result.patch).toBeUndefined()
    expect(result.compareUrl).toBeUndefined()
    expect(result.note).toContain('No commits landed')
  })
  it('retains the real commit and file diff when a commit lands during the task', async () => {
    const f = fixture()
    const result = await f.service.changes('project', 'task', f.base, f.head)
    expect(result.commits).toHaveLength(1)
    expect(result.commits[0]).toMatchObject({ sha: f.head, subject: 'During task' })
    expect(result.files).toHaveLength(1)
    expect(result.patch).toContain('+after')
    expect(result.patch).toContain('-before')
  })
})