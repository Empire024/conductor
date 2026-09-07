import { describe, expect, it, vi } from 'vitest'
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
import * as pty from 'node-pty'
import type { StructuredSessions } from './structured-sessions'
import type { ConductorDatabase } from './database'
import { NativeCliManager, nativeCliArgs } from './native-cli-manager'
describe('native conversation launch arguments', () => {
  it('resumes the exact Codex ID without newest-session fallback or a prompt', () => {
    const args = nativeCliArgs('codex', 'specific-native-id', { permission: 'read-only', plan: false, model: 'test-model', effort: 'low' })
    expect(args.slice(0, 2)).toEqual(['resume', 'specific-native-id'])
    expect(args).toContain('read-only')
    expect(args).not.toContain('--last')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
  it('preserves Claude Auto, Edit, Plan and manual policies during CLI handoff', () => {
    expect(nativeCliArgs('claude', 'same-id', { permission: 'auto', plan: false })).toContain('auto')
    expect(nativeCliArgs('claude', 'same-id', { permission: 'accept-edits', plan: false })).toContain('acceptEdits')
    expect(nativeCliArgs('claude', 'same-id', { permission: 'auto', plan: true })).toContain('plan')
    expect(nativeCliArgs('claude', 'same-id', { permission: 'default', plan: false })).toContain('manual')
  })
  it('uses an exact Claude identity for both a new session and a resume', () => {
    const settings = { permission: 'default', plan: false } as const
    expect(nativeCliArgs('claude', 'same-id', settings).slice(0, 2)).toEqual(['--resume', 'same-id'])
    expect(nativeCliArgs('claude', 'same-id', settings, true).slice(0, 2)).toEqual(['--session-id', 'same-id'])
    expect(() => nativeCliArgs('codex', '--last; run', settings)).toThrow()
  })
})

describe('CLI startup recovery', () => {
  it('omits inherited settings and provider defaults from native arguments', () => {
    const args = nativeCliArgs('codex', 'same-id', { permission: 'default', plan: false, model: 'default', effort: 'auto', sandbox: 'inherit', approvalPolicy: 'inherit' })
    expect(args).toEqual(['resume', 'same-id'])
    expect(nativeCliArgs('codex', 'same-id', { permission: 'default', plan: false, approvalPolicy: 'untrusted' })).toContain('approval_policy="untrusted"')
  })
  it('releases CLI ownership when the PTY fails, allowing a clean retry', async () => {
    const spec = { id: 'pane', provider: 'codex', cwd: process.cwd() }
    const sessions = { cliSpec: () => spec, prepareCli: vi.fn(async () => ({ spec, nativeSessionId: 'same-id', settings: { permission: 'default', plan: false } })), cancelCli: vi.fn() }
    const database = { structured: { snapshot: () => ({ settings: { plan: false } }) } }
    const manager = new NativeCliManager(sessions as unknown as StructuredSessions, database as unknown as ConductorDatabase, () => 'provider.exe', vi.fn())
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw new Error('PTY unavailable') })
    await expect(manager.ensure('pane')).rejects.toThrow('PTY unavailable')
    expect(sessions.cancelCli).toHaveBeenCalledWith('pane')
    vi.mocked(pty.spawn).mockReturnValueOnce({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() } as unknown as ReturnType<typeof pty.spawn>)
    await expect(manager.ensure('pane')).resolves.toMatchObject({ available: true, status: 'running' })
    expect(sessions.prepareCli).toHaveBeenCalledTimes(2)
    manager.dispose()
  })
})
