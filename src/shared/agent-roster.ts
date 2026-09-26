import type { AgentProviderId } from './models'

/**
 * The roles Conductor's own work actually runs (owner: "agents that we're using ... in loops etc
 * and like reviewer updater etc loop improver all that we've used even swarm controller"). Each is
 * one Agent roster entry: the model, effort and permission it runs on, where its brief lives and
 * when to reach for it. Starting one from the roster opens a tab on exactly those settings and sends
 * the role's instructions (plus the owner's goal) as its first message.
 *
 * `briefs` are repository paths. A role is only seeded into a project whose folder holds the first
 * of them, so the Conductor team does not appear in every unrelated project the owner opens.
 * docs/swarm/roster.md is the same list for people.
 */
export type RosterPermission = 'auto' | 'accept-edits' | 'read-only' | 'default'

export interface RosterRole {
  name: string
  /** Stable key; the roster row is matched on it, so the owner may rename the entry. */
  role: string
  provider: AgentProviderId
  model: string
  effort?: string
  permission: RosterPermission
  briefs: string[]
  whenToUse: string
  /** Sent as the first message when the role is started, followed by the owner's goal. */
  instructions: string
  /** Runs as a Claude Code cloud session (tabs.open provider "cloud") rather than on this machine;
   *  it cannot start without a goal, since the session is created from its prompt. */
  cloud?: boolean
}

const read = (briefs: string[]): string => `Read AGENTS.md and ${briefs.map(path => '`' + path + '`').join(', ')} first and follow them.`

const role = (entry: Omit<RosterRole, 'instructions'> & { job: string }): RosterRole => {
  const { job, ...rest } = entry
  return { ...rest, instructions: `You are the ${entry.name} of this project. ${read(entry.briefs)} ${job}` }
}

