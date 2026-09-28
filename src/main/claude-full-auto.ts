import type { ClaudeFullAutoState } from '../shared/claude-full-auto'

export const CLAUDE_FULL_AUTO_KEY = 'claudeFullAutoOwnerAuthorization:v1'
interface RecordV1 { version: 1; source: 'trusted-owner-control'; enabled: boolean; authorizedAt?: string; changedAt: string }
interface Store { getSetting(key: string): string | null; setSetting(key: string, value: string): void }

function savedRecord(store: Store): RecordV1 | undefined {
  try {
    const record: unknown = JSON.parse(store.getSetting(CLAUDE_FULL_AUTO_KEY) ?? 'null')
    if (!record || typeof record !== 'object') return undefined
    const value = record as Record<string, unknown>
    if (value.version !== 1 || value.source !== 'trusted-owner-control' || typeof value.enabled !== 'boolean' || typeof value.changedAt !== 'string' || !Number.isFinite(Date.parse(value.changedAt))) return undefined
    if (value.enabled && (typeof value.authorizedAt !== 'string' || !Number.isFinite(Date.parse(value.authorizedAt)))) return undefined
    return value as unknown as RecordV1
  } catch { return undefined }
}

/** No migration from Auto, wizard authority, provider settings, messages or permission grants.
 * Only the dedicated trusted owner IPC calls setEnabled. Policy is persisted before reconciliation
 * so new launches and queued work see a revocation immediately, even if a live runtime is busy. */
export class ClaudeFullAutoPolicy {
  private applying = false
  private error?: string
  constructor(private readonly store: Store, private readonly reconcile: () => Promise<unknown>, private readonly changed: (state: ClaudeFullAutoState) => void) {}
  authorized = (): boolean => savedRecord(this.store)?.enabled === true
  state(): ClaudeFullAutoState {
    const record = savedRecord(this.store)
    return { enabled: record?.enabled === true, ...(record?.authorizedAt ? { authorizedAt: record.authorizedAt } : {}), ...(record ? { changedAt: record.changedAt } : {}), applying: this.applying, ...(this.error ? { error: this.error } : {}) }
  }
  async setEnabled(enabled: boolean): Promise<ClaudeFullAutoState> {
    if (typeof enabled !== 'boolean') throw new Error('Full Auto authorization must be a boolean')
    if (this.applying) throw new Error('A Full Auto permission transition is already in progress')
    // Duplicate IPC delivery is idempotent and never turns into a fresh authorization or retry.
    if (enabled === this.authorized()) return this.state()
    const now = new Date().toISOString()
    const record: RecordV1 = { version: 1, source: 'trusted-owner-control', enabled, changedAt: now, ...(enabled ? { authorizedAt: now } : {}) }
    this.store.setSetting(CLAUDE_FULL_AUTO_KEY, JSON.stringify(record))
    this.applying = true; this.error = undefined; this.changed(this.state())
    try { await this.reconcile() }
    catch (error) { this.error = error instanceof Error ? error.message : String(error) }
    finally { this.applying = false; this.changed(this.state()) }
    return this.state()
  }
}
