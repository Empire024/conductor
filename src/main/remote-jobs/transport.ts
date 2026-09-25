import { spawn } from 'node:child_process'
import type { ExecutionNode } from './types.ts'

export interface ExecOptions {
  /** One command line for the node's login shell (see shell.ts builders). */
  command: string
  /** Keep stdin open for the whole run; closing it tells the job wrapper to stop the job. */
  holdStdin?: boolean
  /** Hard local limit: the connection is dropped after this, whatever the node is doing. */
  timeoutMs: number
  onStdout?(chunk: string): void
  onStderr?(chunk: string): void
}

export interface ExecResult {
  /** The remote command's exit code as ssh passes it on; 255 is ssh's own failure. */
  code: number | null
  signal: string | null
  /** The connection could not be made or the transport process failed; null otherwise. */
  error: string | null
  /** The local limit dropped the connection. */
  timedOut: boolean
}

export interface ExecHandle {
  done: Promise<ExecResult>
  /** Ends stdin: a held job is asked to stop, and stops its whole process group. */
  closeStdin(): void
  /** Drops the connection outright. */
  kill(): void
}

export interface PushCommit {
  localRepoPath: string
  commit: string
  /** Bare repository path on the node, relative to the node account's home. */
  remotePath: string
  ref: string
  timeoutMs: number
}

/** How Conductor reaches one node. SSH today; a paired Conductor host can carry the same calls. */
export interface NodeTransport {
  exec(options: ExecOptions): ExecHandle
  pushCommit(input: PushCommit): Promise<void>
}

export type TransportFactory = (node: ExecutionNode) => NodeTransport

export interface SshTransportOptions {
  /** ssh executable; "ssh" from PATH by default (Windows ships OpenSSH in System32). */
  ssh?: string
  git?: string
  /** A known_hosts file of Conductor's own, so node keys are pinned apart from the owner's. */
  knownHostsFile: string
  spawnProcess?: typeof spawn
}

/**
 * ssh options for an unattended, bounded call: keys only (never a password prompt that would hang),
 * the node's host key pinned on first contact and refused if it ever changes, a connect timeout,
 * and keepalives so a dead path is noticed in about a minute rather than never.
 */
export function sshArgs(node: ExecutionNode, knownHostsFile: string): string[] {
  const ssh = node.ssh
  return [
    '-T',
    '-i', ssh.identityFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    ...(ssh.port ? ['-p', String(ssh.port)] : []),
    `${ssh.user}@${ssh.host}`
  ]
}

/** GIT_SSH_COMMAND quoting: git runs it through sh, so forward slashes and double quotes. */
const gitSshArg = (value: string): string => `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`

export function sshTransport(options: SshTransportOptions): TransportFactory {
  const run = options.spawnProcess ?? spawn
  const sshBin = options.ssh ?? 'ssh'
  return node => ({
    exec(exec: ExecOptions): ExecHandle {
      let timedOut = false
      let settled = false
      const child = run(sshBin, [...sshArgs(node, options.knownHostsFile), exec.command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => exec.onStdout?.(chunk))
      child.stderr?.on('data', (chunk: string) => exec.onStderr?.(chunk))
      // An EPIPE on stdin after the node closed its side is expected, not a failure.
      child.stdin?.on('error', () => undefined)
      if (!exec.holdStdin) child.stdin?.end()
      const timer = setTimeout(() => { timedOut = true; child.kill() }, exec.timeoutMs)
      const done = new Promise<ExecResult>(resolve => {
        child.once('error', error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ code: null, signal: null, error: error.message, timedOut })
        })
        child.once('close', (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ code, signal, error: code === 255 ? 'ssh could not complete the connection' : null, timedOut })
        })
      })
      return {
        done,
        closeStdin: () => { if (!child.stdin?.destroyed) child.stdin?.end() },
        kill: () => { child.kill() }
      }
    },

    pushCommit(input: PushCommit): Promise<void> {
      const ssh = node.ssh
      const sshCommand = [gitSshArg(sshBin), ...sshArgs(node, options.knownHostsFile).slice(0, -1).map(gitSshArg)].join(' ')
      const target = `${ssh.user}@${ssh.host}:${input.remotePath}`
      return new Promise((resolve, reject) => {
        const child = run(options.git ?? 'git', ['-C', input.localRepoPath, 'push', '--quiet', '--force', target, `${input.commit}:${input.ref}`], {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_SSH_COMMAND: sshCommand, GIT_TERMINAL_PROMPT: '0' }
        })
        let stderr = ''
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
        const timer = setTimeout(() => child.kill(), input.timeoutMs)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('close', code => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`git push to ${node.id} failed (${code ?? 'killed'}): ${stderr.trim() || 'no output'}`))
        })
      })
    }
  })
}
