import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { PHONE_LOCK_IDLE_MINUTES, type PhoneLockView } from '../shared/phone-access'
import type { SecretKeyValueStore, SecretVault } from './secret-store'

/**
 * The phone's 6-digit lock: a second factor on top of pairing.
 *
 * Pairing proves which phone is asking (its bearer token); the code proves the owner is holding
 * it. The listener asks this object before every phone API call and stream, so a phone that is
 * locked gets nothing but the lock endpoints. docs/phone-lock-and-terminal.md is the threat model.
 *
 * What is kept where:
 *   - the code only as a salted scrypt hash, in the OS credential vault (not the plain settings
 *     table), so a copied database alone does not even hold the hash;
 *   - the failure counter in the settings table, so a restart does not hand out fresh attempts;
 *   - unlock sessions in memory only: a restart locks every phone.
 */

const HASH_KEY = 'phone-access.lock.hash'
const ATTEMPTS_KEY = 'phone-access.lock.attempts'
const OPTIONS_KEY = 'phone-access.lock.options'
/** Non-secret marker that a code exists: the lock fails closed if the vault stops answering. */
const MARKER_KEY = 'phone-access.lock.setAt'

export const PHONE_CODE_LENGTH = 6
/** Consecutive wrong codes, counted across every phone, before only the desktop can clear it. */
export const PHONE_LOCK_MAX_FAILURES = 5
/** The wait after the n-th consecutive failure before the next attempt is looked at. */
export const PHONE_LOCK_BACKOFF_MS = [0, 0, 5_000, 30_000, 120_000] as const
export const PHONE_LOCK_IDLE_CHOICES_MIN = PHONE_LOCK_IDLE_MINUTES
export const DEFAULT_PHONE_LOCK_IDLE_MIN = 5
/** How long the app may sit in the background before it locks itself when it comes back. */
export const PHONE_LOCK_BACKGROUND_MS = 60_000
/** How often idle sessions are swept, so a long-lived stream does not outlive its session. */
const SWEEP_MS = 10_000
const MAX_SESSIONS = 64

/** scrypt at N=2^15, r=8: about 32 MiB and ~100 ms per guess, off the main thread. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

interface StoredHash { v: 1; salt: string; hash: string; N: number; r: number; p: number; keylen: number; setAt: string }
interface Attempts { failures: number; lastFailureAt: number; lockedOut: boolean }
interface UnlockSession { id: string; deviceId: string; tokenHash: string; createdAt: number; lastActiveAt: number }

export type PhoneLockStatus = PhoneLockView

export interface PhoneLockDependencies {
  store: SecretKeyValueStore
  vault: SecretVault
  now?(): number
  /** One line for the app's audit log: lockouts, resets, code changes. Never the code. */
  audit?(line: string): void
  /** A device's unlocked session ended (idle, explicit lock, code change, reset, revoke). */
  locked?(deviceId: string, sessionId: string): void
  /**
   * A code was set or changed: every phone locks, including streams opened while there was no
   * code and so no session to end.
   */
  everyPhone?(): void
}

const scryptAsync = (code: string, salt: Buffer, options: typeof SCRYPT): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(code, salt, options.keylen, { N: options.N, r: options.r, p: options.p, maxmem: options.maxmem }, (error, key) => error ? reject(error) : resolve(key))
})

const tokenHash = (token: string): Buffer => createHash('sha256').update(token).digest()

/** Exactly six ASCII digits; anything else is refused before it costs a hash. */
export const isPhoneCode = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{6}$/.test(value)

/** Carries the HTTP status and the fields the lock pad reads (remaining, retryAt, lockedOut). */
export class PhoneLockError extends Error {
  constructor(message: string, readonly status = 400, readonly detail: Record<string, unknown> = {}) { super(message) }
}

