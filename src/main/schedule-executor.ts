import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScheduleDefinition, ScheduleModelStep, ScheduleRun, ScheduleScript, ScheduleScriptResult } from '../shared/schedules'
import type { AgentTurnRequest, AgentTurnResult } from './schedule-agent-turn'
import type { LocalChurn } from './schedule-churn'
import { judgeScript, materializeScript, type ScriptProcessOutput, type ScriptProcessRequest } from './schedule-scripts'
import type { RunFinishData, ScheduleSourceState, ScheduleStore } from './schedule-store'

/**
 * One run of a scheduled task (docs/schedules.md):
 *
 *   1. Run the task's scripts in order. Each script's stdout is digested and compared with the
 *      last valid output of that script. `runWhen: 'changed'` scripts (tests) only run once an
 *      earlier script changed or failed.
 *   2. Nothing moved and nothing failed: the run ends. No model is asked anything.
 *   3. Something moved or failed: the local model summarizes the diff against the task's goal
 *      (churn). Without one, a deterministic diff stands in.
 *   4. When the task has a non-local assigned agent with review on, that summary — bounded — goes
 *      to it as one small request (brain). Its answer is the run's result.
 *   5. A Markdown report and a JSON record are saved as evidence. The new digests are committed
 *      last, and only when the brain step it wanted succeeded, so a failed review is retried.
 *
 * A task with no scripts is a standing question for its agent: the agent answers the goal each
 * run, bounded the same way.
 */

export interface ScheduleExecutionContext {
  schedule: ScheduleDefinition
  run: ScheduleRun
  now: Date
  signal: AbortSignal
  deadline: number
}

export interface ScheduleExecutionResult extends RunFinishData {
  outcome: 'unchanged' | 'changed' | 'dispatched' | 'skipped' | 'failed'
  detail: string
}

export type ScheduleExecutor = (context: ScheduleExecutionContext) => Promise<ScheduleExecutionResult>

export interface ScheduleExecutorDeps {
  store: Pick<ScheduleStore, 'scripts' | 'source' | 'saveSource'>
  projectPath(projectId: string): string | null
  /** Per-task working data: userData/schedule-tasks. */
  dataDirectory: string
  /** Saved evidence: userData/schedule-evidence. */
  artifactDirectory: string
  scripts: { run(request: ScriptProcessRequest): Promise<ScriptProcessOutput> }
  churn?: LocalChurn
  agentTurn?(request: AgentTurnRequest): Promise<AgentTurnResult>
  /** Why a frontier provider must not be asked right now (its allowance is nearly spent), or null. */
  allowance?(provider: string): string | null
  /** Environment every script inherits, e.g. the resolved Claude/Codex executables. */
  environment?(): Record<string, string>
  now?(): Date
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const MAX_EVIDENCE_CHARS = 24_000
const MAX_BRAIN_EVIDENCE_CHARS = 12_000
const MAX_DIFF_LINES = 120
const BRAIN_TIMEOUT_MS = 10 * 60_000
const ARTIFACTS_KEPT_PER_TASK = 100

export const CHURN_SYSTEM = 'You summarize what changed in the output of scheduled checks for the owner of a software project. Say what changed, what it means for the goal, and what, if anything, should be done. Be concrete: quote identifiers, versions, file paths and numbers exactly as they appear. At most 12 short bullet points. No preamble.'

/** JSON reads best line by line when pretty-printed; anything else is compared as printed. */
const comparable = (text: string, format: ScheduleScript['format']): string[] => {
  if (format === 'json') { try { return JSON.stringify(JSON.parse(text), null, 2).split('\n') } catch { /* compare as text */ } }
  return text.split('\n')
}

/** Lines added and removed, in order. Deterministic and cheap; not a minimal edit script. */
export function lineDiff(before: string[], after: string[], limit = MAX_DIFF_LINES): string[] {
  const remaining = new Map<string, number>()
  for (const line of before) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after) {
    const count = remaining.get(line) ?? 0
    if (count > 0) remaining.set(line, count - 1)
    else added.push(`+ ${line}`)
  }
  const kept = new Map<string, number>()
  for (const line of after) kept.set(line, (kept.get(line) ?? 0) + 1)
  const removed: string[] = []
  for (const line of before) {
    const count = kept.get(line) ?? 0
    if (count > 0) kept.set(line, count - 1)
    else removed.push(`- ${line}`)
  }
  const lines = [...removed, ...added]
  return lines.length > limit ? [...lines.slice(0, limit), `… ${lines.length - limit} more changed lines`] : lines
}

