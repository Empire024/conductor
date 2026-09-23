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

/**
 * Hand the checkout to the installed app: app.update builds it into the local feed; with
 * `restart`, check/download/install(force) and wait for the relaunched app's credential.
 */
export async function deliver({ client, userData, checkout = CHECKOUT, restart = false, log = () => {}, sleep = realSleep, pollMs = 5000, buildTimeoutMs = 45 * 60_000, updateTimeoutMs = 20 * 60_000, relaunchTimeoutMs = 5 * 60_000, isAlive = pidAlive }) {
  const scope = await projectScope(client, checkout)
  const call = (method, args = {}, options) => client.call(method, args, scope, options)
  let build = await call('app.update')
  log(`app.update: ${build?.state}${build?.version ? ` ${build.version}` : ''}`)
  const buildDeadline = Date.now() + buildTimeoutMs
  while (build?.state === 'running' && Date.now() < buildDeadline) {
    await sleep(pollMs)
    build = await call('app.update.status')
  }
  if (build?.state !== 'succeeded') return { ok: false, stage: 'build', build, reason: build?.state === 'running' ? 'local update build did not finish in time' : `local update build ${build?.state}: ${build?.message ?? ''}` }
  log(`local update ${build.version ?? ''} published to the installed app's feed`)
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
  log(`update ${state.availableVersion ?? ''} ready; installing with a forced restart`)
  try { await call('app.update.install', { force: true }) } catch (error) { if (error.code !== 'unreachable') throw error }
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