export class PhoneLock {
  private sessions = new Map<string, UnlockSession>()
  private attempts: Attempts
  private idleMinutes: number
  /** One verification at a time, so parallel guesses cannot all be counted against the same state. */
  private verifying: Promise<unknown> = Promise.resolve()
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: PhoneLockDependencies) {
    this.attempts = this.readAttempts()
    const options = this.readJson<{ idleMinutes?: number }>(deps.store.getSetting(OPTIONS_KEY), {})
    this.idleMinutes = PHONE_LOCK_IDLE_CHOICES_MIN.includes(options.idleMinutes as never) ? options.idleMinutes! : DEFAULT_PHONE_LOCK_IDLE_MIN
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private audit(line: string): void { this.deps.audit?.(line) }

  private readJson<T>(value: string | null, fallback: T): T {
    if (!value) return fallback
    try { return JSON.parse(value) as T } catch { return fallback }
  }

  private readAttempts(): Attempts {
    const raw = this.readJson<Partial<Attempts>>(this.deps.store.getSetting(ATTEMPTS_KEY), {})
    const failures = Number.isSafeInteger(raw.failures) && raw.failures! > 0 ? raw.failures! : 0
    return { failures, lastFailureAt: Number(raw.lastFailureAt) || 0, lockedOut: raw.lockedOut === true || failures >= PHONE_LOCK_MAX_FAILURES }
  }

  private saveAttempts(): void { this.deps.store.setSetting(ATTEMPTS_KEY, JSON.stringify(this.attempts)) }

  private stored(): StoredHash | null {
    if (!this.deps.vault.available()) return null
    const value = this.readJson<StoredHash | null>(this.deps.vault.read(HASH_KEY), null)
    return value && value.v === 1 && typeof value.salt === 'string' && typeof value.hash === 'string' ? value : null
  }

  configured(): boolean { return Boolean(this.deps.store.getSetting(MARKER_KEY)) || this.stored() !== null }

  idleMs(): number { return this.idleMinutes * 60_000 }

  status(): PhoneLockStatus {
    this.sweep()
    const stored = this.stored()
    const retryAt = this.retryAt()
    return {
      configured: this.configured(), setAt: stored?.setAt ?? this.deps.store.getSetting(MARKER_KEY), idleMinutes: this.idleMinutes, backgroundMs: PHONE_LOCK_BACKGROUND_MS,
      failures: this.attempts.failures, lockedOut: this.attempts.lockedOut,
      retryAt: retryAt ? new Date(retryAt).toISOString() : null,
      unlockedDevices: [...new Set([...this.sessions.values()].map(session => session.deviceId))]
    }
  }

  /* ----------------------------------------------------------------------- *
   * Desktop side: set, change, remove, reset
   * ----------------------------------------------------------------------- */

  /** Sets or replaces the code. Every phone locks: an old unlock was made with the old code. */
  async setCode(code: unknown): Promise<void> {
    if (!isPhoneCode(code)) throw new PhoneLockError('The code is exactly six digits.')
    if (!this.deps.vault.available()) throw new PhoneLockError('The OS credential store is unavailable, so the code cannot be stored safely.', 409)
    const salt = randomBytes(16)
    const hash = await scryptAsync(code, salt, SCRYPT)
    const record: StoredHash = { v: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen, setAt: new Date(this.now()).toISOString() }
    const replaced = this.configured()
    this.deps.vault.write(HASH_KEY, JSON.stringify(record))
    this.deps.store.setSetting(MARKER_KEY, record.setAt)
    this.attempts = { failures: 0, lastFailureAt: 0, lockedOut: false }
    this.saveAttempts()
    this.lockAll()
    try { this.deps.everyPhone?.() } catch { /* the gate refuses them on their next call anyway */ }
    this.audit(replaced ? 'phone lock: code changed on the desktop; every phone locked' : 'phone lock: code set on the desktop')
  }

  removeCode(): void {
    if (!this.configured()) return
    try { this.deps.vault.delete(HASH_KEY) } catch { /* the marker below is what the lock reads */ }
    this.deps.store.removeSetting(MARKER_KEY)
    this.attempts = { failures: 0, lastFailureAt: 0, lockedOut: false }
    this.saveAttempts()
    this.lockAll()
    this.audit('phone lock: code removed on the desktop')
  }

  /** The desktop's answer to a lockout: attempts start over; the code stays. */
  resetAttempts(): void {
    const was = this.attempts
    this.attempts = { failures: 0, lastFailureAt: 0, lockedOut: false }
    this.saveAttempts()
    if (was.failures || was.lockedOut) this.audit(`phone lock: attempts reset on the desktop (was ${was.failures} failure${was.failures === 1 ? '' : 's'}${was.lockedOut ? ', locked out' : ''})`)
  }

  setIdleMinutes(minutes: unknown): void {
    if (!PHONE_LOCK_IDLE_CHOICES_MIN.includes(minutes as never)) throw new PhoneLockError(`Choose one of ${PHONE_LOCK_IDLE_CHOICES_MIN.join(', ')} minutes.`)
    this.idleMinutes = minutes as number
    this.deps.store.setSetting(OPTIONS_KEY, JSON.stringify({ idleMinutes: this.idleMinutes }))
    this.sweep()
  }

  /* ----------------------------------------------------------------------- *
   * Phone side
   * ----------------------------------------------------------------------- */

  private retryAt(): number | null {
    if (this.attempts.lockedOut || this.attempts.failures < 1) return null
    const wait = PHONE_LOCK_BACKOFF_MS[Math.min(this.attempts.failures, PHONE_LOCK_BACKOFF_MS.length - 1)] ?? 0
    const at = this.attempts.lastFailureAt + wait
    return at > this.now() ? at : null
  }

  /**
   * Checks a code against the hash, counting a miss against the shared failure budget. Refused
   * without hashing while backing off or locked out, so waiting is the only way through.
   */
  verify(code: unknown, device: { id: string; name?: string }): Promise<void> {
    const run = this.verifying.then(() => this.verifyNow(code, device))
    this.verifying = run.catch(() => undefined)
    return run
  }

  private async verifyNow(code: unknown, device: { id: string; name?: string }): Promise<void> {
    const stored = this.stored()
    if (!stored) throw new PhoneLockError(this.configured() ? 'The code could not be read from the OS credential store. Set it again in Conductor on the computer.' : 'No phone code is set on the computer.', 409, { configured: this.configured() })
    if (this.attempts.lockedOut) throw new PhoneLockError('Too many wrong codes. Reset the lock in Conductor on the computer (Settings > Phone).', 423, { lockedOut: true })
    const retryAt = this.retryAt()
    if (retryAt) throw new PhoneLockError('Wait before trying again.', 429, { retryAt: new Date(retryAt).toISOString() })
    const attempt = isPhoneCode(code) ? code : ''
    const expected = Buffer.from(stored.hash, 'base64')
    // A malformed attempt still costs the same hash, so its answer takes as long as a real one.
    const actual = await scryptAsync(attempt || '------', Buffer.from(stored.salt, 'base64'), { N: stored.N, r: stored.r, p: stored.p, keylen: stored.keylen, maxmem: SCRYPT.maxmem })
    if (attempt && actual.length === expected.length && timingSafeEqual(actual, expected)) {
      if (this.attempts.failures) { this.attempts = { failures: 0, lastFailureAt: 0, lockedOut: false }; this.saveAttempts() }
      return
    }
    const failures = this.attempts.failures + 1
    this.attempts = { failures, lastFailureAt: this.now(), lockedOut: failures >= PHONE_LOCK_MAX_FAILURES }
    this.saveAttempts()
    if (this.attempts.lockedOut) {
      this.lockAll()
      this.audit(`phone lock: locked out after ${failures} wrong codes (last from ${device.name ?? device.id}); reset it on the desktop`)
      throw new PhoneLockError('Too many wrong codes. Reset the lock in Conductor on the computer (Settings > Phone).', 423, { lockedOut: true })
    }
    const next = this.retryAt()
    throw new PhoneLockError('That code is wrong.', 403, { remaining: PHONE_LOCK_MAX_FAILURES - failures, retryAt: next ? new Date(next).toISOString() : null })
  }

  /** A right code opens one session for this phone; its token rides on every later request. */
  async unlock(code: unknown, device: { id: string; name?: string }): Promise<{ unlockToken: string; idleMs: number; backgroundMs: number }> {
    await this.verify(code, device)
    const token = randomBytes(32).toString('base64url')
    const at = this.now()
    const session: UnlockSession = { id: randomBytes(9).toString('base64url'), deviceId: device.id, tokenHash: tokenHash(token).toString('hex'), createdAt: at, lastActiveAt: at }
    this.sessions.set(session.id, session)
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
      if (!oldest) break
      this.end(oldest)
    }
    this.startSweeper()
    return { unlockToken: token, idleMs: this.idleMs(), backgroundMs: PHONE_LOCK_BACKGROUND_MS }
  }

  /**
   * The session a request's unlock token names, for that device, if it is still live. Checking
   * does not count as activity: a screen that polls on its own must not hold the phone open.
   */
  session(deviceId: string, token: string | undefined): { id: string } | null {
    if (!token || token.length > 200) return null
    const wanted = tokenHash(token)
    for (const session of this.sessions.values()) {
      const stored = Buffer.from(session.tokenHash, 'hex')
      if (stored.length !== wanted.length || !timingSafeEqual(stored, wanted)) continue
      if (session.deviceId !== deviceId) return null
      if (this.now() - session.lastActiveAt > this.idleMs()) { this.end(session); return null }
      return { id: session.id }
    }
    return null
  }

  /** The owner touched the phone: the idle clock starts over. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && this.now() - session.lastActiveAt <= this.idleMs()) session.lastActiveAt = this.now()
  }

  /** Ends one session: the app went to the background, or the owner locked it. */
  lock(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) this.end(session)
  }

  /** Ends every session a device holds, for an unpaired or revoked phone. */
  lockDevice(deviceId: string): void {
    for (const session of [...this.sessions.values()]) if (session.deviceId === deviceId) this.end(session)
  }

  /** Whether this device holds a live session; locked phones get notifications without content. */
  unlocked(deviceId: string): boolean {
    this.sweep()
    return [...this.sessions.values()].some(session => session.deviceId === deviceId)
  }

  lockAll(): void { for (const session of [...this.sessions.values()]) this.end(session) }

  private end(session: UnlockSession): void {
    if (!this.sessions.delete(session.id)) return
    try { this.deps.locked?.(session.deviceId, session.id) } catch { /* a listener never keeps a session alive */ }
    if (!this.sessions.size) this.stopSweeper()
  }

  /** Ends every session that went idle; streams and terminals follow through `locked`. */
  sweep(): void {
    const at = this.now(), idle = this.idleMs()
    for (const session of [...this.sessions.values()]) if (at - session.lastActiveAt > idle) this.end(session)
  }

  private startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS)
    this.sweeper.unref?.()
  }

  private stopSweeper(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null }
  }

  dispose(): void {
    this.stopSweeper()
    this.sessions.clear()
  }
}

/**
 * The app log's phone audit trail: one timestamped line per event, in a file of its own under
 * userData/logs so it survives the console. Rolled once at 1 MiB so it never grows unbounded.
 */
export function phoneAuditWriter(file: string, echo: (line: string) => void = line => console.info(line)): (line: string) => void {
  return line => {
    const entry = `${new Date().toISOString()} ${line.replace(/[\r\n]+/g, ' ')}`
    echo(entry)
    try {
      mkdirSync(dirname(file), { recursive: true })
      try { if (statSync(file).size > 1024 * 1024) renameSync(file, file + '.1') } catch { /* no file yet */ }
      appendFileSync(file, entry + '\n')
    } catch { /* the audit line was still echoed to the console */ }
  }
}
