import type { IdeaStageRecurrence } from '../../shared/idea-runs'

/** A logic-loop id for a recurring stage: `idea-<stage>-<run suffix>`, within the loop id rules. */
export function loopIdFor(runId: string, stageId: string): string {
  const suffix = runId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-7) || 'run'
  return `idea-${stageId}`.slice(0, 60).replace(/-+$/, '') + `-${suffix}`
}

/** A value the loop front-matter parser keeps as one plain string. */
const quoted = (value: string): string => `"${value.replace(/["'#\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()}"`

/**
 * The .conductor/loops/<id>.md file for a recurring stage (docs/logic-loops.md). Its budget is
 * locked to the run's weekly caps, and the steps come from the approved plan; agents may later
 * change a step's model or effort through loops.propose/apply, which bumps the version.
 */
export function loopFileFor(input: {
  loopId: string; scheduleId: string; runId: string; ideaTitle: string; stageId: string; stageTitle: string
  recurrence: IdeaStageRecurrence; caps: { claude: number; codex: number }
}): string {
  const lines = [
    '---',
    `id: ${input.loopId}`,
    'version: 1',
    `title: ${quoted(input.recurrence.loop.title)}`,
    `trigger: [schedule:${input.scheduleId}]`,
    'inputs: [runId, stageId, occurrence]',
    'budget:',
    `  claudeWeeklyMax: ${input.caps.claude}`,
    `  codexWeeklyMax: ${input.caps.codex}`,
    'steps:',
    ...input.recurrence.loop.steps.flatMap(step => [
      `  - id: ${step.id}`,
      `    role: ${quoted(step.role)}`,
      `    model: ${quoted(step.model)}`,
      ...(step.done ? [`    done: ${quoted(step.done)}`] : [])
    ]),
    'locked: [budget]',
    '---',
    '',
    `# ${input.recurrence.loop.title.replace(/[\r\n]+/g, ' ')}`,
    '',
    `Created by idea run ${input.runId} for stage "${input.stageTitle}" (${input.stageId}) of the idea "${input.ideaTitle.replace(/[\r\n]+/g, ' ')}".`,
    `The idea autopilot's scheduled task fires it every ${input.recurrence.everyMinutes} minutes, ${input.recurrence.times} times (docs/idea-autopilot.md).`,
    'Each occurrence runs every step in order; the stage agent reports each step\'s outcome, and may propose a model or effort change for a step.',
    '',
    '## Run log',
    ''
  ]
  return lines.join('\n')
}

/**
 * The same loop file with one step's model and/or effort changed: an auto-safe change under the
 * loop rules (classifyLoopChange), so loops.apply takes it without the owner. Throws when the
 * step is not in the file.
 */
export function adjustLoopFile(content: string, stepId: string, change: { model?: string; effort?: string }): string {
  const eol = /\r\n/.test(content) ? '\r\n' : '\n'
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim() === `- id: ${stepId}` && line.startsWith('  - '))
  if (start < 0) throw new Error(`The loop has no step ${stepId}`)
  let end = start + 1
  while (end < lines.length && lines[end]!.startsWith('    ')) end++
  const block = lines.slice(start + 1, end)
  const set = (key: 'model' | 'effort', value: string | undefined): void => {
    if (!value) return
    const at = block.findIndex(line => line.trimStart().startsWith(`${key}:`))
    const line = `    ${key}: ${quoted(value)}`
    if (at >= 0) block[at] = line; else block.push(line)
  }
  set('model', change.model)
  set('effort', change.effort)
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n').replace(/\n/g, eol)
}
