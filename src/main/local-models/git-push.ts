import { spawn } from 'node:child_process'
import { commandSegments, SandboxPolicyError, segmentProgram } from './sandbox.ts'

/** A `git push` the owner has granted, reduced to the only three things a sandboxed model is
 *  allowed to decide about it: which existing remote, which branch (always the one that is
 *  checked out), and whether to record the upstream. Everything else — force, delete, mirror,
 *  arbitrary refspecs, `--exec`, push options — is refused rather than forwarded. */
export interface GitPushRequest { remote?: string; branch?: string; setUpstream: boolean }

const REMOTE = /^[A-Za-z0-9._-]+$/
const BRANCH = /^[A-Za-z0-9._\-\/]+$/

/** Does this command run `git push` at all? Used to decide between brokering the push on the
 *  host and letting the command go to the networkless container, where it can only fail. */
export function mentionsGitPush(command: string): boolean {
  return commandSegments(command).some(segment => {
    const { program, args } = segmentProgram(segment)
    return program === 'git' && args.find(argument => !argument.startsWith('-'))?.toLowerCase() === 'push'
  })
}

/** Parse the one push form the broker will run. The command must be a push and nothing else:
 *  a compound line is refused rather than partly run on the host and partly in the container. */
export function parsePushCommand(command: string): GitPushRequest {
  const segments = commandSegments(command)
  if (segments.length !== 1) throw new SandboxPolicyError('A push has to be its own command: run the add and commit steps first, then `git push` on a line by itself.')
  const { program, args } = segmentProgram(segments[0]!)
  // Global options before the subcommand can redirect git at another repository entirely.
  if (program !== 'git' || args[0]?.toLowerCase() !== 'push') throw new SandboxPolicyError('Only a plain `git push` can be brokered; options before the `push` subcommand are refused.')
  const request: GitPushRequest = { setUpstream: false }
  const positional: string[] = []
  for (const argument of args.slice(1)) {
    if (argument === '-u' || argument === '--set-upstream') { request.setUpstream = true; continue }
    if (argument.startsWith('-')) throw new SandboxPolicyError(`Refusing \`git push ${argument}\`: the granted push takes only an existing remote, the checked-out branch and -u. Force, delete, mirror, tag and push-option flags are the owner's to run.`)
    positional.push(argument)
  }
  if (positional.length > 2) throw new SandboxPolicyError('Refusing this push: it takes at most a remote and a branch.')
  const [remote, branch] = positional
  if (remote !== undefined && !REMOTE.test(remote)) throw new SandboxPolicyError('Refusing this push: the remote has to be the name of a remote that already exists, not a URL or a refspec.')
  // `src:dst`, `+branch` and a leading colon are how a push retargets or deletes a ref.
  if (branch !== undefined && !BRANCH.test(branch)) throw new SandboxPolicyError('Refusing this push: the branch has to be a plain branch name, not a refspec.')
  return { ...request, ...(remote === undefined ? {} : { remote }), ...(branch === undefined ? {} : { branch }) }
}

interface HostGit { code: number | null; stdout: string; stderr: string; spawnError?: Error }

/** Host `git`, argv only and never through a shell, with the terminal prompt disabled so a
 *  repository whose credentials have expired fails the tool call instead of hanging on a
 *  prompt nobody is watching. */
function hostGit(workspace: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<HostGit> {
  return new Promise(resolvePromise => {
    let stdout = '', stderr = '', settled = false
    const child = spawn('git', args, {
      cwd: workspace, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    const finish = (outcome: HostGit): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      resolvePromise(outcome)
    }
    const cancel = (): void => { child.kill('SIGKILL') }
    const timer = setTimeout(cancel, timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', chunk => { stdout += (chunk as Buffer).toString('utf8').slice(0, 16_384) })
    child.stderr.on('data', chunk => { stderr += (chunk as Buffer).toString('utf8').slice(0, 16_384) })
    child.on('error', error => finish({ code: null, stdout, stderr, spawnError: error as Error }))
    child.on('close', code => finish({ code, stdout, stderr }))
  })
}

export interface GitPushOutcome { output: string; failed: boolean }

/** Run a granted push on the host, because the container deliberately has no network and never
 *  gets the owner's credentials. The model chooses nothing the host does not re-check here: the
 *  remote must already be configured, the branch must be the one that is actually checked out,
 *  and the push is a fast-forward — a rejected push is reported, never retried with force. */
export async function brokeredGitPush(workspace: string, command: string, signal?: AbortSignal): Promise<GitPushOutcome> {
  const request = parsePushCommand(command)
  const head = await hostGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], 15_000, signal)
  if (head.spawnError || head.code !== 0) throw new SandboxPolicyError('The push could not be brokered: the workspace does not look like a git repository this machine can read.')
  const branch = head.stdout.trim()
  if (!branch || branch === 'HEAD') throw new SandboxPolicyError('Refusing this push: HEAD is detached, so there is no branch to push. Check out a branch first.')
  if (request.branch && request.branch !== branch) throw new SandboxPolicyError(`Refusing this push: only the checked-out branch (${branch}) can be pushed from a sandboxed turn, not ${request.branch}.`)
  const listed = await hostGit(workspace, ['remote'], 15_000, signal)
  const remotes = listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!remotes.length) throw new SandboxPolicyError('Refusing this push: the repository has no remote configured. The owner has to add one.')
  const remote = request.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0]!)
  if (!remotes.includes(remote)) throw new SandboxPolicyError(`Refusing this push: ${remote} is not a remote of this repository (${remotes.join(', ')}).`)
  const pushed = await hostGit(workspace, ['push', ...(request.setUpstream ? ['--set-upstream'] : []), remote, branch], 180_000, signal)
  if (pushed.spawnError) throw new SandboxPolicyError('The push could not be brokered: git could not be launched on the host.')
  // git writes its progress and its "everything up-to-date" line to stderr, so both streams
  // are reported whichever way the push went.
  const detail = [pushed.stdout.trim(), pushed.stderr.trim()].filter(Boolean).join('\n').slice(0, 8_000)
  if (pushed.code !== 0) return { output: `push failed (exit ${pushed.code ?? -1}):\n${detail || 'no output'}`, failed: true }
  return { output: `pushed ${branch} to ${remote} from the host on your behalf; the sandbox itself still has no network.\n${detail}`.trim(), failed: false }
}
