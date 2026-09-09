import { safeStorage } from 'electron'
import type { SecretCipher } from './secret-store'

/** The only place Electron's credential store is touched; kept out of unit-tested modules. */
export const safeStorageCipher: SecretCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: value => safeStorage.encryptString(value),
  decrypt: value => safeStorage.decryptString(value)
}
