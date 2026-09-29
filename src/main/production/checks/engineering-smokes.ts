import type { EvidenceSink } from '../../../shared/production'
import type { EngineeringSmokeOutcome } from '../report'

/**
 * The `engineering-smokes` step (docs/production-agent.md section 10): the project's own release
 * smoke command, when the environment names one, run as an additional engineering step. It is
 * labelled so in the report and is not one of the 26 source items: it feeds no control status.
 * The command runs in a child process with a bounded time and output; its log is evidence.
 */

export const SMOKE_TIMEOUT_MS = 10 * 60_000

export type CommandRunner = (command: string, options: { cwd: string | null; timeoutMs: number; signal: AbortSignal }) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>

export async function runEngineeringSmoke(command: string | null, run: CommandRunner | null, options: { cwd: string | null; evidence: EvidenceSink; signal: AbortSignal; timeoutMs?: number }): Promise<EngineeringSmokeOutcome | null> {
  if (!command?.trim()) return null
  if (!run) return { command, status: 'skipped', exitCode: null, durationMs: 0, detail: 'no command runner is wired for this run', evidence: [] }
  const started = Date.now()
  try {
    const result = await run(command, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? SMOKE_TIMEOUT_MS, signal: options.signal })
    const ref = await options.evidence.writeText('command', `engineering smoke: ${command}`, result.output.slice(-256 * 1024), 'log')
    const status: EngineeringSmokeOutcome['status'] = result.timedOut ? 'error' : result.exitCode === 0 ? 'passed' : 'failed'
    const tail = result.output.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
    return { command, status, exitCode: result.exitCode, durationMs: Date.now() - started, detail: result.timedOut ? 'timed out' : tail, evidence: [ref.id] }
  } catch (error) {
    return { command, status: 'error', exitCode: null, durationMs: Date.now() - started, detail: error instanceof Error ? error.message.slice(0, 300) : String(error), evidence: [] }
  }
}
