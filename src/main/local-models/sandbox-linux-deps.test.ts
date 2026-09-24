import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { SandboxConfig } from './config.ts'
import {
  containerRunArgs, DockerSandbox, hostAcceptanceCopy, linuxDepsKey, linuxDepsStatus, linuxDepsVolume,
  prepareLinuxDependencies, resetLinuxDepsCacheForTests, runHostAcceptance, SandboxUnavailableError,
  type DockerRun, type RunOutcome, type SandboxResult
} from './sandbox.ts'

const CONFIG: SandboxConfig = { image: 'conductor-local-sandbox:1', memory: '4g', cpus: '4', pids: 256, timeoutSec: 120, maxOutputBytes: 1024, tmpfsSizeMb: 512 }
const VOLUME = 'conductor-linux-deps-0123456789abcdef'

let roots: string[] = []
const scratch = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
beforeEach(() => resetLinuxDepsCacheForTests())
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = [] })

const mountsOf = (args: string[]): string[] => args.filter((_argument, index) => args[index - 1] === '--mount')
const tmpfsOf = (args: string[]): string[] => args.filter((_argument, index) => args[index - 1] === '--tmpfs')

function workspaceWithDeps(lock = '{"lockfileVersion":3}'): string {
  const workspace = scratch('linux-deps-ws-')
  mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1')
  writeFileSync(join(workspace, 'package.json'), '{"name":"fixture"}')
  writeFileSync(join(workspace, 'package-lock.json'), lock)
  return workspace
}

const ok = (stdout = ''): RunOutcome => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false })
const failed = (stderr = 'no such volume'): RunOutcome => ({ code: 1, stdout: '', stderr, timedOut: false, truncated: false })

/** A docker CLI that records every argv and answers from a table. */
function fakeDocker(answer: (args: string[]) => RunOutcome = () => ok()): { docker: DockerRun; calls: string[][] } {
  const calls: string[][] = []
  const docker: DockerRun = async (args, _timeoutMs, _maxBytes, controls) => {
    calls.push(args)
    const outcome = answer(args)
    if (outcome.stdout) controls?.onData?.(outcome.stdout, 'out')
    if (outcome.stderr) controls?.onData?.(outcome.stderr, 'err')
    return outcome
  }
  return { docker, calls }
}

describe('containerRunArgs with a Linux dependency volume', () => {
  const run = (workspace: string, linuxDeps?: string): string[] => containerRunArgs({ name: 'conductor-local-test', image: CONFIG.image, workspace, sandbox: CONFIG, masks: [], emptyFile: join(workspace, 'package-lock.json'), linuxDeps })

  it('mounts the volume read-only in place of the host node_modules and keeps the lockfile bound', () => {
    const args = run(workspaceWithDeps(), VOLUME)
    const mounts = mountsOf(args)
    expect(mounts).toContain(`type=volume,source=${VOLUME},target=/workspace/node_modules,readonly,volume-nocopy`)
    expect(mounts.some(mount => mount.startsWith('type=bind') && mount.includes('target=/workspace/node_modules,'))).toBe(false)
    expect(mounts.some(mount => mount.startsWith('type=bind') && mount.includes('target=/workspace/package-lock.json') && mount.endsWith('readonly'))).toBe(true)
    // The volume carries .cache and .vite, so their scratch mounts are always safe to add.
    const tmpfs = tmpfsOf(args)
    expect(tmpfs.some(mount => mount.startsWith('/workspace/node_modules/.cache'))).toBe(true)
    expect(tmpfs.some(mount => mount.startsWith('/workspace/node_modules/.vite'))).toBe(true)
  })

  it('binds the host tree as before without one', () => {
    const args = run(workspaceWithDeps())
    const mounts = mountsOf(args)
    expect(mounts.some(mount => mount.startsWith('type=volume'))).toBe(false)
    expect(mounts.some(mount => mount.startsWith('type=bind') && mount.includes('target=/workspace/node_modules,readonly'))).toBe(true)
    expect(tmpfsOf(args).some(mount => mount.startsWith('/workspace/node_modules/.vite'))).toBe(false)
  })

  it('does not mount the volume into a workspace with no node_modules of its own', () => {
    const workspace = scratch('linux-deps-bare-')
    writeFileSync(join(workspace, 'package-lock.json'), '{}')
    const args = run(workspace, VOLUME)
    expect(mountsOf(args).some(mount => mount.includes('node_modules'))).toBe(false)
  })

  it('refuses a volume name that is not a Conductor dependency volume', () => {
    const workspace = workspaceWithDeps()
    for (const bad of ['node_modules', 'conductor-linux-deps-XYZ', `${VOLUME},readonly=false`, `${VOLUME}0`, '/var/run/docker.sock', '']) {
      expect(() => run(workspace, bad), bad).toThrow(SandboxUnavailableError)
    }
  })
})

