import { describe, expect, it, vi } from 'vitest'
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
import * as pty from 'node-pty'
import type { StructuredSessions } from './structured-sessions'
import type { ConductorDatabase } from './database'
import { NativeCliManager, nativeCliArgs, trackNativeCliInput } from './native-cli-manager'
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

  it('reports submitted native work globally until interrupt or process exit', async () => {
    const spec = { id: 'pane', provider: 'codex', cwd: process.cwd() }
    const sessions = { cliSpec: () => spec, prepareCli: vi.fn(async () => ({ spec, nativeSessionId: 'same-id', settings: { permission: 'default', plan: false } })), cancelCli: vi.fn() }
    const database = { structured: { snapshot: () => ({ settings: { plan: false } }) } }
    let exit: ((event: { exitCode: number }) => void) | undefined
    const ptyProcess = { onData: vi.fn(), onExit: vi.fn(callback => { exit = callback }), write: vi.fn(), kill: vi.fn() }
    vi.mocked(pty.spawn).mockReturnValueOnce(ptyProcess as unknown as ReturnType<typeof pty.spawn>)
    const manager = new NativeCliManager(sessions as unknown as StructuredSessions, database as unknown as ConductorDatabase, () => 'provider.exe', vi.fn())
    await manager.ensure('pane')
    expect(manager.hasSubmittedInput()).toBe(false)
    manager.write('pane', 'work across another project')
    expect(manager.hasSubmittedInput()).toBe(false)
    manager.write('pane', '\r')
    expect(manager.hasSubmittedInput()).toBe(true)
    expect(manager.hasSubmittedInput('pane')).toBe(true)
    manager.write('pane', '\x03')
    expect(manager.hasSubmittedInput()).toBe(false)
    manager.write('pane', 'again\r')
    exit?.({ exitCode: 0 })
    expect(manager.hasSubmittedInput()).toBe(false)
    manager.dispose()
  })
})

describe('native CLI work evidence', () => {
  it('requires non-empty submitted input and clears only on an explicit interrupt', () => {
    let state = { draft: '', submitted: false }
    state = trackNativeCliInput(state, '\r')
    expect(state.submitted).toBe(false)
    state = trackNativeCliInput(state, 'fix the failing test')
    expect(state.submitted).toBe(false)
    state = trackNativeCliInput(state, '\r')
    expect(state.submitted).toBe(true)
    state = trackNativeCliInput(state, '\x03')
    expect(state).toEqual({ draft: '', submitted: false })
  })

  it('honours editing controls before Enter', () => {
    let state = trackNativeCliInput({ draft: '', submitted: false }, 'discard me\x15')
    expect(state).toEqual({ draft: '', submitted: false })
    state = trackNativeCliInput(state, 'x\x7f\r')
    expect(state.submitted).toBe(false)
  })
})
