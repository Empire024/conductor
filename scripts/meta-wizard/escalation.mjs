// The meta-wizard's repair ladder (docs/startup-diagnostics.md, part 2). Pure: the incident, the
// restore-point catalog, the repair history and the clock in; one decision out. Effects live in
// service.mjs and repair.mjs.
//
// An incident opens when a start the meta-wizard makes fails (or the crash-loop guard trips) and
// closes when Conductor has answered for incidentCloseMs. Within one incident the rungs are:
//   1. restart     at most restartAttempts times with the same signature on the same version;
//   2. rollback    to the previous known-good restore point (skipped when there is none);
//   3. repair      a high-effort agent in its own worktree, when the rolled-back build fails too,
//                  when there is no restore point, or when the crash-loop guard trips. One at a
//                  time, at most maxRepairsPerDay in repairWindowMs.

export const ESCALATION_TIMINGS = {
  restartAttempts: 2,
  incidentCloseMs: 600_000,
  maxRepairsPerDay: 2,
  repairWindowMs: 86_400_000,
  repairTimeoutMs: 90 * 60_000,
  // After the repair agent exits, how long Conductor may take to answer before the repair counts as failed.
  repairAnswerGraceMs: 180_000,
  // A live recovery watchdog for the dead pid is waited for at most this long.
  watchdogWaitMs: 20 * 60_000,
  rollbackTimeoutMs: 10 * 60_000,
  // A start whose process exited is given up on this long after the exit when nothing answers.
  exitSettleMs: 10_000
}

const KEEP_FAILURES = 20

const signatureOf = failure => failure?.signature || 'unknown'

/** Whether two failures are the same failure: the same state, stage and cause. Unknown never matches. */
export function sameSignature(a, b) {
  return Boolean(a?.signature && b?.signature && a.signature === b.signature)
}

/** A new incident, or the open one. */
export function openIncident(incident, { now }) {
  if (incident) return incident
  return { id: `incident-${new Date(now).toISOString()}`, openedAt: now, failures: [], rungs: [], rolledBack: null, repairs: [], lastStartedPid: null, answeredSince: null }
}

/** Records one failed start (or a crash of a start that had answered) with its boot verdict. */
export function recordFailure(incident, { verdict, rung, now, pid = null }) {
  const open = openIncident(incident, { now })
  const failure = {
    at: now, rung, pid: pid ?? verdict?.pid ?? null, state: verdict?.state ?? 'unknown', stage: verdict?.stage ?? null, cause: verdict?.cause ?? null,
    signature: verdict?.signature ?? null, version: verdict?.version ?? null, line: verdict?.line ?? 'no boot verdict'
  }
  return { ...open, failures: [...open.failures, failure].slice(-KEEP_FAILURES), answeredSince: null }
}

/** Records that a rung was taken (the ladder history the alerts and the repair prompt show). */
export function recordRung(incident, { rung, now, detail = '' }) {
  const open = openIncident(incident, { now })
  return { ...open, rungs: [...open.rungs, { at: now, rung, detail }].slice(-KEEP_FAILURES) }
}

/** Conductor answered this tick: the incident closes once it has answered for incidentCloseMs and no repair is busy. */
export function incidentAnswered(incident, { now, timings = ESCALATION_TIMINGS, repairBusy = false }) {
  if (!incident) return { incident: null, close: false }
  const answeredSince = incident.answeredSince ?? now
  const next = { ...incident, answeredSince }
  return { incident: next, close: !repairBusy && now - answeredSince >= timings.incidentCloseMs }
}

/** Conductor did not answer this tick: the quiet period starts over. */
export function incidentDown(incident) {
  return incident && incident.answeredSince !== null ? { ...incident, answeredSince: null } : incident
}

/** Whether a repair may start now: one at a time, at most maxRepairsPerDay in repairWindowMs. */
export function repairGate({ active = false, history = [], now, timings = ESCALATION_TIMINGS }) {
  if (active) return { ok: false, reason: 'a repair agent is already running' }
  const recent = history.filter(entry => now - entry.startedAt < timings.repairWindowMs)
  if (recent.length >= timings.maxRepairsPerDay) return { ok: false, reason: `${recent.length} repairs in the last ${Math.round(timings.repairWindowMs / 3_600_000)} hours already (at most ${timings.maxRepairsPerDay})` }
  return { ok: true, reason: '' }
}

const validTime = value => Number.isFinite(Date.parse(value ?? ''))

/**
 * The restore point to roll back to (`<userData>/local-updates/restore-points.json`): not the failing
 * version, ran on this machine (`firstLaunchedAt`), installer still there; pinned or known-good
 * first, then points without crashes, newest first. With no failing version known, the newest point
 * that ran is presumed to be the failing one and skipped. Null when none qualifies.
 */
export function pickRestorePoint(catalog, { failingVersion = null, installerExists = () => true, exclude = [] } = {}) {
  const points = (Array.isArray(catalog) ? catalog : catalog?.points ?? []).filter(point => point && typeof point.version === 'string' && typeof point.installer === 'string')
  const ran = points.filter(point => validTime(point.firstLaunchedAt))
  let skip = failingVersion
  if (!skip) skip = [...ran].sort((a, b) => Date.parse(b.firstLaunchedAt) - Date.parse(a.firstLaunchedAt))[0]?.version ?? null
  const candidates = ran.filter(point => point.version !== skip && !exclude.includes(point.version) && installerExists(point.installer))
  const tier = point => (point.pinned || point.knownGood ? 0 : 2) + (point.crashCount > 0 || point.failedShipCount > 0 ? 1 : 0)
  const created = point => Date.parse(point.createdAt ?? point.firstLaunchedAt) || 0
  candidates.sort((a, b) => tier(a) - tier(b) || created(b) - created(a))
  return candidates[0] ?? null
}