describe('linux dependency key and status', () => {
  it('keys the volume on the lockfile bytes alone', async () => {
    const first = workspaceWithDeps('{"a":1}')
    const second = workspaceWithDeps('{"a":1}')
    const third = workspaceWithDeps('{"a":2}')
    const key = await linuxDepsKey(first)
    expect(key).toBe(createHash('sha256').update('{"a":1}').digest('hex').slice(0, 16))
    expect(await linuxDepsKey(second)).toBe(key)
    expect(await linuxDepsKey(third)).not.toBe(key)
    expect(linuxDepsVolume(key!)).toBe(`conductor-linux-deps-${key}`)
    expect(await linuxDepsKey(scratch('linux-deps-nolock-'))).toBeNull()
  })

  it('is ready only when the host marker and the Docker volume both exist', async () => {
    const workspace = workspaceWithDeps('{"status":1}')
    const markerRoot = scratch('linux-deps-markers-')
    const key = (await linuxDepsKey(workspace))!
    const volume = linuxDepsVolume(key)
    const present = fakeDocker(() => ok(volume))
    const absent = fakeDocker(() => failed())

    expect(await linuxDepsStatus(scratch('linux-deps-nolock-'), CONFIG, { docker: present.docker, markerRoot: () => markerRoot })).toEqual({ state: 'no-lockfile' })
    // Volume exists but no marker: an interrupted prepare, not a usable tree.
    expect((await linuxDepsStatus(workspace, CONFIG, { docker: present.docker, markerRoot: () => markerRoot })).state).toBe('missing')

    writeFileSync(join(markerRoot, `${key}.json`), JSON.stringify({ key, volume, preparedAt: '2026-09-24T10:00:00.000Z', scripts: 'ran', image: CONFIG.image }))
    expect((await linuxDepsStatus(workspace, CONFIG, { docker: absent.docker, markerRoot: () => markerRoot })).state).toBe('missing')
    expect(absent.calls[0]).toEqual(['volume', 'inspect', '--format', '{{.Name}}', volume])

    expect(await linuxDepsStatus(workspace, CONFIG, { docker: present.docker, markerRoot: () => markerRoot })).toEqual({ state: 'ready', key, volume, preparedAt: '2026-09-24T10:00:00.000Z' })
    // A tree built with another image is not this sandbox's tree.
    resetLinuxDepsCacheForTests()
    expect((await linuxDepsStatus(workspace, { ...CONFIG, image: 'conductor-local-sandbox:2' }, { docker: present.docker, markerRoot: () => markerRoot })).state).toBe('missing')
  })
})

