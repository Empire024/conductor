import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import {
  CONTROL_IDS, FINDING_STATUSES, MUTATION_KINDS, PRODUCTION_CONTROL_METHODS, PRODUCTION_LOCAL_METHODS, PRODUCTION_SOVEREIGN_METHODS, REVIEW_ANSWERS, SEVERITIES,
  type ControlId, type DriftSettings, type Finding, type FindingStatus, type MutationKind, type ProductionControlMethod, type ProfileUpdate,
  type ReviewAnswer, type Severity, type Waiver,
} from '../../shared/production'
import { maskSecrets } from '../structured-store'
import type { Actor, ProductionService } from './index'
import type { RunRequestOutcome } from './triggers'

/**
 * production.* app-control methods (docs/production-agent.md sections 2, 4.7 and 11 M8). Every
 * method acts in the caller's own project, or for the owner or a wizard tab in the co-open project
 * its projectId names (agent-control resolves it into caller.projectId). Who may call what is decided here from the caller facts
 * agent-control derives from the authorized scope, never from anything the caller sends:
 * - PRODUCTION_SOVEREIGN_METHODS (designation, owner answers, review answers, waivers, write
 *   authorizations, drift) need the owner's credential or a wizard tab;
 * - the other mutations need a writable conversation of the project that is not a local model;
 * - reads are open to the project, except evidence and report contents (writable or sovereign);
 * - a local model reaches only PRODUCTION_LOCAL_METHODS.
 * Every refusal names the next step.
 */

export const productionSignatures: Readonly<Record<ProductionControlMethod, string>> = {
  'production.status': '({environmentId?}) — the project\'s production audit: gate state with every reason (never a percentage), designation, active run with progress, recent runs, per-control results with human-review items, open findings (top 50), open owner questions, live waivers, browser availability. Every production.* method also takes projectId? naming a co-open project (projects.list), for the owner or a wizard tab only',
  'production.queue': '() — one row per project designated production-ready: gate, open critical/high findings, open questions, active run, last completed audit',
  'production.registry': '({controlId?}) — the sixteen controls (C01-C16): sources, applicability predicate, provenance with dates, evidence requirements, checks',
  'production.runs': '({limit?}) — the project\'s audit runs, newest first, with progress and budget ledger',
  'production.run': '({runId}) — one run: steps, checkpoint, ledger, coverage, latest events, results',
  'production.findings': '({findingId?,status?,controlId?,severity?,limit?,offset?}) — findings of the designated environment with stable ids, expected/observed, reproduction, evidence ids, verification and task links',
  'production.report': '({runId?,format?}) — the report of a run (default the last completed): format "markdown" (default) or "json", bounded to 1 MiB and secret-masked; writable conversations and the owner only',
  'production.evidence': '({runId,evidenceId}) — one evidence file of a run: text bounded to 1 MiB and secret-masked, or the path and size of a binary (screenshot); writable conversations and the owner only',
  'production.profile.get': '() — the versioned production profile: facts with their status and source, environments, scope, budget, drift settings, owner questions',
  'production.profile.update': '({facts?,environments?,scope?,budget?}) — change the profile (a new version). A conversation may record facts only, and they stay assumptions; environments, scope, budget and evidenced facts need the owner or a wizard tab. Facts from a wizard tab are recorded with source "wizard" (never "owner") and a wizard cannot change a fact the owner set',
  'production.designate': '({productionReady,environmentId?,note}) — owner or wizard: mark the project production-ready for an environment (starts an audit) or withdraw it',
  'production.answer': '({questionId,answer} | {questionId,dismiss}) — owner or wizard: answer an owner question (the fact becomes evidenced, source "owner" or "wizard" by who answered) or dismiss it with a reason',
  'production.review.answer': '({itemId,answer,note?,environmentId?}) — owner or wizard: answer a human-review item of the last completed run, answer "confirmed" or "rejected"; once every item of a control is answered its NEEDS_HUMAN_REVIEW cap lifts, and a rejection makes it FAIL',
  'production.audit': '({environmentId?,controls?,full?}) — start an audit of the designated environment (or one control subset); a trigger during an active run coalesces into one follow-up run',
  'production.retest': '({findingIds}) — re-run the checks of these findings',
  'production.verify': '({findingIds}) — an independent Production Verifier run on these findings: a fresh browser, no prior evidence; only it can mark a finding fixed',
  'production.pause': '({runId,reason?}) — pause a run at its next checkpoint',
  'production.resume': '({runId}) — resume a paused or blocked run from its checkpoint',
  'production.cancel': '({runId,reason}) — cancel a run',
  'production.tasks.create': '({findingIds}) — file or reopen one orchestration board task per finding (critical and high ones are filed by the audit itself); never changes a finding\'s status',
  'production.waive': '({findingId,reason,scope,owner,expiresAt}) — owner or wizard: waive a finding until expiresAt; the finding stays, and the waiver records who granted it and why',
  'production.waivers.revoke': '({waiverId,reason}) — owner or wizard: revoke a waiver',
  'production.writes.authorize': '({environmentId,mutations,expiresAt,note}) — owner or wizard: allow the named mutations in one non-production environment until expiresAt (production is always refused)',
  'production.writes.revoke': '({authorizationId}) — owner or wizard: revoke a sandbox write authorization',
  'production.drift': '({enabled?,everyMinutes?,onChange?,runNow?}) — owner or wizard: the opt-in drift check (a disabled schedule until enabled); onChange "mark-stale" or "audit"; runNow checks once now',
}