/**
 * The next rung. `trigger` is 'start' (liveness wants Conductor started) or 'guard' (the crash-loop
 * guard just tripped). `repair` is `{active, history}`.
 *
 * Returns `{rung, reason, ...}`: 'wait-repair' (a repair owns the app), 'restart' (`attempt`, `of`),
 * 'rollback' (`point`), 'repair', or 'exhausted' (no rung left: plain restarts under the guard).
 */
export function chooseRung({ incident = null, trigger = 'start', catalog = null, failingVersion = null, installerExists = () => true, repair = {}, now, timings = ESCALATION_TIMINGS }) {
  const gate = repairGate({ active: repair.active, history: repair.history ?? [], now, timings })
  if (repair.active) return { rung: 'wait-repair', reason: 'a repair agent owns Conductor until it finishes' }
  const toRepair = reason => gate.ok ? { rung: 'repair', reason } : { rung: 'exhausted', reason: `${reason}, but no repair now: ${gate.reason}` }
  if (trigger === 'guard') return toRepair('the crash-loop guard tripped')
  const failures = incident?.failures ?? []
  const last = failures.at(-1)
  if (!last) return { rung: 'restart', attempt: 1, of: timings.restartAttempts, reason: 'start Conductor' }
  const lastRepair = (incident.repairs ?? []).at(-1)
  if (lastRepair) {
    // After a repair: one plain start (the agent may have installed a fix and not started it);
    // a failure after that goes back to the repair rung.
    const since = failures.filter(failure => failure.at > (lastRepair.finishedAt ?? lastRepair.startedAt ?? 0))
    if (!since.length) return { rung: 'restart', attempt: 1, of: 1, reason: `start Conductor after repair ${lastRepair.id}` }
    return toRepair(`Conductor still does not start after repair ${lastRepair.id} (${last.line})`)
  }
  if (last.rung === 'rollback') {
    const before = [...failures].reverse().find(failure => failure.rung !== 'rollback')
    return toRepair(sameSignature(last, before)
      ? `the rolled-back build${last.version ? ` ${last.version}` : ''} fails the same way (${last.signature}): data or environment, not the build`
      : `the rolled-back build fails too (${last.line})`)
  }
  const same = failures.filter(failure => failure.rung === 'restart' && signatureOf(failure) === signatureOf(last) && failure.version === last.version).length
  if (same < timings.restartAttempts) return { rung: 'restart', attempt: same + 1, of: timings.restartAttempts, reason: `${last.line}` }
  if (!incident.rolledBack) {
    const point = pickRestorePoint(catalog, { failingVersion: last.version ?? failingVersion, installerExists })
    if (point) return { rung: 'rollback', point, reason: `${same} starts failed the same way (${signatureOf(last)}); rolling back to ${point.version}` }
    return toRepair(`${same} starts failed the same way (${signatureOf(last)}) and there is no restore point to roll back to`)
  }
  return toRepair(`Conductor still does not start after rolling back to ${incident.rolledBack}`)
}

/** What the owner is told comes next, after a failed start. */
export function nextStepText(rung) {
  if (rung.rung === 'restart') return `Restarting (${rung.attempt} of ${rung.of})`
  if (rung.rung === 'rollback') return `Rolling back to ${rung.point.version} next`
  if (rung.rung === 'repair') return `Starting a repair agent next: ${rung.reason}`
  if (rung.rung === 'wait-repair') return 'A repair agent is working on it'
  return `No rung left (${rung.reason}); restarting under the crash-loop guard`
}

/**
 * The recovery watchdog's first minutes (docs/recovery-mode.md): while `recovery/watchdog.json`
 * names a live watchdog whose appPid is the dead pid, the meta-wizard waits for it, at most
 * watchdogWaitMs. `waiting` is the remembered `{pid, since}`; returns `{hold, waiting, reason}`.
 */
export function watchdogHold({ lock, lockAlive = false, deadPid = null, waiting = null, now, timings = ESCALATION_TIMINGS }) {
  if (!lock || !lockAlive || !deadPid || lock.appPid !== deadPid) return { hold: false, waiting: null, reason: '' }
  const since = waiting?.pid === lock.pid ? waiting.since : now
  const next = { pid: lock.pid, since }
  if (now - since >= timings.watchdogWaitMs) return { hold: false, waiting: next, reason: `the recovery watchdog (pid ${lock.pid}) has had ${Math.round((now - since) / 60_000)} minutes` }
  return { hold: true, waiting: next, reason: `the recovery watchdog (pid ${lock.pid}) is still handling pid ${deadPid}; waiting for it (at most ${Math.round(timings.watchdogWaitMs / 60_000)} minutes)` }
}

/** Repair ids: `YYYY-MM-DD-HHmm` (UTC), with `-2`, `-3`… when that minute is taken. */
export function repairId(now, taken = []) {
  const base = new Date(now).toISOString().slice(0, 16).replace('T', '-').replace(':', '')
  let id = base
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`
  return id
}

/** Whether the live-runner record names a runner still at work (pid alive, within its time limit plus slack). */
export function repairActive({ active, alive = false, now, timings = ESCALATION_TIMINGS }) {
  if (!active?.pid || !alive) return false
  const started = Date.parse(active.startedAt ?? '')
  return !Number.isFinite(started) || now - started < timings.repairTimeoutMs + 15 * 60_000
}
