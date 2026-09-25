import { describe, expect, it, vi } from 'vitest'
import { PHONE_LOCK_MAX_FAILURES, PhoneLock, PhoneLockError, isPhoneCode } from './phone-lock'
import { MemoryVault, type SecretKeyValueStore } from './secret-store'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

function fixture(options: { store?: MapStore; vault?: MemoryVault } = {}) {
  const store = options.store ?? new MapStore()
  const vault = options.vault ?? new MemoryVault()
  let now = Date.parse('2026-09-25T10:00:00Z')
  const audit = vi.fn()
  const locked = vi.fn()
  const lock = new PhoneLock({ store, vault, now: () => now, audit, locked })
  return { lock, store, vault, audit, locked, advance: (ms: number) => { now += ms } }
}

const phone = { id: 'phone-1', name: 'iPhone' }

const refusal = async (promise: Promise<unknown>): Promise<PhoneLockError> => {
  try { await promise } catch (error) { if (error instanceof PhoneLockError) return error; throw error }
  throw new Error('expected a refusal')
}

describe('the phone lock code', () => {
  it('accepts exactly six ASCII digits', () => {
    expect(isPhoneCode('123456')).toBe(true)
    for (const bad of ['12345', '1234567', '12345a', '１２３４５６', ' 123456', 123456, null]) expect(isPhoneCode(bad)).toBe(false)
  })

  it('stores only a salted scrypt hash, in the vault, never the code', async () => {
    const { lock, store, vault } = fixture()
    expect(lock.configured()).toBe(false)
    await lock.setCode('482915')
    expect(lock.configured()).toBe(true)
    const everything = JSON.stringify([...store.values]) + JSON.stringify(vault.read('phone-access.lock.hash'))
    expect(everything).not.toContain('482915')
    const stored = JSON.parse(vault.read('phone-access.lock.hash')!) as Record<string, unknown>
    expect(stored).toMatchObject({ v: 1, N: 32768, r: 8, p: 1, keylen: 32 })
    expect(Buffer.from(String(stored.salt), 'base64')).toHaveLength(16)
    // Two codes set the same way still differ, because the salt does.
    const other = fixture()
    await other.lock.setCode('482915')
    expect(JSON.parse(other.vault.read('phone-access.lock.hash')!).hash).not.toBe(stored.hash)
  })

  it('refuses a malformed code on the desktop', async () => {
    const { lock } = fixture()
    await expect(lock.setCode('12345')).rejects.toThrow(/six digits/)
    await expect(lock.setCode('abcdef')).rejects.toThrow(/six digits/)
  })

  it('unlocks with the right code and refuses a wrong one with the attempts left', async () => {
    const { lock } = fixture()
    await lock.setCode('482915')
    const wrong = await refusal(lock.unlock('000000', phone))
    expect(wrong.status).toBe(403)
    expect(wrong.detail).toMatchObject({ remaining: PHONE_LOCK_MAX_FAILURES - 1 })
    const opened = await lock.unlock('482915', phone)
    expect(opened.unlockToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(lock.session(phone.id, opened.unlockToken)).not.toBeNull()
    expect(lock.status().failures).toBe(0)
  })

  it('backs off between attempts and locks out after five, across a restart, until the desktop resets it', async () => {
    const { lock, store, vault, advance, audit } = fixture()
    await lock.setCode('482915')
    await refusal(lock.unlock('000001', phone))
    await refusal(lock.unlock('000002', phone))
    // Two misses: the third attempt waits.
    const waiting = await refusal(lock.unlock('482915', phone))
    expect(waiting.status).toBe(429)
    expect(waiting.detail.retryAt).toBeTruthy()
    advance(5_001)
    await refusal(lock.unlock('000003', phone))
    advance(30_001)
    await refusal(lock.unlock('000004', phone))
    advance(120_001)
    const out = await refusal(lock.unlock('000005', phone))
    expect(out.status).toBe(423)
    expect(out.detail).toMatchObject({ lockedOut: true })
    expect(audit).toHaveBeenCalledWith(expect.stringMatching(/locked out after 5 wrong codes/))
    // Even the right code is refused now, and a restart does not hand out new attempts.
    advance(24 * 3600_000)
    expect((await refusal(lock.unlock('482915', phone))).status).toBe(423)
    const restarted = new PhoneLock({ store, vault })
    expect(restarted.status()).toMatchObject({ lockedOut: true, failures: 5 })
    expect((await refusal(restarted.unlock('482915', phone))).status).toBe(423)
    restarted.resetAttempts()
    expect(restarted.status()).toMatchObject({ lockedOut: false, failures: 0 })
    await expect(restarted.unlock('482915', phone)).resolves.toMatchObject({ unlockToken: expect.any(String) })
  })

  it('counts parallel guesses one at a time', async () => {
    const { lock } = fixture()
    await lock.setCode('482915')
    const results = await Promise.allSettled(['000001', '000002', '000003', '000004'].map(code => lock.unlock(code, phone)))
    const statuses = results.map(result => result.status === 'rejected' ? (result.reason as PhoneLockError).status : 200)
    // Two are looked at; the rest meet the backoff without costing a hash.
    expect(statuses).toEqual([403, 403, 429, 429])
    expect(lock.status().failures).toBe(2)
  })

  it('binds an unlock token to its device and expires it after idle time unless touched', async () => {
    const { lock, advance, locked } = fixture()
    await lock.setCode('482915')
    const { unlockToken } = await lock.unlock('482915', phone)
    expect(lock.session('phone-2', unlockToken)).toBeNull()
    expect(lock.session(phone.id, 'x'.repeat(43))).toBeNull()
    const session = lock.session(phone.id, unlockToken)!
    advance(4 * 60_000)
    lock.touch(session.id)
    advance(4 * 60_000)
    expect(lock.session(phone.id, unlockToken)).not.toBeNull()
    // Checking is not activity: only touch() moves the idle clock.
    advance(90_000)
    expect(lock.session(phone.id, unlockToken)).toBeNull()
    expect(locked).toHaveBeenCalledWith(phone.id, session.id)
    expect(lock.unlocked(phone.id)).toBe(false)
  })

  it('locks every phone when the code changes or is removed, and an explicit lock ends one session', async () => {
    const { lock, locked } = fixture()
    await lock.setCode('482915')
    const first = await lock.unlock('482915', phone)
    const second = await lock.unlock('482915', { id: 'phone-2' })
    lock.lock(lock.session('phone-2', second.unlockToken)!.id)
    expect(lock.session('phone-2', second.unlockToken)).toBeNull()
    expect(lock.session(phone.id, first.unlockToken)).not.toBeNull()
    await lock.setCode('111111')
    expect(lock.session(phone.id, first.unlockToken)).toBeNull()
    expect(locked).toHaveBeenCalledTimes(2)
    await expect(lock.unlock('482915', phone)).rejects.toThrow(/wrong/)
    const third = await lock.unlock('111111', phone)
    lock.removeCode()
    expect(lock.configured()).toBe(false)
    expect(lock.session(phone.id, third.unlockToken)).toBeNull()
  })

  it('fails closed when a code was set but the vault no longer holds it', async () => {
    const store = new MapStore()
    const first = fixture({ store })
    await first.lock.setCode('482915')
    const second = fixture({ store, vault: new MemoryVault() })
    expect(second.lock.configured()).toBe(true)
    const refused = await refusal(second.lock.unlock('482915', phone))
    expect(refused.status).toBe(409)
    expect(refused.message).toMatch(/Set it again/)
  })

  it('offers only the idle choices the desktop shows', () => {
    const { lock } = fixture()
    expect(lock.status().idleMinutes).toBe(5)
    lock.setIdleMinutes(10)
    expect(lock.idleMs()).toBe(600_000)
    expect(() => lock.setIdleMinutes(0)).toThrow()
    expect(() => lock.setIdleMinutes(999)).toThrow()
  })
})
