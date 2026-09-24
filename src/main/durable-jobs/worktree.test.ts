import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorktrees, WORKTREE_SETTINGS_FILE } from './worktree'

const dirs: string[] = []
const trees: Array<{ repo: string; path: string }> = []
afterEach(() => {
  for (const tree of trees.splice(0)) { try { git(tree.repo, 'worktree', 'remove', '--force', tree.path) } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const write = (path: string, content: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
const read = (path: string) => readFileSync(path, 'utf8')

describe('non-git checkpoints', () => {
  it('capture a file the stage created but never reported, and restore brings it back', async () => {
    const cwd = temp('durable-plain-')
    write(join(cwd, 'notes.md'), 'reported\n')
    // Created during the stage by a shell command: not in handoff.filesChanged.
    write(join(cwd, 'generated', 'untracked.txt'), 'made by a script\n')
    write(join(cwd, 'node_modules', 'dep', 'index.js'), 'dependency\n')
    const checkpoints = temp('durable-snap-')
    const directory = join(checkpoints, 'snap_1')
    await gitWorktrees.snapshot(cwd, ['notes.md'], directory)
    expect(gitWorktrees.snapshotComplete(directory)).toBe(true)
    const manifest = JSON.parse(read(join(directory, 'manifest.json')))
    expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual(['generated/untracked.txt', 'notes.md'])
    expect(manifest.skipped.directories).toContain('node_modules')

    // The next stage damages both files and adds one of its own.
    rmSync(join(cwd, 'generated'), { recursive: true })
    writeFileSync(join(cwd, 'notes.md'), 'overwritten\n')
    writeFileSync(join(cwd, 'later.txt'), 'after the checkpoint\n')

    const restored = await gitWorktrees.restore(directory, cwd)
    expect(read(join(cwd, 'generated', 'untracked.txt'))).toBe('made by a script\n')
    expect(read(join(cwd, 'notes.md'))).toBe('reported\n')
    expect(restored.written.sort()).toEqual(['generated/untracked.txt', 'notes.md'])
    // Without prune a restore never deletes; with it, files the checkpoint did not have go.
    expect(existsSync(join(cwd, 'later.txt'))).toBe(true)
    const pruned = await gitWorktrees.restore(directory, cwd, { prune: true })
    expect(pruned.removed).toEqual(['later.txt'])
    expect(existsSync(join(cwd, 'later.txt'))).toBe(false)
    // Skipped folders are neither captured nor pruned.
    expect(read(join(cwd, 'node_modules', 'dep', 'index.js'))).toBe('dependency\n')
  })

  it('stores unchanged content once across checkpoints', async () => {
    const cwd = temp('durable-plain-')
    write(join(cwd, 'a.txt'), 'same\n')
    write(join(cwd, 'b.txt'), 'same\n')
    const checkpoints = temp('durable-snap-')
    await gitWorktrees.snapshot(cwd, [], join(checkpoints, 'snap_1'))
    write(join(cwd, 'c.txt'), 'new\n')
    await gitWorktrees.snapshot(cwd, ['c.txt'], join(checkpoints, 'snap_2'))
    const objects = readdirSync(join(checkpoints, 'objects'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    expect(objects).toHaveLength(2)
  })

  it('refuses a restore whose stored content no longer matches the manifest', async () => {
    const cwd = temp('durable-plain-')
    write(join(cwd, 'a.txt'), 'original\n')
    const checkpoints = temp('durable-snap-')
    const directory = join(checkpoints, 'snap_1')
    await gitWorktrees.snapshot(cwd, [], directory)
    const object = readdirSync(join(checkpoints, 'objects'), { recursive: true, withFileTypes: true }).find(entry => entry.isFile())!
    writeFileSync(join(object.parentPath, object.name), 'tampered\n')
    writeFileSync(join(cwd, 'a.txt'), 'changed\n')
    await expect(gitWorktrees.restore(directory, cwd)).rejects.toThrow(/does not match/)
    expect(read(join(cwd, 'a.txt'))).toBe('changed\n')
  })

  it('restores a snapshot written in the earlier files/ layout', async () => {
    const cwd = temp('durable-plain-')
    const directory = join(temp('durable-snap-'), 'snap_old')
    write(join(directory, 'files', 'notes.md'), 'hello')
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ cwd, files: [{ path: 'notes.md', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', bytes: 5 }] }))
    expect((await gitWorktrees.restore(directory, cwd)).written).toEqual(['notes.md'])
    expect(read(join(cwd, 'notes.md'))).toBe('hello')
  })
})

describe('dependencies in a job worktree', () => {
  function nodeRepo(ignoreModules = true) {
    const repo = temp('durable-node-repo-')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'owner@example.invalid'); git(repo, 'config', 'user.name', 'Owner')
    write(join(repo, 'package.json'), '{"name":"fixture","scripts":{"test":"node test.js"}}\n')
    if (ignoreModules) write(join(repo, '.gitignore'), 'node_modules/\n')
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base')
    write(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    return repo
  }
  async function create(repo: string, jobId: string) {
    const tree = await gitWorktrees.create(repo, jobId, join(temp('durable-wt-'), 'worktree'))
    trees.push({ repo, path: tree.path })
    return tree
  }

  it('does not link the owner\'s node_modules by default and says why tests cannot run', async () => {
    const repo = nodeRepo()
    const tree = await create(repo, 'job_deps_default')
    expect(existsSync(join(tree.path, 'node_modules'))).toBe(false)
    expect(tree.dependencies).toMatchObject({ mode: 'none', status: 'missing', packageDirs: ['.'] })
    expect(tree.dependencies!.note).toMatch(/no node_modules/)
    expect(tree.dependencies!.note).toContain('npm ci')
    expect(tree.dependencies!.note).toContain(WORKTREE_SETTINGS_FILE)
  })

  it('copies real files on opt-in, skips links, and a write in the copy never reaches the owner', async () => {
    const repo = nodeRepo()
    write(join(repo, WORKTREE_SETTINGS_FILE), '{"worktreeDependencies":"copy"}\n')
    const outside = temp('durable-link-target-')
    write(join(outside, 'index.js'), 'owner workspace package\n')
    symlinkSync(outside, join(repo, 'node_modules', 'linked'), 'junction')
    const tree = await create(repo, 'job_deps_copy')
    expect(tree.dependencies).toMatchObject({ mode: 'copy', status: 'copied', packageDirs: ['.'] })
    expect(tree.dependencies!.note).toMatch(/1 link/)
    const copied = join(tree.path, 'node_modules', 'dep', 'index.js')
    expect(lstatSync(join(tree.path, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(tree.path, 'node_modules', 'dep')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(tree.path, 'node_modules', 'linked'))).toBe(false)
    writeFileSync(copied, 'job edit\n')
    unlinkSync(join(tree.path, 'node_modules', 'dep', 'index.js'))
    expect(read(join(repo, 'node_modules', 'dep', 'index.js'))).toBe('module.exports = 1\n')
    // The copy is ignored, so a checkpoint commit never carries it.
    writeFileSync(copied, 'again\n')
    expect(git(tree.path, 'status', '--porcelain').trim()).toBe('')
  })

  it('refuses to copy node_modules a checkpoint commit would pick up', async () => {
    const repo = nodeRepo(false)
    write(join(repo, WORKTREE_SETTINGS_FILE), '{"worktreeDependencies":"copy"}\n')
    const tree = await create(repo, 'job_deps_unignored')
    expect(existsSync(join(tree.path, 'node_modules'))).toBe(false)
    expect(tree.dependencies).toMatchObject({ mode: 'copy', status: 'missing' })
    expect(tree.dependencies!.note).toMatch(/not ignored by git/)
  })

  it('reports nothing for a project without package.json', async () => {
    const repo = temp('durable-plain-repo-')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'owner@example.invalid'); git(repo, 'config', 'user.name', 'Owner')
    write(join(repo, 'a.txt'), 'x\n')
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base')
    expect((await create(repo, 'job_no_node')).dependencies).toBeUndefined()
  })
})