export const productionMethods: ReadonlySet<string> = new Set(PRODUCTION_CONTROL_METHODS)
/** For control-method-classes.ts. */
export const PRODUCTION_READ_METHODS = ['production.status', 'production.queue', 'production.registry', 'production.runs', 'production.run', 'production.findings', 'production.report', 'production.evidence', 'production.profile.get'] as const satisfies readonly ProductionControlMethod[]
export const PRODUCTION_MUTATION_METHODS = PRODUCTION_CONTROL_METHODS.filter(method => !(PRODUCTION_READ_METHODS as readonly string[]).includes(method))
/** Reads that hand out artifact contents or paths: sovereign callers and writable conversations only. */
const ARTIFACT_READS: readonly string[] = ['production.report', 'production.evidence']
const MAX_ARTIFACT_BYTES = 1024 * 1024

/** Who is calling, decided by agent-control from the authorized scope and durable settings. */
export interface ProductionCaller {
  projectId: string
  agentSessionId: string
  title: string
  owner: boolean
  wizard: boolean
  /** The owner's credential or a wizard tab. */
  sovereign: boolean
  /** A local model. */
  local: boolean
  /** A read-only or planning conversation. */
  readOnly: boolean
}

const keys: Readonly<Record<ProductionControlMethod, readonly string[]>> = {
  'production.status': ['environmentId'], 'production.queue': [], 'production.registry': ['controlId'], 'production.runs': ['limit'], 'production.run': ['runId'],
  'production.findings': ['findingId', 'status', 'controlId', 'severity', 'limit', 'offset'], 'production.report': ['runId', 'format'], 'production.evidence': ['runId', 'evidenceId'],
  'production.profile.get': [], 'production.profile.update': ['facts', 'environments', 'scope', 'budget'], 'production.designate': ['productionReady', 'environmentId', 'note'],
  'production.answer': ['questionId', 'answer', 'dismiss'], 'production.review.answer': ['itemId', 'answer', 'note', 'environmentId'], 'production.audit': ['environmentId', 'controls', 'full'],
  'production.retest': ['findingIds'], 'production.verify': ['findingIds'], 'production.pause': ['runId', 'reason'], 'production.resume': ['runId'], 'production.cancel': ['runId', 'reason'],
  'production.tasks.create': ['findingIds'], 'production.waive': ['findingId', 'reason', 'scope', 'owner', 'expiresAt'], 'production.waivers.revoke': ['waiverId', 'reason'],
  'production.writes.authorize': ['environmentId', 'mutations', 'expiresAt', 'note'], 'production.writes.revoke': ['authorizationId'], 'production.drift': ['enabled', 'everyMinutes', 'onChange', 'runNow'],
}

