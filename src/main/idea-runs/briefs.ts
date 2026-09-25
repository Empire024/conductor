import type { IdeaDetail } from '../../shared/ideas'
import { IDEA_ACTION_TYPES, IDEA_RUN_DEFAULT_WEEKLY_CAPS, IDEA_STAGE_KINDS, type IdeaRun, type IdeaRunCheckpoint, type IdeaRunStage } from '../../shared/idea-runs'
import { BRAND_CHECK_RULE, CHECKPOINT_RULE, PROVENANCE_RULE } from './policy'

/**
 * Every prompt the run controller sends. Each starts with a one-line key ("PLAN", "STAGE <id>",
 * "OCCURRENCE <id> <n>", "DECISIONS <id>", "REMIND <id>") so a transcript reads plainly and the
 * offline fixture agents can answer each kind (docs/idea-autopilot.md, Testing).
 */

const DRY_RUN = 'DRY RUN: this is a rehearsal on harmless data. Do not create accounts, publish, message anyone, buy, order or spend, even after an approval: describe exactly what you would do and report it as done.'

export const REPORT_FORMAT = [
  'End every turn with exactly one fenced block of JSON:',
  '```idea-run-report',
  '{"status": "done" | "continue" | "blocked",',
  ' "summary": "what you did and found, 1-5 sentences",',
  ' "artifacts": [{"path": "relative/file.md" | "url": "https://...", "label": "what it is"}],',
  ' "decisions": ["a decision you made and why"],',
  ` "actions": [{"type": ${IDEA_ACTION_TYPES.map(type => `"${type}"`).join(' | ')}, "summary": "one line", "detail": "the exact post text, file, account name, recipient, order lines", "target": "site/account/URL", "amountEur": 0}],`,
  ' "spentEur": 0}',
  '```',
  '"actions" lists outward-facing or irreversible steps you want done; do not do them yourself. "done" means every done-criterion is met; "blocked" means you need the owner for something that is not an action.'
].join('\n')

const ideaBlock = (idea: Pick<IdeaDetail, 'id' | 'title' | 'text'>): string => [`Idea ${idea.id}: ${idea.title}`, '--- the owner\'s note ---', idea.text.trim(), '--- end of note ---'].join('\n')

export function planningBrief(idea: Pick<IdeaDetail, 'id' | 'title' | 'text'>, options: { dryRun: boolean; runId: string }): string {
  return [
    'PLAN',
    `You are planning an idea run (${options.runId}) for Conductor's idea autopilot. Write the plan only; do not start the work.`,
    ...(options.dryRun ? [DRY_RUN] : []),
    '',
    ideaBlock(idea),
    '',
    'Break the idea into stages that run one after another over days. For each stage give: a goal, concrete done-criteria, which agent does it (a frontier model for judgment, a cheaper one for volume; Codex computer use sparingly), a budget, and the outward action types it will need approved.',
    'Recurring work (daily posting, measuring, adjusting) is one stage with a recurrence: Conductor turns it into a logic loop fired by a scheduled task.',
    'The rules below are enforced whatever the plan says:',
    `- ${PROVENANCE_RULE}`,
    `- ${BRAND_CHECK_RULE}`,
    `- ${CHECKPOINT_RULE}`,
    `- Weekly usage caps: Claude ${IDEA_RUN_DEFAULT_WEEKLY_CAPS.claude}%, Codex ${IDEA_RUN_DEFAULT_WEEKLY_CAPS.codex}% at most; the run pauses at a cap.`,
    '',
    'Answer with one fenced block of JSON:',
    '```idea-run-plan',
    '{"summary": "the plan in 2-4 sentences",',
    ' "stages": [{"id": "research", "title": "...", "kind": ' + IDEA_STAGE_KINDS.map(kind => `"${kind}"`).join(' | ') + ',',
    '   "goal": "...", "doneCriteria": ["..."], "agent": {"provider": "claude" | "codex" | "local", "model": "opus[1m]", "effort": "high"},',
    '   "budget": {"maxMinutes": 60, "maxTurns": 6, "maxEur": 0}, "checkpoints": ["publish"], "generatesMedia": false,',
    '   "recurrence": {"everyMinutes": 1440, "times": 3, "loop": {"title": "...", "steps": [{"id": "post", "role": "publisher", "model": "claude:sonnet", "done": "..."}]}}}],',
    ' "weeklyCaps": {"claude": 85, "codex": 95},',
    ' "rules": ["any extra rule for this idea"]}',
    '```',
    'Omit "recurrence" on stages that run once.'
  ].join('\n')
}

