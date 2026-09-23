import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CHECKOUT } from './util.mjs'

/** File the app writes into its userData when its control server starts, and deletes on close. */
export const CREDENTIAL_FILE = 'control-owner.json'

/** The installed app's userData: %APPDATA%\Conductor. */
export function installedUserData(env = process.env) {
  if (!env.APPDATA) throw new Error('APPDATA is not set; cannot locate the installed Conductor profile')
  return join(env.APPDATA, 'Conductor')
}

/** Default parked dev instance layout (userData + projects root), inside the ignored artifacts tree. */
export function devLayout(checkout = CHECKOUT) {
  const base = resolve(checkout, 'artifacts', 'overseer')
  return { userData: join(base, 'profile'), projectsRoot: join(base, 'projects'), base }
}

export const userDataFor = (target, { env = process.env, checkout = CHECKOUT } = {}) =>
  target === 'installed' ? installedUserData(env) : devLayout(checkout).userData

/** Whether a pid names a live process. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** Shape check only; says nothing about whether the process is alive. */
export function validateCredential(value) {
  const problems = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['credential is not a JSON object']
  if (value.version !== 1) problems.push(`unsupported credential version ${JSON.stringify(value.version)}`)
  if (typeof value.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/control$/.test(value.endpoint)) problems.push('endpoint must be http://127.0.0.1:<port>/control')
  if (typeof value.token !== 'string' || !/^[0-9a-f]{16,}$/i.test(value.token)) problems.push('token must be a hex string')
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) problems.push('pid must be a positive integer')
  return problems
}

/**
 * Read and check `<userData>/control-owner.json`. Returns `{ok:true, credential, path}` or
 * `{ok:false, reason, path}`. A file whose pid is dead is stale: the app crashed without
 * deleting it, so its token is worthless and its port may belong to something else now.
 */
export async function readCredential(userData, { isAlive = pidAlive } = {}) {
  const path = join(userData, CREDENTIAL_FILE)
  let text
  try { text = await readFile(path, 'utf8') } catch (error) {
    return { ok: false, path, reason: error?.code === 'ENOENT' ? 'no credential file (app not running or control server not started)' : `cannot read credential: ${error.message}` }
  }
  let value
  try { value = JSON.parse(text.replace(/^﻿/, '')) } catch { return { ok: false, path, reason: 'credential file is not valid JSON' } }
  const problems = validateCredential(value)
  if (problems.length) return { ok: false, path, reason: problems.join('; ') }
  if (!isAlive(value.pid)) return { ok: false, path, stale: true, credential: value, reason: `stale credential: pid ${value.pid} is not running` }
  return { ok: true, path, credential: value }
}
