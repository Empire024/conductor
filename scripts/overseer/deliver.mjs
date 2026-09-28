import { scopeOf } from './control-client.mjs'
import { readCredential, pidAlive } from './credentials.mjs'
import { connect } from './app-instance.mjs'
import { CHECKOUT, samePath, sleep as realSleep } from './util.mjs'

/** Scope of `path` in an app: the open project with that folder, else projects.open it. */
export async function projectScope(client, path, name) {
  const projects = await client.call('projects.list', {}, null)
  const found = (Array.isArray(projects) ? projects : []).find(project => project?.path && samePath(project.path, path))
  return scopeOf(found ?? await client.call('projects.open', { path, ...(name ? { name } : {}) }, null))
}

/** The line a failed smoke is summed up by: its name, exit code and the last lines of its log. */
const smokeFailure = smoke => `${smoke.name} ${smoke.state}${smoke.exitCode === null || smoke.exitCode === undefined ? '' : ` (exit ${smoke.exitCode})`}${smoke.tail?.length ? `: ${smoke.tail.slice(-5).join(' | ')}` : ''}${smoke.log ? ` [log ${smoke.log}]` : ''}`

/**
 * Hand work to the installed app: app.update builds it into the local feed; with `restart`,
 * check/download/install and wait for the relaunched app's credential.
 *
 * With `commit` the installed app builds exactly that commit in a clean worktree (never the shared
 * checkout with other agents' edits) and runs `smoke` there; a failed smoke stops the delivery
 * before anything is installed. The install is unforced: Conductor refuses while any tab is
 * mid-turn or runs background tasks, and this waits (up to `gateTimeoutMs`) for them to settle.
 * `resume` names the wizard tab the restart brings back, as if it had started it; `force` skips
 * the wait and cuts running work.
 */
export async function deliver({ client, userData, checkout = CHECKOUT, restart = false, commit = null, smoke = [], resume = null, force = false, log = () => {}, sleep = realSleep, pollMs = 5000, buildTimeoutMs = 45 * 60_000, smokeTimeoutMs = 90 * 60_000, updateTimeoutMs = 20 * 60_000, gateTimeoutMs = 30 * 60_000, relaunchTimeoutMs = 5 * 60_000, isAlive = pidAlive }) {
  if (smoke.length && !commit) return { ok: false, stage: 'build', reason: '--smoke needs --commit: smokes run against a clean build of one commit, never the shared checkout' }
  const scope = await projectScope(client, checkout)
  const call = (method, args = {}, options) => client.call(method, args, scope, options)
  let build = await call('app.update', commit ? { commit, ...(smoke.length ? { smoke } : {}) } : {})
  // An installed app older than app.update({commit}) ignores the argument and builds the dirty checkout.
  if (commit && (!build || !('commit' in build))) return { ok: false, stage: 'build', build, reason: 'the installed Conductor predates app.update({commit}); deliver once without --commit to install a build that has it' }
  log(`app.update: ${build?.state}${build?.commit ? ` ${build.commit.slice(0, 10)}` : ''}${build?.worktree ? ` in ${build.worktree}` : ''}`)
  const deadline = Date.now() + buildTimeoutMs + (smoke.length ? smokeTimeoutMs : 0)
  let seen = ''
  while (build?.state === 'running' && Date.now() < deadline) {
    const progress = [build.stage, ...(build.smokes ?? []).map(entry => `${entry.name}:${entry.state}`)].filter(Boolean).join(' ')
    if (progress && progress !== seen) { log(`app.update: ${progress}`); seen = progress }
    // waitSeconds returns as soon as the build moves on; an app without it answers at once.
    build = await call('app.update.status', { waitSeconds: 45 }, { timeoutMs: 70_000 })
    if (build?.state === 'running' && build.stage === undefined) await sleep(pollMs)
  }
  if (build?.state !== 'succeeded') return { ok: false, stage: 'build', build, reason: build?.state === 'running' ? 'local update build did not finish in time' : `local update build ${build?.state}: ${build?.message ?? ''}` }
  if (smoke.length && build.verified !== true) {
    const failed = (build.smokes ?? []).filter(entry => entry.state !== 'passed')
    return { ok: false, stage: 'smoke', build, reason: `built ${build.version ?? ''} from ${String(build.commit).slice(0, 10)}, but not verified: ${failed.map(smokeFailure).join('; ') || 'no smoke result'}` }
  }
  log(`local update ${build.version ?? ''} published to the installed app's feed${build.commit ? ` (commit ${build.commit.slice(0, 10)}, clean)` : ''}${smoke.length ? `; ${smoke.length} smoke(s) passed` : ''}`)
  if (!restart) return { ok: true, stage: 'published', build }

  const before = await readCredential(userData, { isAlive })
  const oldPid = before.credential?.pid
  const updateDeadline = Date.now() + updateTimeoutMs
  let state = await call('app.update.check')
  let idleChecks = 0
  while (Date.now() < updateDeadline) {
    if (state?.phase === 'available') { state = await call('app.update.download'); continue }
    if (state?.phase === 'ready') break
    idleChecks = state?.phase === 'idle' ? idleChecks + 1 : 0
    if (state?.phase === 'error' || state?.phase === 'disabled' || idleChecks >= 2) return { ok: false, stage: 'update', build, state, reason: `installed app update ${state.phase}: ${state.message ?? ''}` }
    await sleep(pollMs)
    state = await call('app.update.check')
  }
  if (state?.phase !== 'ready') return { ok: false, stage: 'update', build, state, reason: 'update did not become ready in time' }
  log(`update ${state.availableVersion ?? ''} ready; installing${force ? ' with a forced restart' : ' once no tab is mid-turn'}${resume ? `, bringing ${resume} back` : ''}`)
  const gateDeadline = Date.now() + gateTimeoutMs
  let waiting = ''
  for (;;) {
    try { await call('app.update.install', { ...(force ? { force: true } : {}), ...(resume ? { resume } : {}) }); break } catch (error) {
      if (error.code === 'unreachable') break
      if (!/Not installing yet/.test(error.message)) throw error
      if (Date.now() >= gateDeadline) return { ok: false, stage: 'install', build, state, reason: error.message }
      if (error.message !== waiting) { log(error.message); waiting = error.message }
      await sleep(Math.max(pollMs, 15_000))
    }
  }
  const relaunchDeadline = Date.now() + relaunchTimeoutMs
  while (Date.now() < relaunchDeadline) {
    await sleep(3000)
    const attempt = await connect(userData, { isAlive })
    if (attempt.ok && attempt.credential.pid !== oldPid) {
      log(`installed app back (pid ${attempt.credential.pid}, version ${attempt.credential.appVersion ?? '?'})`)
      return { ok: true, stage: 'installed', build, state, appVersion: attempt.credential.appVersion ?? null, pid: attempt.credential.pid, client: attempt.client }
    }
  }
  return { ok: false, stage: 'relaunch', build, state, reason: 'installed app did not come back with a new pid in time' }
}
