import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { AgentControlLink, AgentControlScope, AgentControlTab, AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import { conductorUri } from '../shared/agent-control'
import { hasSessionWork } from './close-confirmation'
import { agentConfirmFailure } from './agent-confirm-broker'
import type { AgentConfirmOutcome } from '../shared/agent-confirm'
import { isMemoryKind, MEMORY_KINDS, makeId, type AgentProviderInfo, type AgentSpec, type AppUpdateState, type LayoutNode, type PaneKind, type PaneTab, type ProjectRecord } from '../shared/models'
import type { PromptOrigin, SessionProjection, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import { isSessionPermission, MAX_PROMPT_CHARS, settingsForRuntime, wizardActive } from '../shared/structured-agent'
import { rememberedPermission } from './app-settings'
import type { CreateOrchestrationTaskInput, SaveRoutineInput, UpdateOrchestrationTaskInput } from '../shared/orchestration'
import type { ConductorDatabase } from './database'
import type { StructuredSessions } from './structured-sessions'
import type { OrchestrationStore } from './orchestration-store'
import type { AgentCollaborationStore } from './agent-collaboration-store'
import type { ProjectBacklogs } from './project-backlog'
import { PROJECT_TASK_MAX_LENGTH, projectTaskPriorities, type ProjectTaskPriority } from '../shared/project-backlog'
import { workspacePath } from './agent-artifacts'
import { writeEditorFile } from './editor-files'
import { readTextFile } from './text-files'
import { invalidateProjectFiles, searchProjectFiles } from './project-file-search'
import { inheritMachineId, machineRunsProject, tabMachineId } from './machines'
import type { LocalUpdateBuildService } from './local-update-build'
import type { DeliveryRequester, DeliveryRun, RepositoryStatus } from '../shared/delivery'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID, type MachineDescriptor } from '../shared/remote-control'
import { createApprovalRouting } from './approval-review-routing'
import { localStopOf } from '../shared/local-stop.ts'
import { summarizeContext } from '../shared/usage-accounting'
import { normaliseContract } from './local-models/completion.ts'
import { DEFAULT_DURABLE_JOB_BUDGETS, DURABLE_JOB_STATUSES, type CreateDurableJobInput, type DurableJobsService, type DurableJobStatus, type DurableJobSummary } from '../shared/durable-jobs'

type Args = Record<string, unknown>
const restricted = (settings?: SessionSettings): boolean => settings?.permission === 'read-only' || settings?.sandbox === 'read-only' || settings?.plan === true
const permissionOrder: SessionSettings['permission'][] = ['read-only', 'default', 'accept-edits', 'auto']
/** A controlled tab inherits its controller autonomy, never more, and only what the target provider
 *  offers. `requested` names a different starting point than the controller's own permission — an
 *  explicit ask or the owner's remembered mode for the target provider — but it is still clamped to
 *  the controller's ceiling and to what the provider actually advertises; omitted, behavior is
 *  unchanged from before requested existed (inherit the controller's own permission outright). */
const inheritedPermission = (source: SessionSettings, supported?: SessionSettings['permission'][], requested?: SessionSettings['permission']): SessionSettings['permission'] => {
  const ceiling = restricted(source) ? 'read-only' : source.permission
  const desired = requested ?? source.permission
  const cap = permissionOrder.indexOf(desired) <= permissionOrder.indexOf(ceiling) ? desired : ceiling
  const offered = supported?.length ? supported : permissionOrder
  const allowed = offered.filter(value => permissionOrder.indexOf(value) <= permissionOrder.indexOf(cap))
  return allowed.sort((a, b) => permissionOrder.indexOf(b) - permissionOrder.indexOf(a))[0] ?? 'default'
}
/** What a dispatched coworker opens on. A native coworker (Claude, Codex) runs on Auto, the
 *  highest mode its provider offers: a worker that has to ask for every command is one the owner
 *  babysits instead of the controller, which defeats dispatching it. Two things keep the lower
 *  modes: a controller that is itself read-only or planning cannot hand out more than it has, and
 *  a caller that says the worker cannot be trusted at all (`exactPermission`) keeps the mode it
 *  named or the owner's remembered one. A local model has no Auto and stays on its own rules. */
const dispatchPermission = (source: SessionSettings, supported: SessionSettings['permission'][] | undefined, provider: StructuredProvider, requested: SessionSettings['permission'] | undefined, exact: boolean): SessionSettings['permission'] => {
  if (exact || provider === 'local' || restricted(source)) return inheritedPermission(source, supported, requested)
  return inheritedPermission({ ...source, permission: 'auto' }, supported, 'auto')
}
const text = (args: Args, key: string, maximum = 20000): string => {
  const value = args[key]
  if (typeof value === 'string' && value.length > maximum) throw new Error(`The ${key} is ${value.length.toLocaleString('en-US')} characters; the limit is ${maximum.toLocaleString('en-US')}.`)
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`Invalid ${key}`)
  return value
}
const object = (value: unknown): Args => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Args
}
/** The sections docs/token-thrift-policy.md requires of a bounded handoff, in the order it
 *  states them. A receiver that opens on a handoff has no other context, so a missing section is
 *  refused by name rather than half-understood: "Owned files" absent is a worker about to edit
 *  another coworker's area, and "Verified findings" absent is one about to re-derive them. */
const handoffSections = ['Objective', 'Constraints', 'Owned files', 'Verified findings', 'Remaining work', 'Artifact references'] as const
const HANDOFF_MINIMUM = 200, HANDOFF_MAXIMUM = 12000

/** A heading is a line that is only that heading, however the model chose to mark it up: bare,
 *  as a Markdown heading, bolded, or with a trailing colon. A sentence that happens to mention
 *  "Remaining work" is prose, not a section, and must not satisfy the check. */
const handoffHeading = (line: string): string =>
  line.trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/:$/, '').trim().toLowerCase()

/** Validates the text of a handoff and returns it. Order is part of the format, so each heading
 *  is looked for only after the one before it: sections out of order read as a different document
 *  and are the same mistake as a missing one. */
function handoffText(args: Args): string {
  const value = args.handoff
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('agents.handoff requires handoff: the bounded handoff text described in docs/token-thrift-policy.md')
  const handoff = value.trim()
  if (handoff.length < HANDOFF_MINIMUM || handoff.length > HANDOFF_MAXIMUM) throw new Error(`A handoff is between ${HANDOFF_MINIMUM} and ${HANDOFF_MAXIMUM} characters; this one is ${handoff.length}. Summarize the remaining work and reference long output by repository path instead of pasting it.`)
  const lines = handoff.split(/\r?\n/).map(handoffHeading)
  let cursor = 0
  for (const heading of handoffSections) {
    const found = lines.indexOf(heading.toLowerCase(), cursor)
    if (found < 0) throw new Error(`The handoff has no “${heading}” section on its own line${cursor ? ' after “' + handoffSections[handoffSections.indexOf(heading) - 1] + '”' : ''}. Use the six sections from docs/token-thrift-policy.md in order: ${handoffSections.join(', ')}.`)
    cursor = found + 1
  }
  return handoff
}

const toolSignatures = {
  'tools.list': '() — discover these methods and arguments',
  'app.state': '() — current project, workspace, tabs, relationships, the machine each tab runs on, and the other projects open in this Conductor',
  'projects.list': '() — every project open in this Conductor with its workspaces; a sibling project accepts projectId on tabs.list/tabs.open, files.list/read/open, tasks.list and router.dispatch tasks, and on tabs.focus/rename/split/detach/close for an agent tab this caller controls there',
  'machines.list': '() — this machine and the paired machines that can run a tab, with the projects each one accepts',
  'models.list': '() — available providers and model-specific effort choices; discovered runtime models take precedence',
  'tabs.list': '({projectId?,workspaceId?}) — open tabs in this workspace, including detached windows, or in a sibling project from projects.list',
  'tabs.open': '({kind?,provider?,model?,effort?,permission?,exactPermission?,title?,machineId?,projectId?,workspaceId?,repository?,research?,contract?,jobId?}) — visible tab; agent default kind, provider/model must be available; a Claude, Codex or Grok coworker opens on Auto (the highest mode the provider offers) unless the controller is itself read-only or planning; only with exactPermission: true — for an agent that cannot be trusted at all — does it open on permission if given, else the owner’s remembered mode for that provider, else the controller’s own mode, clamped to the controller’s autonomy and to what the provider offers; a local model has no Auto and opens on accept-edits or read-only as before; runs on the controller machine unless machineId names another from machines.list; projectId hands work to a sibling project from projects.list, and only the controller that opened such a tab may steer it; repository/research open a provider-local tab with its repository-writes and deep-research grants already on, under the agents.grant rules; contract ({allowedPaths?:string[],acceptance?:{command,timeoutSec?}}) opens a provider-local tab as a bounded coding task: the runtime refuses writes outside allowedPaths, runs the acceptance command itself after edits, and when it passes with only allowed paths changed tells the model to finish; kind "job" with jobId (from jobs.list) opens the view of that durable job in this workspace, and asking again focuses the open one',
  'tabs.focus': '({tabId,projectId?,workspaceId?}) — any tab of this workspace, or an agent tab this caller controls in a sibling project (agents.list controlled:true); the same holds for rename, split, detach and close',
  'tabs.rename': '({tabId,title,projectId?,workspaceId?})',
  'tabs.split': '({tabId,direction:"horizontal"|"vertical",projectId?,workspaceId?})',
  'tabs.detach': '({tabId,projectId?,workspaceId?})',
  'tabs.close': '({tabId,projectId?,workspaceId?}) — closes settled agent tabs with history retained; other tabs and active work require owner confirmation; never closes the caller or its ancestors; a coworker this caller controls in a sibling project closes under the same rule and its control link is released',
  'agents.list': '() — visible native sessions with observedAt, workspace/tab IDs, phase and lastActivityAt, including tabs this caller controls in a sibling project (controlled:true) and sibling-project tabs nobody controls (controlled:false); an uncontrolled one may be read with agents.snapshot/status/history and steered with submit/steer/interrupt, and submit/steer take control of it; a controlled one answers every agents.* and tabs.* method as a coworker in this workspace does',
  'agents.snapshot': '({agentSessionId}) — agentSessionId is required and must be one listed by agents.list; observed native state, pending/running tools and recent output/results; refresh to verify older briefing intents',
  'agents.history': '({agentSessionId,afterSequence?}) — incremental native events',
  'agents.artifact': '({agentSessionId,artifactId}) — the full text of a tool output the history only carries a tail of (the outputArtifactId on a tool event), up to 2 MiB',
  'agents.status': '({agentSessionId}) — the compact supervision view of one visible conversation: phase, model, last stop reason with its figures (rounds used of the hard cap, context used / capacity / reserve, compactions, loop warnings, acceptance result, files changed), last tool and its status, and the durable task state a local worker keeps. A few hundred bytes; use it instead of agents.snapshot to poll a local worker',
  'agents.compact': '({agentSessionId}) — fold an idle local-model coworker’s transcript into its durable task state (task, constraints, files changed, recent commands, current failure, remaining work) inside the same conversation, so its next turn starts from compact state without a new tab; only a coworker this caller controls, only between turns; returns the tokens recovered',
  'agents.configure': '({agentSessionId,model,effort?}) — while the controlled coworker is idle with no queued input, persist an exact models.list model/effort for its next turn and update its visible tab; provider and permissions never change',
  'agents.grant': '({agentSessionId,repository?,research?}) — switch a local-model coworker’s per-conversation grants: repository (the sandbox may commit and branch, and a plain git push runs for it on the host) and research (web_search plus a larger tool-round budget). These are the conversation’s durable settings, the same toggles as its composer, so its own buttons show the change and it applies from its next turn. Only a non-local coworker may grant, only to a provider-local tab it already controls on this machine, never to itself or an ancestor; an omitted field is left alone, false revokes; returns what is now on and off',
  'agents.submit': '({agentSessionId,prompt}) — dispatch to a visible native tab with its existing permission settings',
  'agents.steer': '({agentSessionId,prompt}) — what the user composer does with a message: while a turn is running (or waiting on an approval or a question) it steers the message into that turn where the provider can, else queues it behind the turn; while the conversation is idle, finished, failed, disconnected or interrupted it starts a turn with it exactly as agents.submit does (one turn, same settings, same control link); while a turn is still stopping it is refused, so send it again once it has stopped. The result says which: delivery "started" for a new turn, "queued" for a message steered into or queued behind the running one',
  'agents.interrupt': '({agentSessionId}) — stops the running turn, including one waiting on an approval; queued messages stay held above its composer, as after the owner’s Stop. Interrupting does not take control, here or in a sibling project',
  'agents.resume': '({agentSessionId}) — reconnect an idle/disconnected native conversation with its existing settings; outside this workspace only a coworker this caller controls',
  'agents.fork': '({agentSessionId,title?}) — fork supported idle native history into a visible linked tab, opened in the workspace that holds the original; outside this workspace only a coworker this caller controls',
  'agents.release': '({agentSessionId}) — release this controller relationship, wherever the coworker lives',
  'agents.handoff': `({handoff,title?}) — hand your own remaining work to a fresh tab when this conversation's context has grown expensive. Takes no agentSessionId: it always hands off the caller. handoff is ${HANDOFF_MINIMUM}-${HANDOFF_MAXIMUM} characters holding the six sections of docs/token-thrift-policy.md on their own lines, in order (${handoffSections.join(', ')}); reference long output by repository path rather than pasting it. The new tab opens in this workspace with your provider, model, effort and mode, and receives the handoff as its first prompt. Your tab stays open and steerable: finish the step you are in, report it, and stop`,
  'files.list': '({query?,projectId?}) — indexed project search, at most 100 matches with stable URIs',
  'files.read': '({path,projectId?}) — UTF-8 text up to 1 MiB; projectId reads a sibling project from projects.list',
  'files.write': '({path,content,expectedContent}) — atomic compare-and-save in this project only; expectedContent:null creates a file; live views refresh. To change a sibling project, open a tab there with tabs.open({projectId}) and dispatch the work to it',
  'files.open': '({path,projectId?}) — open the file in a visible editor',
  'tasks.list': '({projectId?}) — feature-list.md bug/feature/idea tasks, their recorded owners and revision',
  'tasks.update': '({revision,id,status?:"todo"|"doing"|"done",title?,priority?:"high"|"normal"|"low"}) — optimistic update preserving markers and other agents’ claims; quote the revision from the tasks.list you just read',
  'memory.recall': '({query?})',
  'memory.remember': `({gist,kind?:${MEMORY_KINDS.map(kind => JSON.stringify(kind)).join('|')},cues?:string[]}) — writes agent-owned memory`,
  'memory.forget': '({id}) — agent-owned memory only; asks the owner to confirm',
  'orchestration.snapshot': '()',
  'orchestration.tasks.create': '({title,description?,priority?,status?,assignedAgentId?})',
  'orchestration.tasks.update': '({id,title?,description?,priority?,status?,assignedAgentId?})',
  'orchestration.routines.save': '({id?,name,description?,steps:[{title,instructions?,assignedAgentId?}]})',
  'workspace.rename': '({title})',
  'app.update': '() — build this Conductor checkout and publish it to the installed app’s local update feed, the same work as `npm run update:local`; returns at once, so poll app.update.status. The owner confirms each build, unless a non-local coworker has pre-authorized this conversation with app.update.authorize. No installer is ever run: the app offers “Update pending” and the owner accepts it',
  'app.update.status': '() — state, version, log tail and result of the local update build',
  'git.status': '() — branch, ahead/behind, head and changed files of this project’s repository, and whether a release workflow is verified after a push',
  'git.ship': '({message,paths?,publish?,waitSeconds?}) — deliver finished work in one call. Conductor runs it on the host with the owner’s own Git credentials and network: tests, build, then a local commit (only paths if given, verified in an isolated copy when other work is also in the tree); nothing is pushed and no release is built. Only publish: true — for the owner, a wizard tab or a controller publishing a finished batch, never a dispatched coworker — also pushes, starts the release workflow and checks the release’s assets. Never escalate your sandbox for git/gh or run these steps yourself. Returns the run; waitSeconds (max 100) blocks until it settles or that time passes, then keep polling git.ship.status',
  'git.ship.status': '({runId?,waitSeconds?}) — the running or latest delivery of this project: each stage with its log tail, commit, release tag and error; waitSeconds (max 100) long-polls until the run settles',
  'usage.limits': '({provider?}) — zero-turn read of the newest account allowance each provider reported: per provider and bucket (Claude five_hour, seven_day and model windows such as Fable weekly; Codex primary/secondary per limit bucket with its credits), usedPercent, resetsAt, windowMinutes, observedAt with its age and the conversation that reported it. A window whose resetsAt has passed says state "reset" (its current use is unknown until the provider reports again); a provider that reported nothing, or does not report an allowance at all (Grok), says status "unknown" and why. Figures are the provider’s own; nothing is estimated',
  'app.update.authorize': '({agentSessionId,allowed?}) — let another visible conversation (typically a local model) run app.update without the owner dialog; only a non-local coworker may grant it, never to itself, and allowed:false revokes',
  'router.start': '({prompt,provider?,model?}) — create/reuse the project router definition, open its tab, dispatch the requested task',
  'router.dispatch': '({tasks:[{title,prompt,provider?,model?,effort?,permission?,exactPermission?,projectTaskIds?:string[],projectId?,workspaceId?,repository?,research?,contract?}]}) - one to four visible coworkers with actual models/efforts; a native coworker opens on Auto, exactly as tabs.open does, and exactPermission: true keeps a lower mode for an agent that cannot be trusted at all; exact optional projectTaskIds transfer controller-owned or to-do claims after prompt acceptance, and cannot be combined with projectId because a claim belongs to the project that owns it; repository/research open a provider-local worker with its grants already on, as tabs.open does; a worker whose prompt was refused before any turn has its tab closed and its task dropped (tabClosed: true, with the error)'
} as const

