import { describe, expect, it, vi } from 'vitest'
import { claudeInChromeEnabled, parseClaudeInChromeMode } from '../shared/claude-in-chrome'
import { CLAUDE_IN_CHROME_SETTING, claudeInChromeHostInstalled, claudeInChromeHostPaths, claudeInChromeState, registerClaudeInChromeIpc } from './claude-in-chrome'

// haf-claude-in-chrome-missing-20261021
describe('Claude in Chrome for Conductor\'s Claude tabs', () => {
  it('finds the native host manifest Claude Code registers, per platform', () => {
    expect(claudeInChromeHostPaths('win32', { APPDATA: 'C:\\Users\\o\\AppData\\Roaming' }, 'C:\\Users\\o')[0]).toMatch(/Roaming[\\/]Claude Code[\\/]ChromeNativeHost[\\/]com\.anthropic\.claude_code_browser_extension\.json$/)
    expect(claudeInChromeHostPaths('darwin', {}, '/Users/o')[0]).toMatch(/Library[\\/]Application Support[\\/]Google[\\/]Chrome[\\/]NativeMessagingHosts[\\/]com\.anthropic\.claude_code_browser_extension\.json$/)
    expect(claudeInChromeHostPaths('linux', {}, '/home/o')[0]).toMatch(/\.config[\\/]google-chrome[\\/]NativeMessagingHosts/)
    expect(claudeInChromeHostInstalled(['a', 'b'], path => path === 'b')).toBe(true)
    expect(claudeInChromeHostInstalled(['a'], () => { throw new Error('denied') })).toBe(false)
  })

  it('is on by default when the host is installed, and the owner\'s on/off wins', () => {
    expect(parseClaudeInChromeMode(null)).toBe('auto')
    expect(parseClaudeInChromeMode('garbage')).toBe('auto')
    expect(claudeInChromeEnabled('auto', true)).toBe(true)
    expect(claudeInChromeEnabled('auto', false)).toBe(false)
    expect(claudeInChromeEnabled('off', true)).toBe(false)
    expect(claudeInChromeEnabled('on', false)).toBe(true)
    expect(claudeInChromeState(() => null, true)).toEqual({ mode: 'auto', hostInstalled: true, enabled: true })
    expect(claudeInChromeState(key => key === CLAUDE_IN_CHROME_SETTING ? 'off' : null, true)).toEqual({ mode: 'off', hostInstalled: true, enabled: false })
  })

  it('takes the owner\'s choice only from the trusted window, and only a known mode', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const store = new Map<string, string>()
    const authorize = vi.fn()
    registerClaudeInChromeIpc({ handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never, { getSetting: key => store.get(key) ?? null, setSetting: (key, value) => { store.set(key, value) } }, authorize)
    expect(await handlers.get('claude-in-chrome:set-mode')!({}, 'off')).toMatchObject({ mode: 'off', enabled: false })
    expect(store.get(CLAUDE_IN_CHROME_SETTING)).toBe('off')
    expect(() => handlers.get('claude-in-chrome:set-mode')!({}, 'always')).toThrow(/auto, on or off/)
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(await handlers.get('claude-in-chrome:state')!({})).toMatchObject({ mode: 'off' })
  })
})