type Args = Record<string, unknown>
const text = (args: Args, name: string, max: number): string => {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be text of 1-${max} characters`)
  return value.trim()
}
const optionalText = (args: Args, name: string, max: number): string | undefined => args[name] === undefined || args[name] === null ? undefined : text(args, name, max)
const ids = (args: Args, name: string, max = 200): string[] => {
  const value = args[name]
  if (!Array.isArray(value) || !value.length || value.length > max || value.some(entry => typeof entry !== 'string' || !entry.trim())) throw new Error(`${name} must be a list of 1-${max} ids`)
  return [...new Set(value.map(entry => String(entry).trim()))]
}
const limit = (args: Args, fallback: number, max: number): number => {
  if (args.limit === undefined) return fallback
  const value = Number(args.limit)
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`limit must be a whole number from 1 to ${max}`)
  return value
}
const isoDate = (args: Args, name: string): string => {
  const value = text(args, name, 40)
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new Error(`${name} must be an ISO date, for example 2026-12-31T00:00:00Z`)
  return new Date(at).toISOString()
}
const enumList = <T extends string>(args: Args, name: string, allowed: readonly T[]): T[] | undefined => {
  if (args[name] === undefined) return undefined
  const value = Array.isArray(args[name]) ? args[name] as unknown[] : [args[name]]
  const bad = value.filter(entry => !allowed.includes(entry as T))
  if (!value.length || bad.length) throw new Error(`${name} must name ${allowed.join(', ')}`)
  return value as T[]
}

export function actorOf(caller: ProductionCaller): Actor {
  if (caller.owner) return { kind: 'owner', agentSessionId: null, title: 'Owner' }
  return { kind: caller.wizard ? 'wizard' : 'agent', agentSessionId: caller.agentSessionId, title: caller.title }
}

/** Refuses a caller the method is not for, with the route it has instead. */
export function authorizeProductionCall(caller: ProductionCaller, method: ProductionControlMethod): void {
  if (caller.local && !caller.sovereign && !PRODUCTION_LOCAL_METHODS.includes(method)) {
    throw new Error(`${method} is not for a local model; it may read ${PRODUCTION_LOCAL_METHODS.join(', ')}. Report what you need to your controller with agents.report.`)
  }
  if (PRODUCTION_SOVEREIGN_METHODS.includes(method)) {
    if (!caller.sovereign) throw new Error(`${method} is the owner's decision: only the owner's control credential or a wizard tab may call it. Ask the owner (or your wizard) with agents.report, naming what to decide and why; the Production panel has the same action.`)
    return
  }
  const read = (PRODUCTION_READ_METHODS as readonly string[]).includes(method)
  if (read && !ARTIFACT_READS.includes(method)) return
  if (!caller.sovereign && (caller.readOnly || caller.local)) {
    throw new Error(`${method} ${read ? 'returns audit artifacts' : 'changes the production audit'}, which a read-only or planning conversation may not; production.status and production.findings show the results. Ask your controller or the owner to run it.`)
  }
}

function runRequestResult(service: ProductionService, outcome: RunRequestOutcome): unknown {
  const run = outcome.run ? service.summary(outcome.run) : null
  if (outcome.outcome === 'dropped') return { outcome: outcome.outcome, reason: outcome.reason, run, next: 'Nothing new was started; production.status shows the current gate.' }
  return { outcome: outcome.outcome, run, next: outcome.outcome === 'coalesced' ? `Run ${run?.id} is active; it will run once more when it ends. production.status shows its progress.` : `Poll production.status (or production.run({runId:"${run?.id}"})) until the run completes.` }
}

const compactFinding = (finding: Finding) => ({
  id: finding.id, controlId: finding.controlId, checkId: finding.checkId, status: finding.status, severity: finding.severity, confidence: finding.confidence, category: finding.category,
  title: finding.title, route: finding.route, occurrences: finding.occurrences, taskId: finding.taskId, waiverId: finding.waiverId, verification: finding.verification?.status ?? null,
})

function readBounded(path: string): { text: string; bytes: number; truncated: boolean } {
  const bytes = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(bytes, MAX_ARTIFACT_BYTES))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return { text: maskSecrets(buffer.subarray(0, read).toString('utf8')), bytes, truncated: bytes > MAX_ARTIFACT_BYTES }
  } finally { closeSync(fd) }
}

const BINARY = /\.(png|jpe?g|webp|gif|pdf|zip)$/i

export async function productionCall(service: ProductionService, caller: ProductionCaller, method: string, rawArgs: unknown): Promise<unknown> {
  if (!productionMethods.has(method)) throw new Error('Unknown production method; tools.list({prefix:"production."}) lists them')
  const name = method as ProductionControlMethod
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Args
  const extra = Object.keys(args).filter(key => !keys[name].includes(key) && key !== 'sessionId' && !(key === 'projectId' && args.projectId === caller.projectId))
  if (extra.length) throw new Error(`${method} does not accept ${extra.join(', ')}; it takes ${keys[name].length ? keys[name].join(', ') : 'no arguments'}`)
  authorizeProductionCall(caller, name)
  const projectId = caller.projectId
  const actor = actorOf(caller)
  const local = caller.local && !caller.sovereign

  switch (name) {
    case 'production.status': {
      const snapshot = service.snapshot(projectId)
      const environmentId = optionalText(args, 'environmentId', 200)
      const gate = environmentId ? service.gate(projectId, environmentId) : snapshot.gate
      const open = snapshot.findings.filter(finding => finding.status === 'open' || finding.status === 'reopened' || finding.status === 'disputed')
      return {
        projectId, gate, designation: snapshot.profile?.designation ?? null,
        environments: snapshot.profile?.environments.map(environment => ({ id: environment.id, kind: environment.kind, label: environment.label, baseUrl: environment.baseUrl })) ?? [],
        activeRun: snapshot.activeRun, runs: snapshot.runs.slice(0, 5).map(run => ({ id: run.id, kind: run.kind, status: run.status, statusReason: run.statusReason, createdAt: run.createdAt, finishedAt: run.finishedAt, progress: run.progress })),
        results: snapshot.results.map(result => ({ controlId: result.controlId, status: result.status, applicability: result.applicability.status, rationale: result.rationale.split('\n')[0]!.slice(0, 300), findingIds: result.findingIds, humanReview: result.humanReview })),
        openFindings: open.slice(0, 50).map(compactFinding), openFindingCount: open.length,
        questions: snapshot.profile?.questions.filter(question => question.status === 'open') ?? [],
        waivers: snapshot.waivers.filter(waiver => !waiver.revokedAt && Date.parse(waiver.expiresAt) > Date.now()),
        browser: snapshot.browser, registryVersion: snapshot.registryVersion,
      }
    }
    case 'production.queue': return service.queue()
    case 'production.registry': {
      const controlId = optionalText(args, 'controlId', 10)
      if (controlId === undefined) return service.registry()
      const control = service.registry().controls.find(entry => entry.id === controlId)
      if (!control) throw new Error(`controlId must be one of ${CONTROL_IDS.join(', ')}`)
      return control
    }
    case 'production.runs': return service.runs(projectId, limit(args, 20, 100))
    case 'production.run': {
      const run = service.run(projectId, text(args, 'runId', 200))
      const summary = service.summary(run)
      const detail = { ...summary, controls: run.controls, steps: run.steps, checkpoint: run.checkpoint, coverage: run.coverage, verifies: run.verifies, rerunRequested: run.rerunRequested, events: service.events(projectId, run.id, 50) }
      return local || caller.readOnly ? { ...detail, reportPaths: null } : { ...detail, artifactsDir: run.artifactsDir }
    }
    case 'production.findings': {
      const findingId = optionalText(args, 'findingId', 200)
      if (findingId) return service.findingsByIds(projectId, [findingId])
      const status = enumList<FindingStatus>(args, 'status', FINDING_STATUSES)
      const severity = enumList<Severity>(args, 'severity', SEVERITIES)
      const controlId = optionalText(args, 'controlId', 10) as ControlId | undefined
      if (controlId && !CONTROL_IDS.includes(controlId)) throw new Error(`controlId must be one of ${CONTROL_IDS.join(', ')}`)
      const offset = args.offset === undefined ? 0 : Number(args.offset)
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a whole number from 0')
      const environmentId = service.snapshot(projectId).gate.environmentId ?? undefined
      return service.findings(projectId, { environmentId, status, severity, controlId, limit: limit(args, 50, 500), offset })
    }
    case 'production.report': {
      const format = args.format === undefined ? 'markdown' : String(args.format)
      if (format !== 'markdown' && format !== 'json') throw new Error('format must be "markdown" or "json"')
      const runId = optionalText(args, 'runId', 200) ?? service.runs(projectId, 50).find(run => run.status === 'completed' && run.reportPaths)?.id
      if (!runId) throw new Error('No completed run with a report yet; production.audit starts one')
      const paths = service.reportPaths(projectId, runId)
      if (!paths) throw new Error(`Run ${runId} has no report (it did not reach the report step); production.run({runId}) shows where it stopped`)
      const path = format === 'json' ? paths.json : paths.markdown
      if (!existsSync(path)) throw new Error(`The report file of run ${runId} is gone (retention keeps the newest runs); run a new audit`)
      return { runId, format, path, ...readBounded(path) }
    }
    case 'production.evidence': {
      const runId = text(args, 'runId', 200)
      const path = service.evidencePath(projectId, runId, text(args, 'evidenceId', 200))
      if (!existsSync(path)) throw new Error('The evidence file is gone (retention keeps the newest runs)')
      if (BINARY.test(path)) return { runId, path, bytes: statSync(path).size, binary: true, next: 'Open the file from the Production panel (Open evidence).' }
      return { runId, path, binary: false, ...readBounded(path) }
    }
    case 'production.profile.get': return service.profile(projectId)
    case 'production.profile.update': {
      const update: ProfileUpdate = {}
      if (args.facts !== undefined) {
        if (!args.facts || typeof args.facts !== 'object' || Array.isArray(args.facts)) throw new Error('facts must be an object of fact name to value')
        update.facts = args.facts as ProfileUpdate['facts']
      }
      const sovereignParts = (['environments', 'scope', 'budget'] as const).filter(key => args[key] !== undefined)
      if (sovereignParts.length && !caller.sovereign) throw new Error(`Changing ${sovereignParts.join(', ')} can widen what an audit may touch or narrow what it tests, so only the owner or a wizard tab may; record facts (as assumptions) or ask the owner with agents.report`)
      for (const key of sovereignParts) (update as Record<string, unknown>)[key] = args[key]
      if (!Object.keys(update).length) throw new Error('Pass at least one of facts, environments, scope, budget')
      return service.updateProfile(projectId, update, actor)
    }
    case 'production.designate': {
      if (typeof args.productionReady !== 'boolean') throw new Error('productionReady must be true or false')
      const environmentId = args.environmentId === undefined || args.environmentId === null ? null : text(args, 'environmentId', 200)
      return service.designate(projectId, { productionReady: args.productionReady, environmentId, note: text(args, 'note', 2_000) }, actor)
    }
    case 'production.answer': {
      const questionId = text(args, 'questionId', 200)
      if ((args.answer === undefined) === (args.dismiss === undefined)) throw new Error('Pass exactly one of answer (the owner\'s fact) or dismiss (the reason)')
      return args.answer !== undefined ? service.answerQuestion(projectId, questionId, text(args, 'answer', 4_000), actor) : service.dismissQuestion(projectId, questionId, text(args, 'dismiss', 2_000), actor)
    }
    case 'production.review.answer': {
      const answer = text(args, 'answer', 20) as ReviewAnswer
      if (!REVIEW_ANSWERS.includes(answer)) throw new Error(`answer must be ${REVIEW_ANSWERS.join(' or ')}`)
      return service.answerReview(projectId, { itemId: text(args, 'itemId', 300), answer, note: optionalText(args, 'note', 2_000) ?? null, environmentId: optionalText(args, 'environmentId', 200) ?? null }, actor)
    }
    case 'production.audit': {
      const controls = args.controls === undefined ? undefined : ids(args, 'controls', CONTROL_IDS.length) as ControlId[]
      if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('full must be true or false')
      return runRequestResult(service, await service.audit(projectId, { environmentId: optionalText(args, 'environmentId', 200), controls, full: args.full as boolean | undefined }, actor))
    }
    case 'production.retest': return runRequestResult(service, await service.retest(projectId, ids(args, 'findingIds'), actor))
    case 'production.verify': return runRequestResult(service, await service.verify(projectId, ids(args, 'findingIds'), actor))
    case 'production.pause': return service.summary(service.pause(projectId, text(args, 'runId', 200), optionalText(args, 'reason', 500) ?? `paused by ${caller.title}`))
    case 'production.resume': {
      const runId = text(args, 'runId', 200)
      service.resume(projectId, runId)
      return service.summary(service.run(projectId, runId))
    }
    case 'production.cancel': return service.summary(service.cancel(projectId, text(args, 'runId', 200), text(args, 'reason', 500)))
    case 'production.tasks.create': return service.createFixTasks(projectId, ids(args, 'findingIds'))
    case 'production.waive': {
      const findingId = text(args, 'findingId', 200)
      const grantedBy: Waiver['grantedBy'] = caller.owner ? { kind: 'owner', agentSessionId: null, title: 'Owner' } : { kind: 'wizard', agentSessionId: caller.agentSessionId, title: caller.title }
      return service.waive(projectId, { findingId, reason: text(args, 'reason', 2_000), scope: text(args, 'scope', 500), owner: text(args, 'owner', 200), expiresAt: isoDate(args, 'expiresAt') }, grantedBy)
    }
    case 'production.waivers.revoke': return service.revokeWaiver(projectId, text(args, 'waiverId', 200), text(args, 'reason', 2_000))
    case 'production.writes.authorize': {
      const mutations = enumList<MutationKind>(args, 'mutations', MUTATION_KINDS)
      if (!mutations) throw new Error(`mutations must name ${MUTATION_KINDS.join(', ')}`)
      const grantedBy = caller.owner ? { kind: 'owner' as const, agentSessionId: null } : { kind: 'wizard' as const, agentSessionId: caller.agentSessionId }
      return service.authorizeWrites(projectId, { environmentId: text(args, 'environmentId', 200), mutations, expiresAt: isoDate(args, 'expiresAt'), note: text(args, 'note', 2_000) }, grantedBy)
    }
    case 'production.writes.revoke': {
      const profile = service.revokeWrites(projectId, text(args, 'authorizationId', 200), actor.kind === 'owner' ? 'owner' : `wizard:${caller.agentSessionId}`)
      return { revoked: true, profileVersion: profile.version, writeAuthorizations: profile.writeAuthorizations }
    }
    case 'production.drift': {
      const settings: Partial<DriftSettings> = {}
      if (args.enabled !== undefined) { if (typeof args.enabled !== 'boolean') throw new Error('enabled must be true or false'); settings.enabled = args.enabled }
      if (args.everyMinutes !== undefined) {
        const minutes = Number(args.everyMinutes)
        if (!Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 24 * 60) throw new Error('everyMinutes must be a whole number from 15 to 10080')
        settings.everyMinutes = minutes
      }
      if (args.onChange !== undefined) { if (args.onChange !== 'mark-stale' && args.onChange !== 'audit') throw new Error('onChange must be "mark-stale" or "audit"'); settings.onChange = args.onChange }
      if (args.runNow !== undefined && typeof args.runNow !== 'boolean') throw new Error('runNow must be true or false')
      const profile = Object.keys(settings).length ? service.setDrift(projectId, settings, actor) : service.profile(projectId)
      const check = args.runNow === true ? await service.runDrift(projectId) : null
      return { drift: profile.drift, check }
    }
  }
}