/** The methods a caller may point at another project the owner has open in this window. Writes
 *  stay out: a change to a sibling project is made by a tab that lives there and shows its work. */
const crossProjectMethods: string[] = ['tabs.list', 'tabs.open', 'tabs.focus', 'tabs.rename', 'tabs.split', 'tabs.detach', 'tabs.close', 'files.list', 'files.read', 'files.open', 'tasks.list']

export interface DeliveryControl {
  status(projectId: string, cwd: string): Promise<RepositoryStatus>
  current(projectId: string): DeliveryRun | null
  ship(projectId: string, cwd: string, request: { message: string; paths?: string[]; publish?: boolean }, requestedBy: DeliveryRequester): DeliveryRun
  wait(projectId: string, runId: string, timeoutMs: number): Promise<DeliveryRun>
}

/** What the owner credential may do to the app itself: register a folder as a project, drive the
 *  updater, and relaunch. Absent where the process is not the app (tests, the CLI). */
export interface AgentControlHost {
  version: string
  pid: number
  openProject?(path: string, name?: string): Promise<ProjectRecord>
  updates?: { state(): AppUpdateState; check(): Promise<AppUpdateState>; download(): Promise<AppUpdateState>; install(force: boolean): Promise<void> }
  relaunch(force: boolean): Promise<void>
}

/** The agentSessionId an owner-credential call carries. No conversation has this id. */
export const OWNER_AGENT_ID = 'owner'

const ownerSignatures: Record<string, string> = {
  'projects.open': '({path,name?}) — owner credential or wizard tab only: register an existing folder as a project (idempotent) and return it with its workspaces',
  'app.update.check': '() — owner credential or wizard tab only: check the release and local update feeds now and return the update state (phase idle, checking, available, downloading, ready, installing, error or disabled)',
  'app.update.download': '() — owner credential or wizard tab only: download the pending update; poll app.update.check until phase is ready',
  'app.update.install': '({force?}) — owner credential or wizard tab only: quit, install the downloaded update and relaunch; force skips the running-work confirmation and keeps unsaved editor drafts for recovery. A wizard tab is brought back afterwards and told to continue; an outside process waits for a new control-owner.json',
  'app.restart': '({force?}) — owner credential or wizard tab only: relaunch this Conductor (a downloaded update installs on the way out); force as above'
}
const ownerMethods = new Set(Object.keys(ownerSignatures))
/** The owner's authority, from either source: the credential file, or a wizard conversation. */
const sovereign = (scope: AgentControlScope): boolean => scope.owner === true || scope.wizard === true

/** Durable overnight jobs on a local model (docs/durable-jobs.md). Listed only where the job
 *  controller is running. Reading is open to the whole project; changing a job is the owner's,
 *  a wizard tab's, or the conversation that created it. */
const jobSignatures: Record<string, string> = {
  'jobs.create': '({objective,model,title?,constraints?:string[],stages?:[{title,objective,completionCriteria:string[]}],budgets?,isolateWorktree?}) — start a durable job in this project that runs overnight on a local model: model must be a local entry of models.list, and a job never switches to a cloud model on its own. The owner credential, a wizard tab or a non-local, writable conversation may create one; a sandboxed local model may not. Returns the job summary; follow it with jobs.status or jobs.events',
  'jobs.list': '({status?:string[]}) — durable jobs of this project: status, current stage and attempt, elapsed and active time, last checkpoint, last event and counters',
  'jobs.status': '({jobId}) — the compact summary of one job; poll this rather than jobs.events',
  'jobs.events': '({jobId,afterId?,limit?}) — the job’s event stream (transitions, stages, checkpoints, retries, recoveries, server restarts, approvals), oldest first, at most 200 per call; pass the last id as afterId to continue',
  'jobs.pause': '({jobId,reason?}) — the owner, a wizard tab, or the conversation that created the job; interrupts the running stage at once (there is no safe point to wait for), records a tool call it cut off as an unknown side effect that is never replayed, and starts nothing new; the interrupted attempt is not charged, and resume starts the stage again in a fresh conversation',
  'jobs.resume': '({jobId}) — resume a paused or blocked job on its own local model, under the same rule as jobs.pause',
  'jobs.cancel': '({jobId,reason?}) — stop the job for good under the same rule as jobs.pause; its worktree, checkpoints and logs stay for inspection',
  'jobs.report': '({jobId}) — write report.json and report.md into the job’s log directory and return the report (results, files, tests, checkpoints, recoveries, remaining work, models by stage, log paths) with reportPath; open to anyone in the project'
}
const jobMethods = new Set(Object.keys(jobSignatures))
const jobKeys: Record<string, string[]> = {
  'jobs.create': ['objective', 'model', 'title', 'constraints', 'stages', 'budgets', 'isolateWorktree'],
  'jobs.list': ['status'],
  'jobs.status': ['jobId'],
  'jobs.events': ['jobId', 'afterId', 'limit'],
  'jobs.pause': ['jobId', 'reason'],
  'jobs.resume': ['jobId'],
  'jobs.cancel': ['jobId', 'reason'],
  'jobs.report': ['jobId']
}
const strings = (value: unknown, key: string, count: number, length: number): string[] => {
  if (!Array.isArray(value) || value.length > count || value.some(item => typeof item !== 'string' || !item.trim() || item.length > length || item.includes('\0'))) throw new Error(`${key} must be a list of at most ${count} non-empty strings of up to ${length} characters`)
  return value as string[]
}

export interface AgentControlDependencies {
  database: ConductorDatabase
  /** The app process itself, for the owner credential; absent outside the app. */
  host?: AgentControlHost
  sessions: StructuredSessions
  orchestration: OrchestrationStore
  collaboration: AgentCollaborationStore
  backlogs: ProjectBacklogs
  /** Builds and publishes a local app update on the host; absent where that is not available. */
  localUpdates?: LocalUpdateBuildService
  /** Host-side test, build, commit, push and release verification; absent where unavailable. */
  delivery?: DeliveryControl
  /** Durable overnight local-model jobs; absent until the job controller is constructed. The
   *  app plugs it in with AgentControl.setDurableJobs, so construction order does not matter. */
  durableJobs?: DurableJobsService
  /** Whether a local model could start its server now; absent where the local runtime is not wired. */
  localModels?: { availability(modelId: string): Promise<{ available: boolean; reason?: string; note?: string }> }
  providers(): AgentProviderInfo[]
  /** This machine plus any paired machines a tab may be placed on. */
  machines?(): MachineDescriptor[]
  /** Opens the tab on a paired machine and returns what it created there. */
  openRemote?(machineId: string, request: { projectId: string; sessionId: string; provider?: string; model?: string; effort?: string; title?: string }): Promise<{ tabId: string; agentSessionId?: string; machineName: string }>
  ui(request: AgentControlUiRequest): Promise<unknown>
  /** `true`/`false` are the owner's answer; the other outcomes say why no answer came. */
  confirm(scope: AgentControlScope, message: string): Promise<boolean | AgentConfirmOutcome>
  fileChanged(change: AgentFileChange): void
  linksChanged?(scope: { projectId: string; sessionId: string }): void
}

/** A facade over the app's native state. Callers cannot supply or change their authority. */
export class AgentControl {
  constructor(private readonly deps: AgentControlDependencies) {
    deps.sessions.setApprovalReviewRouting(createApprovalRouting(deps, {
      controller: id => this.linkFor(id)?.controllerAgentSessionId,
      localAndOpen: spec => {
        const tab = this.tabs({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id }).find(tab => tab.resourceId === spec.id)
        return Boolean(tab && !tab.state?.remotePeerId && tabMachineId(tab) === LOCAL_MACHINE_ID)
      },
      discoveredOpus: spec => {
        const entry = this.catalog({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id }).find(provider => provider.provider === 'claude' && provider.available && provider.source === 'runtime')
        return entry?.models.find(model => model.id === 'opus[1m]')?.id ?? entry?.models.find(model => model.id === 'opus')?.id
      },
      open: async (spec, model) => (await this.open({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id }, { provider: 'claude', model, title: 'Stronger approval review', permission: 'default', focus: false }, true)).resourceId!,
      // One review, one tab, gone when the decision is journaled: a swarm's approvals must not
      // leave a trail of reviewer tabs for the owner to close.
      close: async (spec, reviewerId) => {
        const scope = { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id }
        const tab = this.tabs(scope).find(candidate => candidate.resourceId === reviewerId)
        if (tab) await this.ui(scope, 'tabs.close', { tabId: tab.id })
      }
    }))
  }

  /** Conversations a non-local coworker cleared to build a local update without asking the owner
   *  again. Deliberately in memory only: the clearance dies with this Conductor process. */
  private readonly updateGrants = new Map<string, { controllerAgentSessionId: string; projectId: string; grantedAt: string }>()

  /** The scope an owner-credential call runs in. The caller names a project and a workspace (or
   *  gets the first open ones); it has no tab of its own, and nothing in the body can make it a
   *  conversation. */
  ownerScope(input: unknown): AgentControlScope {
    const { database } = this.deps
    const requested = input === undefined || input === null ? {} : object(input)
    if (Object.keys(requested).some(key => !['projectId', 'workspaceId'].includes(key))) throw new Error('scope accepts only projectId and workspaceId')
    const projectId = requested.projectId === undefined ? database.listDeskProjects()[0]?.id ?? database.listProjects()[0]?.id : text(requested, 'projectId', 160)
    // A fresh profile has no project yet. The owner still needs tools.list, projects.list and
    // projects.open to get one, so the scope is allowed to name none; call() refuses everything
    // that would need one.
    if (!projectId && requested.projectId === undefined) return { projectId: '', sessionId: '', agentSessionId: OWNER_AGENT_ID, owner: true }
    if (!projectId || !database.getProject(projectId)) throw new Error('No project with that id is open in this Conductor; use projects.list, or projects.open({path}) to register a folder')
    const workspaces = database.listSessions(projectId)
    const sessionId = requested.workspaceId === undefined ? workspaces[0]?.id : text(requested, 'workspaceId', 160)
    if (!sessionId || !workspaces.some(workspace => workspace.id === sessionId)) throw new Error('That workspace is not open in the requested project; use projects.list')
    return { projectId, sessionId, agentSessionId: OWNER_AGENT_ID, owner: true }
  }

  authorize(scope: AgentControlScope): AgentSpec {
    const { database } = this.deps
    if (scope.owner) {
      // The owner's own credential: as much authority as the window, addressed at one project
      // and workspace. It is described as a full-autonomy native controller so every rule that
      // caps a coworker at its controller's mode lets the owner open coworkers on Auto.
      if (!scope.projectId && !scope.sessionId) return { id: OWNER_AGENT_ID, projectId: '', sessionId: '', provider: 'claude', title: 'Owner control', cwd: '' }
      const project = database.getProject(scope.projectId), workspace = database.getSession(scope.sessionId)
      if (!project || workspace?.projectId !== scope.projectId) throw new Error('Control scope is no longer active')
      return { id: OWNER_AGENT_ID, projectId: scope.projectId, sessionId: scope.sessionId, provider: 'claude', title: 'Owner control', cwd: project.path }
    }
    if (this.deps.sessions.isApprovalReviewer(scope.agentSessionId)) throw new Error('Approval reviewers have no app-control or delegation authority')
    const spec = database.structured.spec<AgentSpec>(scope.agentSessionId)
    const workspace = database.getSession(scope.sessionId)
    if (!spec || spec.projectId !== scope.projectId || spec.sessionId !== scope.sessionId || workspace?.projectId !== scope.projectId || !database.listSessions(scope.projectId).some(item => item.id === scope.sessionId)) throw new Error('Control scope is no longer active')
    if (!this.tabs(scope).some(tab => tab.resourceId === scope.agentSessionId)) throw new Error('The caller no longer has an open tab')
    return spec
  }

