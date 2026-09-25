import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fallbackPathEntries, importLoginShellPath, mergePath, parseShellPath, type ShellRunner } from './login-shell-path'

const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const shellSays = (output: string): { run: ShellRunner; calls: Array<{ shell: string; args: string[] }> } => {
  const calls: Array<{ shell: string; args: string[] }> = []
  return { calls, run: async (shell, args) => { calls.push({ shell, args }); return output } }
}

describe('login shell PATH', () => {
  it('puts the shell entries first and keeps the app entries it lacks, once each', () => {
    expect(mergePath(FINDER_PATH, '/opt/homebrew/bin:/usr/bin:/Users/o/.local/bin')).toBe('/opt/homebrew/bin:/usr/bin:/Users/o/.local/bin:/bin:/usr/sbin:/sbin')
    expect(mergePath('', '/a::/b')).toBe('/a:/b')
  })

  it('reads the PATH between its markers, past whatever the profile prints', () => {
    expect(parseShellPath('Welcome back!\n__CONDUCTOR_LOGIN_PATH__/opt/homebrew/bin:/usr/bin__CONDUCTOR_LOGIN_PATH__')).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parseShellPath('no markers')).toBeNull()
    expect(parseShellPath('__CONDUCTOR_LOGIN_PATH____CONDUCTOR_LOGIN_PATH__')).toBeNull()
  })

  it('imports the login shell PATH on macOS from the owner shell', async () => {
    const env: NodeJS.ProcessEnv = { PATH: FINDER_PATH, SHELL: '/bin/bash' }
    const shell = shellSays('__CONDUCTOR_LOGIN_PATH__/opt/homebrew/bin:/Users/o/.local/bin:/usr/bin__CONDUCTOR_LOGIN_PATH__')
    await expect(importLoginShellPath({ platform: 'darwin', env, run: shell.run })).resolves.toMatchObject({ source: 'shell' })
    expect(env.PATH).toBe('/opt/homebrew/bin:/Users/o/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    expect(shell.calls).toHaveLength(1)
    expect(shell.calls[0]!.shell).toBe('/bin/bash')
    expect(shell.calls[0]!.args[0]).toBe('-ilc')
    // Without SHELL the macOS default, zsh, is asked.
    const plain = shellSays('__CONDUCTOR_LOGIN_PATH__/opt/homebrew/bin__CONDUCTOR_LOGIN_PATH__')
    await importLoginShellPath({ platform: 'darwin', env: { PATH: FINDER_PATH }, run: plain.run })
    expect(plain.calls[0]!.shell).toBe('/bin/zsh')
  })

  it('falls back to the usual install folders when the shell fails, and never throws', async () => {
    const env: NodeJS.ProcessEnv = { PATH: FINDER_PATH }
    const failing: ShellRunner = async () => { throw new Error('timed out') }
    const present = new Set(['/opt/homebrew/bin', '/Users/o/.local/bin'])
    await expect(importLoginShellPath({ platform: 'darwin', env, run: failing, home: '/Users/o', exists: path => present.has(path) })).resolves.toMatchObject({ source: 'fallback' })
    expect(env.PATH).toBe(`/opt/homebrew/bin:/Users/o/.local/bin:${FINDER_PATH}`)
    expect(fallbackPathEntries('/Users/o', () => false)).toEqual([])
  })

  // On a Mac with Homebrew (its installer adds shellenv to ~/.zprofile), the real login shell is asked.
  it.runIf(process.platform === 'darwin' && existsSync('/opt/homebrew/bin/brew'))('finds Homebrew through the real login shell from a Finder PATH', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: FINDER_PATH }
    await expect(importLoginShellPath({ env })).resolves.toMatchObject({ source: 'shell' })
    expect(env.PATH!.split(':')).toContain('/opt/homebrew/bin')
    expect(env.PATH!.endsWith(FINDER_PATH) || env.PATH!.split(':').includes('/usr/bin')).toBe(true)
  })

  it('leaves Windows and Linux PATH alone without starting a shell', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows;C:\\tools' }
      const shell = shellSays('__CONDUCTOR_LOGIN_PATH__/x__CONDUCTOR_LOGIN_PATH__')
      await expect(importLoginShellPath({ platform, env, run: shell.run })).resolves.toEqual({ source: 'unchanged', path: 'C:\\Windows;C:\\tools' })
      expect(env.PATH).toBe('C:\\Windows;C:\\tools')
      expect(shell.calls).toEqual([])
    }
  })
})
