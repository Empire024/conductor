import { describe, expect, it, vi } from 'vitest'
import { ClaudeFullAutoPolicy, CLAUDE_FULL_AUTO_KEY } from './claude-full-auto'
import { registerClaudeFullAutoIpc } from './claude-full-auto-ipc'

function harness() {
  const values = new Map<string, string>()
  const store = { getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) } }
  const reconcile = vi.fn(async (): Promise<void> => undefined)
  const changed = vi.fn()
  const policy = new ClaudeFullAutoPolicy(store, reconcile, changed)
  return { values, store, reconcile, changed, policy }
}
describe('installation-wide owner Full Auto policy', () => {
  it('never infers authorization from existing Auto, wizard, or a malformed record', () => {
    const h = harness()
    h.values.set('rememberedPermission:claude', 'auto')
    for (const forged of ['true', '{"enabled":true}', '{"version":1,"source":"agent","enabled":true,"changedAt":"2026-09-28"}', 'not json']) {
      h.values.set(CLAUDE_FULL_AUTO_KEY, forged)
      expect(h.policy.authorized()).toBe(false)
    }
  })
  it('persists one owner activation before applying runtimes, survives restart, and deduplicates replay', async () => {
    const h = harness()
    h.reconcile.mockImplementation(async () => { expect(h.policy.authorized()).toBe(true) })
    const result = await h.policy.setEnabled(true)
    expect(result).toMatchObject({ enabled: true, applying: false })
    expect(result.authorizedAt).toBeTruthy()
    expect(new ClaudeFullAutoPolicy(h.store, h.reconcile, h.changed).authorized()).toBe(true)
    await h.policy.setEnabled(true)
    expect(h.reconcile).toHaveBeenCalledTimes(1)
  })
  it('revokes policy before subsequent runtime work and preserves the exact runtime failure', async () => {
    const h = harness()
    await h.policy.setEnabled(true)
    h.reconcile.mockImplementation(async () => { expect(h.policy.authorized()).toBe(false); throw new Error('runtime rejected set_permission_mode: managed policy') })
    expect(await h.policy.setEnabled(false)).toMatchObject({ enabled: false, error: 'runtime rejected set_permission_mode: managed policy', applying: false })
    expect(new ClaudeFullAutoPolicy(h.store, h.reconcile, h.changed).authorized()).toBe(false)
  })
  it('rejects concurrent transitions so an approval replay cannot queue multiple mode changes', async () => {
    const h = harness()
    let resolve!: () => void
    h.reconcile.mockImplementation(() => new Promise<void>(done => { resolve = done }))
    const applying = h.policy.setEnabled(true)
    await expect(h.policy.setEnabled(true)).rejects.toThrow('already in progress')
    resolve(); await applying
    expect(h.reconcile).toHaveBeenCalledTimes(1)
  })
  it('rejects untrusted IPC origins before accessing the policy, and has no agent-control channel', async () => {
    const h = harness()
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipc = { handle: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler) }, removeHandler: vi.fn() }
    const trusted = { sender: 'owner-top-level' }
    registerClaudeFullAutoIpc(ipc, h.policy, event => { if (event !== trusted as unknown) throw new Error('Untrusted origin') })
    const enable = handlers.get('claude-full-auto:set-enabled')!
    for (const origin of [{ sender: 'agent' }, { sender: 'web-page' }, { sender: 'replayed-approval' }, {}]) expect(() => enable(origin, true)).toThrow('Untrusted origin')
    expect(h.policy.authorized()).toBe(false)
    expect(() => enable(trusted, 'true')).toThrow('must be a boolean')
    await enable(trusted, true)
    expect(h.policy.authorized()).toBe(true)
  })
})