describe('prepareLinuxDependencies', () => {
  const ensureDocker = async (): Promise<{ available: boolean }> => ({ available: true })

  it('installs into the volume from the package files alone, with the network, and records a marker', async () => {
    const workspace = workspaceWithDeps('{"prepare":1}')
    writeFileSync(join(workspace, '.env'), 'TOKEN=secret')
    const markerRoot = scratch('linux-deps-markers-')
    const progress: string[] = []
    const { docker, calls } = fakeDocker(args => args[0] === 'run' ? ok('added 900 packages\nCONDUCTOR_LINUX_DEPS_SCRIPTS=skipped\n') : ok())
    const result = await prepareLinuxDependencies(workspace, CONFIG, { onProgress: line => progress.push(line) }, { docker, markerRoot: () => markerRoot, ensureDocker })
    const key = (await linuxDepsKey(workspace))!
    expect(result).toEqual({ volume: linuxDepsVolume(key), key, scripts: 'skipped' })

    const create = calls.find(args => args[0] === 'volume' && args[1] === 'create')!
    expect(create).toEqual(['volume', 'create', '--label', `conductor.linux-deps=${key}`, linuxDepsVolume(key)])
    const run = calls.find(args => args[0] === 'run')!
    expect(run).toContain('--rm')
    expect(run.indexOf('--network') === -1 || run[run.indexOf('--network') + 1] !== 'none').toBe(true)
    expect(run).not.toContain('--read-only')
    expect(run[run.indexOf('--security-opt') + 1]).toBe('no-new-privileges')
    expect(run[run.indexOf('--memory') + 1]).toBe('4g')
    expect(run[run.indexOf('--cpus') + 1]).toBe('4')
    expect(run[run.indexOf('--user') + 1]).toBe('0:0')
    const mounts = mountsOf(run)
    expect(mounts).toHaveLength(3)
    expect(mounts.filter(mount => mount.startsWith('type=bind')).map(mount => /target=([^,]+)/.exec(mount)![1]).sort()).toEqual(['/src/package-lock.json', '/src/package.json'])
    expect(mounts.filter(mount => mount.startsWith('type=bind')).every(mount => mount.endsWith(',readonly'))).toBe(true)
    expect(mounts).toContain(`type=volume,source=${linuxDepsVolume(key)},target=/out`)
    expect(run.some(argument => argument.includes('target=/workspace'))).toBe(false)
    const script = run.at(-1)!
    expect(script).toContain('npm ci --no-audit --no-fund')
    expect(script).toContain('npm ci --ignore-scripts --no-audit --no-fund')
    expect(script).toContain('ELECTRON_SKIP_BINARY_DOWNLOAD=1')
    expect(script).toContain('cp -a node_modules/. /out/')
    expect(script).toContain('chown -R 10001:10001 /out/.cache /out/.vite')
    expect(progress).toContain('added 900 packages')

    const marker = JSON.parse(readFileSync(join(markerRoot, `${key}.json`), 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({ key, volume: linuxDepsVolume(key), scripts: 'skipped', image: CONFIG.image })
    expect(typeof marker.preparedAt).toBe('string')
  })

  it('throws with the tail of the output and writes no marker when the install fails', async () => {
    const workspace = workspaceWithDeps('{"prepare":2}')
    const markerRoot = scratch('linux-deps-markers-')
    const { docker, calls } = fakeDocker(args => args[0] === 'run' ? { ...failed('npm ERR! network ETIMEDOUT registry.npmjs.org'), code: 1 } : ok())
    const error = await prepareLinuxDependencies(workspace, CONFIG, {}, { docker, markerRoot: () => markerRoot, ensureDocker }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SandboxUnavailableError)
    expect((error as Error).message).toContain('ETIMEDOUT')
    expect(existsSync(join(markerRoot, `${(await linuxDepsKey(workspace))!}.json`))).toBe(false)
    expect(calls.some(args => args[0] === 'volume' && args[1] === 'rm')).toBe(false)
    // The owner's own tree is never touched by a prepare.
    expect(existsSync(join(workspace, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })
})

describe('DockerSandbox.runAcceptance', () => {
  const result: SandboxResult = { exitCode: 0, stdout: 'pass', stderr: '', truncated: false, timedOut: false, durationMs: 1 }

  function sandboxFor(workspace: string, markerRoot: string) {
    const host = vi.fn(async () => ({ ...result, stdout: 'host' }))
    const { docker } = fakeDocker(args => args[0] === 'volume' ? ok() : failed())
    const sandbox = new DockerSandbox('acceptance-test', workspace, CONFIG, { hostAcceptance: host, linuxDeps: { docker, markerRoot: () => markerRoot } })
    const exec = vi.spyOn(sandbox, 'exec').mockResolvedValue(result)
    return { sandbox, host, exec }
  }

  it('runs in the sandbox when the workspace has no lockfile', async () => {
    const workspace = scratch('acceptance-nolock-')
    const { sandbox, host, exec } = sandboxFor(workspace, scratch('linux-deps-markers-'))
    expect(await sandbox.runAcceptance('node test.js', 30)).toMatchObject({ where: 'sandbox', stdout: 'pass' })
    expect(exec).toHaveBeenCalledWith('node test.js', 30, undefined)
    expect(host).not.toHaveBeenCalled()
  })

  it('runs on a host copy while the Linux tree is missing, and in the sandbox once it is ready', async () => {
    const workspace = workspaceWithDeps('{"acceptance":1}')
    const markerRoot = scratch('linux-deps-markers-')
    const { sandbox, host, exec } = sandboxFor(workspace, markerRoot)
    expect(await sandbox.linuxDepsReady()).toBe(false)
    expect(await sandbox.runAcceptance('npm test', 30)).toMatchObject({ where: 'host-copy', stdout: 'host' })
    expect(host).toHaveBeenCalledWith(workspace, 'npm test', 30, { signal: undefined })
    expect(exec).not.toHaveBeenCalled()

    const key = (await linuxDepsKey(workspace))!
    writeFileSync(join(markerRoot, `${key}.json`), JSON.stringify({ key, volume: linuxDepsVolume(key), preparedAt: 'now', scripts: 'ran', image: CONFIG.image }))
    expect(await sandbox.linuxDepsReady()).toBe(true)
    expect(await sandbox.runAcceptance('npm test', 30)).toMatchObject({ where: 'sandbox' })
    expect(host).toHaveBeenCalledTimes(1)
  })
})

describe('host acceptance copy', () => {
  function hostWorkspace(): { workspace: string; files: string[] } {
    const workspace = workspaceWithDeps()
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, '.git'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1')
    writeFileSync(join(workspace, '.env'), 'TOKEN=secret')
    writeFileSync(join(workspace, '.git', 'config'), '[core]')
    // Listed as git would list them: tracked, untracked, and a tracked file deleted since.
    return { workspace, files: ['src/a.ts', 'package.json', 'package-lock.json', '.env', '.git/config', 'node_modules/pkg/index.js', 'src/deleted.ts'] }
  }

  function recordingFs(order: string[]): typeof fsp {
    return {
      ...fsp,
      unlink: (async (path: Parameters<typeof fsp.unlink>[0]) => { order.push(`unlink ${String(path)}`); return fsp.unlink(path) }) as typeof fsp.unlink,
      rm: (async (path: Parameters<typeof fsp.rm>[0], options?: Parameters<typeof fsp.rm>[1]) => { order.push(`rm ${String(path)}`); return fsp.rm(path, options) }) as typeof fsp.rm
    }
  }

  it('copies the listed files except dependencies, git metadata and secrets, and links node_modules', async () => {
    const { workspace, files } = hostWorkspace()
    const order: string[] = []
    const copy = await hostAcceptanceCopy(workspace, { listFiles: async () => files, tempRoot: () => scratch('acceptance-temp-'), fs: recordingFs(order) })
    expect(existsSync(join(copy.root, 'src', 'a.ts'))).toBe(true)
    expect(existsSync(join(copy.root, 'package-lock.json'))).toBe(true)
    expect(existsSync(join(copy.root, '.env'))).toBe(false)
    expect(existsSync(join(copy.root, '.git'))).toBe(false)
    expect(copy.files).toBe(3)
    expect(copy.junction).toBe(join(copy.root, 'node_modules'))
    expect(realpathSync(join(copy.root, 'node_modules', 'pkg', 'index.js'))).toBe(realpathSync(join(workspace, 'node_modules', 'pkg', 'index.js')))

    await copy.cleanup()
    // The link goes first and on its own; only then is the copy removed recursively.
    expect(order).toEqual([`unlink ${copy.junction}`, `rm ${copy.root}`])
    expect(existsSync(copy.root)).toBe(false)
    expect(existsSync(join(workspace, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })

  it('refuses a copy larger than its budget and leaves nothing behind', async () => {
    const { workspace, files } = hostWorkspace()
    const tempRoot = scratch('acceptance-temp-')
    await expect(hostAcceptanceCopy(workspace, { listFiles: async () => files, tempRoot: () => tempRoot, maxCopyBytes: 10 })).rejects.toBeInstanceOf(SandboxUnavailableError)
    expect(await fsp.readdir(tempRoot)).toEqual([])
  })

  it('kills the whole process tree on timeout and still removes the junction before the copy', async () => {
    const { workspace, files } = hostWorkspace()
    const order: string[] = []
    const spawned: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
    let target: (EventEmitter & { stdout: PassThrough; stderr: PassThrough }) | undefined
    const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options })
      const child = Object.assign(new EventEmitter(), { pid: command === 'taskkill' ? 5 : 4242, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
      if (command === 'taskkill') setImmediate(() => { order.push('taskkill'); target!.emit('close', 1); child.emit('close', 0) })
      else { target = child; setImmediate(() => child.stdout.write('running\n')) }
      return child as unknown as ChildProcess
    }) as unknown as typeof import('node:child_process').spawn
    const run = await runHostAcceptance(workspace, 'npm test', 1, {}, { platform: 'win32', spawn, listFiles: async () => files, tempRoot: () => scratch('acceptance-temp-'), fs: recordingFs(order) })
    expect(run.timedOut).toBe(true)
    expect(run.exitCode).not.toBe(0)
    expect(run.stdout).toContain('running')
    const command = spawned.find(entry => entry.command === 'npm test')!
    expect(command.options).toMatchObject({ shell: true })
    expect(spawned.find(entry => entry.command === 'taskkill')!.args).toEqual(['/pid', '4242', '/T', '/F'])
    const copyRoot = command.options.cwd as string
    expect(order).toEqual(['taskkill', `unlink ${join(copyRoot, 'node_modules')}`, `rm ${copyRoot}`])
    expect(existsSync(copyRoot)).toBe(false)
    expect(existsSync(join(workspace, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })

  it('refuses a package install before copying anything', async () => {
    const { workspace, files } = hostWorkspace()
    const listFiles = vi.fn(async () => files)
    await expect(runHostAcceptance(workspace, 'npm ci && npm test', 30, {}, { listFiles })).rejects.toThrow(/Refusing/)
    expect(listFiles).not.toHaveBeenCalled()
  })
})