interface ScriptEvidence { script: ScheduleScript; result: ScheduleScriptResult; normalized: string; previous: string | null }

function describeEvidence(items: ScriptEvidence[], limit: number): string {
  const sections: string[] = []
  for (const { script, result, normalized, previous } of items) {
    const heading = `### ${script.name}${script.description ? ` — ${script.description}` : ''}`
    if (result.status !== 'ok') sections.push(`${heading}\nStatus: ${result.status}${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}${result.error ? `: ${result.error}` : ''}\n${result.excerpt}`)
    else if (previous === null) sections.push(`${heading}\nFirst output of this check:\n${normalized.slice(0, 6_000)}`)
    else sections.push(`${heading}\nChanged lines since the last run:\n${lineDiff(comparable(previous, script.format), comparable(normalized, script.format)).join('\n')}`)
  }
  const text = sections.join('\n\n')
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n[… evidence shortened …]`
}

const brainPrompt = (schedule: ScheduleDefinition, summary: string, evidence: string, hasScripts: boolean): string => hasScripts
  ? [
      `You are the agent assigned to the scheduled task "${schedule.name}" in this project. Its checks ran unattended and some output changed or failed.`,
      `Goal:\n${schedule.prompt || '(no goal was written; say what the change means for the project)'}`,
      `Summary of what moved:\n${summary}`,
      `Evidence (bounded):\n${evidence}`,
      'Answer from this evidence only: do not run tools, open files or browse. Report what changed, what it means for the goal, and the exact actions to take (files, names, old -> new values, commands). If nothing needs doing, say so in one line. At most 400 words.'
    ].join('\n\n')
  : [
      `You are the agent assigned to the scheduled task "${schedule.name}" in this project. It has no scripts yet, so you answer its goal directly.`,
      `Goal:\n${schedule.prompt}`,
      'Answer from what you already know and can read without changing anything. Be concrete and brief (at most 400 words). If this goal needs data only a script can gather reliably, end with one line describing the script the task should get.'
    ].join('\n\n')

function markdownReport(schedule: ScheduleDefinition, run: ScheduleRun, result: ScheduleExecutionResult, evidence: string): string {
  const lines = [`# ${schedule.name}`, '', `Run ${run.id} (${run.trigger}), started ${run.startedAt}. Outcome: **${result.outcome}**.`, '']
  if (schedule.prompt) lines.push('## Goal', '', schedule.prompt, '')
  lines.push('## Result', '', result.detail, '')
  if (result.scripts?.length) {
    lines.push('## Scripts', '', '| Script | Status | Changed | Exit | Duration |', '| --- | --- | --- | --- | --- |')
    for (const script of result.scripts) lines.push(`| ${script.name} | ${script.status} | ${script.changed ? 'yes' : 'no'} | ${script.exitCode ?? '—'} | ${(script.durationMs / 1000).toFixed(1)} s |`)
    lines.push('')
  }
  const step = (label: string, value: ScheduleModelStep | null | undefined): void => { if (value) lines.push(`- ${label}: ${value.provider} ${value.model} — ${value.ok ? 'answered' : 'did not answer'}${value.note ? ` (${value.note})` : ''}`) }
  if (result.churn || result.brain) { lines.push('## Models', ''); step('Local summary', result.churn); step('Brain request', result.brain); lines.push('') }
  if (evidence) lines.push('## Evidence', '', '```text', evidence, '```', '')
  return lines.join('\n')
}

