import { describe, expect, it, vi } from 'vitest'
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
import { nativeCliArgs } from './native-cli-manager'
describe('native conversation launch arguments', () => {
  it('resumes the exact Codex ID without newest-session fallback or a prompt', () => {
    const args = nativeCliArgs('codex', 'specific-native-id', { permission: 'read-only', plan: false, model: 'test-model', effort: 'low' })
    expect(args.slice(0, 2)).toEqual(['resume', 'specific-native-id'])
    expect(args).toContain('read-only')
    expect(args).not.toContain('--last')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
  it('uses an exact Claude identity for both a new session and a resume', () => {
    const settings = { permission: 'default', plan: false } as const
    expect(nativeCliArgs('claude', 'same-id', settings).slice(0, 2)).toEqual(['--resume', 'same-id'])
    expect(nativeCliArgs('claude', 'same-id', settings, true).slice(0, 2)).toEqual(['--session-id', 'same-id'])
    expect(() => nativeCliArgs('codex', '--last; run', settings)).toThrow()
  })
})
