import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brokeredGitPush, mentionsGitPush, parsePushCommand } from './git-push.ts'
import { runTool } from './tools.ts'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** A workspace with a real remote, so the broker is exercised against git rather than a stub.
 *  The remote is a bare repository on disk: no network is involved in the test either. */
function repository(): { workspace: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'conductor-push-'))
  const remote = join(root, 'remote.git')
  const workspace = join(root, 'work')
  git(root, 'init', '--bare', remote)
  git(root, 'init', '--initial-branch=main', workspace)
  git(workspace, 'config', 'user.email', 'test@conductor.invalid')
  git(workspace, 'config', 'user.name', 'Conductor test')
  git(workspace, 'remote', 'add', 'origin', remote)
  writeFileSync(join(workspace, 'file.txt'), 'one\n')
  git(workspace, 'add', 'file.txt')
  git(workspace, 'commit', '-m', 'first')
  return { workspace, remote }
}

describe('granted git push', () => {
  it('recognizes a push however it is hidden in a command line', () => {
    expect(mentionsGitPush('git push')).toBe(true)
    expect(mentionsGitPush('git commit -m x && git push origin main')).toBe(true)
    expect(mentionsGitPush('echo $(git push)')).toBe(true)
    expect(mentionsGitPush('/usr/bin/git push')).toBe(true)
    expect(mentionsGitPush('git log --oneline')).toBe(false)
    expect(mentionsGitPush('grep -rn "git push" docs')).toBe(false)
  })

  it('accepts only a plain push of an existing remote and branch', () => {
    expect(parsePushCommand('git push')).toEqual({ setUpstream: false })
    expect(parsePushCommand('git push -u origin main')).toEqual({ setUpstream: true, remote: 'origin', branch: 'main' })
    for (const command of [
      'git push --force',
      'git push -f origin main',
      'git push --force-with-lease',
      'git push --delete origin main',
      'git push --mirror',
      'git push origin :main',
      'git push origin HEAD:refs/heads/other',
      'git push https://example.com/repo.git main',
      'git push --receive-pack=evil origin main',
      'git -C /other push',
      'git push && rm -rf /workspace',
      'git push origin main extra'
    ]) expect(() => parsePushCommand(command), command).toThrow()
  })

  it('pushes the checked-out branch on the host and reports the result', async () => {
    const { workspace, remote } = repository()
    const first = await brokeredGitPush(workspace, 'git push -u origin main')
    expect(first.failed).toBe(false)
    expect(git(remote, 'log', '--oneline', 'main')).toContain('first')
    // A push that has nothing to send is a success with git's own wording, not an error.
    const again = await brokeredGitPush(workspace, 'git push')
    expect(again.failed).toBe(false)
  })

  it('refuses a branch that is not checked out and a remote that does not exist', async () => {
    const { workspace } = repository()
    await expect(brokeredGitPush(workspace, 'git push origin other')).rejects.toThrow(/checked-out branch/)
    await expect(brokeredGitPush(workspace, 'git push upstream main')).rejects.toThrow(/not a remote/)
  })

  it('reports a rejected push instead of retrying it with force', async () => {
    const { workspace, remote } = repository()
    await brokeredGitPush(workspace, 'git push -u origin main')
    // Someone else moves the branch on, so the next push is not a fast-forward.
    const other = mkdtempSync(join(tmpdir(), 'conductor-push-peer-'))
    git(other, 'clone', remote, 'clone')
    const clone = join(other, 'clone')
    // The bare remote's HEAD still names its default branch, so the clone starts detached.
    git(clone, 'checkout', 'main')
    git(clone, 'config', 'user.email', 'peer@conductor.invalid')
    git(clone, 'config', 'user.name', 'Peer')
    writeFileSync(join(clone, 'file.txt'), 'two\n')
    git(clone, 'commit', '-am', 'second')
    git(clone, 'push', 'origin', 'main')
    writeFileSync(join(workspace, 'file.txt'), 'three\n')
    git(workspace, 'commit', '-am', 'divergent')
    const pushed = await brokeredGitPush(workspace, 'git push')
    expect(pushed.failed).toBe(true)
    expect(pushed.output).toContain('push failed')
  })

  it('is refused by run_command until the owner grants repository writes', async () => {
    const { workspace } = repository()
    const context = { workspace, readOnly: false, sandbox: null, timeoutSec: 30 }
    const denied = await runTool('run_command', JSON.stringify({ command: 'git push' }), context)
    expect(denied.failed).toBe(true)
    expect(denied.output).toContain('repository writes')
    // Granted, the push never reaches the container: there is no sandbox here and it still runs.
    const granted = await runTool('run_command', JSON.stringify({ command: 'git push -u origin main' }), { ...context, grants: { git: true, research: false } })
    expect(granted.failed).toBe(false)
  })
})
