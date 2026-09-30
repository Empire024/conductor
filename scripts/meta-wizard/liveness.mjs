import { TIMINGS } from './detect.mjs'

// Is Conductor alive, and if not, whose move is it? Pure: the credential, the probe, the recovery
// watchdog's arm record and the remembered state in; one action out (docs/meta-wizard.md).
//
// Actions: ok | recheck (probe again soon) | wait (someone else is handling it, or it is starting)
// | start | kill-and-start | stand-down (crash-loop guard) | idle (nothing to bring back).

const age = (now, iso) => { const at = Date.parse(iso ?? ''); return Number.isFinite(at) ? now - at : Infinity }

export function decideLiveness({ now = Date.now(), credential, probe, armed, armedAppAlive = false, bootAt = 0, memory = {}, timings = TIMINGS }) {
  const next = { strikes: memory.strikes ?? 0, downSince: memory.downSince ?? null, restarts: (memory.restarts ?? []).filter(at => now - at < timings.restartWindowMs), standDownUntil: memory.standDownUntil ?? null }
  const result = (action, reason, extra = {}) => ({ action, reason, memory: next, ...extra })
  const restart = (action, reason) => {
    if (next.standDownUntil && now < next.standDownUntil) return result('stand-down', `crash-loop guard: not starting Conductor again before ${new Date(next.standDownUntil).toISOString()} (${reason})`)
    if (next.restarts.length >= timings.maxRestarts) {
      next.standDownUntil = now + timings.standDownMs
      return result('stand-down', `crash-loop guard: ${next.restarts.length} starts in ${Math.round(timings.restartWindowMs / 60_000)} minutes; standing down for ${Math.round(timings.standDownMs / 60_000)} minutes (${reason})`, { alert: true })
    }
    return result(action, reason)
  }

  if (credential?.ok && probe === 'ok') {
    next.strikes = 0; next.downSince = null; next.standDownUntil = null
    return result('ok', `pid ${credential.credential.pid} answers`)
  }
  const stopping = armed && ['restart', 'update-install', 'quit', 'update-on-quit'].includes(armed.kind)
  if (credential?.ok) {
    // The process is there and does not answer: hung, or on its way out of a restart or install.
    next.strikes += 1
    if (next.strikes < timings.hungStrikes) return result('recheck', `pid ${credential.credential.pid} did not answer (${probe}); ${next.strikes} of ${timings.hungStrikes}`)
    if (stopping && armed.appPid === credential.credential.pid && age(now, armed.at) < timings.updateGraceMs) return result('wait', `pid ${credential.credential.pid} is stopping (${armed.kind} at ${armed.at})`)
    return restart('kill-and-start', `pid ${credential.credential.pid} has not answered app control ${next.strikes} times in a row (hung)`)
  }
  next.strikes = 0
  if (armed?.kind === 'running' && armedAppAlive) {
    // Up, but no control endpoint yet: starting, or hung before its control server.
    if (age(now, armed.at) < timings.startingGraceMs) return result('wait', `pid ${armed.appPid} is starting`)
    return restart('kill-and-start', `pid ${armed.appPid} runs but has had no control endpoint since ${armed.at}`)
  }
  next.downSince ??= now
  const down = now - next.downSince
  const workInProgress = Boolean(memory.workInProgress)
  if (armed && ['restart', 'update-install'].includes(armed.kind)) {
    const grace = armed.kind === 'update-install' ? timings.updateGraceMs : timings.restartGraceMs
    if (age(now, armed.at) < grace) return result('wait', `${armed.kind} at ${armed.at}: the recovery watchdog brings it back first`)
    return restart('start', `Conductor did not come back after ${armed.kind} at ${armed.at}`)
  }
  if (armed && ['quit', 'update-on-quit'].includes(armed.kind)) {
    if (armed.kind === 'update-on-quit' && age(now, armed.at) < timings.updateGraceMs) return result('wait', `an update installs after the quit at ${armed.at}`)
    const beforeBoot = Date.parse(armed.at ?? '') < bootAt
    if (beforeBoot && workInProgress) return restart('start', `Windows restarted (or logged off) at ${armed.at} with work in progress`)
    return result('idle', beforeBoot ? 'Conductor was closed before Windows restarted and nothing was in progress' : `the owner quit Conductor at ${armed.at}`)
  }
  if (armed?.kind === 'running') {
    // A crash: the recovery watchdog relaunches within seconds; step in when it did not.
    if (down < timings.crashGraceMs) return result('wait', `pid ${armed.appPid} is gone (crash); giving the recovery watchdog ${Math.round(timings.crashGraceMs / 1000)} s`, { soon: true })
    return restart('start', `Conductor (pid ${armed.appPid}) crashed or was killed and did not come back`)
  }
  if (workInProgress) {
    if (down < timings.crashGraceMs) return result('wait', `Conductor is gone with work in progress; rechecking before starting it`, { soon: true })
    return restart('start', `Conductor is not running and work was in progress (${credential?.reason ?? 'no credential'})`)
  }
  return result('idle', `Conductor is not running and nothing was in progress (${credential?.reason ?? 'no credential'})`)
}
