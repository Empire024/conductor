import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Where the meta-wizard finds Conductor and keeps its own files (docs/meta-wizard.md). Self-contained:
// `install` copies scripts/meta-wizard* out of the checkout, so nothing here imports the overseer.

export const TASK_NAME = 'Conductor Meta-wizard'
export const CREDENTIAL_FILE = 'control-owner.json'

/** The installed app's userData: %APPDATA%\Conductor. */
export function installedUserData(env = process.env) {
  if (!env.APPDATA) throw new Error('APPDATA is not set; cannot locate the installed Conductor profile')
  return join(env.APPDATA, 'Conductor')
}

/** The installed Conductor.exe when the recovery arm record names none. */
export function defaultExe(env = process.env) {
  return join(env.LOCALAPPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Local'), 'Programs', 'conductor-desktop', 'Conductor.exe')
}

export const stateDir = userData => join(userData, 'meta-wizard')

/** Whether a pid names a live process. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))

/**
 * `<userData>/control-owner.json`: `{ok:true, credential}`, or `{ok:false, reason, stale?, credential?}`.
 * A file whose pid is dead is stale (the app crashed without deleting it). The token is kept in
 * memory only; nothing here ever logs it.
 */
export async function readCredential(userData, { isAlive = pidAlive } = {}) {
  let value
  try { value = await readJson(join(userData, CREDENTIAL_FILE)) } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'no control-owner.json (Conductor is not running, or its control server has not started)' : `control-owner.json unreadable: ${error.message}` }
  }
  if (!value || typeof value.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/control$/.test(value.endpoint) || typeof value.token !== 'string' || !Number.isSafeInteger(value.pid)) return { ok: false, reason: 'control-owner.json is malformed' }
  if (!isAlive(value.pid)) return { ok: false, stale: true, credential: value, reason: `control-owner.json names pid ${value.pid}, which is not running` }
  return { ok: true, credential: value }
}

/** The recovery watchdog's arm record (docs/recovery-mode.md): how the last Conductor stopped. */
export async function readArmed(userData) {
  try { return await readJson(join(userData, 'recovery', 'armed.json')) } catch { return null }
}