  tabs(scope: AgentControlScope): AgentControlTab[] {
    const workspace = this.deps.database.getSession(scope.sessionId)
    if (workspace?.projectId !== scope.projectId) throw new Error('Workspace is outside the authorized project')
    const tabs: AgentControlTab[] = []
    const visit = (node: LayoutNode, detachedId?: string): void => {
      if (node.type === 'split') { node.children.forEach(child => visit(child, detachedId)); return }
      node.tabs.forEach(tab => tabs.push({ ...tab, groupId: node.id, ...(detachedId ? { detachedId } : {}), uri: conductorUri(scope.projectId, 'tab', tab.id) }))
    }
    visit(workspace.layout.root)
    for (const window of this.deps.database.listDetachedWindows()) if (window.projectId === scope.projectId && window.sessionId === scope.sessionId) visit(window.layout.root, window.id)
    return tabs
  }

  /**
   * A claim only binds while its owner still has a tab open somewhere in the project. A
   * conversation that was closed or crashed mid-task would otherwise hold the item forever:
   * no other agent may move it, and the owner can never come back to release it.
   */
  private claimHolderIsOpen(projectId: string, agentSessionId: string): boolean {
    return this.deps.database.listSessions(projectId).some(workspace =>
      this.tabs({ projectId, sessionId: workspace.id, agentSessionId: '' }).some(tab => tab.resourceId === agentSessionId))
  }

  private tab(scope: AgentControlScope, id: string): AgentControlTab {
    const tab = this.tabs(scope).find(tab => tab.id === id)
    if (!tab) throw new Error('Tab is outside this workspace or closed')
    return tab
  }

  /** The tab a tabs.* call names, and the workspace that holds it. Any tab of the caller's own
   *  workspace, as before; outside it only an agent tab this caller controls, so a controller can
   *  stop, close, rename or focus the coworker it opened or took over in a sibling project, but
   *  cannot touch anything else there. projectId/workspaceId, when given, must be where it is. */
  private tabTarget(scope: AgentControlScope, args: Args): { tab: AgentControlTab; scope: AgentControlScope } {
    const id = text(args, 'tabId', 160)
    const own = this.tabs(scope).find(tab => tab.id === id)
    const found = own ? { tab: own, scope } : this.reachableElsewhere(scope).find(entry => entry.yours && entry.tab.id === id)
    if (!found) throw new Error('Tab is outside this workspace or closed; outside it, name an agent tab this agent controls (agents.list controlled:true)')
    if (args.projectId !== undefined && args.projectId !== found.scope.projectId || args.workspaceId !== undefined && args.workspaceId !== found.scope.sessionId) throw new Error('That tab is not open in the requested project or workspace')
    return { tab: found.tab, scope: found.scope }
  }

  async openUri(uri: string): Promise<void> {
    const target = new URL(uri)
    if (target.protocol !== 'conductor:' || target.username || target.password || target.port || target.search || target.hash) throw new Error('Invalid Conductor link')
    const projectId = decodeURIComponent(target.hostname), parts = target.pathname.split('/').filter(Boolean)
    if (parts.length !== 2) throw new Error('Invalid Conductor link')
    const kind = parts[0], id = decodeURIComponent(parts[1]!)
    const project = this.deps.database.getProject(projectId)
    if (!project) throw new Error('This linked project is no longer loaded')
    const workspaces = this.deps.database.listSessions(projectId)
    if (kind === 'tab') {
      for (const workspace of workspaces) {
        const scope = { projectId, sessionId: workspace.id, agentSessionId: '' }
        if (this.tabs(scope).some(tab => tab.id === id)) { await this.ui(scope, 'tabs.focus', { tabId: id }); return }
      }
      throw new Error('This linked tab is no longer open')
    }
    const workspace = kind === 'workspace' ? workspaces.find(workspace => workspace.id === id) : workspaces[0]
    if (!workspace) throw new Error('This linked workspace is no longer open')
    const scope = { projectId, sessionId: workspace.id, agentSessionId: '' }
    if (kind === 'workspace') await this.ui(scope, 'workspace.focus', {})
    else if (kind === 'file') await this.ui(scope, 'files.open', { path: relative(await realpath(project.path), await workspacePath(project.path, id)).replaceAll('\\', '/') })
    else throw new Error('Unsupported Conductor link')
  }

