import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeTokenStore, claudeTokenActive, claudeTokenEnvironment, LoginFlows, loginUrl, plainTerminalText, setClaudeTokenSource, setupTokenResult, type LoginFlowsDeps, type LoginPty } from './claude-login'
import { MemoryVault, type SecretKeyValueStore } from './secret-store'
import type { LoginFlowView } from '../shared/claude-login'

const TOKEN = 'sk-ant-oat01-' + 'Ab3_dE-fG'.repeat(10)
const URL_TEXT = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

class FakePty implements LoginPty {
  readonly written: string[] = []
  killed = false
  private data?: (data: string) => void
  private exit?: (event: { exitCode: number }) => void
  onData(listener: (data: string) => void): void { this.data = listener }
  onExit(listener: (event: { exitCode: number }) => void): void { this.exit = listener }
  write(data: string): void { this.written.push(data) }
  kill(): void { this.killed = true }
  print(text: string): void { this.data?.(text) }
  end(exitCode: number): void { this.exit?.({ exitCode }) }
}

function harness(overrides: Partial<LoginFlowsDeps> = {}) {
  const ptys: Array<{ pty: FakePty; file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
  const views: LoginFlowView[] = []
  const saved: Array<{ token: string; expiresAt: string | null }> = []
  const removed: string[] = []
  const restored = vi.fn()
  const verify = vi.fn(async () => ({ loggedIn: true }))
  let scratch = 0
  const logs: string[] = []
  const flows = new LoginFlows({
    spawn: (file, args, options) => { const pty = new FakePty(); ptys.push({ pty, file, args, env: options.env, cwd: options.cwd }); return pty },
    executable: provider => provider === 'claude' ? 'claude.exe' : 'codex.exe',
    environment: () => ({ PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'from-conductor-env' }),
    scratchDirectory: () => `scratch-${++scratch}`,
    removeDirectory: path => { removed.push(path) },
    saveToken: (token, expiresAt) => { saved.push({ token, expiresAt }) },
    verify, restored,
    changed: view => { views.push(view) },
    log: message => { logs.push(message) },
    ...overrides
  })
  return { flows, ptys, views, saved, removed, restored, verify, logs }
}

afterEach(() => { vi.useRealTimers(); setClaudeTokenSource(null) })

describe('the long-lived Claude token store', () => {
  it('keeps the token in the vault, reports status without it, and stops handing out a rejected one', () => {
    const vault = new MemoryVault(), settings = new MapStore()
    const store = new ClaudeTokenStore(vault, settings, {}, () => Date.parse('2026-10-04T18:00:00Z'))
    expect(store.status()).toMatchObject({ set: false, active: false, storageAvailable: true })
    expect(() => store.save('not-a-token')).toThrow(/not a Claude long-lived token/)
    store.save(` ${TOKEN}\n`, '2027-10-04T18:00:00.000Z')
    expect(store.token()).toBe(TOKEN)
    expect(vault.read('claude.longLivedToken')).toBe(TOKEN)
    // Only the vault holds it: no plain setting and no status field carries it.
    expect([...settings.values.values()].join('')).not.toContain(TOKEN)
    expect(JSON.stringify(store.status())).not.toContain(TOKEN)
    expect(store.status()).toMatchObject({ set: true, active: true, createdAt: '2026-10-04T18:00:00.000Z', expiresAt: '2027-10-04T18:00:00.000Z' })
    expect(store.reject('API Error: 401 authentication_error')).toBe(true)
    expect(store.reject('again')).toBe(false)
    expect(store.token()).toBeNull()
    expect(store.status()).toMatchObject({ set: true, active: false, rejectedReason: 'API Error: 401 authentication_error' })
    store.remove()
    expect(store.status().set).toBe(false)
    expect(vault.read('claude.longLivedToken')).toBeNull()
  })

  it('refuses to save without an OS credential store', () => {
    const store = new ClaudeTokenStore(new MemoryVault(false), new MapStore(), {})
    expect(store.status().storageAvailable).toBe(false)
    expect(() => store.save(TOKEN)).toThrow(/credential store/)
  })

  it('injects the token into a Claude environment only while one is active, and never over the owner\'s own', () => {
    expect(claudeTokenEnvironment({ PATH: 'x' })).toEqual({ PATH: 'x' })
    expect(claudeTokenActive()).toBe(false)
    const store = new ClaudeTokenStore(new MemoryVault(), new MapStore(), {})
    setClaudeTokenSource(() => store.token())
    expect(claudeTokenEnvironment({ PATH: 'x' })).toEqual({ PATH: 'x' })
    store.save(TOKEN)
    expect(claudeTokenActive()).toBe(true)
    expect(claudeTokenEnvironment({ PATH: 'x' })).toEqual({ PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    expect(claudeTokenEnvironment({ PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'owner-exported' }).CLAUDE_CODE_OAUTH_TOKEN).toBe('owner-exported')
    store.reject('refused')
    expect(claudeTokenEnvironment({ PATH: 'x' })).toEqual({ PATH: 'x' })
  })
})

describe('reading the login CLIs', () => {
  it('finds the sign-in URL in an OSC 8 link and in plain text, and the setup-token result', () => {
    const raw = `\x1b[2mBrowser didn't open? Use the url below to sign in\x1b[0m \x1b]8;id=1;${URL_TEXT}\x07${URL_TEXT.slice(0, 40)}\x1b]8;;\x07\r\nPaste code here if prompted >`
    const text = plainTerminalText(raw)
    expect(loginUrl('claude', text)).toBe(new URL(URL_TEXT).toString())
    expect(loginUrl('codex', 'Open this link\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m')).toBe('https://auth.openai.com/codex/device')
    expect(loginUrl('codex', plainTerminalText('Open this link\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m'))).toBe('https://auth.openai.com/codex/device')
    const now = Date.parse('2026-10-04T18:00:00Z')
    expect(setupTokenResult(plainTerminalText(`Your OAuth token (valid for 1 year):\r\n\x1b[33m${TOKEN}\x1b[0m\r\n`), now)).toEqual({ token: TOKEN, expiresAt: '2027-10-04T18:00:00.000Z' })
    expect(setupTokenResult('no token here', now)).toBeNull()
  })
})

describe('a login flow in a PTY Conductor owns', () => {
  it('runs claude auth login without a browser, takes one code, verifies and restores', async () => {
    vi.useFakeTimers()
    const { flows, ptys, views, restored, verify } = harness()
    const view = flows.start({ provider: 'claude', mode: 'login', origin: 'phone', requester: 'phone:p1' })
    expect(view.phase).toBe('starting')
    const launch = ptys[0]!
    expect(launch.args).toEqual(['auth', 'login'])
    // The token would make the CLI log in for this session only; the browser launch is disabled.
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(launch.env.BROWSER).toMatch(/scratch-1[\\/]no-browser\.exe$/)
    expect(launch.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    launch.pty.print(`If the browser didn't open, visit: \x1b]8;id=1;${URL_TEXT}\x07${URL_TEXT}\x1b]8;;\x07\r\n`)
    expect(flows.view()!.phase).toBe('starting')
    launch.pty.print('Paste code here if prompted > ')
    expect(flows.view()).toMatchObject({ phase: 'awaiting-code', url: new URL(URL_TEXT).toString(), codeUsed: false })
    expect(() => flows.submitCode({ id: view.id, code: 'short' })).toThrow(/whole code/)
    expect(() => flows.submitCode({ id: 'other', code: 'abcdefgh#state123' })).toThrow(/no longer running/)
    flows.submitCode({ id: view.id, code: '  abcdefgh12345#state123 ' })
    expect(() => flows.submitCode({ id: view.id, code: 'abcdefgh12345#state123' })).toThrow(/already took its code/)
    await vi.advanceTimersByTimeAsync(400)
    expect(launch.pty.written).toEqual(['abcdefgh12345#state123', '\r'])
    launch.pty.print('Login successful.\r\n')
    launch.pty.end(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(verify).toHaveBeenCalledWith('claude')
    expect(flows.view()).toMatchObject({ phase: 'succeeded', codeUsed: true })
    expect(restored).toHaveBeenCalledWith('claude', 'login')
    // No view the windows or the phone heard ever held the code.
    expect(JSON.stringify(views)).not.toContain('abcdefgh12345')
  })

  it('fails on a refused code and on a CLI that still reports no login', async () => {
    const { flows, ptys, restored } = harness({ verify: async () => ({ loggedIn: false, detail: 'not logged in' }) })
    const first = flows.start({ provider: 'claude', mode: 'login', origin: 'desktop', requester: 'desktop' })
    ptys[0]!.pty.print(`visit: ${URL_TEXT}\r\nPaste code here if prompted > `)
    flows.submitCode({ id: first.id, code: 'abcdefgh12345#state123' })
    ptys[0]!.pty.print('Login failed: Request failed with status code 400\r\n')
    expect(flows.view()).toMatchObject({ phase: 'failed', message: expect.stringContaining('status code 400') })
    expect(ptys[0]!.pty.killed).toBe(true)
    const second = flows.start({ provider: 'claude', mode: 'login', origin: 'desktop', requester: 'desktop' })
    expect(second.id).not.toBe(first.id)
    ptys[1]!.pty.print(`visit: ${URL_TEXT}\r\nPaste code here if prompted > `)
    flows.submitCode({ id: second.id, code: 'abcdefgh12345#state123' })
    ptys[1]!.pty.end(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flows.view()).toMatchObject({ phase: 'failed', message: expect.stringContaining('still reports no login') })
    expect(restored).not.toHaveBeenCalled()
  })

  it('captures the setup-token result into the store and nowhere else, in a scratch config home', async () => {
    const { flows, ptys, views, saved, removed, restored, logs } = harness()
    const view = flows.start({ provider: 'claude', mode: 'setup-token', origin: 'desktop', requester: 'desktop' })
    const launch = ptys[0]!
    expect(launch.args).toEqual(['setup-token'])
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe('scratch-1')
    expect(launch.cwd).toBe('scratch-1')
    launch.pty.print(`Browser didn't open? Use the url below to sign in (c to copy) ${URL_TEXT}\r\nPaste code here if prompted > `)
    flows.submitCode({ id: view.id, code: 'abcdefgh12345#state123' })
    launch.pty.print(`\x1b[32m✓ Long-lived authentication token created successfully!\x1b[0m\r\nYour OAuth token (valid for 1 year):\r\n\x1b[33m${TOKEN}\x1b[0m\r\nStore this token securely.`)
    expect(saved).toEqual([{ token: TOKEN, expiresAt: expect.any(String) }])
    expect(flows.view()).toMatchObject({ phase: 'succeeded' })
    expect(launch.pty.killed).toBe(true)
    expect(removed).toEqual(['scratch-1'])
    expect(restored).toHaveBeenCalledWith('claude', 'setup-token')
    expect(JSON.stringify(views) + JSON.stringify(flows.view()) + logs.join('\n')).not.toContain(TOKEN)
  })

  it('shows the Codex device code and needs no pasted code', async () => {
    const { flows, ptys, restored } = harness()
    const view = flows.start({ provider: 'codex', mode: 'device', origin: 'phone', requester: 'phone:p1' })
    expect(ptys[0]!.args).toEqual(['login', '--device-auth'])
    ptys[0]!.pty.print('1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94mABCD-EF123\x1b[0m\r\n')
    expect(flows.view()).toMatchObject({ phase: 'awaiting-device', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EF123' })
    expect(() => flows.submitCode({ id: view.id, code: 'abcdefgh12345' })).toThrow(/not waiting for a code/)
    ptys[0]!.pty.end(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flows.view()!.phase).toBe('succeeded')
    expect(restored).toHaveBeenCalledWith('codex', 'device')
  })

  it('runs one login at a time, rate-limits starts per requester and kills a PTY after ten minutes', async () => {
    vi.useFakeTimers()
    const { flows, ptys } = harness()
    const first = flows.start({ provider: 'claude', mode: 'login', origin: 'phone', requester: 'phone:p1' })
    // Tapping Log in again is the same flow; a different one waits for it.
    expect(flows.start({ provider: 'claude', mode: 'login', origin: 'phone', requester: 'phone:p1' }).id).toBe(first.id)
    expect(() => flows.start({ provider: 'claude', mode: 'setup-token', origin: 'desktop', requester: 'desktop' })).toThrow(/Another login/)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(flows.view()).toMatchObject({ phase: 'expired' })
    expect(ptys[0]!.pty.killed).toBe(true)
    for (let attempt = 0; attempt < 4; attempt++) { const flow = flows.start({ provider: 'claude', mode: 'login', origin: 'phone', requester: 'phone:p1' }); flows.cancel(flow.id) }
    expect(() => flows.start({ provider: 'claude', mode: 'login', origin: 'phone', requester: 'phone:p1' })).toThrow(/Too many login attempts/)
    // Another requester has its own budget, and the window passes.
    const desktop = flows.start({ provider: 'claude', mode: 'login', origin: 'desktop', requester: 'desktop' })
    flows.cancel(desktop.id)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(flows.start({ provider: 'claude', mode: 'login', origin: 'phone', requester: 'phone:p1' }).phase).toBe('starting')
    expect(() => flows.start({ provider: 'claude', mode: 'device', origin: 'phone', requester: 'phone:p2' })).toThrow(/Unknown login/)
  })
})
