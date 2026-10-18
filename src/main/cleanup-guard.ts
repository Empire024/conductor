// One rule for every cleanup reachable from app control that can hit another project's work
// (local.stop first; owner 2026-10-18, after the haf-stuff wizard's "release my GPUs" stopped the
// model server miron had said must stay up): a stop, kill, cancel or close of a target that another
// project owns or protects is refused unless the owner's own credential asks, or the owner approved
// that exact call. A wizard tab holds the owner's authority inside its own project only: across
// projects it is that project, not the owner. The project that owns a target keeps its rights, but
// stopping something it protected itself takes force:true with a reason.

/** A project as a refusal names it. */
export interface CleanupProject { projectId: string; projectName?: string }

/** What a target carries: who started it, and who said it must stay up, and why. */
export interface CleanupClaims {
  owner?: CleanupProject | null
  protection?: (CleanupProject & { reason: string }) | null
}

export interface CleanupCaller {
  /** The calling conversation's project (scope.projectId). */
  projectId: string
  /** The owner's own control credential (scope.owner); a wizard tab is not this. */
  owner: boolean
  /** The owner approved this exact call through the owner-approval dialog. */
  approved?: boolean
}

export interface CleanupRequest {
  /** The target as a person reads it: 'Qwen 3.5 9B (pid 35800)'. */
  label: string
  /** What is being done, for the refusal: 'stop', 'cancel', 'close'. */
  action: string
  /** The exact call to retry, as the caller would make it: 'local.stop({pid:35800})'. */
  call: string
  force?: boolean
  reason?: string
}

export type CleanupVerdict =
  | { allowed: true; by: 'owner' | 'approval' | 'same-project' | 'unclaimed'; overrodeProtection?: boolean }
  | { allowed: false; kind: 'other-project'; project: CleanupProject; message: string }
  | { allowed: false; kind: 'protected-self'; message: string }

export const projectLabel = (project: CleanupProject): string => project.projectName ? `${project.projectName} (${project.projectId})` : project.projectId

/** The other project a target belongs to, from the caller's side: its protector first (the claim
 *  that says why), else its owner; null when every claim is the caller's own or there is none. */
export function foreignClaim(claims: CleanupClaims, callerProjectId: string): { project: CleanupProject; reason?: string } | null {
  if (claims.protection && claims.protection.projectId !== callerProjectId) return { project: claims.protection, reason: claims.protection.reason }
  if (claims.owner && claims.owner.projectId !== callerProjectId) return { project: claims.owner }
  return null
}

/** Whether the caller may do `request.action` to a target with these claims. */
export function cleanupVerdict(claims: CleanupClaims, caller: CleanupCaller, request: CleanupRequest): CleanupVerdict {
  const protectedBySelf = Boolean(claims.protection && claims.protection.projectId === caller.projectId)
  if (caller.owner) return { allowed: true, by: 'owner', ...(claims.protection ? { overrodeProtection: true } : {}) }
  const foreign = foreignClaim(claims, caller.projectId)
  if (foreign) {
    if (caller.approved) return { allowed: true, by: 'approval', ...(claims.protection ? { overrodeProtection: true } : {}) }
    const why = foreign.reason ? `is protected by project ${projectLabel(foreign.project)}: ${foreign.reason}` : `belongs to project ${projectLabel(foreign.project)}, which started it`
    return {
      allowed: false, kind: 'other-project', project: foreign.project,
      message: `Refused: ${request.label} ${why}, so this project may not ${request.action} it. A wizard tab of another project is not the owner for this. ` +
        `Ask that project with send_message({projectId:"${foreign.project.projectId}", text}), or ask the owner: retry ${request.call} with ownerApproval:true, which shows the owner a dialog naming it, and goes through only if the owner approves.`
    }
  }
  if (protectedBySelf && !(request.force === true && request.reason?.trim())) {
    return { allowed: false, kind: 'protected-self', message: `Refused: ${request.label} is protected by this project: ${claims.protection!.reason}. To ${request.action} it anyway pass force:true with a reason, or lift the protection first.` }
  }
  return { allowed: true, by: claims.owner || claims.protection ? 'same-project' : 'unclaimed', ...(protectedBySelf ? { overrodeProtection: true } : {}) }
}

/** What a cleanup method elsewhere (remote jobs, idea runs) hands agent-control for a target that
 *  sits in another project than the caller's: it resolves when the stop may go ahead (the owner's
 *  credential, or ownerApproval:true and the owner approved in the dialog) and throws the refusal
 *  otherwise. Built from the authorized scope, never from the caller's arguments. */
export type CrossProjectCleanupGuard = (target: { projectId: string; label: string; action: string; call: string; ownerApproval: boolean; reason?: string }) => Promise<void>

/** The owner-approval dialog's text: the target, who owns or protects it and why, and who asks. */
export function ownerApprovalMessage(claims: CleanupClaims, request: CleanupRequest, asker: string): string {
  const parts = [`${asker} wants to ${request.action} ${request.label}, which belongs to another project.`]
  if (claims.owner) parts.push(`Started by project ${projectLabel(claims.owner)}.`)
  if (claims.protection) parts.push(`Protected by project ${projectLabel(claims.protection)}: ${claims.protection.reason}.`)
  if (request.reason?.trim()) parts.push(`Reason given: ${request.reason.trim()}`)
  return parts.join(' ')
}
