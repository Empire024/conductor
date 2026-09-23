import { createHash } from 'node:crypto'

export interface ExecutionState {
  version: 1
  taskId: string
  lifecycle: 'running' | 'recovering' | 'completed' | 'blocked' | 'failed' | 'cancelled'
  objective: string
  corrections: string[]
  observations: Array<{ id: string; tool: string; source: string; excerpt: string; rawSample?: string }>
  inputs: Array<{ path: string; fingerprint: string }>
  artifacts: Array<{ path: string; fingerprint: string }>
  hypotheses: Array<{ text: string; status: 'unverified' | 'invalidated'; reason?: string }>
  failures: Array<{ method: string; error: string; count: number }>
  budgets: { startedAt: number; rounds: number; requests: number; recoveries: number; tokens: number; checkpoints: number }
  progress: number
  segmentProgress: number
  idleSegments?: number
  nextAction: string
  pending?: { id: string; name: string; arguments: string }
  executed?: Array<{ id:string; name:string; argumentsHash:string; result:string }>
  validation?: { passed: boolean; artifact: string; issues: string[]; counts?: Record<string, number> }
}

export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex')
export const newExecutionState = (taskId: string, objective: string): ExecutionState => ({ version: 1, taskId, lifecycle: 'running', objective: objective.slice(0,6000), corrections: [], observations: [], inputs: [], artifacts: [], hypotheses: [], failures: [], budgets: { startedAt: Date.now(), rounds: 0, requests: 0, recoveries: 0, tokens: 0, checkpoints: 0 }, progress: 0, segmentProgress: 0, nextAction: 'Inspect the inputs independently; validate processing before drawing conclusions.' })

/** These are tool observations, never semantic facts inferred from arbitrary stdout. */
export function observeExecution(state: ExecutionState, call: { id: string; name: string; arguments: string }, output: string, failed: boolean): void {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(call.arguments) } catch { /* recorded as failure below */ }
  const source = typeof args.path === 'string' ? args.path : typeof args.script === 'string' ? args.script : call.name
  if (failed) {
    const error = output.replace(/\b\d{4,}\b/g, '#').slice(0,400)
    const method = `${call.name}:${source}`
    const previous = state.failures.find(f => f.method === method && f.error === error)
    if (previous) previous.count++
    else state.failures.push({ method, error, count: 1 })
    state.failures = state.failures.slice(-16)
    state.nextAction = recoveryHint(call.name, output)
    return
  }
  // Script rewrites, exit zero and fresh narration alone are not processing progress.
  if (!['read_file','search','list_files','read_output'].includes(call.name)) return
  if(source.includes('.conductor-scratch/')) return
  const id = fingerprint(`${call.name}:${source}:${output}`)
  if (state.observations.some(o=>o.id===id)) return
  state.observations.push({ id, tool: call.name, source, excerpt: output.slice(0,1600) })
  state.observations = state.observations.slice(-12)
  state.progress++
}

export function recoveryHint(name: string, error: string): string {
  if (/old_text|anchor|version|changed since/i.test(error)) return 'Read the current script and its fingerprint; construct a new exact edit from that version. Keep diagnostics in a separate script.'
  if (/ENOTDIR|not a directory/i.test(error)) return 'Search accepts a file or directory; inspect the specified path and use the returned type and workspace-relative path.'
  if (/bytes|too large|truncat/i.test(error)) return 'Inspect the file, then request a bounded line or byte range. Use local code to process the full input.'
  if (/denied|unavailable|permission/i.test(error)) return 'This capability is unavailable under the current permissions/runtime. Report the concrete blocker; do not repeat or bypass it.'
  return `Change the failed ${name} approach using the current source evidence; check a small example before rerunning the full task.`
}

export function executionSummary(state: ExecutionState): string {
  return JSON.stringify({ version: state.version, lifecycle:state.lifecycle, corrections:state.corrections, inputs:state.inputs, artifacts:state.artifacts, observations:state.observations.slice(-6).map(o=>({...o,excerpt:o.excerpt.slice(0,400)})), hypotheses:state.hypotheses, failures:state.failures.slice(-6), validation:state.validation, budgets:state.budgets, nextAction:state.nextAction })
}