const stageHeader = (run: IdeaRun, stage: IdeaRunStage): string[] => [
  `Idea run ${run.id}, stage ${stage.index + 1} of ${run.stages.length}: ${stage.title} (${stage.kind}).`,
  ...(run.dryRun ? [DRY_RUN] : []),
  `Goal: ${stage.goal}`,
  'Done when:', ...stage.doneCriteria.map(item => `- ${item}`),
  `Budget: ${stage.budget.maxMinutes} minutes, ${stage.budget.maxTurns} turns, €${stage.budget.maxEur.toFixed(2)}.`,
  'Rules:', ...(run.plan?.rules ?? [PROVENANCE_RULE, BRAND_CHECK_RULE, CHECKPOINT_RULE]).map(rule => `- ${rule}`),
  ...(stage.generatesMedia ? ['This stage makes media: keep every AI label and all metadata on it; name the tool and model that made each file.'] : [])
]

const previous = (run: IdeaRun, stage: IdeaRunStage): string[] => {
  const done = run.stages.filter(entry => entry.index < stage.index && entry.summary)
  return done.length ? ['Earlier stages:', ...done.map(entry => `- ${entry.title}: ${entry.summary}`)] : []
}

export function stageBrief(run: IdeaRun, stage: IdeaRunStage, idea: Pick<IdeaDetail, 'id' | 'title' | 'text'>): string {
  return [`STAGE ${stage.id}`, ...stageHeader(run, stage), '', ...previous(run, stage), '', ideaBlock(idea), '', REPORT_FORMAT].join('\n')
}

export function occurrenceBrief(run: IdeaRun, stage: IdeaRunStage, loop: { id: string; version: number; steps: Array<{ id: string; role: string; model?: string; done?: string }> }, occurrence: number): string {
  return [
    `OCCURRENCE ${stage.id} ${occurrence}`,
    ...stageHeader(run, stage),
    '',
    `This is occurrence ${occurrence} of ${stage.recurrence?.times ?? 1}, fired by the scheduled task. Run logic loop ${loop.id} (version ${loop.version}), step by step:`,
    ...loop.steps.map(step => `- ${step.id} (${step.role}${step.model ? `, ${step.model}` : ''})${step.done ? `: done when ${step.done}` : ''}`),
    'In your report add "loop": {"steps": [{"id": "<step>", "outcome": "ok" | "failed" | "skipped", "note": "..."}], "adjust": {"stepId": "<step>", "model": "provider:model", "reason": "why the next occurrence should use it"}}. "adjust" is optional: use it when a step would go better with another model or effort.',
    '',
    REPORT_FORMAT
  ].join('\n')
}

export function decisionsBrief(run: IdeaRun, stage: IdeaRunStage, decided: IdeaRunCheckpoint[]): string {
  const lines = decided.map(checkpoint => checkpoint.status === 'approved'
    ? `- APPROVED ${checkpoint.action.type}: ${checkpoint.action.summary}. ${run.dryRun ? 'Dry run: do not perform it; describe what you would do.' : 'Do exactly this and nothing more:'}\n  ${checkpoint.action.detail.replace(/\n/g, '\n  ')}`
    : `- DENIED ${checkpoint.action.type}: ${checkpoint.action.summary}.${checkpoint.note ? ` ${checkpoint.note}` : ''} Do not do it; continue without it or propose something else.`)
  return [`DECISIONS ${stage.id}`, `The owner answered your checkpoints for stage "${stage.title}" of idea run ${run.id}:`, ...lines, '', 'Carry on with the stage and report again.', '', REPORT_FORMAT].join('\n')
}

export function reminderBrief(stage: IdeaRunStage, reason: 'no-report' | 'continue' | 'interrupted'): string {
  const why = reason === 'no-report' ? 'Your last turn ended without an ```idea-run-report block.' : reason === 'interrupted' ? 'Your last turn was interrupted before it reported (Conductor may have restarted).' : 'You reported "continue".'
  return [`REMIND ${stage.id}`, `${why} Carry on with stage "${stage.title}" and end with the report block.`, '', REPORT_FORMAT].join('\n')
}

export function planReminderBrief(): string {
  return ['PLAN', 'Your answer had no valid ```idea-run-plan block. Answer again with only that block of JSON, in the format given before.'].join('\n')
}
