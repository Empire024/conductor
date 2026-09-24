import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScheduleScript, ScheduleScriptResult } from '../shared/schedules'

/**
 * Runs a scheduled task's scripts: the deterministic half of a scheduled task. A script is text
 * an agent (or Conductor, for a built-in task) saved through app control; it is written to a
 * fresh file for each run, checked against the digest recorded when it was saved, and executed
 * with the project folder as its working directory, a timeout and an output ceiling. Its stdout
 * is the evidence the runner digests; stderr is diagnostics only.
 */

export const SCRIPT_OUTPUT_LIMIT = 256 * 1024
const EXCERPT_CHARS = 4000

export interface ScriptProcessRequest {
  script: ScheduleScript
  /** The materialized file (materializeScript). */
  file: string
  cwd: string
  env: Record<string, string>
  signal: AbortSignal
}

export interface ScriptProcessOutput {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  truncated: boolean
  error?: string
}

export interface ScriptLaunchers {
  /** How a node script runs: the owner's own `node` when there is one, else Electron as Node. */
  node(): { command: string; args: string[]; env?: Record<string, string> }
  powershell(): { command: string; args: string[] }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

let resolvedNode: string | null | undefined
function nodeOnPath(): string | null {
  if (resolvedNode !== undefined) return resolvedNode
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    resolvedNode = found.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null
  } catch { resolvedNode = null }
  return resolvedNode
}

export const defaultLaunchers: ScriptLaunchers = {
  node: () => {
    const node = nodeOnPath()
    // Electron is a Node runtime too; it only needs to be told to behave as one.
    return node ? { command: node, args: [] } : { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }
  },
  powershell: () => ({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] })
}

/** Writes the stored script to a fresh file for this run. The content is checked against the
 *  digest recorded when it was saved, so a row edited behind the store's back never runs. */
export function materializeScript(directory: string, script: ScheduleScript): string {
  if (sha256(script.content) !== script.digest) throw new Error(`Script ${script.name} does not match the digest recorded when it was saved; save it again through app control`)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${script.name}.${script.language === 'powershell' ? 'ps1' : 'mjs'}`)
  // PowerShell 5.1 reads a BOM-less script as the ANSI code page; the BOM keeps non-ASCII intact.
  writeFileSync(file, script.language === 'powershell' ? `﻿${script.content}` : script.content, 'utf8')
  if (readFileSync(file, 'utf8').replace(/^﻿/, '') !== script.content) throw new Error(`Script ${script.name} could not be written intact`)
  return file
}

/** Output as evidence: line endings and trailing whitespace are not a change. */
export const normalizeOutput = (value: string): string => value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim()

const tail = (value: string, limit = EXCERPT_CHARS): string => value.length <= limit ? value : `…${value.slice(-(limit - 1))}`

/** The whole tree: a script's own children (a CLI it asked, a test runner) must not outlive it.
 *  Asynchronous, because this runs in the app's main process and must never block its UI. */
function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => { /* already gone */ })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
}

export class ScheduleScriptRunner {
  constructor(private readonly launchers: ScriptLaunchers = defaultLaunchers, private readonly outputLimit = SCRIPT_OUTPUT_LIMIT) {}

  run(request: ScriptProcessRequest): Promise<ScriptProcessOutput> {
    const { script } = request
    const launch = script.language === 'powershell' ? { ...this.launchers.powershell(), env: undefined } : this.launchers.node()
    const started = Date.now()
    return new Promise(resolve => {
      if (request.signal.aborted) { resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, truncated: false, error: 'Cancelled before it started' }); return }
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      let outBytes = 0, errBytes = 0, truncated = false, timedOut = false, settled = false
      const child = spawn(launch.command, [...launch.args, request.file], {
        cwd: request.cwd, env: { ...request.env, ...launch.env }, windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
      })
      const collect = (chunks: Buffer[], chunk: Buffer, bytes: number): number => {
        const room = this.outputLimit - bytes
        if (room <= 0) { truncated = true; return bytes }
        const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
        if (part !== chunk) truncated = true
        chunks.push(part)
        return bytes + part.byteLength
      }
      child.stdout!.on('data', (chunk: Buffer) => { outBytes = collect(stdout, chunk, outBytes) })
      child.stderr!.on('data', (chunk: Buffer) => { errBytes = collect(stderr, chunk, errBytes) })
      const finish = (exitCode: number | null, error?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        resolve({
          exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut, durationMs: Date.now() - started, truncated, ...(error ? { error } : {})
        })
      }
      const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, script.timeoutSec * 1000)
      timer.unref?.()
      const abort = (): void => killTree(child.pid)
      request.signal.addEventListener('abort', abort, { once: true })
      child.once('error', error => finish(null, error.message))
      child.once('close', code => finish(code, timedOut ? `Timed out after ${script.timeoutSec} s` : request.signal.aborted ? 'Cancelled' : undefined))
    })
  }
}

/** Judges one script's output: whether it is valid evidence, and whether it moved since the last
 *  valid output. A failed or invalid run never counts as "unchanged", whatever it printed. */
export function judgeScript(script: ScheduleScript, output: ScriptProcessOutput, previousDigest: string | null): { result: ScheduleScriptResult; normalized: string } {
  const normalized = normalizeOutput(output.stdout)
  const outputDigest = normalized ? sha256(normalized) : null
  let status: ScheduleScriptResult['status'] = 'ok'
  let error = output.error
  if (output.timedOut) status = 'timeout'
  else if (output.exitCode !== 0) { status = 'failed'; error ??= `Exited with code ${output.exitCode ?? 'unknown'}` }
  else if (output.truncated) { status = 'invalid'; error = `Printed more than ${SCRIPT_OUTPUT_LIMIT / 1024} KB; evidence must be a compact, stable summary` }
  else if (script.format === 'json') {
    try { JSON.parse(normalized) } catch { status = 'invalid'; error = 'Its format is json but it did not print one JSON document' }
  }
  const excerptSource = status === 'ok' ? normalized : [normalized, normalizeOutput(output.stderr)].filter(Boolean).join('\n--- stderr ---\n')
  return {
    normalized,
    result: {
      name: script.name, status, exitCode: output.exitCode, durationMs: output.durationMs, outputDigest,
      changed: status !== 'ok' || outputDigest !== previousDigest,
      excerpt: tail(excerptSource), ...(error ? { error: error.slice(0, 500) } : {})
    }
  }
}
