import type { ProviderCapabilities, SessionSettings, StructuredProvider } from '../../../shared/structured-agent'

type Permission = SessionSettings['permission']
export type PermissionStore = Pick<Storage, 'getItem' | 'setItem'>
const KEY = 'conductor.structured.permission'
const PERMISSIONS: Permission[] = ['default', 'read-only', 'accept-edits', 'auto']
const isPermission = (value: unknown): value is Permission => PERMISSIONS.includes(value as Permission)
const browserStore = (): PermissionStore | undefined => { try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined } }
const read = (store: PermissionStore | undefined): Record<string, unknown> => {
  try { const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? 'null'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
}
/** The chosen mode is a per-provider preference: Codex never offers these, and a Claude
 *  choice must not silently become the default for a provider that cannot honour it. */
export function rememberedPermission(provider: StructuredProvider, store = browserStore()): Permission | undefined {
  const value = read(store)[provider]
  return isPermission(value) ? value : undefined
}
/** Only a mode the provider actually offered is stored, so a later session never opens on a
 *  permission the adapter rejects. A full or blocked store must not break the mode picker. */
export function rememberPermission(provider: StructuredProvider, permission: unknown, capabilities?: ProviderCapabilities, store = browserStore()): void {
  if (!store || !isPermission(permission)) return
  if (capabilities && capabilities.provider !== provider) return
  if (capabilities?.permissions && !capabilities.permissions.includes(permission)) return
  try { store.setItem(KEY, JSON.stringify({ ...read(store), [provider]: permission })) } catch { /* storage quota or a blocked origin */ }
}
export const initialPermission = (provider: StructuredProvider, store = browserStore()): Permission => rememberedPermission(provider, store) ?? 'default'
