import { TIMINGS } from './detect.mjs'

// Is Conductor alive, and if not, whose move is it? Pure: the credential, the probe, the recovery
// watchdog's arm record and the remembered state in; one action out (docs/meta-wizard.md).
//
// Actions: ok | recheck (probe again soon) | wait (someone else is handling it, or it is starting)
// | start | kill-and-start | stand-down (crash-loop guard) | idle (nothing to bring back).

const age = (now, iso) => { const at = Date.parse(iso ?? ''); return Number.isFinite(at) ? now - at : Infinity }

/**
 * `cpu` is the CPU time, in seconds, of the main process in question (the credential's pid, or the
 * armed pid while it starts), sampled this tick; null when it could not be read. It rising between
 * two ticks means the process is working, so a silent one is busy rather than hung.
 */
export function decideLiveness({ now = Date.now(), credential, probe, armed, armedAppAlive = false, cpu = null, bootAt = 0, memory = {}, timings = TIMINGS }) {
  const next = { strikes: memory.strikes ?? 0, downSince: memory.downSince ?? null, restarts: (memory.restarts ?? []).filter(at => now - at < timings.restartWindowMs), standDownUntil: memory.standDownUntil ?? null, silentSince: memory.silentSince ?? null, cpu: typeof cpu === 'number' ? { pid: memory.cpu?.pid, seconds: cpu } : null }
  const sampledPid = credential?.ok ? credential.credential.pid : armedAppAlive ? armed?.appPid : null
  if (next.cpu) next.cpu.pid = sampledPid
  const rising = typeof cpu === 'number' && memory.cpu?.pid === sampledPid && typeof memory.cpu?.seconds === 'number' && cpu - memory.cpu.seconds >= 0.05
  const busy = rising ? `its CPU time rose ${(cpu - memory.cpu.seconds).toFixed(1)} s since the last probe` : ''
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
    next.strikes = 0; next.downSince = null; next.standDownUntil = null; next.silentSince = null
    return result('ok', `pid ${credential.credential.pid} answers`)
  }
  const stopping = armed && ['restart', 'update-install', 'quit', 'update-on-quit'].includes(armed.kind)
  if (credential?.ok) {
    // The process is there and does not answer: hung, or on its way out of a restart or install.
    next.strikes += 1
    next.silentSince ??= now
    if (next.strikes < timings.hungStrikes) return result('recheck', `pid ${credential.credential.pid} did not answer (${probe}); ${next.strikes} of ${timings.hungStrikes}`)
    if (stopping && armed.appPid === credential.credential.pid && age(now, armed.at) < timings.updateGraceMs) return result('wait', `pid ${credential.credential.pid} is stopping (${armed.kind} at ${armed.at})`)
    const silentFor = now - next.silentSince
    // 2026-10-21: a main process busy in a two-minute launch prune was killed twice after about 60 s.
    if (rising && silentFor < timings.busyMaxMs) return result('recheck', `pid ${credential.credential.pid} is busy, not hung: silent for ${Math.round(silentFor / 1000)} s but ${busy}; allowed ${Math.round(timings.busyMaxMs / 1000)} s`)
    return restart('kill-and-start', `pid ${credential.credential.pid} has not answered app control ${next.strikes} times in a row over ${Math.round(silentFor / 1000)} s (${rising ? `busy past ${Math.round(timings.busyMaxMs / 1000)} s` : 'hung: its CPU time is not rising'})`)
  }
  next.strikes = 0
  next.silentSince = null
  if (armed?.kind === 'running' && armedAppAlive) {
    // Up, but no control endpoint yet: starting, or hung before its control server.
    if (age(now, armed.at) < timings.startingGraceMs) return result('wait', `pid ${armed.appPid} is starting`)
    if (rising && age(now, armed.at) < timings.startingGraceMs + timings.busyMaxMs) return result('wait', `pid ${armed.appPid} is still starting: ${busy}`)
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
