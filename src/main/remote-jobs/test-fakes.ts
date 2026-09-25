import { MARKER_PREFIX } from './shell.ts'
import type { ExecHandle, ExecOptions, ExecResult, NodeTransport, PushCommit, TransportFactory } from './transport.ts'
import type { ExecutionNode } from './types.ts'

/** Reads back the POSIX single-quoted words of a command line built by shell.ts. */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let at = 0
  while (at < command.length) {
    while (command[at] === ' ') at++
    if (at >= command.length) break
    let word = ''
    while (at < command.length && command[at] !== ' ') {
      if (command[at] === "'") {
        const end = command.indexOf("'", at + 1)
        word += command.slice(at + 1, end)
        at = end + 1
      } else if (command[at] === '\\') { word += command[at + 1]; at += 2 } else { word += command[at]; at++ }
    }
    words.push(word)
  }
  return words
}

export interface FakeJob { id: string; cwd: string; timeoutSec: number; command: string; nonce: string }

export interface FakeRun {
  stdout(text: string): void
  stderr(text: string): void
  /** A wrapper line: "started pid=1", "reason=timeout", "exit=0". */
  mark(body: string): void
  end(code: number | null, extra?: Partial<ExecResult>): void
  stdinClosed: boolean
  onStdinClosed(callback: () => void): void
  onKill(callback: () => void): void
}

export type FakeHandler = (command: string, run: FakeRun, options: ExecOptions, nodeId: string) => void

/**
 * A node that answers in memory. Each exec goes to `handler`; the job helper decodes the job
 * wrapper's arguments so a test can act as the wrapper would.
 */
export class FakeNodes {
  readonly calls: Array<{ nodeId: string; command: string; holdStdin: boolean }> = []
  readonly pushes: Array<{ nodeId: string } & PushCommit> = []
  pushError: Error | null = null
  handler: FakeHandler = (_command, run) => run.end(0)

  factory(): TransportFactory {
    return (node: ExecutionNode): NodeTransport => ({
      exec: options => this.exec(node, options),
      pushCommit: async input => {
        this.pushes.push({ nodeId: node.id, ...input })
        if (this.pushError) throw this.pushError
      }
    })
  }

  private exec(node: ExecutionNode, options: ExecOptions): ExecHandle {
    this.calls.push({ nodeId: node.id, command: options.command, holdStdin: Boolean(options.holdStdin) })
    let resolve!: (result: ExecResult) => void
    const done = new Promise<ExecResult>(settle => { resolve = settle })
    let ended = false
    const stdinListeners: Array<() => void> = []
    const killListeners: Array<() => void> = []
    const run: FakeRun = {
      stdout: text => options.onStdout?.(text),
      stderr: text => options.onStderr?.(text),
      mark: body => {
        const nonce = FakeNodes.job(options.command)?.nonce ?? ''
        options.onStderr?.(`${MARKER_PREFIX}${nonce} ${body}\n`)
      },
      end: (code, extra) => { if (!ended) { ended = true; resolve({ code, signal: null, error: null, timedOut: false, ...extra }) } },
      stdinClosed: !options.holdStdin,
      onStdinClosed: callback => { stdinListeners.push(callback) },
      onKill: callback => { killListeners.push(callback) }
    }
    queueMicrotask(() => this.handler(options.command, run, options, node.id))
    return {
      done,
      closeStdin: () => { if (!run.stdinClosed) { run.stdinClosed = true; for (const listener of stdinListeners) listener() } },
      kill: () => { for (const listener of killListeners) listener(); run.end(null, { signal: 'SIGTERM' }) }
    }
  }

  /** The job wrapper's arguments, when this command is a job. */
  static job(command: string): FakeJob | null {
    const words = shellWords(command)
    const at = words.indexOf('conductor-job')
    if (at < 0) return null
    const [id, cwd, timeout, body, nonce] = words.slice(at + 1)
    return { id: id!, cwd: cwd!, timeoutSec: Number(timeout), command: body!, nonce: nonce! }
  }
}
