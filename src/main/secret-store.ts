/**
 * Credentials live in the OS credential store, never in the SQLite file or a config file in
 * readable form. The database only ever holds the opaque ciphertext produced by the platform
 * cipher; when the platform cannot encrypt, writing a secret fails loudly instead of degrading
 * to plaintext.
 */
export interface SecretCipher {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export interface SecretKeyValueStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  removeSetting(key: string): void
}

export interface SecretVault {
  available(): boolean
  read(key: string): string | null
  write(key: string, value: string): void
  delete(key: string): void
}

const settingKey = (key: string): string => `secret.${key}`

export class StoredSecretVault implements SecretVault {
  constructor(private readonly store: SecretKeyValueStore, private readonly cipher: SecretCipher) {}

  available(): boolean {
    try { return this.cipher.available() } catch { return false }
  }

  read(key: string): string | null {
    const stored = this.store.getSetting(settingKey(key))
    if (!stored) return null
    if (!this.available()) return null
    try { return this.cipher.decrypt(Buffer.from(stored, 'base64')) }
    catch { this.delete(key); return null }
  }

  write(key: string, value: string): void {
    if (!this.available()) throw new Error('This computer has no available credential store, so Conductor will not save the token. Sign in again once the OS keychain is unlocked.')
    this.store.setSetting(settingKey(key), this.cipher.encrypt(value).toString('base64'))
  }

  delete(key: string): void {
    this.store.removeSetting(settingKey(key))
  }
}

/** Test and headless double; keeps secrets in process memory and never touches disk. */
export class MemoryVault implements SecretVault {
  private readonly values = new Map<string, string>()
  constructor(private readonly ready = true) {}
  available(): boolean { return this.ready }
  read(key: string): string | null { return this.ready ? this.values.get(key) ?? null : null }
  write(key: string, value: string): void {
    if (!this.ready) throw new Error('This computer has no available credential store, so Conductor will not save the token. Sign in again once the OS keychain is unlocked.')
    this.values.set(key, value)
  }
  delete(key: string): void { this.values.delete(key) }
}