async function pruneArtifacts(directory: string, prefix: string): Promise<void> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => name.startsWith(prefix))
  if (names.length <= ARTIFACTS_KEPT_PER_TASK) return
  const dated = await Promise.all(names.map(async name => ({ name, at: (await stat(join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })))
  for (const old of dated.sort((a, b) => b.at - a.at).slice(ARTIFACTS_KEPT_PER_TASK)) await rm(join(directory, old.name), { force: true }).catch(() => undefined)
}

export function createScheduleExecutor(deps: ScheduleExecutorDeps): ScheduleExecutor {
  return async ({ schedule, run, signal, deadline }) => {
    const cwd = deps.projectPath(schedule.projectId)
    if (!cwd) throw new Error('The project folder is not available on this machine')
    const scripts = deps.store.scripts(schedule.id)
    const taskDirectory = join(deps.dataDirectory, schedule.id)
    const stateDirectory = join(taskDirectory, 'state'), runDirectory = join(taskDirectory, 'runs', run.id)
    await mkdir(stateDirectory, { recursive: true })
    await mkdir(runDirectory, { recursive: true })
    const fetchedAt = (deps.now?.() ?? new Date()).toISOString()
    const validUntil = new Date(Date.parse(fetchedAt) + Math.max(24 * 60, schedule.everyMinutes * 2) * 60_000).toISOString()
    const results: ScheduleScriptResult[] = [], evidence: ScriptEvidence[] = [], staged: ScheduleSourceState[] = []
    let moved = false
    try {
      for (const script of scripts) {
        signal.throwIfAborted()
        if (script.runWhen === 'changed' && !moved) {
          results.push({ name: script.name, status: 'skipped', exitCode: null, durationMs: 0, outputDigest: null, changed: false, excerpt: 'Skipped: nothing earlier in this run changed.' })
          continue
        }
        const previous = deps.store.source(schedule.id, `script:${script.name}`)
        let output: ScriptProcessOutput
        try {
          const file = materializeScript(join(runDirectory, 'scripts'), script)
          output = await deps.scripts.run({
            script, file, cwd, signal,
            env: {
              ...deps.environment?.(),
              CONDUCTOR_SCHEDULE_TASK_ID: schedule.id,
              CONDUCTOR_SCHEDULE_PROJECT_DIR: cwd,
              CONDUCTOR_SCHEDULE_STATE_DIR: stateDirectory,
              CONDUCTOR_SCHEDULE_RUN_DIR: runDirectory,
              CONDUCTOR_SCHEDULE_CHANGED: moved ? '1' : '0'
            }
          })
        } catch (error) {
          output = { exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, truncated: false, error: error instanceof Error ? error.message : String(error) }
        }
        signal.throwIfAborted()
        const { result, normalized } = judgeScript(script, output, previous?.digest ?? null)
        await writeFile(join(runDirectory, `${script.name}.out`), normalized, 'utf8')
        results.push(result)
        if (result.changed) {
          moved = true
          evidence.push({ script, result, normalized, previous: result.status === 'ok' ? previous?.normalized ?? null : null })
        }
        if (result.status === 'ok') staged.push({ scheduleId: schedule.id, sourceId: `script:${script.name}`, etag: null, lastModified: null, digest: result.outputDigest ?? sha256(''), normalized, fetchedAt, validUntil })
      }

      const failed = results.filter(result => result.status !== 'ok' && result.status !== 'skipped')
      const changed = results.filter(result => result.status === 'ok' && result.changed)
      const digest = sha256(results.map(result => `${result.name}:${result.outputDigest ?? result.status}`).join('\n'))
      const commit = (): void => { for (const state of staged) deps.store.saveSource(state) }

      if (scripts.length && !moved) {
        commit()
        return { outcome: 'unchanged', detail: `${scripts.length === 1 ? 'Its script' : `All ${results.filter(result => result.status === 'ok').length} scripts`} ran and printed exactly what they printed last time. No model was asked anything.`, digest, validUntil, scripts: results }
      }

      const agent = schedule.agent
      const evidenceText = describeEvidence(evidence, MAX_EVIDENCE_CHARS)
      let summary = evidenceText, churn: ScheduleModelStep | null = null, brain: ScheduleModelStep | null = null, answer: string | null = null
      if (scripts.length && deps.churn) {
        const local = await deps.churn.summarize({ model: schedule.churnModel, system: CHURN_SYSTEM, input: `Goal: ${schedule.prompt || '(none written)'}\n\n${evidenceText}`, maxTokens: 1_200, signal, holder: `schedule:${schedule.id}` })
        churn = { provider: 'local', model: local.model ?? 'none', ok: local.ok, ...(local.ok ? (local.note ? { note: local.note } : {}) : { note: local.note }) }
        if (local.ok) summary = local.text
      }
      const remaining = deadline - Date.now() - 60_000
      const wantsBrain = Boolean(agent && deps.agentTurn && (scripts.length ? schedule.brain && agent.provider !== 'local' : true))
      if (!scripts.length && !agent) {
        return { outcome: 'skipped', detail: 'This task has no scripts and no assigned agent, so there is nothing to run. Assign an agent and ask it to write the task\'s scripts.', scripts: results }
      }
      if (wantsBrain && agent && deps.agentTurn) {
        const blocked = agent.provider === 'local' ? null : deps.allowance?.(agent.provider) ?? null
        if (blocked) brain = { provider: agent.provider, model: agent.model, ok: false, note: blocked }
        else if (remaining < 60_000) brain = { provider: agent.provider, model: agent.model, ok: false, note: 'The run had no time left for the agent before its timeout.' }
        else {
          const turn = await deps.agentTurn({
            projectId: schedule.projectId, agent, title: `Scheduled: ${schedule.name}`, signal, timeoutMs: Math.min(BRAIN_TIMEOUT_MS, remaining),
            prompt: brainPrompt(schedule, summary, describeEvidence(evidence, MAX_BRAIN_EVIDENCE_CHARS), scripts.length > 0),
            research: !scripts.length && agent.provider === 'local'
          })
          brain = { provider: agent.provider, model: agent.model, ok: turn.ok, agentSessionId: turn.agentSessionId, ...(turn.note ? { note: turn.note } : {}) }
          if (turn.ok) answer = turn.answer
        }
      }

      const headline = !scripts.length ? '' : [
        changed.length ? `Changed: ${changed.map(result => result.name).join(', ')}.` : '',
        failed.length ? `Failed: ${failed.map(result => `${result.name} (${result.status})`).join(', ')}.` : ''
      ].filter(Boolean).join(' ')
      const body = answer ?? (scripts.length ? summary : brain?.note ?? 'The agent did not answer.')
      const result: ScheduleExecutionResult = {
        outcome: !scripts.length ? (answer ? 'dispatched' : 'failed') : failed.length ? 'failed' : 'changed',
        detail: [headline, body].filter(Boolean).join('\n\n'), digest, validUntil, scripts: results, churn, brain
      }

      await mkdir(deps.artifactDirectory, { recursive: true })
      const stamp = fetchedAt.replace(/[:.]/g, '-'), prefix = `${schedule.projectId}-${schedule.id}-`
      const artifactPath = join(deps.artifactDirectory, `${prefix}${stamp}.md`)
      await writeFile(join(deps.artifactDirectory, `${prefix}${stamp}.json`), JSON.stringify({
        task: { id: schedule.id, name: schedule.name, kind: schedule.kind, prompt: schedule.prompt, agent: schedule.agent }, run: { id: run.id, trigger: run.trigger, startedAt: run.startedAt },
        outcome: result.outcome, detail: result.detail, digest, validUntil, scripts: results, churn, brain,
        outputs: evidence.map(item => ({ name: item.script.name, output: item.normalized.slice(0, 64 * 1024) }))
      }, null, 2), 'utf8')
      await writeFile(artifactPath, markdownReport(schedule, run, result, evidenceText), 'utf8')
      await pruneArtifacts(deps.artifactDirectory, prefix)
      signal.throwIfAborted()
      // A review that was wanted but did not happen is retried next run rather than forgotten.
      if (!wantsBrain || brain?.ok) commit()
      return { ...result, artifactPath }
    } finally {
      await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