export const ROSTER_ROLES: ReadonlyArray<RosterRole> = [
  role({
    name: 'Swarm orchestrator', role: 'swarm-orchestrator', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto',
    briefs: ['docs/swarm/orchestrator.md', 'docs/swarm/worker-rules.md'],
    whenToUse: 'A batch of owner items: plan it, partition files, dispatch up to four fixers, verify, ship each locally and publish once. Turn the wand on in its composer to make it the wizard controller (owner authority, approvals, restarts).',
    job: 'You coordinate; fixers implement. Keep core wiring, verification and delivery in this tab.'
  }),
  role({
    name: 'Fixer', role: 'swarm-fixer', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto',
    briefs: ['docs/swarm/worker-rules.md'],
    whenToUse: 'One bounded item group with the files it owns, usually dispatched by the orchestrator with the worker rules appended to its brief.',
    job: 'Own only the files your brief names, test first, prove the scenario in a parked run and deliver with git.ship.'
  }),
  role({
    name: 'Verifier', role: 'verifier', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto',
    briefs: ['docs/verification/verifier-brief.md', '.conductor/loops/verify.md'],
    whenToUse: 'After a batch is delivered: one tab plans, runs and judges adversarial scenarios against the owner\'s own words (verify loop v3).',
    job: 'Plan, write, run and judge in this one tab; every verdict carries its evidence path.'
  }),
  role({
    name: 'Verifier runner', role: 'verifier-runner', provider: 'claude', model: 'sonnet', effort: 'low', permission: 'auto',
    briefs: ['.conductor/loops/verify.md'],
    whenToUse: 'The verify loop\'s cheap fallback: re-run committed smokes unchanged and collect their logs when the verifier asks.',
    job: 'Re-run the named smokes unchanged through scripts/smoke-lock.mjs and collect their logs. Never write harness code and never give verdicts.'
  }),
  role({
    name: 'Architect', role: 'architect', provider: 'codex', model: 'gpt-6-astra', effort: 'high', permission: 'auto',
    briefs: ['.conductor/loops/batch-delivery.md'],
    whenToUse: 'The contract step of batch delivery and task triage: before any fixer starts, write the failing tests, the acceptance commands and the allowedPaths. Alternate: Claude opus[1m] when Codex has no allowance.',
    job: 'Write the contract only: failing tests, acceptance commands and allowedPaths, pointing at code by file:line. Do not implement.'
  }),
  role({
    name: 'Code reviewer', role: 'code-reviewer', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto',
    briefs: ['.conductor/loops/batch-delivery.md'],
    whenToUse: 'The locked review step of batch delivery: a fresh tab, never the implementer, reads the batch\'s git diff once within allowedPaths. Alternate: Codex gpt-6-astra, the brain that did not write the contract.',
    job: 'Read the git diff limited to allowedPaths once and answer approve or a specific list of changes. Change nothing yourself.'
  }),
  role({
    name: 'Approval reviewer', role: 'approval-reviewer', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'read-only',
    briefs: ['src/main/approval-review.ts', 'docs/approval-upgrade-brief.md'],
    // Read only is plan mode on Claude: it reads and searches but changes nothing, so under a wizard
    // it never asks for an approval that would cost a fresh stronger-model review (Ask would).
    whenToUse: 'Runs by itself under a wizard: each held coworker approval gets a fresh stronger-model review. Open one by hand only to re-review a held request; it runs read only (plan mode), never on Ask.',
    job: 'Review the named approval request against the exact action, its target and the owner\'s standing rules; answer approve or deny with the reason. Change nothing.'
  }),
  role({
    name: 'Updater', role: 'updater', provider: 'local', model: 'local/qwen3.6-35b-a3b', permission: 'accept-edits',
    briefs: ['.conductor/loops/update-readback.md', 'docs/conductor-local-updates.md'],
    whenToUse: 'After a batch is shipped: build the local update, read the build back, and after the wizard installs it verify the running version.',
    job: 'Call app.update once the wizard authorizes it, poll app.update.status about once a minute, and report the fixed last line (UPDATE OK / UPDATE FAILED, then VERIFIED / REGRESSION) with agents.report.'
  }),
  role({
    name: 'Loop runner', role: 'loop-runner', provider: 'claude', model: 'sonnet', effort: 'medium', permission: 'auto',
    briefs: ['docs/logic-loops.md'],
    whenToUse: 'Running a saved procedure in .conductor/loops (batch delivery, task triage, update read-back, verify) step by step.',
    job: 'Start the loop with loops.run, run each step on its stated model and effort, and loops.record every step\'s outcome.'
  }),
  role({
    name: 'Loop improver', role: 'loop-improver', provider: 'codex', model: 'gpt-6-astra', effort: 'high', permission: 'auto',
    briefs: ['docs/logic-loops.md'],
    whenToUse: 'After loop runs have metrics: find the step that costs or fails most and propose a better version of the loop.',
    job: 'Read the loops\' recorded metrics, propose one evidence-backed change with loops.propose, and apply it with loops.apply only when it is auto-safe.'
  }),
  role({
    name: 'Overseer', role: 'overseer', provider: 'claude', model: 'opus[1m]', effort: 'medium', permission: 'auto',
    briefs: ['docs/overseer.md', 'scripts/overseer.mjs'],
    whenToUse: 'An unattended fix loop over goals a unit test cannot show (a local model on a real file task, a tool-call format): the overseer script runs them, dispatches Opus fixers and rebuilds.',
    job: 'Launch scripts/overseer.mjs detached with a goal file under scripts/overseer/goals, watch its run.json, and take over when it stops.'
  }),
  role({
    name: 'Recovery agent', role: 'recovery-agent', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto',
    briefs: ['docs/recovery-mode.md'],
    whenToUse: 'Conductor failed to come back after an update or restart: the recovery watchdog calls it with the error it saw; open it by hand to diagnose a failed start.',
    job: 'Read the recovery report and logs, find why Conductor did not come back, fix it or tell the owner exactly what to do.'
  }),
  role({
    name: 'Project controller', role: 'project-controller', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'auto',
    briefs: ['docs/swarm/project-controller.md'],
    whenToUse: 'Work in another project the owner has open (a website such as haftheme): launch, test and fix it there, including on the Mac node.',
    job: 'Open that project\'s coworkers with tabs.open({projectId}), run its smokes (nodes.run for the Mac), and report back to whoever started you.'
  }),
  role({
    name: 'Autopilot controller', role: 'autopilot-controller', provider: 'codex', model: 'gpt-6-astra', effort: 'high', permission: 'auto',
    briefs: ['docs/autopilot-brief.md'],
    whenToUse: 'A long durable sweep over the whole app: audit, backlog and dispatch in priority order, resumed from its brief and backlog rather than restarted.',
    job: 'Resume from docs/autopilot-backlog.md; do not restart the sweep.'
  }),
  role({
    name: 'Local model helper', role: 'local-helper', provider: 'local', model: 'local/qwen3.5-9b', permission: 'accept-edits',
    briefs: ['docs/local-assist.md'],
    whenToUse: 'Bounded reading and churn that saves frontier tokens: summarising logs, test runs and large files (the conductor-local tools), or a scoped mechanical edit with an acceptance check.',
    job: 'Do exactly the bounded job you are given and report the result in a few lines.'
  }),
  role({
    name: 'Cloud coworker', role: 'cloud-coworker', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', permission: 'auto', cloud: true,
    briefs: ['docs/cloud-coworker.md'],
    whenToUse: 'Work that should run off this machine on the GitHub repository (a Claude Code cloud session), e.g. while the PC is busy or asleep.',
    job: 'Work on the pushed repository, keep your branch, and report what you changed.'
  })
]

export const rosterRole = (role: string): RosterRole | undefined => ROSTER_ROLES.find(entry => entry.role === role)

/** The first message a started roster entry receives: its instructions and the owner's goal. */
export function rosterStartPrompt(instructions: string, goal?: string): string {
  const text = goal?.trim()
  return `${instructions.trim()}\n\n${text ? `Goal: ${text}` : 'No goal was given yet: read your brief, then ask the owner in one short question what to work on.'}`
}

export const permissionLabel = (permission: RosterPermission): string => ({ auto: 'Auto', 'accept-edits': 'Edit', 'read-only': 'Read only', default: 'Ask' })[permission]
