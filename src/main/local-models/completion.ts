import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'

/** When a local run is finished, and whether its final message can be believed. Small models
 *  say "all edits applied, tests pass" with no tool call behind it (a real run did exactly that),
 *  and keep inspecting after the tests already passed until they break what worked. Both are
 *  decided here from evidence the runtime collected, never from the model's own account. */

/** A bounded coding task's contract, set by whoever dispatched it. The runtime enforces it:
 *  writes outside `allowedPaths` are refused as tool results, and `acceptance.command` is what
 *  decides completion, run in the sandbox after the model's edits. */
export interface TaskContract {
  /** Workspace-relative paths, or directory prefixes ending in '/', the run may write. */
  allowedPaths?: string[]
  acceptance?: { command: string; timeoutSec?: number }
}

const toPosix = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '')

export function normaliseContract(value: unknown): TaskContract | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('contract must be an object with allowedPaths and/or acceptance')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['allowedPaths', 'acceptance'].includes(key))) throw new Error('contract accepts only allowedPaths and acceptance')
  const contract: TaskContract = {}
  if (raw.allowedPaths !== undefined) {
    if (!Array.isArray(raw.allowedPaths) || !raw.allowedPaths.length || raw.allowedPaths.length > 200 || raw.allowedPaths.some(path => typeof path !== 'string' || !path.trim() || path.length > 400 || /[\0\r\n]/.test(path))) throw new Error('contract.allowedPaths must be a non-empty list of workspace-relative paths')
    contract.allowedPaths = raw.allowedPaths.map(path => toPosix(String(path).trim()))
    if (contract.allowedPaths.some(path => path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..'))) throw new Error('contract.allowedPaths must be workspace-relative and may not climb out of the workspace')
  }
  if (raw.acceptance !== undefined) {
    if (!raw.acceptance || typeof raw.acceptance !== 'object' || Array.isArray(raw.acceptance)) throw new Error('contract.acceptance must be an object with command')
    const acceptance = raw.acceptance as Record<string, unknown>
    if (Object.keys(acceptance).some(key => !['command', 'timeoutSec'].includes(key))) throw new Error('contract.acceptance accepts only command and timeoutSec')
    if (typeof acceptance.command !== 'string' || !acceptance.command.trim() || acceptance.command.length > 2000 || /[\0\r\n]/.test(acceptance.command)) throw new Error('contract.acceptance.command must be a single shell command line')
    contract.acceptance = { command: acceptance.command.trim() }
    if (acceptance.timeoutSec !== undefined) {
      if (!Number.isInteger(acceptance.timeoutSec) || Number(acceptance.timeoutSec) < 1 || Number(acceptance.timeoutSec) > 3600) throw new Error('contract.acceptance.timeoutSec must be 1 to 3600')
      contract.acceptance.timeoutSec = Number(acceptance.timeoutSec)
    }
  }
  return Object.keys(contract).length ? contract : undefined
}

/** Whether a workspace-relative path is inside the contract's allowed set. */
export function pathAllowed(contract: TaskContract | undefined, workspaceRelative: string): boolean {
  if (!contract?.allowedPaths?.length) return true
  const path = toPosix(workspaceRelative)
  return contract.allowedPaths.some(allowed => allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed)
}

/** The constraints the task state renders for the model, from the contract. */
export function contractConstraints(contract: TaskContract | undefined): string[] {
  if (!contract) return []
  const lines: string[] = []
  if (contract.allowedPaths?.length) lines.push(`Only these paths may be changed: ${contract.allowedPaths.join(', ')}. Writes elsewhere are refused.`)
  if (contract.acceptance) lines.push(`Acceptance command (Conductor runs it after your edits and when you finish): ${contract.acceptance.command}`)
  return lines
}

/** What the runtime saw a run actually do. Hashes are of the written content, so a claimed
 *  edit can be checked against the file on disk. */
export interface RunEvidence {
  writes: Array<{ path: string; tool: string; sha256: string }>
  commands: Array<{ command: string; exitCode: number | null; ok: boolean }>
  acceptance?: AcceptanceResult
}

export const emptyEvidence = (): RunEvidence => ({ writes: [], commands: [] })

export async function recordWrite(evidence: RunEvidence, workspace: string, absolutePath: string, tool: string): Promise<void> {
  let sha256 = ''
  try { sha256 = createHash('sha256').update(await readFile(absolutePath)).digest('hex') } catch { sha256 = 'unreadable' }
  const path = toPosix(relative(workspace, absolutePath))
  const existing = evidence.writes.findIndex(entry => entry.path === path)
  if (existing >= 0) evidence.writes[existing] = { path, tool, sha256 }
  else evidence.writes.push({ path, tool, sha256 })
}

export function recordCommand(evidence: RunEvidence, command: string, exitCode: number | null, ok: boolean): void {
  evidence.commands.push({ command: command.length > 300 ? `${command.slice(0, 297)}...` : command, exitCode, ok })
  if (evidence.commands.length > 40) evidence.commands.splice(0, evidence.commands.length - 40)
}

const CLAIMS_CHANGES = /\b(I (?:have )?(?:applied|made|added|edited|updated|replaced|wrote|created|implemented|fixed|changed|modified|removed|deleted)|(?:edits?|replacements?|changes?|fix(?:es)?) (?:were|was|have been|has been|are|is) (?:applied|made|done|complete|completed|in place)|all (?:\S+ ){0,3}(?:edits|replacements|changes) (?:were |are |have been )?(?:done|applied|complete|in place)|(?:file|files) (?:has|have) been (?:written|updated|created|modified)|(?:successfully )?(?:updated|edited|modified|created|wrote) (?:the )?(?:file|files|`))/i
const CLAIMS_TESTS = /\b(tests? (?:are |is |all )?(?:now )?pass(?:es|ing|ed)?|all (?:\d+ )?tests? pass|passing|\d+\/\d+ (?:tests? )?pass|verified (?:with|by|each)|ran (?:the )?tests?|test suite (?:passes|passed|is green))\b/i
const DENIES_CHANGES = /\b(did not|didn't|could not|couldn't|cannot|can't|unable to|no changes? (?:were|was) made|nothing (?:was )?changed|not (?:yet )?(?:applied|made|done|implemented))\b/i

/** A final message that asserts edits or test results the run never performed. The verdict is
 *  what stops a fabricated report from surfacing as a completed task; the phrasing is a net,
 *  not a parser, so it only fires when the message claims and the evidence is empty. */
export function unverifiedClaim(finalText: string, evidence: RunEvidence): string | undefined {
  const text = finalText.replace(/```[\s\S]*?```/g, ' ')
  const claimsChanges = CLAIMS_CHANGES.test(text) && !DENIES_CHANGES.test(text)
  const claimsTests = CLAIMS_TESTS.test(text) && !DENIES_CHANGES.test(text)
  const ranTests = evidence.commands.some(entry => entry.ok) || evidence.acceptance !== undefined
  if (claimsChanges && !evidence.writes.length) return 'The final message reports edits, but no write, edit or apply_edits tool call ran in this turn.'
  if (claimsTests && !evidence.commands.length && !evidence.acceptance) return 'The final message reports test results, but no command ran in this turn.'
  if (claimsTests && !ranTests && evidence.commands.length && evidence.commands.every(entry => !entry.ok)) return 'The final message reports passing tests, but every command in this turn failed.'
  return undefined
}

export interface AcceptanceResult { command: string; passed: boolean; exitCode: number; report: string; at: string; where?: 'sandbox' | 'host-copy' }

/** The three conditions under which the loop asks for the final answer instead of another
 *  round: acceptance passed, only allowed paths changed, and nothing the runtime knows of is
 *  still failing. Without a contract the loop has no ground truth, so it never forces this. */
export function completionEstablished(contract: TaskContract | undefined, evidence: RunEvidence): { done: true; because: string } | { done: false; because: string } {
  if (!contract?.acceptance) return { done: false, because: 'no acceptance command was given, so completion is the model\'s to judge' }
  if (!evidence.acceptance) return { done: false, because: 'the acceptance command has not run yet' }
  if (!evidence.acceptance.passed) return { done: false, because: `acceptance failed (exit ${evidence.acceptance.exitCode})` }
  const outside = evidence.writes.filter(write => !pathAllowed(contract, write.path)).map(write => write.path)
  if (outside.length) return { done: false, because: `files outside the allowed paths were changed: ${outside.join(', ')}` }
  return { done: true, because: `acceptance passed (${evidence.acceptance.command}) and only allowed paths changed` }
}

/** What the model is told once completion is established: stop now. */
export const finalizeNow = (because: string): string => `[Conductor] The task is complete: ${because}. Do not call any more tools and do not change anything else. Give your final answer now: what you changed (by file) and what the validation showed.`
