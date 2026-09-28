import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cachedLookupOnPath, clearPathLookupCache, lookupOnPath } from './path-lookup'

const files = (...paths: string[]) => {
  const present = new Set(paths.map(path => path.toLowerCase()))
  return (path: string): boolean => present.has(path.toLowerCase())
}

describe('provider CLI lookup without where.exe (typing-lag-long-conversation)', () => {
  it('follows where.exe order: current directory, then PATH; bare name, then each PATHEXT', () => {
    const cwd = join('C:', 'app'), npm = join('C:', 'npm'), bin = join('C:', 'bin')
    const env = { Path: `${npm};"${bin}"`, PATHEXT: '.COM;.EXE;.CMD' }
    expect(lookupOnPath('claude', { env, platform: 'win32', cwd, isFile: files(join(npm, 'claude'), join(npm, 'claude.cmd'), join(bin, 'claude.exe')) })).toBe(join(npm, 'claude'))
    expect(lookupOnPath('claude', { env, platform: 'win32', cwd, isFile: files(join(npm, 'claude.cmd'), join(bin, 'claude.exe')) })).toBe(join(npm, 'claude.cmd'))
    expect(lookupOnPath('claude', { env, platform: 'win32', cwd, isFile: files(join(bin, 'claude.exe'), join(cwd, 'claude.exe')) })).toBe(join(cwd, 'claude.exe'))
    expect(lookupOnPath('claude', { env, platform: 'win32', cwd, isFile: files(join(bin, 'claude.ps1')) })).toBeNull()
  })

  it('takes the first executable file on a POSIX PATH, as which', () => {
    const env = { PATH: '/usr/local/bin:/opt/codex/bin' }
    const isFile = files('/usr/local/bin/codex', '/opt/codex/bin/codex')
    expect(lookupOnPath('codex', { env, platform: 'linux', isFile, isExecutable: path => path.startsWith('/opt') })).toBe('/opt/codex/bin/codex')
    expect(lookupOnPath('codex', { env, platform: 'darwin', isFile, isExecutable: () => false })).toBeNull()
  })

  it('remembers an answer for 30 s per command and PATH', () => {
    clearPathLookupCache()
    const env = { PATH: '/one', Path: '/one' }
    let calls = 0
    const isFile = (): boolean => { calls++; return false }
    const options = { env, platform: 'linux' as const, isFile }
    expect(cachedLookupOnPath('grok', 1_000, options)).toBeNull()
    expect(cachedLookupOnPath('grok', 20_000, options)).toBeNull()
    expect(calls).toBe(1)
    cachedLookupOnPath('grok', 40_000, options)
    expect(calls).toBe(2)
    cachedLookupOnPath('grok', 40_001, { ...options, env: { PATH: '/two', Path: '/two' } })
    expect(calls).toBe(3)
  })

  // listProviders runs on main for every catalog read; a process start there blocked main for most
  // of a minute while coworkers streamed, and every keystroke waited (perf-input --background).
  it('keeps process starts out of the provider catalog path', () => {
    for (const file of ['./agent-manager.ts', './cli-versions.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/execFileSync\(|spawnSync\(|['"]where(\.exe)?['"]/)
    }
  })

  it.runIf(process.platform === 'win32')('agrees with where.exe on this machine', () => {
    for (const command of ['node', 'git', 'cmd']) {
      let expected: string | null = null
      try { expected = execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null } catch { expected = null }
      expect(lookupOnPath(command)?.toLowerCase() ?? null).toBe(expected?.toLowerCase() ?? null)
    }
  })
})