  /** The few hundred bytes a controller needs to supervise a worker, in place of a 40 KB
   *  snapshot: where it is, why it last stopped, what it changed. The stop figures come from the
   *  local runtime's own report on the timeline, so a controller sees the same numbers the owner
   *  does; a native CLI conversation reports what its events carry. */
  private status(scope: AgentControlScope, tab: AgentControlTab, state: SessionProjection) {
    const items = [...state.items].sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence))
    const stop = items.map(item => localStopOf(item.data)).find(Boolean)
    const lastTool = items.find(item => item.data.type === 'tool' && item.data.name !== 'acceptance')
    const lastText = items.find(item => item.data.type === 'text' && item.data.role === 'assistant')
    const lastError = items.find(item => item.data.type === 'error')
    const context = summarizeContext(state.items)
    const changed = new Set<string>()
    for (const item of state.items) if (item.data.type === 'changes') for (const change of item.data.changes) changed.add(change.path)
    return {
      ...this.observation(scope, tab, state, new Date().toISOString()),
      model: state.settings.model ?? tab.state?.model ?? null,
      permission: state.settings.permission,
      contract: state.settings.localContract ?? null,
      stop: stop ? { reason: stop.reason, detail: stop.detail, rounds: stop.rounds, hardLimit: stop.hardLimit, context: stop.context, compactions: stop.compactions, loopWarnings: stop.loopWarnings, acceptance: stop.acceptance ?? null, filesChanged: stop.filesChanged, unverified: stop.unverified ?? null } : null,
      context: context ? { used: context.used, capacity: context.capacity, window: context.window ?? null, percent: Math.round(context.percent * 10) / 10, level: context.level } : null,
      lastTool: lastTool && lastTool.data.type === 'tool' ? { name: lastTool.data.name, status: lastTool.data.status, at: lastTool.timestamp } : null,
      lastError: lastError && lastError.data.type === 'error' ? lastError.data.message.slice(0, 400) : null,
      lastAnswer: lastText && lastText.data.type === 'text' ? lastText.data.text.slice(-600) : null,
      filesChanged: [...changed].slice(0, 100),
      taskState: this.deps.sessions.runStatus(tab.resourceId!)
    }
  }

  private observation(scope: AgentControlScope, tab: AgentControlTab, state: SessionProjection | null, observedAt: string) {
    const lastEvent = state?.sequence ? this.deps.database.structured.events(tab.resourceId!, state.sequence - 1)[0] : undefined
    return {
      observedAt, source: 'native-session' as const, projectId: scope.projectId, workspaceId: scope.sessionId,
      tabId: tab.id, agentSessionId: tab.resourceId, groupId: tab.groupId, detachedId: tab.detachedId,
      title: tab.title, provider: tab.state?.provider, uri: tab.uri, phase: state?.phase ?? null,
      wizard: wizardActive(state?.settings, typeof tab.state?.provider === 'string' ? tab.state.provider : undefined),
      lastActivityAt: lastEvent?.timestamp ?? null, sequence: state?.sequence ?? 0,
      lastEvent: lastEvent ? {
        sequence: lastEvent.sequence, timestamp: lastEvent.timestamp, type: lastEvent.data.type,
        ...(lastEvent.data.type === 'tool' ? { name: lastEvent.data.name, status: lastEvent.data.status, exitCode: lastEvent.data.exitCode } : {})
      } : null
    }
  }

  /**
   * The tab an agents.* call names, and the workspace it actually lives in. Anything in the
   * caller's own workspace stays open to it as before, and a tab the caller opened anywhere else
   * stays its own. `reach` opens one more door: a tab in a sibling project the owner co-opened
   * that nobody controls - the owner's own conversation included - may be read ('read') or
   * prompted and interrupted ('steer'), so the owner no longer relays prompts between projects by
   * hand. Co-opening the projects is that consent. A tab another controller holds stays out of
   * reach; a conversation a paired machine drives keeps the bounds its pairing drew, on either
   * end; and a sandboxed local model does not steer outside its own project.
   */
  private target(scope: AgentControlScope, id: string, mutate = false, reach: 'read' | 'steer' | null = null): { tab: AgentControlTab; scope: AgentControlScope } {
    const spec = this.deps.database.structured.spec<AgentSpec>(id)
    const missing = new Error('Agent is outside this workspace or has no visible tab; agents.list returns every agentSessionId this caller may name')
    if (!spec) throw missing
    const elsewhere = spec.projectId !== scope.projectId || spec.sessionId !== scope.sessionId
    const link = this.linkFor(id)
    const sideways = elsewhere && link?.controllerAgentSessionId !== scope.agentSessionId
    if (sideways && spec.projectId === scope.projectId) throw missing
    // Even a tab it controls: a link made before a paired machine took this conversation over
    // does not carry that machine past the project it was granted.
    if (spec.projectId !== scope.projectId && this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)?.state?.remotePeerId) throw new Error('This conversation is driven by a paired machine and stays inside the project shared with it')
    if (sideways && !reach) throw link ? missing : new Error('That tab is outside this workspace and this agent does not control it. agents.submit or agents.steer takes control of an uncontrolled tab in a sibling project; after that it answers every agents.* and tabs.* method')
    if (sideways) {
      if (link) throw new Error(`Another agent controls that tab in ${this.deps.database.getProject(spec.projectId)?.name ?? 'the other project'}; only its controller can read or steer it`)
      if (reach === 'steer' && this.deps.database.structured.spec<AgentSpec>(scope.agentSessionId)?.provider === 'local') throw new Error('A sandboxed local conversation cannot steer a tab in another project; a non-local coworker or the owner can')
    }
    const target = elsewhere ? { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: scope.agentSessionId } : scope
    const tab = this.tabs(target).find(tab => tab.kind === 'agent' && tab.resourceId === id)
    if (!tab) throw missing
    if (sideways && reach === 'steer' && tab.state?.remotePeerId) throw new Error('That conversation is driven by a paired machine; only that machine steers it')
    if (mutate) {
      const ancestors = new Set([scope.agentSessionId])
      for (let cursor = scope.agentSessionId;;) {
        const parent = this.linkFor(cursor)?.controllerAgentSessionId
        if (!parent || ancestors.has(parent)) break
        ancestors.add(parent); cursor = parent
      }
      if (ancestors.has(id)) throw new Error('An agent cannot control itself or an ancestor')
      // The owner drives any tab in the window, a coworker's included, exactly as from the UI.
      if (link && link.controllerAgentSessionId !== scope.agentSessionId && !sovereign(scope)) throw new Error('Another agent already controls this tab; its controller must release it first')
    }
    return { tab, scope: target }
  }

  /** Settings are more durable than a prompt: changing an unclaimed neighbour would leave it
   * altered after this caller went away. Only a relationship the caller already owns qualifies. */
  private configuredTarget(scope: AgentControlScope, id: string): { tab: AgentControlTab; scope: AgentControlScope } {
    const target = this.target(scope, id, true)
    if (this.linkFor(id)?.controllerAgentSessionId !== scope.agentSessionId) throw new Error('Configure only a coworker this agent already controls')
    const spec = this.deps.database.structured.spec<AgentSpec>(id)
    // The durable spec is the execution owner. Old layouts may predate the machine badge, so
    // accepting a missing/local-looking tab stamp would turn a remote configuration into a local
    // settings-only lie. A remote tab stamp is likewise sufficient to fail closed.
    if (spec?.machineId && spec.machineId !== LOCAL_MACHINE_ID || tabMachineId(target.tab) !== LOCAL_MACHINE_ID) throw new Error('This coworker runs on another machine; agents.configure must be sent to its owning machine')
    return target
  }

  private configurableSettings(id: string, provider: StructuredProvider, args: Args): { previous: SessionSettings; next: SessionSettings; model: string; effort?: string } {
    const state = this.deps.database.structured.snapshot(id)
    if (!state) throw new Error('Agent session is no longer available')
    if (['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(state.phase) || state.queued || state.queuedPrompts?.length || state.pendingSteering?.length) {
      throw new Error('Wait until the coworker is idle and has no queued or pending input before changing its model and effort')
    }
    if (state.capabilities?.provider !== provider) throw new Error('The visible tab provider does not match the native conversation')
    const model = text(args, 'model', 160)
    const choice = state.capabilities.models.find(candidate => candidate.id === model)
    if (!choice) throw new Error('Choose an exact model advertised for this coworker by models.list')
    let effort: string | undefined
    if (choice.effort?.length) {
      effort = text(args, 'effort', 40)
      if (!choice.effort.includes(effort)) throw new Error('Choose an effort supported by this model')
    } else if (args.effort !== undefined) throw new Error('This model does not accept an effort setting')
    return { previous: structuredClone(state.settings), next: { ...state.settings, model, effort }, model, effort }
  }

  /** The per-conversation grants a caller asked for, by the names the protocol uses. Only parsed
   *  here; whether the caller may hand them out is grantAuthority, so tabs.open, router.dispatch
   *  and agents.grant read them under one rule. */
  private grantArguments(args: Args): Partial<Pick<SessionSettings, 'localGit' | 'localResearch'>> {
    const requested: Partial<Pick<SessionSettings, 'localGit' | 'localResearch'>> = {}
    for (const [key, setting] of [['repository', 'localGit'], ['research', 'localResearch']] as const) {
      if (args[key] === undefined) continue
      if (typeof args[key] !== 'boolean') throw new Error(`${key} must be true or false`)
      requested[setting] = args[key]
    }
    return requested
  }

  /**
   * Whether this caller may hand out a local model's grants at all. A sandboxed local
   * conversation never may: one that could widen another local tab could widen one it opened and
   * hand its own work to it, which is the sandbox escaped one step removed. A read-only or
   * planning caller may not either, for the same reason it cannot dispatch into a writable
   * conversation, and a conversation a paired machine is driving stays inside what that pairing
   * granted, as everywhere else.
   */
  private grantAuthority(scope: AgentControlScope, source: AgentSpec): void {
    if (source.provider === 'local') throw new Error('A sandboxed local conversation cannot grant repository writes or research, to itself or to any other conversation. A non-local coworker grants them with agents.grant, or the owner toggles them in that tab’s composer.')
    if (restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
    if (this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)?.state?.remotePeerId) throw new Error('This conversation is driven by a paired machine and cannot widen a local model')
  }

  /**
   * Switches a local coworker's repository-writes and deep-research grants from outside it.
   * Modelled on app.update.authorize — the same kind of caller, the same "never itself" rule, the
   * same strictness about arguments — with one deliberate difference: an update clearance lives
   * in memory, but these grants are the conversation's durable settings, written through exactly
   * the path its composer uses (StructuredSessions.saveSettings). That is what makes the tab's
   * own toggles show the change, keeps the local runtime's dispatch-time enforcement unchanged,
   * and means a queued prompt cannot carry a grant that was withdrawn in the meantime. Authority
   * is more durable than a prompt, so ownership follows agents.configure rather than steering:
   * only a coworker this caller already controls, running on this machine.
   */
  private async grant(scope: AgentControlScope, source: AgentSpec, id: string, args: Args): Promise<unknown> {
    if (Object.keys(args).some(key => !['agentSessionId', 'repository', 'research'].includes(key))) throw new Error('agents.grant accepts only agentSessionId, repository and research')
    this.grantAuthority(scope, source)
    const { tab, scope: target } = this.configuredTarget(scope, id)
    if (tab.state?.remotePeerId) throw new Error('That conversation is driven by a paired machine; its grants belong to that machine')
    if (this.deps.database.structured.spec<AgentSpec>(id)?.provider !== 'local' || tab.state?.provider !== 'local') throw new Error('Repository and research grants apply to local models only')
    const requested = this.grantArguments(args)
    const changing = Object.keys(requested).length > 0
    if (changing) this.deps.sessions.saveSettings(id, { ...this.deps.database.structured.snapshot(id)!.settings, ...requested })
    const saved = this.deps.database.structured.snapshot(id)!.settings
    const grants = { repository: Boolean(saved.localGit), research: Boolean(saved.localResearch) }
    // The mounted pane keeps its own copy of the settings, so it is told. The durable state is
    // already the truth; a pane that missed the note reads it again when it mounts.
    let paneNotified = false
    if (changing) await this.ui(target, 'agents.grant-confirmed', { tabId: tab.id, agentSessionId: id, ...grants }).then(() => { paneNotified = true }, () => undefined)
    return { agentSessionId: id, tabId: tab.id, uri: tab.uri, projectId: target.projectId, workspaceId: target.sessionId, provider: 'local', grants, effective: 'next-turn', paneNotified, grantedBy: scope.agentSessionId, note: 'Repository writes let the sandbox commit and branch, and run a plain git push for it on the host; research adds web_search and a larger tool-round budget. Both apply from that conversation’s next turn.' }
  }

  /**
   * Who controls this tab, wherever that controller sits. A link only binds while the controller
   * still has an open tab of its own; otherwise a closed or crashed controller would hold the tab
   * forever and nobody could take it over. A controller in a sibling project recorded its own
   * workspace on the link, so ownership is checked there rather than beside the controlled tab.
   */
  private linkFor(agentSessionId: string): AgentControlLink | null {
    const stored = this.deps.database.getSetting('agentControlParent:' + agentSessionId)
    if (!stored) return null
    let link: AgentControlLink
    try { link = JSON.parse(stored) as AgentControlLink } catch { return null }
    if (link.targetAgentSessionId !== agentSessionId) return null
    const projectId = link.controllerProjectId ?? link.projectId, sessionId = link.controllerSessionId ?? link.sessionId
    if (this.deps.database.getSession(sessionId)?.projectId !== projectId) return null
    return this.tabs({ projectId, sessionId, agentSessionId: '' }).some(tab => tab.resourceId === link.controllerAgentSessionId) ? link : null
  }

  listLinks(projectId: string, sessionId: string): AgentControlLink[] {
    const tabs = this.tabs({ projectId, sessionId, agentSessionId: '' }), ids = new Set(tabs.map(tab => tab.resourceId))
    return tabs.flatMap(tab => {
      // The cable is only drawn between two tabs of one workspace; a cross-project controller has
      // no tab here to draw it from, so its link stays invisible while still binding ownership.
      const link = tab.resourceId ? this.linkFor(tab.resourceId) : null
      return link && link.projectId === projectId && link.sessionId === sessionId && ids.has(link.controllerAgentSessionId)
        ? [{ ...link, controllerTitle: tabs.find(tab => tab.resourceId === link.controllerAgentSessionId)?.title, controlledTitle: tab.title }] : []
    })
  }

  /**
   * Focuses the concrete tab that originated a persisted coordinated message. This deliberately
   * searches durable tab/resource identity rather than control links: a release drops control
   * authority but must not make the owner-facing transcript lose its sender. A closed tab can be
   * restored only in its recorded workspace, never reconstructed from a label or a guessed ID.
   */
  async focusOrigin(agentSessionId: string): Promise<void> {
    if (!agentSessionId || agentSessionId.length > 160) throw new Error('Invalid originating agent')
    for (const project of this.deps.database.listProjects()) for (const workspace of this.deps.database.listSessions(project.id)) {
      const scope: AgentControlScope = { projectId: project.id, sessionId: workspace.id, agentSessionId: '' }
      const open = this.tabs(scope).find(tab => tab.kind === 'agent' && tab.resourceId === agentSessionId)
      if (open) { await this.ui(scope, 'tabs.focus', { tabId: open.id }); return }
      if (workspace.closedTabs.some(tab => tab.kind === 'agent' && tab.resourceId === agentSessionId)) {
        await this.ui(scope, 'tabs.focus-origin', { agentSessionId })
        return
      }
    }
    throw new Error('The originating agent tab is no longer available.')
  }

  releaseByOwner(targetAgentSessionId: string): void {
    const spec = this.deps.database.structured.spec<AgentSpec>(targetAgentSessionId)
    if (!spec) throw new Error('Agent not found')
    const stored = this.deps.database.getSetting('agentControlParent:' + targetAgentSessionId)
    this.deps.database.removeSetting('agentControlParent:' + targetAgentSessionId)
    if (stored) {
      const link = JSON.parse(stored) as AgentControlLink
      // Same rule as relationship(): there is no shared thread to post to when the controller
      // that was just released lives in another project.
      if (!link.controllerProjectId || link.controllerProjectId === spec.projectId && link.controllerSessionId === spec.sessionId) {
        this.deps.collaboration.postMessage({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: link.controllerAgentSessionId, toAgentSessionId: targetAgentSessionId, kind: 'handoff', body: 'The owner released this control relationship.', metadata: { control: 'detached', controllerTabId: link.controllerTabId, controlledTabId: link.controlledTabId } })
      } else this.deps.linksChanged?.({ projectId: link.controllerProjectId, sessionId: link.controllerSessionId ?? link.sessionId })
    }
    this.deps.linksChanged?.({ projectId: spec.projectId, sessionId: spec.sessionId })
  }

  private relationship(scope: AgentControlScope, target: AgentControlScope, tab: AgentControlTab, state: 'attached' | 'detached'): void {
    // The owner has no tab to draw a cable from and never needs a link to reach a tab.
    if (scope.owner) return
    const source = this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)
    const together = target.projectId === scope.projectId && target.sessionId === scope.sessionId
    if (state === 'attached') {
      const link: AgentControlLink = { projectId: target.projectId, sessionId: target.sessionId, controllerAgentSessionId: scope.agentSessionId, targetAgentSessionId: tab.resourceId!, controllerTabId: source!.id, controlledTabId: tab.id, ...(together ? {} : { controllerProjectId: scope.projectId, controllerSessionId: scope.sessionId }) }
      this.deps.database.setSetting('agentControlParent:' + tab.resourceId, JSON.stringify(link))
    } else this.deps.database.removeSetting('agentControlParent:' + tab.resourceId)
    this.deps.linksChanged?.(target)
    if (!together) { this.deps.linksChanged?.(scope); return }
    // A collaboration message is a note between coworkers of one project; there is no shared
    // thread to post it to when the controller lives in another one.
    this.deps.collaboration.postMessage({ ...target, agentSessionId: scope.agentSessionId, toAgentSessionId: tab.resourceId, kind: 'handoff', body: state === 'attached' ? `Controlling ${tab.title}` : `Released ${tab.title}`, metadata: { control: state, controllerTabId: source?.id, controlledTabId: tab.id } })
  }

  /**
   * Every project open in this Conductor. Two projects side by side in one window is the owner's
   * own arrangement, so an agent may look across at a sibling and hand work to it; this never
   * reaches past this window, and writing into a sibling still goes through a tab opened there.
   */
  private projects(scope: AgentControlScope): Array<{ id: string; name: string; path: string; current: boolean; uri: string; workspaces: Array<{ id: string; name: string; uri: string; current: boolean }> }> {
    return this.deps.database.listProjects().map(project => ({
      id: project.id, name: project.name, path: project.path, current: project.id === scope.projectId,
      uri: conductorUri(project.id, 'workspace', this.deps.database.listSessions(project.id)[0]?.id ?? ''),
      workspaces: this.deps.database.listSessions(project.id).map(workspace => ({ id: workspace.id, name: workspace.name, uri: conductorUri(project.id, 'workspace', workspace.id), current: workspace.id === scope.sessionId }))
    }))
  }

  /** The tabs outside its own workspace this caller may name: the ones it opened, so a handoff
   *  stays findable after the agentSessionId that tabs.open returned has scrolled out of the
   *  caller's context, and the uncontrolled ones in a sibling project that target() lets it read
   *  and steer. A tab another controller holds is not listed at all. */
  private reachableElsewhere(scope: AgentControlScope): Array<{ tab: AgentControlTab; scope: AgentControlScope; yours: boolean }> {
    const found: Array<{ tab: AgentControlTab; scope: AgentControlScope; yours: boolean }> = []
    const paired = Boolean(this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)?.state?.remotePeerId)
    for (const project of this.deps.database.listProjects()) {
      if (paired && project.id !== scope.projectId) continue
      for (const workspace of this.deps.database.listSessions(project.id)) {
        if (project.id === scope.projectId && workspace.id === scope.sessionId) continue
        const target = { projectId: project.id, sessionId: workspace.id, agentSessionId: scope.agentSessionId }
        for (const tab of this.tabs(target)) {
          if (tab.kind !== 'agent' || !tab.resourceId) continue
          const link = this.linkFor(tab.resourceId)
          if (link?.controllerAgentSessionId === scope.agentSessionId) found.push({ tab, scope: target, yours: true })
          else if (!link && project.id !== scope.projectId) found.push({ tab, scope: target, yours: false })
        }
      }
    }
    return found
  }

  /** Resolves an optional projectId/workspaceId onto a co-open project. Omitting both always
   *  means the caller's own workspace, so every existing call keeps its exact meaning. */
  private sibling(scope: AgentControlScope, args: Args): AgentControlScope {
    if (args.projectId === undefined && args.workspaceId === undefined) return scope
    const projectId = args.projectId === undefined ? scope.projectId : text(args, 'projectId', 160)
    // Co-opening two projects is the owner's consent for this window's own agents. A conversation
    // a paired machine is driving stays inside the one project that machine was granted, which is
    // what the pairing approval promised.
    if (projectId !== scope.projectId && this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)?.state?.remotePeerId) throw new Error('This conversation is driven by a paired machine and stays inside the project shared with it')
    if (!this.deps.database.getProject(projectId)) throw new Error('No project with that id is open in this Conductor; use projects.list')
    const workspaces = this.deps.database.listSessions(projectId)
    const sessionId = args.workspaceId === undefined ? projectId === scope.projectId ? scope.sessionId : workspaces[0]?.id : text(args, 'workspaceId', 160)
    if (!sessionId || !workspaces.some(workspace => workspace.id === sessionId)) throw new Error('That workspace is not open in the requested project; use projects.list')
    return { projectId, sessionId, agentSessionId: scope.agentSessionId }
  }

  private ui(scope: AgentControlScope, action: AgentControlUiRequest['action'], params: Args): Promise<unknown> {
    return this.deps.ui({ ...scope, id: randomUUID(), action, params })
  }

  private catalog(scope: AgentControlScope): Array<{ provider: StructuredProvider; available: boolean; source: 'runtime' | 'configured'; models: Array<{ id: string; label: string; effort?: string[]; defaultEffort?: string; isDefault?: boolean }> }> {
    return this.deps.providers().filter(provider => provider.id === 'codex' || provider.id === 'claude' || provider.id === 'grok' || provider.id === 'local').map(provider => {
      const runtime = this.tabs(scope).filter(tab => tab.kind === 'agent' && tab.state?.provider === provider.id).map(tab => this.deps.database.structured.snapshot(tab.resourceId!)?.capabilities).find(capabilities => capabilities?.models.length)
      return { provider: provider.id as StructuredProvider, available: provider.available, source: runtime ? 'runtime' : 'configured', models: runtime?.models ?? provider.models.filter(model => !['default', 'auto'].includes(model.id)).map(model => ({ ...model, effort: provider.efforts.map(effort => effort.id).filter(id => id !== 'auto') })) }
    })
  }

  private machines(): MachineDescriptor[] {
    return this.deps.machines?.() ?? [{ id: LOCAL_MACHINE_ID, name: 'This machine', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION }]
  }

  /** Where the caller itself is running; a tab it opens follows unless it says otherwise. */
  private callerMachineId(scope: AgentControlScope): string {
    return tabMachineId(this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId))
  }

  private async open(scope: AgentControlScope, args: Args, approvalReviewer = false): Promise<AgentControlTab & { projectId: string; workspaceId: string; grants?: { repository: boolean; research: boolean } }> {
    const kind = (args.kind ?? 'agent') as PaneKind
    const allowed: PaneKind[] = ['agent', 'terminal', 'file-tree', 'browser', 'tasks', 'memory', 'routine', 'logs', 'job']
    if (!allowed.includes(kind)) throw new Error('Unsupported tab kind; use files.open for editors')
    if (kind === 'job') return this.openJobTab(scope, args)
    // Where the tab is going. Only the caller's own scope is ever authorized; the target only
    // says which open workspace receives the tab.
    const target = this.sibling(scope, args)
    const machines = this.machines()
    const machineId = inheritMachineId(this.callerMachineId(scope), args.machineId, machines)
    if (machineId !== LOCAL_MACHINE_ID) return this.openOnMachine(scope, target, machineId, machines, args) as Promise<AgentControlTab & { projectId: string; workspaceId: string }>
    const title = args.title === undefined ? kind === 'agent' ? 'Agent' : kind : text(args, 'title', 120)
    const tab: PaneTab = { id: makeId('tab'), kind, title }
    let grants: { repository: boolean; research: boolean } | undefined
    if (kind === 'agent') {
      const source = this.authorize(scope)
      const catalog = this.catalog(scope)
      const provider = (args.provider ?? source.provider) as StructuredProvider
      const entry = catalog.find(entry => entry.provider === provider && entry.available)
      if (!entry) throw new Error('This native provider is unavailable')
      const model = typeof args.model === 'string' ? entry.models.find(model => model.id === args.model) : entry.models.find(model => model.isDefault) ?? entry.models[0]
      if (!model) throw new Error('Choose a model from models.list')
      const effort = args.effort === undefined ? model.defaultEffort : text(args, 'effort', 40)
      if (effort && !model.effort?.includes(effort)) throw new Error('Choose an effort supported by this model')
      if (args.permission !== undefined && !isSessionPermission(args.permission)) throw new Error('Invalid permission mode')
      if (args.exactPermission !== undefined && typeof args.exactPermission !== 'boolean') throw new Error('exactPermission must be true or false')
      const explicitPermission = args.permission as SessionSettings['permission'] | undefined
      // Grants are checked before the session exists, so a refused ask leaves no orphaned
      // conversation behind; the rules are the ones agents.grant applies later.
      const requestedGrants = this.grantArguments(args)
      if (Object.keys(requestedGrants).length) {
        this.grantAuthority(scope, source)
        if (provider !== 'local') throw new Error('Repository and research grants apply to local models only')
      }
      // A contract narrows what the worker may do rather than widening it, so any caller that may
      // open a tab may set one; it only means something to the local runtime.
      const contract = normaliseContract(args.contract)
      if (contract && provider !== 'local') throw new Error('A task contract applies to local models only')
      // A local model whose server cannot start right now (another model is busy on the one
      // slot this machine has) is refused here, with the reason, rather than as the failure of the
      // first turn inside a tab that then sits there.
      if (provider === 'local' && this.deps.localModels) {
        const availability = await this.deps.localModels.availability(model.id)
        if (!availability.available) throw new Error(availability.reason ?? 'This local model cannot start right now')
      }
      tab.resourceId = makeId('agent')
      if (approvalReviewer) this.deps.sessions.markApprovalReviewer(tab.resourceId)
      tab.title = args.title === undefined ? model.label : title
      tab.state = { provider, model: model.id, effort: effort ?? 'auto', viewMode: 'visual', machineId }
      // A tab handed to a sibling project belongs to that project and works in its folder, not in
      // the folder of whoever asked for it.
      const cwd = target.projectId === scope.projectId ? source.cwd : this.deps.database.getProject(target.projectId)!.path
      // A coworker of the owner or of a wizard waits out usage limits and continues, like the wizard itself.
      const spec: AgentSpec = { id: tab.resourceId, projectId: target.projectId, sessionId: target.sessionId, provider, model: model.id, title: tab.title, cwd, ...(sovereign(scope) ? { continueOnLimit: true } : {}) }
      const result = this.deps.sessions.ensure(spec)
      if (!result.available) throw new Error(result.message || 'Provider unavailable')
      const created = this.deps.database.structured.snapshot(spec.id)!
      if (explicitPermission && !created.capabilities?.permissions?.includes(explicitPermission)) throw new Error('Choose a permission mode supported by this provider')
      const sourceSettings: SessionSettings = sovereign(scope) ? { permission: 'auto', plan: false } : settingsForRuntime(this.deps.database.structured.snapshot(scope.agentSessionId)!.settings)
      // A native coworker opens on Auto (see dispatchPermission). Only with exactPermission does
      // an explicit ask, else the owner's remembered mode for this provider (permission-memory.ts
      // on the renderer side, mirrored via app-settings.ts), decide — still capped by the
      // controller's own autonomy and by what this provider actually offers.
      const requested = explicitPermission ?? rememberedPermission(key => this.deps.database.getSetting(key), provider)
      const permission = dispatchPermission(sourceSettings, created.capabilities?.permissions, provider, requested, args.exactPermission === true)
      // Read-only is a permission every provider that offers it enforces; only a provider with its
      // own execution sandbox (Codex) is also told to run commands read-only. Naming a sandbox mode
      // the provider does not have fails the first turn: a local model's read-only is its permission.
      const readOnlySandbox = permission === 'read-only' && created.capabilities?.sandboxModes?.includes('read-only')
      const settings: SessionSettings = { ...created.settings, model: model.id, effort, permission, ...(readOnlySandbox ? { sandbox: 'read-only' as const } : {}), plan: restricted(sourceSettings) && (provider === 'claude' || provider === 'grok'), ...requestedGrants, ...(contract ? { localContract: contract } : {}) }
      this.deps.database.structured.update(spec.id, { settings })
      if (Object.keys(requestedGrants).length) grants = { repository: Boolean(settings.localGit), research: Boolean(settings.localResearch) }
    } else {
      if (kind === 'terminal') tab.resourceId = makeId('terminal')
      tab.state = { ...tab.state, machineId }
    }
    await this.ui(target, 'tabs.open', { tab, ...(args.focus === false ? { focus: false } : {}) })
    const opened = this.tab(target, tab.id)
    if (kind === 'agent') this.relationship(scope, target, opened, 'attached')
    return { ...opened, projectId: target.projectId, workspaceId: target.sessionId, ...(grants ? { grants } : {}) }
  }

  /**
   * Places the tab on a paired machine instead of this one. The tab is created and shown over
   * there; what comes back identifies it so the caller can steer it through the same machine.
   */
  private async openOnMachine(scope: AgentControlScope, target: AgentControlScope, machineId: string, machines: MachineDescriptor[], args: Args): Promise<unknown> {
    const machine = machines.find(candidate => candidate.id === machineId)!
    // Refused before anything is dialled, and refused again against a live answer inside
    // openRemote; the message names which identity rule stopped it so the owner can act on it.
    // The identity that has to match is the project the tab is for, not the caller's own.
    const placement = machineRunsProject(machine, target.projectId)
    if (!placement.ok) throw new Error(placement.message)
    if (!this.deps.openRemote) throw new Error('Remote machine placement is unavailable in this window')
    if (args.kind !== undefined && args.kind !== 'agent') throw new Error('Only agent tabs can be opened on another machine')
    // The grants are settings of the conversation where it runs; silently dropping them here
    // would hand that machine a job the tab cannot finish.
    if (args.repository !== undefined || args.research !== undefined) throw new Error('Repository and research grants are set on the machine that runs the tab; open it there without them and grant through that machine')
    const created = await this.deps.openRemote(machineId, {
      projectId: target.projectId,
      sessionId: target.sessionId,
      ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
      ...(typeof args.model === 'string' ? { model: args.model } : {}),
      ...(typeof args.effort === 'string' ? { effort: args.effort } : {}),
      ...(args.title === undefined ? {} : { title: text(args, 'title', 120) })
    })
    return { machineId, machineName: created.machineName, remote: true, tabId: created.tabId, agentSessionId: created.agentSessionId, projectId: target.projectId, workspaceId: target.sessionId,
      note: `This tab runs on ${created.machineName}. Steer it with agents.* through that machine; it is not a local tab.` }
  }

  async call(scope: AgentControlScope, method: string, rawArgs: unknown = {}): Promise<unknown> {
    const source = this.authorize(scope), args = object(rawArgs), { database, sessions, backlogs, orchestration } = this.deps
    if (process.env.CONDUCTOR_LIVE_TESTS === '1') throw new Error('App control is disabled during isolated live acceptance tests')
    // A wizard conversation (the wand toggle on a frontier model, not read-only or planning)
    // carries the owner's authority in its own tab: decided here from its durable settings on
    // every call, never from anything the caller sends.
    if (!scope.owner && wizardActive(database.structured.snapshot(scope.agentSessionId)?.settings, source.provider)) scope = { ...scope, wizard: true }
    if (args.sessionId !== undefined && args.sessionId !== scope.sessionId) throw new Error('Requested scope differs from the authorized session')
    // Naming another project is only meaningful for the methods that were opened to a sibling;
    // everywhere else it is still an attempt to act outside the authorized scope.
    if (args.projectId !== undefined && args.projectId !== scope.projectId && !crossProjectMethods.includes(method)) throw new Error('This method only runs in the authorized project. Use projects.list to see what else is open, and hand work to a sibling project with tabs.open({projectId}).')
    if (method === 'tools.list') return { ...toolSignatures, ...(this.deps.durableJobs ? jobSignatures : {}), ...(sovereign(scope) ? ownerSignatures : {}) }
    if (ownerMethods.has(method)) {
      if (!sovereign(scope)) throw new Error(`${method} answers only the owner's own control credential (control-owner.json) or a wizard tab (the wand toggle, frontier models only), not an ordinary conversation`)
      return this.ownerCall(scope, method, args)
    }
    if (method === 'projects.list') return this.projects(scope)
    if (method === 'usage.limits') {
      if (Object.keys(args).some(key => key !== 'provider')) throw new Error('usage.limits accepts only provider')
      const providers: StructuredProvider[] = ['claude', 'codex', 'grok']
      if (args.provider !== undefined && !providers.includes(args.provider as StructuredProvider)) throw new Error('provider must be claude, codex or grok')
      // Allowance is account-wide; which conversation reported it is named only inside this project.
      return { observedNow: new Date().toISOString(), providers: sessions.usageLimits(args.provider as StructuredProvider | undefined).map(report => ({ ...report, windows: report.windows.map(window => ({ ...window, source: window.source.projectId === scope.projectId ? { agentSessionId: window.source.agentSessionId } : { otherProject: true } })) })) }
    }
    if (scope.owner && !scope.projectId) throw new Error(`${method} needs a project: none is open in this Conductor yet. Register one with projects.open({path}) and pass its id as scope.projectId`)
    if (method === 'app.state') return { observedAt: new Date().toISOString(), projectId: scope.projectId, workspaceId: scope.sessionId, project: database.getProject(scope.projectId), workspace: database.getSession(scope.sessionId), tabs: this.tabs(scope), relationships: this.listLinks(scope.projectId, scope.sessionId).map(link => ({ agentSessionId: link.targetAgentSessionId, controllerAgentSessionId: link.controllerAgentSessionId })), machineId: this.callerMachineId(scope), machines: this.machines(), projects: this.projects(scope), ...(sovereign(scope) ? { owner: scope.owner === true, wizard: scope.wizard === true, appVersion: this.deps.host?.version ?? null, pid: this.deps.host?.pid ?? null, updates: this.deps.host?.updates?.state() ?? null } : {}) }
    if (method === 'machines.list') {
      return this.machines().map(machine => {
        const placement = machineRunsProject(machine, scope.projectId)
        return { ...machine, current: machine.id === this.callerMachineId(scope), runsThisProject: placement.ok, projectNote: !placement.ok ? placement.message : machine.kind === 'local' ? 'Runs every project open in this Conductor; projects.list names them.' : null }
      })
    }
    if (method === 'models.list') return this.catalog(scope)
    if (method === 'tabs.list') return this.tabs(this.sibling(scope, args))
    if (method === 'tabs.open') return this.open(scope, args)
    if (['tabs.focus', 'tabs.rename', 'tabs.split', 'tabs.detach', 'tabs.close'].includes(method)) {
      const { tab, scope: target } = this.tabTarget(scope, args)
      if (method !== 'tabs.focus' && tab.kind === 'agent') this.target(scope, tab.resourceId!, true)
      if (method === 'tabs.rename') text(args, 'title', 120)
      if (method === 'tabs.split' && !['horizontal', 'vertical'].includes(String(args.direction))) throw new Error('Invalid split direction')
      const closingState = method === 'tabs.close' && tab.kind === 'agent' ? database.structured.snapshot(tab.resourceId!) : undefined
      const where = target.projectId === scope.projectId ? '' : ` in ${database.getProject(target.projectId)?.name ?? 'another project'}`
      if (method === 'tabs.close' && (!closingState || hasSessionWork(closingState))) await this.ask(scope, `${source.title} wants to close the tab “${tab.title}”${where}.`, 'close this tab')
      // The owner may take a while to answer; the tab and the control over it are checked again.
      this.authorize(scope); this.tabTarget(scope, args)
      if (method !== 'tabs.focus' && tab.kind === 'agent') this.target(scope, tab.resourceId!, true)
      const result = await this.ui(target, method as AgentControlUiRequest['action'], args)
      if (method === 'tabs.close' && tab.kind === 'agent') this.relationship(scope, target, tab, 'detached')
      return result
    }
    if (method === 'agents.handoff') {
      if (scope.owner) throw new Error('The owner credential has no conversation to hand off; open a tab with tabs.open instead')
      return this.handoff(scope, args)
    }
    if (method === 'agents.list') {
      const observedAt = new Date().toISOString()
      const own = this.tabs(scope).filter(tab => tab.kind === 'agent').map(tab => this.observation(scope, tab, database.structured.snapshot(tab.resourceId!), observedAt))
      // A tab this caller handed to another open project is still its own work to follow, and it
      // would otherwise be unfindable after the id that came back from tabs.open is forgotten.
      // `controlled: false` marks a sibling-project tab nobody controls yet.
      return [...own, ...this.reachableElsewhere(scope).map(({ tab, scope: target, yours }) => ({ ...this.observation(target, tab, database.structured.snapshot(tab.resourceId!), observedAt), crossProject: true, controlled: yours }))]
    }
    if (method.startsWith('agents.')) {
      if (typeof args.agentSessionId !== 'string' || !args.agentSessionId.trim()) throw new Error(method + ' requires agentSessionId: the exact id of a visible conversation, as returned by agents.list or app.state')
      const id = text(args, 'agentSessionId', 160), mutate = !['agents.snapshot', 'agents.history', 'agents.artifact'].includes(method)
      const reach = ['agents.snapshot', 'agents.history', 'agents.status', 'agents.artifact'].includes(method) ? 'read' : ['agents.submit', 'agents.steer', 'agents.interrupt'].includes(method) ? 'steer' : null
      const { tab, scope: target } = this.target(scope, id, mutate, reach), state = database.structured.snapshot(id)!
      if (method === 'agents.artifact') {
        const artifactId = text(args, 'artifactId', 200)
        let content: string
        try { content = database.structured.output(id, artifactId) } catch { throw new Error('No such tool output artifact in this conversation; use the outputArtifactId of one of its tool events') }
        const limit = 2 * 1024 * 1024
        return { agentSessionId: id, artifactId, bytes: Buffer.byteLength(content), truncated: content.length > limit, content: content.slice(0, limit) }
      }
      if (method === 'agents.snapshot') {
        const recent = [...state.items].sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence)).slice(0, 60)
        const activeTools = state.items.filter(item => item.data.type === 'tool' && ['preparing', 'running', 'awaiting_approval'].includes(item.data.status))
        return { ...this.observation(target, tab, state, new Date().toISOString()), ...state, activeTools, items: recent.sort((a, b) => a.sequence - b.sequence), truncated: state.truncated || state.items.length > recent.length }
      }
      if (method === 'agents.history') return database.structured.events(id, typeof args.afterSequence === 'number' && Number.isSafeInteger(args.afterSequence) && args.afterSequence >= 0 ? args.afterSequence : 0).slice(0, 100)
      if (method === 'agents.status') return this.status(target, tab, state)
      if (method === 'agents.compact') {
        if (Object.keys(args).some(key => key !== 'agentSessionId')) throw new Error('agents.compact accepts only agentSessionId')
        if (database.structured.spec<AgentSpec>(id)?.provider !== 'local') throw new Error('Only a local-model conversation keeps a task state Conductor can compact; native CLIs compact themselves')
        const result = await sessions.compactContext(id)
        return { agentSessionId: id, compacted: result !== null, result, note: result ? 'The next turn starts from the compacted task state; the full history stays in the timeline.' : 'Nothing to fold yet.' }
      }
      if (method === 'agents.configure') {
        if (Object.keys(args).some(key => !['agentSessionId', 'model', 'effort'].includes(key))) throw new Error('agents.configure accepts only agentSessionId, model, and effort')
        const spec = database.structured.spec<AgentSpec>(id)
        if (!spec || !['codex', 'claude', 'grok', 'local'].includes(spec.provider)) throw new Error('This native provider does not support structured model configuration')
        const provider = spec.provider as StructuredProvider
        if (provider !== tab.state?.provider) throw new Error('The visible tab provider does not match the native conversation')
        const configured = this.configuredTarget(scope, id)
        const desired = this.configurableSettings(id, provider, args)
        const visibleBefore = { provider, model: String(configured.tab.state?.model ?? desired.previous.model ?? ''), ...(configured.tab.state?.effort === undefined ? {} : { effort: String(configured.tab.state.effort) }) }
        await this.ui(configured.scope, 'agents.configure', { tabId: configured.tab.id, agentSessionId: id, provider, model: desired.model, ...(desired.effort === undefined ? {} : { effort: desired.effort }) })
        try {
          this.authorize(scope)
          const current = this.configuredTarget(scope, id)
          if (current.tab.id !== configured.tab.id) throw new Error('The controlled tab changed while its settings were being applied')
          const fresh = this.configurableSettings(id, provider, args)
          if (JSON.stringify(fresh.previous) !== JSON.stringify(desired.previous)) throw new Error('The coworker settings changed while its model and effort were being applied')
          sessions.saveSettings(id, desired.next)
        } catch (error) {
          // Compensation is compare-and-set too. A relationship release can race this renderer
          // round trip, and the owner may immediately choose something newer. Restore the old tab
          // metadata only while both durable settings and visible metadata are still exactly the
          // values this call observed/applied.
          const currentState = database.structured.snapshot(id)
          const currentTab = this.tabs(configured.scope).find(candidate => candidate.id === configured.tab.id && candidate.resourceId === id)
          const visibleIsOurs = currentTab?.state?.provider === provider && currentTab.state.model === desired.model && (currentTab.state.effort === desired.effort || desired.effort === undefined && currentTab.state.effort === 'auto')
          if (currentState && JSON.stringify(currentState.settings) === JSON.stringify(desired.previous) && visibleIsOurs) {
            await this.ui(configured.scope, 'agents.configure', { tabId: configured.tab.id, agentSessionId: id, ...visibleBefore, expectedModel: desired.model, expectedEffort: desired.effort ?? 'auto' }).catch(() => undefined)
          }
          throw error
        }
        await this.ui(configured.scope, 'agents.configure-confirmed', { tabId: configured.tab.id, agentSessionId: id, model: desired.model, ...(desired.effort === undefined ? {} : { effort: desired.effort }) })
        const saved = database.structured.snapshot(id)!
        return { agentSessionId: id, tabId: configured.tab.id, uri: configured.tab.uri, projectId: configured.scope.projectId, workspaceId: configured.scope.sessionId, provider, model: saved.settings.model, effort: saved.settings.effort ?? null, effective: 'next-turn', phase: saved.phase }
      }
      if (method === 'agents.grant') return this.grant(scope, source, id, args)
      if (method === 'agents.resume' || method === 'agents.fork') {
        if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings) && !restricted(state.settings)) throw new Error('A read-only controller cannot resume or fork a writable conversation')
        if (method === 'agents.resume') { await sessions.resume(id, state.settings); return { agentSessionId: id, phase: database.structured.snapshot(id)?.phase } }
        const forkId = await sessions.fork(id)
        const forkTab: PaneTab = { id: makeId('tab'), kind: 'agent', resourceId: forkId, title: args.title === undefined ? tab.title + ' (fork)' : text(args, 'title', 120), state: { ...tab.state, viewMode: 'visual' } }
        await this.ui(target, 'tabs.open', { tab: forkTab })
        const opened = this.tab(target, forkTab.id)
        this.relationship(scope, target, opened, 'attached')
        return { ...opened, projectId: target.projectId, workspaceId: target.sessionId }
      }
      if (method === 'agents.release') { this.relationship(scope, target, tab, 'detached'); return { released: true } }
      if (method === 'agents.interrupt') { await sessions.interrupt(id); return { interrupted: true } }
      if (method === 'agents.submit' || method === 'agents.steer') {
        const prompt = text(args, 'prompt', MAX_PROMPT_CHARS)
        if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings) && !restricted(state.settings)) throw new Error('A read-only controller cannot dispatch to a writable conversation')
        this.relationship(scope, target, tab, 'attached')
        // A coordinated prompt is not the owner's message. Record the controlling tab so the
        // conversation attributes it to that coworker instead of to "You".
        const controller = this.tabs(scope).find(candidate => candidate.resourceId === scope.agentSessionId)
        const label = scope.owner ? 'Owner control' : controller?.title || 'Another Conductor tab'
        const origin: PromptOrigin = { agentSessionId: scope.agentSessionId, label: target.projectId === scope.projectId ? label : `${label} (${database.getProject(scope.projectId)?.name ?? 'another project'})` }
        let delivery: 'started' | 'queued' = 'started'
        try {
          if (method === 'agents.submit') await sessions.submit(id, prompt, state.settings, [], origin)
          // As the composer does: into (or behind) a running turn, else a new turn of its own.
          else delivery = await sessions.steerOrStart(id, prompt, state.settings, [], origin)
        } catch (error) { this.relationship(scope, target, tab, 'detached'); throw error }
        return { agentSessionId: id, tabId: tab.id, uri: tab.uri, projectId: target.projectId, workspaceId: target.sessionId, phase: database.structured.snapshot(id)?.phase, ...(method === 'agents.steer' ? { delivery } : {}) }
      }
    }
    if (method === 'files.list') {
      const target = this.sibling(scope, args)
      return (await searchProjectFiles([database.getProject(target.projectId)!], typeof args.query === 'string' ? args.query.slice(0, 300) : '', { showHidden: true })).map(file => ({ ...file, projectId: target.projectId, uri: conductorUri(target.projectId, 'file', file.path) }))
    }
    if (['files.read', 'files.write', 'files.open'].includes(method)) {
      const target = this.sibling(scope, args)
      const foreign = target.projectId !== scope.projectId
      // Reading across co-open projects is fine; changing one is not. A sibling's files are
      // edited by a tab that lives there, where the owner can see the work being done.
      if (foreign && method === 'files.write') throw new Error('files.write only writes in this project. Open a tab in the other project with tabs.open({projectId}) and dispatch the change to it.')
      const root = foreign ? database.getProject(target.projectId)!.path : source.cwd
      const path = await workspacePath(root, text(args, 'path', 4000), method === 'files.write')
      if (method !== 'files.write' && (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)) throw new Error('Only text files up to 1 MiB are supported')
      // Match workspacePath's native resolver, including Windows 8.3 folder aliases.
      const relativePath = relative(await realpath(root), path).replaceAll('\\', '/')
      this.authorize(scope)
      if (method === 'files.open') return this.ui(target, 'files.open', { path: relativePath })
      // Same guard the editor uses: an agent asking for a binary file gets a
      // clear refusal rather than a megabyte of mojibake it will act on.
      if (method === 'files.read') return { path: relativePath, projectId: target.projectId, content: readTextFile(path), uri: conductorUri(target.projectId, 'file', relativePath) }
      if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 1024 * 1024 || !(args.expectedContent === null || typeof args.expectedContent === 'string' && Buffer.byteLength(args.expectedContent) <= 1024 * 1024)) throw new Error('Provide content and the exact expectedContent (null for a new file), up to 1 MiB')
      const lease = this.deps.collaboration.announcePresence({ ...scope, path: relativePath, intent: args.expectedContent === null ? 'create' : 'edit', ttlSeconds: 90 })
      if (!lease.granted) throw new Error('Another agent holds an active edit lease for this file')
      const saved = writeEditorFile(path, args.content, args.expectedContent)
      if (saved.status === 'saved') { invalidateProjectFiles(source.cwd); this.deps.fileChanged({ ...scope, path: relativePath }) }
      return saved
    }
    if (method === 'tasks.list') return backlogs.get(this.sibling(scope, args).projectId)
    if (method === 'tasks.update') {
      if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
      const board = await backlogs.get(scope.projectId), id = text(args, 'id', 160), task = board.tasks.find(task => task.id === id)
      if (!task) throw new Error('Task not found')
      if (task.agentId && task.agentId !== scope.agentSessionId && task.status === 'doing' && this.claimHolderIsOpen(scope.projectId, task.agentId)) throw new Error('Another agent owns this task')
      const status = args.status === undefined ? task.status : args.status
      if (!['todo', 'doing', 'done'].includes(String(status))) throw new Error('Invalid task status')
      // parsePriority would quietly degrade a typo to 'normal'; an agent deserves to hear that its edit did nothing.
      if (args.priority !== undefined && !projectTaskPriorities.includes(args.priority as ProjectTaskPriority)) throw new Error('Invalid task priority')
      const updated = await backlogs.edit(scope.projectId, text(args, 'revision', 100), { type: 'update', id, status: status as 'todo' | 'doing' | 'done', ...(args.title === undefined ? {} : { title: text(args, 'title', PROJECT_TASK_MAX_LENGTH) }), ...(args.priority === undefined ? {} : { priority: args.priority as ProjectTaskPriority }), agentId: scope.agentSessionId }, { actor: 'agent', agentId: scope.agentSessionId, sessionId: scope.sessionId })
      this.deps.fileChanged({ ...scope, path: 'feature-list.md' })
      return updated
    }
    if (method === 'memory.recall') return database.recall(scope.projectId, typeof args.query === 'string' ? args.query.slice(0, 4000) : '', undefined, 12)
    if (method === 'memory.remember') {
      const kind = args.kind ?? 'semantic'
      if (!isMemoryKind(kind)) throw new Error('Invalid memory kind')
      if (args.cues !== undefined && (!Array.isArray(args.cues) || args.cues.length > 20 || args.cues.some(cue => typeof cue !== 'string' || cue.length > 160))) throw new Error('Invalid memory cues')
      return database.remember({
        projectId: scope.projectId, kind, source: 'agent',
        // Attribution comes from the authorized scope, never from the caller's arguments.
        origin: { agentSessionId: scope.agentSessionId, workspaceId: scope.sessionId, title: source.title, provider: source.provider },
        gist: text(args, 'gist', 4000), cues: args.cues as string[] | undefined
      })
    }
    if (method === 'memory.forget') {
      const memory = database.listMemories(scope.projectId).find(memory => memory.id === args.id)
      if (!memory || memory.source !== 'agent') throw new Error('Only agent-authored memories from this project can be forgotten')
      await this.ask(scope, `${source.title} wants to forget this agent memory:\n${memory.gist}`, 'forget this memory')
      this.authorize(scope); database.removeMemory(memory.id); return { removed: true }
    }
    if (method === 'orchestration.snapshot') return orchestration.snapshot(scope.projectId)
    if (method === 'orchestration.tasks.create') return orchestration.createTask({ ...args, projectId: scope.projectId, title: text(args, 'title', 300) } as CreateOrchestrationTaskInput)
    if (method === 'orchestration.tasks.update') {
      const id = text(args, 'id', 160)
      if (!orchestration.listTasks(scope.projectId).some(task => task.id === id)) throw new Error('Task is outside this project')
      return orchestration.updateTask(id, args as UpdateOrchestrationTaskInput)
    }
    if (method === 'orchestration.routines.save') {
      if (!Array.isArray(args.steps) || args.steps.length > 100) throw new Error('Invalid routine steps')
      return orchestration.saveRoutine({ ...args, projectId: scope.projectId, name: text(args, 'name', 200) } as unknown as SaveRoutineInput)
    }
    if (method.startsWith('app.update')) return this.localUpdate(scope, source, method, args)
    if (method.startsWith('git.')) return this.deliver(scope, source, method, args)
    if (method === 'workspace.rename') return this.ui(scope, 'workspace.rename', { title: text(args, 'title', 120) })
    if (method === 'router.start') return this.startRouter(scope, args)
    if (method === 'router.dispatch') return this.dispatchRouter(scope, args)
    if (jobMethods.has(method)) return this.jobs(scope, source, method, args)
    throw new Error('Unknown control method; use tools.list')
  }

  /** A job tab is a view of one durable job: its resourceId is the job id, so closing, splitting,
   *  reopening or reloading the tab never changes which job it shows, and the job runs whether or
   *  not any tab shows it. One tab per job and workspace: asking again focuses the open one. */
  private async openJobTab(scope: AgentControlScope, args: Args): Promise<AgentControlTab & { projectId: string; workspaceId: string }> {
    const service = this.deps.durableJobs
    if (!service) throw new Error('Durable jobs are unavailable in this Conductor')
    if (args.projectId !== undefined && args.projectId !== scope.projectId || args.workspaceId !== undefined && args.workspaceId !== scope.sessionId) throw new Error('A job tab opens in the caller’s own workspace')
    const job = this.job(scope, service, args)
    const existing = this.tabs(scope).find(tab => tab.kind === 'job' && tab.resourceId === job.id)
    if (existing) {
      if (args.focus !== false) await this.ui(scope, 'tabs.focus', { tabId: existing.id })
      return { ...existing, projectId: scope.projectId, workspaceId: scope.sessionId }
    }
    const tab: PaneTab = { id: makeId('tab'), kind: 'job', title: args.title === undefined ? job.title.slice(0, 120) : text(args, 'title', 120), resourceId: job.id }
    await this.ui(scope, 'tabs.open', { tab, ...(args.focus === false ? { focus: false } : {}) })
    return { ...this.tab(scope, tab.id), projectId: scope.projectId, workspaceId: scope.sessionId }
  }

  /** Plugs in the durable job controller once it is constructed (src/main/index.ts); undefined
   *  unplugs it. jobs.* methods and job tabs answer only while one is set. */
  setDurableJobs(service: DurableJobsService | undefined): void { this.deps.durableJobs = service }

  /** The job a jobs.* call names, only when it belongs to the caller's project. Another project's
   *  job reads as missing, so its id discloses nothing. */
  private job(scope: AgentControlScope, service: DurableJobsService, args: Args): DurableJobSummary {
    const jobId = text(args, 'jobId', 160)
    let summary: DurableJobSummary
    try { summary = service.status(jobId) } catch { throw new Error('No durable job with that id in this project; use jobs.list') }
    if (summary.projectId !== scope.projectId) throw new Error('No durable job with that id in this project; use jobs.list')
    return summary
  }

  /** Who may change a job: the owner (credential or wizard tab), or the writable, non-local
   *  conversation that created it. A local model never steers a job: pausing, resuming or
   *  cancelling is the owner's or its controller's decision, and nothing here can switch a job
   *  to a cloud model. */
  private mayChangeJob(scope: AgentControlScope, source: AgentSpec, service: DurableJobsService, jobId: string): void {
    if (sovereign(scope)) return
    if (source.provider === 'local') throw new Error('A sandboxed local conversation cannot change a durable job; the owner, a wizard tab or the conversation that created the job can')
    if (restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
    if (service.get(jobId).createdBy?.agentSessionId !== scope.agentSessionId) throw new Error('Only the owner, a wizard tab or the conversation that created this job may pause, resume or cancel it')
  }

  private async jobs(scope: AgentControlScope, source: AgentSpec, method: string, args: Args): Promise<unknown> {
    const service = this.deps.durableJobs
    if (!service) throw new Error('Durable jobs are unavailable in this Conductor')
    const allowed = jobKeys[method]!
    const extra = Object.keys(args).filter(key => !allowed.includes(key) && key !== 'projectId')
    if (extra.length) throw new Error(`${method} accepts only ${allowed.join(', ') || 'no arguments'}; ${extra.join(', ')} is not an argument`)
    if (method === 'jobs.list') {
      let status: DurableJobStatus[] | undefined
      if (args.status !== undefined) {
        status = strings(args.status, 'status', DURABLE_JOB_STATUSES.length, 20) as DurableJobStatus[]
        if (status.some(value => !DURABLE_JOB_STATUSES.includes(value))) throw new Error(`status names job statuses: ${DURABLE_JOB_STATUSES.join(', ')}`)
      }
      return service.list({ projectId: scope.projectId, ...(status ? { status } : {}) })
    }
    if (method === 'jobs.create') return this.createJob(scope, source, service, args)
    const summary = this.job(scope, service, args)
    if (method === 'jobs.status') return summary
    if (method === 'jobs.events') {
      const limit = args.limit === undefined ? 50 : args.limit
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive whole number')
      return service.events(summary.id, args.afterId === undefined ? undefined : text(args, 'afterId', 160), Math.min(limit, 200))
    }
    if (method === 'jobs.report') {
      const report = await service.report(summary.id)
      return { ...report, note: 'The report is a file beside the job logs; read reportPath for the full account. Log paths are listed, not pasted.' }
    }
    this.mayChangeJob(scope, source, service, summary.id)
    const reason = args.reason === undefined ? undefined : text(args, 'reason', 500)
    this.authorize(scope)
    if (method === 'jobs.pause') return service.pause(summary.id, reason)
    if (method === 'jobs.resume') return service.resume(summary.id)
    return service.cancel(summary.id, reason)
  }

  private async createJob(scope: AgentControlScope, source: AgentSpec, service: DurableJobsService, args: Args): Promise<DurableJobSummary> {
    if (!sovereign(scope)) {
      if (source.provider === 'local') throw new Error('A sandboxed local conversation cannot start a durable job; the owner, a wizard tab or a non-local coworker can')
      if (restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
    }
    const objective = text(args, 'objective', 20000)
    const model = text(args, 'model', 200)
    // Only a local entry: the catalog the caller sees (runtime models first) or the configured
    // local models. A cloud model id is refused by name, never mapped to something local.
    const local = [...(this.catalog(scope).find(entry => entry.provider === 'local')?.models ?? []), ...(this.deps.providers().find(provider => provider.id === 'local')?.models ?? [])]
    if (!local.some(entry => entry.id === model)) throw new Error(`Durable jobs run on a local model only; ${model} is not a local entry of models.list`)
    const input: CreateDurableJobInput = {
      projectId: scope.projectId, workspaceId: scope.sessionId,
      title: args.title === undefined ? objective.replace(/\s+/g, ' ').trim().slice(0, 80) : text(args, 'title', 120),
      objective, model,
      createdBy: { kind: scope.owner ? 'owner' : scope.wizard ? 'wizard' : 'agent', agentSessionId: scope.agentSessionId, title: source.title }
    }
    if (args.constraints !== undefined) input.constraints = strings(args.constraints, 'constraints', 50, 2000)
    if (args.isolateWorktree !== undefined) {
      if (typeof args.isolateWorktree !== 'boolean') throw new Error('isolateWorktree must be true or false')
      input.isolateWorktree = args.isolateWorktree
    }
    if (args.stages !== undefined) {
      if (!Array.isArray(args.stages) || !args.stages.length || args.stages.length > 50) throw new Error('stages must be a list of 1 to 50 stages')
      input.stages = args.stages.map((raw, index) => {
        const stage = object(raw)
        if (Object.keys(stage).some(key => !['title', 'objective', 'completionCriteria'].includes(key))) throw new Error(`stage ${index + 1} accepts only title, objective and completionCriteria`)
        return { title: text(stage, 'title', 200), objective: text(stage, 'objective', 8000), completionCriteria: strings(stage.completionCriteria ?? [], 'completionCriteria', 20, 1000) }
      })
    }
    if (args.budgets !== undefined) {
      const budgets = object(args.budgets), known = [...Object.keys(DEFAULT_DURABLE_JOB_BUDGETS), 'stagePromptBudgetTokens']
      const unknown = Object.keys(budgets).filter(key => !known.includes(key))
      if (unknown.length) throw new Error(`budgets accepts only ${known.join(', ')}`)
      for (const [key, value] of Object.entries(budgets)) if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`budgets.${key} must be a non-negative number`)
      input.budgets = budgets as CreateDurableJobInput['budgets']
    }
    this.authorize(scope)
    // The service persists createdBy on the job: the creator is who may pause, resume and cancel
    // it besides the owner.
    return service.create(input)
  }

  /**
   * Delivery runs on the host because a sandboxed conversation cannot reach GitHub, and asking
   * to leave the sandbox for every git call is what made finishing a task a chore. A cloud
   * coworker is already bound by the project's delivery contract to commit and push, so it ships
   * without a dialog; a sandboxed local model runs host code only when the owner confirms.
   */
  private async deliver(scope: AgentControlScope, source: AgentSpec, method: string, args: Args): Promise<unknown> {
    const delivery = this.deps.delivery
    if (!delivery) throw new Error('Delivery is unavailable in this Conductor')
    const wait = (): number => {
      if (args.waitSeconds === undefined) return 0
      if (typeof args.waitSeconds !== 'number' || !Number.isFinite(args.waitSeconds) || args.waitSeconds < 0) throw new Error('waitSeconds must be a number of seconds')
      return Math.min(args.waitSeconds, 100) * 1000
    }
    const settle = async (run: DeliveryRun | null): Promise<DeliveryRun | null> => run && run.state === 'running' && wait() ? delivery.wait(scope.projectId, run.id, wait()) : run
    if (method === 'git.status') return delivery.status(scope.projectId, source.cwd)
    if (method === 'git.ship.status') {
      if (Object.keys(args).some(key => !['runId', 'waitSeconds'].includes(key))) throw new Error('git.ship.status accepts only runId and waitSeconds')
      const run = delivery.current(scope.projectId)
      if (args.runId !== undefined && run?.id !== text(args, 'runId', 160)) throw new Error('That delivery is no longer the latest one for this project')
      return await settle(run) ?? { state: 'idle', note: 'No delivery has run for this project since Conductor started.' }
    }
    if (method !== 'git.ship') throw new Error('Unknown control method; use tools.list')
    if (Object.keys(args).some(key => !['message', 'paths', 'publish', 'waitSeconds'].includes(key))) throw new Error('git.ship accepts only message, paths, publish and waitSeconds')
    if (args.publish !== undefined && typeof args.publish !== 'boolean') throw new Error('publish must be true or false')
    if (restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
    const message = text(args, 'message', 5000)
    let paths: string[] | undefined
    if (args.paths !== undefined) {
      if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 500 || args.paths.some(path => typeof path !== 'string' || !path)) throw new Error('paths must be a non-empty list of repository paths')
      paths = args.paths as string[]
    }
    // A delivery is a local commit; only an explicit publish pushes and builds a release
    // (delivery.ts), and the owner is asked for exactly the one that will happen.
    const publish = args.publish === true
    if (source.provider === 'local') await this.ask(scope, publish ? `${source.title} wants to test, build and commit this project, push it and publish its release.` : `${source.title} wants to test, build and commit this project on this machine (no push, no release).`, 'deliver this project')
    this.authorize(scope)
    const run = delivery.ship(scope.projectId, source.cwd, { message, ...(paths ? { paths } : {}), ...(publish ? { publish } : {}) }, scope.owner ? { kind: 'owner' } : { kind: 'agent', agentSessionId: scope.agentSessionId, title: source.title })
    return settle(run)
  }

  /**
   * Building the installed app from this working tree runs host code, which is exactly what a
   * sandboxed local model is otherwise kept away from — so the build is never something a
   * conversation decides on its own. Either the owner confirms this one, or a coworker that is
   * not itself sandboxed authorized this conversation for it beforehand and still has its tab
   * open. The build only publishes into the local feed; accepting the update stays a click the
   * owner makes in the app.
   */
  /** Asks the owner and throws unless they allowed it, saying whether they declined or were never reached. */
  private async ask(scope: AgentControlScope, message: string, action: string): Promise<void> {
    // The owner's own credential, or a wizard tab, is the owner answering: nobody else to ask.
    if (sovereign(scope)) return
    const answer = await this.deps.confirm(scope, message)
    const outcome: AgentConfirmOutcome = answer === true ? 'allowed' : answer === false ? 'declined' : answer
    if (outcome !== 'allowed') throw new Error(agentConfirmFailure(outcome, action))
  }

  /** The owner-only methods: the app itself, not a conversation in it. Each answers at once;
   *  an install or restart is started after the reply has left, since the process it ends is
   *  the one sending the reply. */
  private async ownerCall(scope: AgentControlScope, method: string, args: Args): Promise<unknown> {
    const host = this.deps.host
    if (method === 'projects.open') {
      if (!host?.openProject) throw new Error('Registering a project folder is unavailable in this Conductor')
      if (Object.keys(args).some(key => !['path', 'name'].includes(key))) throw new Error('projects.open accepts only path and name')
      const project = await host.openProject(text(args, 'path', 4000), args.name === undefined ? undefined : text(args, 'name', 200))
      return { id: project.id, name: project.name, path: project.path, workspaces: this.deps.database.listSessions(project.id).map(workspace => ({ id: workspace.id, name: workspace.name })) }
    }
    if (!host) throw new Error('App updates and restarts are unavailable in this Conductor')
    if (args.force !== undefined && typeof args.force !== 'boolean') throw new Error('force must be true or false')
    const force = args.force === true
    const later = (label: string, work: () => Promise<void>): void => { setTimeout(() => { work().catch(error => console.warn(`${label} failed`, error)) }, 150) }
    if (method === 'app.restart') {
      later('app.restart', () => host.relaunch(force))
      return { restarting: true, force, note: 'Conductor relaunches; a downloaded update installs on the way out. Wait for a new control-owner.json (new pid) before calling again.' }
    }
    if (!host.updates) throw new Error('The updater is unavailable in this Conductor')
    if (method === 'app.update.check') return host.updates.check()
    if (method === 'app.update.download') return host.updates.download()
    if (method === 'app.update.install') {
      const state = host.updates.state()
      if (state.phase !== 'ready') throw new Error(`No downloaded update to install (phase ${state.phase}). Call app.update.check, then app.update.download, and poll app.update.check until the phase is ready.`)
      later('app.update.install', () => host.updates!.install(force))
      return { installing: true, version: state.availableVersion ?? null, force, note: 'Conductor quits, installs and relaunches. Wait for a new control-owner.json (new pid) before calling again.' }
    }
    throw new Error('Unknown control method; use tools.list')
  }

  private async localUpdate(scope: AgentControlScope, source: AgentSpec, method: string, args: Args): Promise<unknown> {
    const builder = this.deps.localUpdates
    if (!builder) throw new Error('Local update builds are unavailable in this Conductor')
    if (method === 'app.update.status') return builder.status()
    if (method === 'app.update.authorize') {
      if (restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
      if (source.provider === 'local') throw new Error('A sandboxed local conversation cannot authorize app.update. The owner confirms it, or a non-local coworker grants it.')
      const id = text(args, 'agentSessionId', 160)
      if (Object.keys(args).some(key => !['agentSessionId', 'allowed'].includes(key))) throw new Error('app.update.authorize accepts only agentSessionId and allowed')
      if (args.allowed !== undefined && typeof args.allowed !== 'boolean') throw new Error('allowed must be true or false')
      // Ownership is the same rule steering uses: a tab this caller may drive, never itself.
      this.target(scope, id, true)
      if (args.allowed === false) { this.updateGrants.delete(id); return { agentSessionId: id, authorized: false } }
      this.updateGrants.set(id, { controllerAgentSessionId: scope.agentSessionId, projectId: scope.projectId, grantedAt: new Date().toISOString() })
      return { agentSessionId: id, authorized: true, grantedBy: scope.agentSessionId, note: 'That conversation can now run app.update without the owner dialog while this tab stays open and Conductor keeps running.' }
    }
    if (method !== 'app.update') throw new Error('Unknown control method; use tools.list')
    if (restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
    const unsupported = builder.unsupported(source.cwd)
    if (unsupported) throw new Error(unsupported)
    const running = builder.status()
    if (running.state === 'running') return { ...running, note: 'A local update build is already running; poll app.update.status.' }
    const grant = this.updateGrants.get(scope.agentSessionId)
    // A grant lapses with the tab that issued it: nobody is left to answer for the build.
    const granted = Boolean(grant && this.claimHolderIsOpen(grant.projectId, grant.controllerAgentSessionId))
    if (!granted) {
      this.updateGrants.delete(scope.agentSessionId)
      await this.ask(scope, `${source.title} wants to build Conductor from this working tree and publish it as a local update.`, 'build a local update')
    }
    this.authorize(scope)
    return { ...builder.start(source.cwd), authorizedBy: granted ? grant!.controllerAgentSessionId : 'owner' }
  }

  private router(scope: AgentControlScope, provider: StructuredProvider, model: string) {
    const { orchestration } = this.deps
    const existing = orchestration.listAgents(scope.projectId).find(agent => agent.role === 'conductor-router')
    const agent = orchestration.saveAgent({ id: existing?.id, projectId: scope.projectId, name: 'Conductor router', provider, model, role: 'conductor-router', instructions: 'Coordinate the user task. Read models.list and app.state once. Choose available models deliberately for up to four independent tasks; use router.dispatch with explicit provider/model and clear bounded prompts. Wait by reading agents.history incrementally; avoid polling excessively. Review results, integrate, and report. Use tasks.update for checklist progress and memory.remember only for reusable findings. Do not spawn another router or duplicate assigned work.' })
    let routine = orchestration.listRoutines(scope.projectId).find(routine => routine.name === 'Conductor router')
    if (!routine) routine = orchestration.saveRoutine({ projectId: scope.projectId, name: 'Conductor router', description: 'Select native models, dispatch visible coworker tabs, then integrate their results.', steps: [{ title: 'Route and coordinate the task', instructions: agent.instructions, assignedAgentId: agent.id }] })
    return { agent, routine }
  }

  private async startRouter(scope: AgentControlScope, args: Args): Promise<unknown> {
    const prompt = text(args, 'prompt', MAX_PROMPT_CHARS)
    const tab = await this.open(scope, { ...args, kind: 'agent', title: 'Conductor router' })
    const { agent, routine } = this.router(scope, tab.state!.provider as StructuredProvider, String(tab.state!.model))
    const started = this.deps.orchestration.startRoutine(routine.id), task = started.tasks[0]!
    this.deps.orchestration.updateTask(task.id, { status: 'in_progress', description: prompt })
    try { await this.call(scope, 'agents.submit', { agentSessionId: tab.resourceId, prompt: agent.instructions + '\n\nTask: ' + prompt + '\n\nYour orchestration task ID is ' + task.id + '. Mark it done only after integrating the results.' }) }
    catch (error) { this.deps.orchestration.updateTask(task.id, { status: 'blocked' }); throw error }
    return { tab, agent, routine, run: started.run, taskId: task.id }
  }

  private async dispatchRouter(scope: AgentControlScope, args: Args): Promise<unknown> {
    if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 4) throw new Error('Route one to four bounded tasks per call')
    const seen = new Set<string>()
    const requests: Array<Args & { projectTaskIds: string[] }> = args.tasks.map(value => {
      const request = object(value); text(request, 'title', 120); text(request, 'prompt', MAX_PROMPT_CHARS)
      const ids = request.projectTaskIds ?? []
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id || id.length > 160 || seen.has(id) || !seen.add(id))) throw new Error('Provide distinct exact project task IDs across this dispatch')
      // A checklist claim is owned by the project whose feature-list.md holds it, and only an
      // agent of that project can be seen to still hold it. Handing one across would strand it.
      if (ids.length && request.projectId !== undefined && request.projectId !== scope.projectId) throw new Error('A worker in another project cannot take this project’s task claims; dispatch it without projectTaskIds')
      return { ...request, projectTaskIds: ids as string[] }
    })
    if (seen.size && restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('A read-only or planning controller cannot assign project tasks')
    const board = seen.size ? await this.deps.backlogs.get(scope.projectId) : undefined
    const selected = new Map((board?.tasks ?? []).filter(task => seen.has(task.id)).map(task => [task.id, task]))
    const claimable = (task: NonNullable<typeof board>['tasks'][number] | undefined): boolean => Boolean(task && task.status !== 'done' && (task.agentId === scope.agentSessionId || task.status === 'todo'))
    for (const id of seen) if (!claimable(selected.get(id))) throw new Error('A selected project task is missing, finished, or owned by another active agent')
    const results: unknown[] = []
    // Whoever is dispatching, if they are themselves a roster identity (the Conductor router, the
    // Auto Fixer), owns every run started here.
    const dispatcherAgentId = this.deps.orchestration.snapshot(scope.projectId).agents
      .find(agent => agent.role === 'conductor-router' || agent.role === 'auto-fixer')?.id ?? null
    for (const request of requests) {
      const tab = await this.open(scope, { ...request, kind: 'agent', ...(request.projectTaskIds.length ? { focus: false } : {}) })
      // A dispatched coworker is a run of this work, not a new identity. Minting an agent per
      // dispatch turned the roster into a task log; the task row below already records the run,
      // and it is attributed to the reusable agent that dispatched it when there is one.
      const task = this.deps.orchestration.createTask({ projectId: scope.projectId, title: String(request.title), description: String(request.prompt), status: 'in_progress', assignedAgentId: dispatcherAgentId })
      let accepted = false
      try {
        await this.deps.sessions.connectSession(tab.resourceId!)
        const state = this.deps.database.structured.snapshot(tab.resourceId!)!
        const model = state.capabilities?.models.find(model => model.id === tab.state!.model)
        if (!model || state.settings.effort && !model.effort?.includes(state.settings.effort)) throw new Error('The native runtime did not advertise the selected model and effort; no worker prompt was sent')
        if (request.projectTaskIds.length) {
          const current = await this.deps.backlogs.get(scope.projectId)
          for (const id of request.projectTaskIds) {
            const before = selected.get(id)!, latest = current.tasks.find(task => task.id === id)
            if (!claimable(latest) || latest?.title !== before.title || latest?.status !== before.status || latest?.agentId !== before.agentId) throw new Error('A selected task changed before native dispatch; review its current owner before retrying')
          }
        }
        const ownership = request.projectTaskIds.length ? '\n\nExact Project tasks assigned to this worker: ' + request.projectTaskIds.join(', ') + '. Read tasks.list before updating these IDs. Ownership is transferred immediately after prompt acceptance; wait for the handoff if it is not visible yet. Do not seize unrelated claims.' : ''
        // The orchestration row belongs to the dispatching project, so a worker handed to a
        // sibling project is not asked to close a task it cannot even see; its controller does that.
        const coordination = tab.projectId === scope.projectId
          ? tab.state!.provider === 'local'
            ? '\n\nConductor orchestration task: ' + task.id + '. When finished, report concrete evidence, tests, and remaining limitations to your controller ' + scope.agentSessionId + '. Your controller updates the orchestration task. Deliver with git.ship({message, paths}) as a local commit only; never pass publish: true. Your controller publishes one release for the whole batch when it is done.'
            : '\n\nConductor orchestration task: ' + task.id + '. Mark it done with orchestration.tasks.update only after finishing. Your controller is ' + scope.agentSessionId + '; coordinate through the provided app protocol. Deliver with git.ship({message, paths}) as a local commit only; never pass publish: true. Your controller publishes one release for the whole batch when it is done.'
          : '\n\nThis work was handed to the ' + (this.deps.database.getProject(tab.projectId)?.name ?? 'this') + ' project by a coworker in ' + (this.deps.database.getProject(scope.projectId)?.name ?? 'another project') + '. You work only in this project; your controller is ' + scope.agentSessionId + ' and tracks the task on its own side, so report your result here rather than looking for its task board.'
        await this.call(scope, 'agents.submit', { agentSessionId: tab.resourceId, prompt: String(request.prompt) + ownership + coordination })
        accepted = true
        if (request.projectTaskIds.length) {
          let current = await this.deps.backlogs.get(scope.projectId)
          for (const id of request.projectTaskIds) {
            const latest = current.tasks.find(task => task.id === id)
            if (latest?.agentId === tab.resourceId) continue
            if (!claimable(latest)) throw new Error('Worker prompt accepted, but task ownership changed. Inspect the worker; do not submit the task again.')
            current = await this.deps.backlogs.edit(scope.projectId, current.revision, { type: 'update', id, status: 'doing', agentId: tab.resourceId! }, { actor: 'agent', agentId: scope.agentSessionId, sessionId: scope.sessionId })
          }
          this.deps.fileChanged({ ...scope, path: 'feature-list.md' })
        }
        results.push({ tabId: tab.id, agentSessionId: tab.resourceId, taskId: task.id, projectTaskIds: request.projectTaskIds, projectId: tab.projectId, workspaceId: tab.workspaceId, provider: tab.state!.provider, model: tab.state!.model, effort: state.settings.effort, uri: tab.uri, accepted })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A worker that never received its prompt has nothing to inspect: its tab and task row
        // would only be clutter the owner has to close. One that did (or might have) keeps both.
        const worker = this.deps.database.structured.snapshot(tab.resourceId!)
        const untouched = !accepted && worker && !['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(worker.phase) && !worker.items.some(item => item.data.type === 'text' && item.data.role === 'user')
        if (untouched) {
          const target = { ...scope, projectId: tab.projectId, sessionId: tab.workspaceId }
          this.relationship(scope, target, tab, 'detached')
          this.deps.orchestration.removeTask(task.id)
          let tabClosed = true
          try { await this.ui(target, 'tabs.close', { tabId: tab.id }) } catch { tabClosed = false }
          results.push({ tabId: tab.id, agentSessionId: tab.resourceId, projectTaskIds: request.projectTaskIds, projectId: tab.projectId, workspaceId: tab.workspaceId, accepted, error: message, tabClosed })
          continue
        }
        this.deps.orchestration.updateTask(task.id, { status: 'blocked' })
        results.push({ tabId: tab.id, agentSessionId: tab.resourceId, taskId: task.id, projectTaskIds: request.projectTaskIds, projectId: tab.projectId, workspaceId: tab.workspaceId, accepted, error: message })
      }
    }
    return results
  }

  /**
   * Hands the caller's own remaining work to a fresh conversation. This is the other half of the
   * context-cost nudge: a long session pays for its whole transcript on every call, and a bounded
   * handoff into a new tab buys back that history at the price of writing it down once.
   *
   * Only ever the caller. A method that could hand off *another* tab would be a way to empty a
   * coworker's context from outside it, and nobody but a conversation knows what its own
   * remaining work is. The caller keeps its tab, its history and its steering rights over what it
   * opened; nothing here interrupts or closes it, because a turn cut off mid-step loses exactly
   * the state the handoff is supposed to carry.
   */
  private async handoff(scope: AgentControlScope, args: Args): Promise<unknown> {
    const { database } = this.deps
    const spec = this.authorize(scope)
    if (args.agentSessionId !== undefined) throw new Error('agents.handoff always hands off the calling conversation and takes no agentSessionId. To give work to a different tab, use agents.submit.')
    const handoff = handoffText(args)
    const settings = settingsForRuntime(database.structured.snapshot(scope.agentSessionId)!.settings)
    const source = this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)
    // The receiver is this conversation continued, so it is named after it. Kept short enough
    // that a repeated handoff cannot grow an unbounded tab title.
    const title = args.title === undefined ? (source?.title ?? spec.title).slice(0, 100).replace(/ \(continued\)$/, '') + ' (continued)' : text(args, 'title', 120)
    // Deliberately the ordinary tabs.open path: same catalog check, same machine inheritance,
    // same permission clamping. Provider is inherited by omission; model, effort and permission
    // are named so the receiver continues on this conversation's settings rather than on the
    // provider default or the owner's remembered mode. A read-only or planning caller therefore
    // hands off to a read-only or planning receiver, which is why it is allowed to hand off at all.
    const tab = await this.open(scope, {
      // The same agent continuing: it keeps the mode the owner set on the caller, not a dispatch default.
      kind: 'agent', title, model: settings.model ?? spec.model, permission: settings.permission, exactPermission: true,
      ...(settings.effort ? { effort: settings.effort } : {})
    })
    // A tab placed on a paired machine comes back in the remote shape, which names the session
    // differently and may not be steerable from here at all.
    const agentSessionId = tab.resourceId ?? (tab as { agentSessionId?: string }).agentSessionId
    if (!agentSessionId) throw new Error(`The handoff tab “${title}” opened, but this machine cannot deliver a prompt to it. Submit the handoff to it yourself with agents.submit before you stop.`)
    try { await this.call(scope, 'agents.submit', { agentSessionId, prompt: handoff }) }
    catch (error) {
      // The tab exists but holds no work. Say so plainly: the caller must not read a failure here
      // as permission to stop.
      throw new Error(`The handoff tab “${title}” opened but would not accept the handoff, so nothing was handed over — keep working in this conversation: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The audit trail for a context handoff, alongside the control link tabs.open recorded.
    this.deps.collaboration.postMessage({ projectId: scope.projectId, sessionId: scope.sessionId, agentSessionId: scope.agentSessionId, toAgentSessionId: agentSessionId, kind: 'handoff', body: `Handed the remaining work to “${tab.title ?? title}”. This conversation finishes its current step and stops.`, metadata: { handoff: 'context', fromTabId: source?.id, toTabId: tab.id, characters: handoff.length } })
    const created = database.structured.snapshot(agentSessionId)
    return {
      handedOff: true, tabId: tab.id, agentSessionId, uri: tab.uri, projectId: tab.projectId, workspaceId: tab.workspaceId,
      title: tab.title ?? title, provider: spec.provider, model: created?.settings.model ?? null, effort: created?.settings.effort ?? null, permission: created?.settings.permission ?? null,
      note: 'The remaining work now belongs to that tab, which has the handoff as its first prompt. Finish only the step you are already in, report it, and stop — do not carry on with the handed-over work here in parallel. Your tab stays open and you may still steer the new one with agents.*.'
    }
  }

}
