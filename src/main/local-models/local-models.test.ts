import { execFileSync, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { isSecretPath, resolveInWorkspace, resolveWritablePath, SecretPathError, WorkspaceBoundaryError } from './workspace.ts'
import {
  adoptableContainer, clearSecretScanCache, containerRunArgs, detectSecretPaths, execArgs, hostAutocrlf, materializeMaskSources,
  mountDigest, SandboxUnavailableError, sandboxContainerName, secretPathsFor, trackedMaskPlan, type SecretMask
} from './sandbox.ts'
import {
  adoptRunningServer, describeStartupFailure, findFreePort, llamaServerArgs, logFile, portBindable,
  inspectAdmission, processAlive, readRunRecord, startServer, validateExtraArgs
} from './llama.ts'
import { StreamAccumulator } from './client.ts'
import { repairToolProtocol, RESPONSE_RESERVE_TOKENS, trimMessages } from './agent.ts'
import { runTool, toolSpecs } from './tools.ts'
import { DEFAULT_SANDBOX, defaultModelConfig, QWEN_35B, QWEN_9B, runFile, validateConfig } from './config.ts'
import type { LocalStackConfig } from './config.ts'
import * as localPaths from './paths.ts'
import * as resources from './resource-guard.ts'

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-local-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1\n', 'utf8')
  writeFileSync(join(root, '.env'), 'TOKEN=super-secret-value\n', 'utf8')
  return root
}

describe('secret policy', () => {
  it('withholds credential material and keeps ordinary source readable', () => {
    for (const path of ['.env', '.env.local', 'packages/api/.env', '.npmrc', '.pypirc', 'deploy/server.pem', '.ssh/config', 'id_rsa', 'config/secrets.json', '.aws/credentials', 'node_modules/.cache', 'node_modules/.cache/babel-loader'])
      expect(isSecretPath(path), path).toBe(true)
    for (const path of ['src/index.ts', 'docs/local-models.md', '.env.example', 'README.md', 'src/environment.ts'])
      expect(isSecretPath(path), path).toBe(false)
  })

  it('lists workspace secrets for masking', async () => {
    const root = workspace()
    try { expect((await detectSecretPaths(root)).map(entry => entry.relative)).toContain('.env') } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('workspace containment', () => {
  it('accepts the container view of the workspace and refuses everything else', async () => {
    const root = workspace()
    try {
      expect((await resolveInWorkspace(root, 'src/index.ts')).relative).toBe('src/index.ts')
      expect((await resolveInWorkspace(root, '/workspace/src/index.ts')).relative).toBe('src/index.ts')
      for (const path of ['../outside.txt', '..\\outside.txt', 'C:\\Windows\\win.ini', '/etc/passwd', '//server/share/x', '~/.ssh/id_rsa', '/workspace/../../etc/passwd', 'src/../../escape'])
        await expect(resolveInWorkspace(root, path), path).rejects.toBeInstanceOf(WorkspaceBoundaryError)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses a link that leaves the workspace after canonicalization', async () => {
    const root = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'conductor-outside-'))
    writeFileSync(join(outside, 'outside.txt'), 'marker', 'utf8')
    let linked = true
    try { symlinkSync(outside, join(root, 'link'), 'junction') } catch { linked = false }
    try {
      if (linked) await expect(resolveInWorkspace(root, 'link/outside.txt')).rejects.toBeInstanceOf(WorkspaceBoundaryError)
    } finally {
      rmSync(join(root, 'link'), { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('withholds secrets and keeps git metadata read-only', async () => {
    const root = workspace()
    try {
      await expect(resolveInWorkspace(root, '.env')).rejects.toBeInstanceOf(SecretPathError)
      await expect(resolveWritablePath(root, '.git/hooks/pre-commit')).rejects.toBeInstanceOf(SecretPathError)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('sandbox arguments', () => {
  const args = containerRunArgs({ name: 'conductor-local-test', image: DEFAULT_SANDBOX.image, workspace: 'C:/projects/demo', sandbox: DEFAULT_SANDBOX, masks: [{ relative: '.env', directory: false }, { relative: '.aws', directory: true }], emptyFile: 'C:/state/empty' })

  it('locks the container down', () => {
    expect(args.join(' ')).toContain('--network none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--cap-drop')
    expect(args).toContain('ALL')
    expect(args).toContain('no-new-privileges')
    expect(args).toContain('--user')
    expect(args).toContain('10001:10001')
    expect(args).toContain('--pids-limit')
    expect(args).toContain('--memory')
    expect(args).toContain('--cpus')
    expect(args.join(' ')).not.toMatch(/docker\.sock|npipe|--privileged|--pid host|--ipc host/)
  })

  it('masks detected secrets and binds nothing but the workspace', () => {
    const joined = args.join(' ')
    expect(joined).toContain('type=bind,source=C:/projects/demo,target=/workspace')
    expect(joined).toContain('target=/workspace/.env,readonly')
    expect(joined).toContain('/workspace/.aws:rw')
    expect(args.filter(arg => arg.startsWith('type=bind')).every(arg => arg.includes('target=/workspace'))).toBe(true)
  })

  it('passes an inherited-free environment', () => {
    const env = args.filter((_value, index) => args[index - 1] === '--env')
    expect(env.some(value => value.startsWith('HOME='))).toBe(true)
    expect(env.some(value => /TOKEN|KEY|SECRET|AWS|ANTHROPIC|OPENAI/i.test(value))).toBe(false)
  })

  it('re-binds .git read-only unless the owner granted repository writes', () => {
    const root = workspace()
    mkdirSync(join(root, '.git'))
    try {
      const mounts = (gitWritable: boolean): string => containerRunArgs({ name: 'conductor-local-test', image: DEFAULT_SANDBOX.image, workspace: root, sandbox: DEFAULT_SANDBOX, masks: [], emptyFile: join(root, 'empty'), gitWritable }).join(' ')
      expect(mounts(false)).toContain('/.git,target=/workspace/.git,readonly')
      expect(mounts(false)).not.toContain('GIT_AUTHOR_NAME')
      // Granted, the workspace bind alone covers .git, and a commit gets an identity the
      // read-only root filesystem could not otherwise provide. The network stays off either way.
      expect(mounts(true)).not.toContain('target=/workspace/.git')
      expect(mounts(true)).toContain('GIT_AUTHOR_NAME=Conductor local model')
      expect(mounts(true)).toContain('--network none')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('mirrors the host line-ending translation into a granted container', async () => {
    const root = workspace()
    mkdirSync(join(root, '.git'))
    try {
      const withSetting = (gitAutocrlf: string | undefined): string => containerRunArgs({ name: 'conductor-local-test', image: DEFAULT_SANDBOX.image, workspace: root, sandbox: DEFAULT_SANDBOX, masks: [], emptyFile: join(root, 'empty'), gitWritable: true, gitAutocrlf }).join(' ')
      // Without it, a Linux container commits this repository's CRLF working tree as content and
      // one `git add -A` rewrites every untouched file.
      expect(withSetting('input')).toContain('GIT_CONFIG_VALUE_0=input')
      expect(withSetting(undefined)).not.toContain('core.autocrlf')
      // What the container is told comes from the repository itself, whichever way it is set.
      const repository = workspace()
      try {
        execFileSync('git', ['init', '--quiet', repository])
        execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repository })
        expect(await hostAutocrlf(repository)).toBe('false')
        execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: repository })
        expect(await hostAutocrlf(repository)).toBe('input')
      } finally { rmSync(repository, { recursive: true, force: true }) }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps model text as a single argument to bash inside the container', () => {
    const command = 'rm -rf / ; powershell.exe -c whoami'
    const argv = execArgs('conductor-local-test', command, 30)
    expect(argv.at(-1)).toBe(command)
    expect(argv).toContain('bash')
    expect(argv).toContain('timeout')
    expect(argv.filter(arg => arg === command)).toHaveLength(1)
  })

  it('validates structured values', () => {
    expect(() => execArgs('bad name; rm -rf /', 'id', 30)).toThrow(SandboxUnavailableError)
    expect(() => execArgs('conductor-local-test', 'id', 0)).toThrow(SandboxUnavailableError)
    expect(sandboxContainerName('agent_123:xyz')).toMatch(/^conductor-local-agent_123-xyz$/)
  })
})

/** A workspace with a real repository, holding both a tracked withheld directory and a tracked
 *  withheld file — exactly the shape that made a granted `git commit -a` destroy them. */
const trackedSecretRepo = (): string | null => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-local-git-'))
  mkdirSync(join(root, '.conductor', 'prompt-images'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '.conductor', '.gitignore'), 'sessions/\n', 'utf8')
  writeFileSync(join(root, '.conductor', 'prompt-images', '.gitignore'), 'cached/\n', 'utf8')
  writeFileSync(join(root, 'src', 'secret-store.ts'), 'export const store = 1\n', 'utf8')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1\n', 'utf8')
  writeFileSync(join(root, '.conductor', 'session-token'), 'UNTRACKED_SECRET_CANARY', 'utf8')
  writeFileSync(join(root, '.env'), 'TOKEN=super-secret-value\n', 'utf8')
  const git = (...args: string[]): number | null =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).status
  if (git('init', '-q') !== 0) { rmSync(root, { recursive: true, force: true }); return null }
  git('config', 'user.email', 'owner@example.invalid'); git('config', 'user.name', 'Owner')
  git('add', '.conductor/.gitignore', '.conductor/prompt-images/.gitignore', 'src/secret-store.ts', 'src/index.ts')
  if (git('commit', '-qm', 'owner history') !== 0) { rmSync(root, { recursive: true, force: true }); return null }
  return root
}

/** The worktree the container would see: the workspace with every mask applied the way
 *  `containerRunArgs` applies it. Running the owner's real repository against this tree is how a
 *  test can ask git itself what a sandboxed `git commit -a` would record, without Docker. */
const maskedWorktree = (workspace: string, masks: SecretMask[]): string => {
  const view = mkdtempSync(join(tmpdir(), 'conductor-local-view-'))
  cpSync(workspace, view, { recursive: true, filter: source => !relative(workspace, source).split(/[\\/]/).includes('.git') })
  for (const mask of masks) {
    const target = join(view, mask.relative)
    rmSync(target, { recursive: true, force: true })
    if (mask.source) cpSync(mask.source, target, { recursive: true })
    else if (mask.directory) mkdirSync(target, { recursive: true })
    else writeFileSync(target, '', 'utf8')
  }
  return view
}

const statusAgainst = (workspace: string, view: string): string =>
  spawnSync('git', ['--git-dir', join(workspace, '.git'), '--work-tree', view, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.trim()

describe('masking under a repository-writes grant', () => {
  const cleanup: string[] = []
  afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); clearSecretScanCache() })

  it('leaves git nothing to record for a masked path the owner tracks', async () => {
    const root = trackedSecretRepo()
    if (!root) return
    cleanup.push(root)
    const stage = mkdtempSync(join(tmpdir(), 'conductor-local-stage-')); cleanup.push(stage)
    const scanned = await detectSecretPaths(root)
    expect(scanned.map(mask => mask.relative)).toEqual(expect.arrayContaining(['.conductor', '.env', 'src/secret-store.ts']))

    // Without the fix — an empty tmpfs over the tracked directory and an empty file over the
    // tracked file — `git commit -a` inside the sandbox records the owner's files as deleted and
    // truncated, into the owner's real history on the owner's real working tree.
    const unprotected = maskedWorktree(root, scanned); cleanup.push(unprotected)
    const before = statusAgainst(root, unprotected)
    expect(before).toMatch(/D\s+\.conductor\/\.gitignore/)
    expect(before).toMatch(/D\s+\.conductor\/prompt-images\/\.gitignore/)
    expect(before).toMatch(/M\s+src\/secret-store\.ts/)

    const planned = await trackedMaskPlan(root, scanned, stage)
    await materializeMaskSources(root, planned.writes)
    const protectedView = maskedWorktree(root, planned.masks); cleanup.push(protectedView)
    // Nothing tracked differs any more: no deletion, no truncation, nothing for `git commit -a`
    // to record. The empty stand-in for an untracked secret stays untracked, as it was before.
    const tracked = statusAgainst(root, protectedView).split(/\r?\n/).filter(line => line.trim() && !line.startsWith('??'))
    expect(tracked).toEqual([])

    // The mask is still a mask: untracked credential material inside the tracked directory is
    // absent from the replica, and the replica is mounted read-only so nothing in it can change.
    expect(existsSync(join(protectedView, '.conductor', 'session-token'))).toBe(false)
    const mounts = containerRunArgs({ name: 'conductor-local-test', image: DEFAULT_SANDBOX.image, workspace: root, sandbox: DEFAULT_SANDBOX, masks: planned.masks, emptyFile: join(stage, 'empty'), gitWritable: true }).join(' ')
    expect(mounts).toContain('target=/workspace/.conductor,readonly')
    expect(mounts).toContain('target=/workspace/src/secret-store.ts,readonly')
    expect(mounts).not.toContain('/workspace/.conductor:rw')
    // An untracked secret is still replaced by an empty file, not by its contents.
    expect(planned.masks.find(mask => mask.relative === '.env')?.source).toBeUndefined()
  })

  it('refuses the grant rather than guessing when the index cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-local-broken-')); cleanup.push(root)
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.env'), 'TOKEN=x', 'utf8')
    await expect(trackedMaskPlan(root, await detectSecretPaths(root), root)).rejects.toBeInstanceOf(SandboxUnavailableError)
  })
})

describe('secret scan cost and cache', () => {
  const cleanup: string[] = []
  afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); clearSecretScanCache() })

  it('skips dependency trees and build output while still masking the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-local-scan-')); cleanup.push(root)
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'left-pad', '.npmrc'), 'token', 'utf8')
    writeFileSync(join(root, 'dist', '.env'), 'token', 'utf8')
    writeFileSync(join(root, 'src', '.env'), 'token', 'utf8')
    writeFileSync(join(root, '.npmrc'), 'token', 'utf8')
    const masks = (await secretPathsFor(root)).map(mask => mask.relative)
    expect(masks).toEqual(['.npmrc', 'src/.env'])
    // The trees that are not walked are still bound read-only, and a secret named at their own
    // level is still masked; only their interiors go unscanned.
    expect(masks).not.toContain('node_modules/left-pad/.npmrc')
  })

  it('reuses the scan until the tree changes, without walking it again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-local-cache-')); cleanup.push(root)
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    writeFileSync(join(root, 'src', 'deep', 'ordinary.ts'), 'export const x = 1\n', 'utf8')
    expect(await secretPathsFor(root)).toEqual([])
    const cachedStart = performance.now()
    expect(await secretPathsFor(root)).toEqual([])
    const cachedMs = performance.now() - cachedStart
    const coldStart = performance.now()
    await detectSecretPaths(root)
    const coldMs = performance.now() - coldStart
    expect(cachedMs).toBeLessThanOrEqual(coldMs + 5)
    // A credential another process drops in mid-session changes its directory's mtime, so the
    // next command masks it rather than running against a stale scan.
    await new Promise(done => setTimeout(done, 20))
    writeFileSync(join(root, 'src', 'deep', '.env'), 'token', 'utf8')
    expect((await secretPathsFor(root)).map(mask => mask.relative)).toEqual(['src/deep/.env'])
  })
})

describe('adopting a running container', () => {
  const inspected = (label: string, source: string): string =>
    `true\t${label}\t${JSON.stringify([{ Type: 'bind', Source: source, Destination: '/workspace' }])}`
  const digest = mountDigest(JSON.stringify({ masks: [], git: false }))

  it('rebuilds unless the running container was built from these exact mounts', () => {
    expect(adoptableContainer(inspected(digest, 'C:\\projects\\demo'), digest, 'C:/projects/demo')).toBe(true)
    expect(adoptableContainer(inspected(digest, '/host_mnt/c/projects/demo'), digest, 'C:/projects/demo')).toBe(true)
    // A container built while .git was writable, or before a secret appeared, carries a different
    // signature; one built for another workspace binds another host path. Neither is adopted.
    expect(adoptableContainer(inspected(mountDigest('other'), 'C:/projects/demo'), digest, 'C:/projects/demo')).toBe(false)
    expect(adoptableContainer(inspected('<no value>', 'C:/projects/demo'), digest, 'C:/projects/demo')).toBe(false)
    expect(adoptableContainer(inspected(digest, 'C:/projects/other'), digest, 'C:/projects/demo')).toBe(false)
    expect(adoptableContainer(`true\t${digest}\tnot-json`, digest, 'C:/projects/demo')).toBe(false)
  })
})

describe('llama.cpp arguments', () => {
  const model = defaultModelConfig(QWEN_9B)
  const key = 'a'.repeat(64)

  it('binds to loopback with the API key and no web UI', () => {
    const args = llamaServerArgs(model, key, 'model.gguf')
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1')
    expect(args).toContain('--no-webui')
    expect(args[args.indexOf('--api-key') + 1]).toBe(key)
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('32768')
    expect(args.some(arg => /--rpc|--mcp|--agent|--tools/.test(arg))).toBe(false)
  })

  it('refuses configured arguments that would undo the hardening', () => {
    for (const arg of ['--rpc', '--host', '--api-key', '--mcp', '--webui'])
      expect(() => validateExtraArgs([arg]), arg).toThrow()
    expect(validateExtraArgs(['--flash-attn'])).toEqual(['--flash-attn'])
  })
})

describe('llama.cpp server lifecycle', () => {
  const previousRoot = process.env.CONDUCTOR_LOCAL_ROOT
  const cleanup: Array<() => void | Promise<void>> = []
  const key = 'a'.repeat(64)

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
    vi.restoreAllMocks()
    if (previousRoot === undefined) delete process.env.CONDUCTOR_LOCAL_ROOT
    else process.env.CONDUCTOR_LOCAL_ROOT = previousRoot
  })

  // These are synthetic server records, not model data. Mock only the storage layout so
  // lifecycle tests run in sandbox-writable scratch without a real second drive.
  const scratchRoot = (): string | null => {
    const root = mkdtempSync(join(tmpdir(), 'ConductorLlamaTest-'))
    mkdirSync(join(root, 'runtime'), { recursive: true })
    mkdirSync(join(root, 'logs'), { recursive: true })
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    process.env.CONDUCTOR_LOCAL_ROOT = root
    vi.spyOn(localPaths, 'layout').mockReturnValue(localPaths.layoutFor(root))
    return root
  }

  // A stand-in llama.cpp server: answers /v1/models with the served model id once the key
  // matches, exactly what adoptRunningServer checks for before trusting a port it didn't bind.
  const fakeOrphan = (modelId: string): Promise<{ port: number; server: Server }> => {
    const server = createHttpServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end('{}'); return }
      if (request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: modelId }] }))
        return
      }
      response.writeHead(404).end()
    })
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : 0, server })
    }))
  }

  // The same shape of answer from a server that authenticates nothing: 200 for every caller,
  // with or without the key. This is what Ollama and an --api-key-less llama-server look like.
  const openServer = (modelId: string): Promise<{ port: number; server: Server }> => {
    const server = createHttpServer((request, response) => {
      if (request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ models: [{ id: modelId }] }))
        return
      }
      response.writeHead(200).end('{}')
    })
    cleanup.push(() => new Promise<void>(done => server.close(() => done())))
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : 0, server })
    }))
  }

  it('portBindable is false for a port held open by someone else and true once nothing holds it', async () => {
    const holder = createTcpServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(done => holder.close(() => done())))
    const heldPort = (holder.address() as { port: number }).port

    const prober = createTcpServer()
    await new Promise<void>(resolve => prober.listen(0, '127.0.0.1', resolve))
    const freePort = (prober.address() as { port: number }).port
    await new Promise<void>(resolve => prober.close(() => resolve()))

    expect(await portBindable(heldPort)).toBe(false)
    expect(await portBindable(freePort)).toBe(true)
  })

  it('adopts an orphaned server already on the configured port instead of failing to start', async () => {
    if (!scratchRoot()) return
    const orphan = await fakeOrphan(QWEN_9B)
    const model = { ...defaultModelConfig(QWEN_9B), port: orphan.port }

    expect(readRunRecord(model)).toBeNull()
    // The executable would blow up the test if it were ever actually spawned; adoption must
    // return before startServer gets anywhere near it.
    const outcome = await startServer('this-executable-must-never-run', model, key)
    expect(outcome.started).toBe(false)
    expect(outcome.port).toBe(orphan.port)
    expect(outcome.message).toContain('adopted')

    const record = readRunRecord(model)
    expect(record?.pid).toBeNull()
    expect(record?.port).toBe(orphan.port)
  })

  it('does not adopt a healthy server that is not serving our model', async () => {
    if (!scratchRoot()) return
    const orphan = await fakeOrphan('local/someone-elses-model')
    const model = { ...defaultModelConfig(QWEN_9B), port: orphan.port }
    const refused = await adoptRunningServer(model, key, orphan.port)
    expect(refused.adopted).toBeNull()
    expect(refused.reason).toContain('local/someone-elses-model')
  })

  it('refuses a second model, preserves the owner server and ignores the dead 35B record', async () => {
    scratchRoot()
    const orphan = await fakeOrphan(QWEN_9B)
    const small = { ...defaultModelConfig(QWEN_9B), port: orphan.port }
    const large = { ...defaultModelConfig(QWEN_35B), port: await findFreePort(small) }
    writeFileSync(runFile(small), JSON.stringify({ pid: null, port: orphan.port, model: small.id, file: small.file, startedAt: '2026-09-21' }))
    writeFileSync(runFile(large), JSON.stringify({ pid: 2147483647, port: large.port, model: large.id, file: large.file, startedAt: '2026-09-14' }))
    const before = readFileSync(runFile(small), 'utf8')
    await expect(startServer('must-never-spawn', large, key)).rejects.toThrow(`${QWEN_9B} is already running`)
    expect(readFileSync(runFile(small), 'utf8')).toBe(before)
    expect((await startServer('must-never-spawn', small, key)).started).toBe(false)
    expect(orphan.server.listening).toBe(true)
  })

  it('stops an idle server this Conductor started to make room for the requested model', async () => {
    scratchRoot()
    vi.spyOn(resources, 'runningLlamaProcesses').mockReturnValue([])
    // Stands in for the llama-server process the record points at; killing it is the switch.
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    await new Promise<void>((resolve, reject) => { sleeper.once('spawn', () => resolve()); sleeper.once('error', reject) })
    cleanup.push(() => { try { sleeper.kill() } catch { /* stopped by the switch */ } })
    const orphan = await fakeOrphan(QWEN_9B)
    const small = { ...defaultModelConfig(QWEN_9B), port: orphan.port }
    const large = { ...defaultModelConfig(QWEN_35B), port: await findFreePort(small) }
    writeFileSync(runFile(small), JSON.stringify({ pid: sleeper.pid, port: orphan.port, model: small.id, file: small.file, startedAt: '2026-09-21' }))
    const asked: string[] = []
    const release = async (running: resources.BlockingServer): Promise<'idle'> => {
      asked.push(`${running.model}:${running.pid}:${running.ours}`)
      await new Promise<void>(done => orphan.server.close(() => done()))
      return 'idle'
    }
    // With the room made, the start goes on to the model file, which this scratch root does not have.
    await expect(startServer('must-never-spawn', large, key, { release })).rejects.toThrow('Model file missing')
    expect(asked).toEqual([`${QWEN_9B}:${sleeper.pid}:true`])
    expect(processAlive(sleeper.pid!)).toBe(false)
    expect(readRunRecord(small)).toBeNull()
  })

  it('refuses to stop a server that is busy or that it did not start, and says why', async () => {
    scratchRoot()
    vi.spyOn(resources, 'runningLlamaProcesses').mockReturnValue([])
    const orphan = await fakeOrphan(QWEN_9B)
    const small = { ...defaultModelConfig(QWEN_9B), port: orphan.port }
    const large = { ...defaultModelConfig(QWEN_35B), port: await findFreePort(small) }
    writeFileSync(runFile(small), JSON.stringify({ pid: process.pid, port: orphan.port, model: small.id, file: small.file, startedAt: '2026-09-21' }))
    await expect(startServer('must-never-spawn', large, key, { release: async () => '1 conversation is mid-turn on it' })).rejects.toThrow('is busy (1 conversation is mid-turn on it)')
    expect(orphan.server.listening).toBe(true)
    expect(readRunRecord(small)?.pid).toBe(process.pid)
    // Adopted rather than started: there is no process of ours to stop, and nobody is even asked.
    writeFileSync(runFile(small), JSON.stringify({ pid: null, port: orphan.port, model: small.id, file: small.file, startedAt: '2026-09-21' }))
    const release = vi.fn(async () => 'idle' as const)
    await expect(startServer('must-never-spawn', large, key, { release })).rejects.toThrow('was not started by this Conductor')
    expect(release).not.toHaveBeenCalled()
    expect(orphan.server.listening).toBe(true)
  })

  it('does not let a stale record whose pid now belongs to something else keep every model off the machine', async () => {
    scratchRoot()
    vi.spyOn(resources, 'runningLlamaProcesses').mockReturnValue([])
    const stale = { ...defaultModelConfig(QWEN_9B), port: await findFreePort({ ...defaultModelConfig(QWEN_9B), port: 52100 }) }
    writeFileSync(runFile(stale), JSON.stringify({ pid: process.pid, port: stale.port, model: stale.id, file: stale.file, startedAt: '2026-09-14' }))
    await expect(inspectAdmission({ ...defaultModelConfig(QWEN_35B), port: await findFreePort(stale) }, key)).resolves.toBeNull()
  })

  it('ignores dead records, refuses unrecorded processes and fails closed on unreadable inventory', async () => {
    scratchRoot()
    const model = { ...defaultModelConfig(QWEN_35B), port: 59861 }
    writeFileSync(runFile(model), JSON.stringify({ pid: 2147483647, port: model.port, model: model.id, file: model.file, startedAt: '2026-09-14' }))
    const inventory = vi.spyOn(resources, 'runningLlamaProcesses').mockReturnValue([])
    await expect(inspectAdmission(model, key)).resolves.toBeNull()
    inventory.mockReturnValue([{ pid: 123, model: QWEN_9B }])
    await expect(inspectAdmission(model, key)).rejects.toThrow(QWEN_9B)
    inventory.mockImplementation(() => { throw new Error('Cannot read process inventory') })
    await expect(inspectAdmission(model, key)).rejects.toThrow('Cannot read process inventory')
  })

  it('never treats a corrupt run record as permission to start another server', async () => {
    scratchRoot()
    const model = { ...defaultModelConfig(QWEN_35B), port: 59861 }
    writeFileSync(runFile(model), '{partially written')
    await expect(startServer('must-never-spawn', model, key)).rejects.toThrow('Cannot read local server record')
  })

  /**
   * A foreign inference server - Ollama, LM Studio, or a llama-server someone started without
   * --api-key - answers 200 to every request, including ones carrying our key, and can be serving
   * a model under the same id. Answering is therefore no evidence of who is listening; only
   * refusing the anonymous request proves our key is enforced. Adopting on the answer alone would
   * quietly route a local conversation into someone else's process.
   */
  it('refuses to adopt a server that answers our probe but does not enforce the API key', async () => {
    if (!scratchRoot()) return
    const open = await openServer(QWEN_9B)
    const model = { ...defaultModelConfig(QWEN_9B), port: open.port }

    const refused = await adoptRunningServer(model, key, open.port)
    expect(refused.adopted).toBeNull()
    expect(refused.reason).toContain('without our API key')
    // Nothing was recorded, so no client is pointed at the foreign server either.
    expect(readRunRecord(model)).toBeNull()
  })

  it('moves to the next free port when the configured one is held by something that is not ours', async () => {
    if (!scratchRoot()) return
    const blocker = createTcpServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(done => blocker.close(() => done())))
    const busyPort = (blocker.address() as { port: number }).port

    const model = { ...defaultModelConfig(QWEN_9B), port: busyPort }
    const free = await findFreePort(model)
    expect(free).toBeGreaterThan(busyPort)
    expect(free).toBeLessThanOrEqual(busyPort + 40)
    // Not re-checked with portBindable: the scan lands in the ephemeral range where every other test
    // worker is binding sockets at the same moment, and a port free at the scan can be taken before a
    // second look - a race in the test, not in the scan. What the scan promised is asserted above.
  })

  /**
   * The case that actually stopped the models on this machine: Hyper-V had reserved TCP
   * 51424-51623, which covers both configured model ports and every port a neighbouring scan would
   * try. A scan alone cannot escape a range that wide, so the OS has to be asked for a port - it
   * will never hand back one it has excluded.
   */
  it('still finds a port when the whole neighbouring range is unavailable', async () => {
    if (!scratchRoot()) return
    const blockers: ReturnType<typeof createTcpServer>[] = []
    const base = 41000
    for (let port = base; port <= base + 40; port++) {
      const server = createTcpServer()
      await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
      blockers.push(server)
    }
    cleanup.push(async () => { await Promise.all(blockers.map(server => new Promise<void>(done => server.close(() => done())))) })
    const model = { ...defaultModelConfig(QWEN_9B), port: base }
    const free = await findFreePort(model)
    expect(free).toBeGreaterThan(0)
    expect(free < base || free > base + 40).toBe(true)
    expect(await portBindable(free)).toBe(true)
  })

  it('names the port and the log tail when the child exits during startup', () => {
    if (!scratchRoot()) return
    const model = defaultModelConfig(QWEN_9B)
    writeFileSync(logFile(model), [
      '0.00.260.574 I srv          init: The UI is disabled',
      "0.00.261.176 E srv         start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 51435",
      '0.00.261.180 I srv    operator(): operator(): cleaning up before exit...',
      '0.00.261.317 E srv  llama_server: exiting due to HTTP server error'
    ].join('\n') + '\n', 'utf8')

    const message = describeStartupFailure(model, model.port)
    expect(message).toContain(`127.0.0.1:${model.port}`)
    expect(message).toContain("couldn't bind HTTP server socket")
    expect(message).toContain(logFile(model))
  })

  it('reads only the last 64 KiB of a huge log, so an old error near the start is not surfaced', () => {
    if (!scratchRoot()) return
    const model = defaultModelConfig(QWEN_9B)
    const earlyMarker = 'E srv start: EARLY_MARKER_SHOULD_NOT_APPEAR'
    const filler = ('I srv noop: '.padEnd(200, 'x')) + '\n'
    const padding = filler.repeat(Math.ceil((200 * 1024) / filler.length))
    writeFileSync(logFile(model), earlyMarker + '\n' + padding, 'utf8')

    const message = describeStartupFailure(model, model.port)
    expect(message).not.toContain('EARLY_MARKER_SHOULD_NOT_APPEAR')
  })
})

describe('config validation', () => {
  const base = (): LocalStackConfig => ({ version: 1, llamaServer: 'llama-server', models: { [QWEN_9B]: defaultModelConfig(QWEN_9B), [QWEN_35B]: defaultModelConfig(QWEN_35B) }, sandbox: { ...DEFAULT_SANDBOX } })

  it('accepts the shipped defaults', () => {
    expect(validateConfig(base()).models[QWEN_35B]?.port).toBe(51436)
  })

  it('rejects injected values', () => {
    const duplicate = base()
    duplicate.models[QWEN_35B]!.port = duplicate.models[QWEN_9B]!.port
    expect(() => validateConfig(duplicate)).toThrow(/Duplicate port/)
    const bad = base()
    bad.models[QWEN_9B]!.file = '../../evil.gguf'
    expect(() => validateConfig(bad)).toThrow(/GGUF filename/)
    const image = base()
    image.sandbox.image = 'evil image; docker run --privileged'
    expect(() => validateConfig(image)).toThrow(/image reference/)
  })
})

describe('streaming', () => {
  it('assembles tool calls split across chunks', () => {
    const accumulator = new StreamAccumulator()
    accumulator.push({ content: 'Chec' })
    accumulator.push({ content: 'king' })
    accumulator.push({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] })
    accumulator.push({ tool_calls: [{ index: 0, function: { arguments: 'th":"src/index.ts"}' } }] }, 'tool_calls')
    const result = accumulator.result()
    expect(result.content).toBe('Checking')
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"path":"src/index.ts"}' }])
    expect(result.finishReason).toBe('tool_calls')
  })
})

describe('context budget', () => {
  it('keeps the system prompt and the newest turns', () => {
    const messages = [{ role: 'system' as const, content: 'system' }, ...Array.from({ length: 40 }, (_value, index) => ({ role: 'user' as const, content: `message ${index} `.repeat(200) }))]
    const trimmed = trimMessages(messages, 2048)
    expect(trimmed[0]?.content).toBe('system')
    expect(trimmed.length).toBeLessThan(messages.length)
    expect(trimmed.at(-1)?.content).toBe(messages.at(-1)?.content)
  })

  it('leaves room for the answer and the tool schemas rather than filling the window', () => {
    const context = 32768, overhead = 900
    const messages = [{ role: 'system' as const, content: 'system' }, ...Array.from({ length: 400 }, (_value, index) => ({ role: 'user' as const, content: `message ${index} `.repeat(200) }))]
    const trimmed = trimMessages(messages, context, overhead)
    const characters = trimmed.reduce((total, message) => total + message.content.length, 0)
    expect(characters).toBeLessThanOrEqual((context - RESPONSE_RESERVE_TOKENS - overhead) * 3)
  })

  it('elides the middle of a tool result no amount of dropping older turns could fit', () => {
    const [, , result] = trimMessages([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call', content: 'x'.repeat(120_000) }
    ], 8192)
    expect(result!.content.length).toBeLessThan(120_000)
    expect(result!.content).toContain('characters elided')
  })

  // A long tool-calling turn puts the owner's question at the oldest end of the history, which
  // is exactly where trimming starts. Dropping it made llama.cpp answer 500 for the rest of the
  // conversation: Qwen's chat template raises "No user query found in messages" and every later
  // prompt failed the same way.
  const toolHeavyTurn = (question: string): Parameters<typeof trimMessages>[0] => [
    { role: 'system', content: 'system' },
    { role: 'user', content: question },
    ...Array.from({ length: 10 }, (_value, index) => [
      { role: 'assistant' as const, content: 'x'.repeat(2000), tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: `call-${index}`, content: 'y'.repeat(2000) }
    ]).flat()
  ]

  it('never trims away the user turn the chat template requires', () => {
    const question = 'Fix the composer banner'
    const trimmed = trimMessages(toolHeavyTurn(question), 8192)
    expect(trimmed.length).toBeLessThan(toolHeavyTurn(question).length)
    expect(trimmed.filter(message => message.role === 'user')).toHaveLength(1)
    expect(trimmed.find(message => message.role === 'user')?.content).toBe(question)
  })

  it('elides the middle of a pinned user turn too big to keep whole', () => {
    const question = `START${'q'.repeat(40_000)}END`
    const user = trimMessages(toolHeavyTurn(question), 8192).find(message => message.role === 'user')!
    expect(user.content.length).toBeLessThan(question.length)
    expect(user.content).toContain('characters elided')
    expect(user.content.startsWith('START')).toBe(true)
    expect(user.content.endsWith('END')).toBe(true)
  })
})

describe('tool protocol repair', () => {
  const assistant = (id: string) => ({ role: 'assistant' as const, content: '', tool_calls: [{ id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] })

  it('fills the result of a call whose turn never finished', () => {
    const repaired = repairToolProtocol([{ role: 'system', content: 'system' }, { role: 'user', content: 'go' }, assistant('open')])
    expect(repaired.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'open' })
    expect(repaired.at(-1)!.content).toContain('never ran')
  })

  it('drops a result that answers no call and keeps one result per call in order', () => {
    const repaired = repairToolProtocol([
      { role: 'tool', tool_call_id: 'orphan', content: 'from a dropped assistant' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'b', content: 'second' },
      { role: 'tool', tool_call_id: 'unknown', content: 'answers nothing' }
    ])
    expect(repaired.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(repaired.slice(2).map(message => message.tool_call_id)).toEqual(['a', 'b'])
    expect(repaired.at(-1)!.content).toBe('second')
  })

  it('leaves a complete conversation untouched', () => {
    const messages = [{ role: 'system' as const, content: 'system' }, { role: 'user' as const, content: 'go' }, assistant('a'), { role: 'tool' as const, tool_call_id: 'a', content: 'done' }, { role: 'assistant' as const, content: 'answer' }]
    expect(repairToolProtocol(messages)).toEqual(messages)
  })
})

describe('tool policy', () => {
  const context = (root: string, readOnly = false) => ({ workspace: root, readOnly, sandbox: null, timeoutSec: 30 })

  it('offers only the sandbox-bound tools', () => {
    expect(toolSpecs(false).map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_read', 'write_file', 'edit_file', 'run_command'])
    expect(toolSpecs(true).map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_read'])
  })

  it('withholds web search until the owner grants research, and refuses it even if the model asks', async () => {
    const research = { git: false, research: true }
    expect(toolSpecs(false, false, research).map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_search', 'web_read', 'write_file', 'edit_file', 'run_command'])
    expect(toolSpecs(true, false, research).map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_search', 'web_read'])
    const root = workspace()
    try {
      // The schema is only an offer; the grant is enforced where the call is dispatched.
      expect((await runTool('web_search', JSON.stringify({ query: 'anything' }), context(root))).output).toMatch(/^denied: Tool denied by policy.*deep research/)
      const described = (grants: { git: boolean; research: boolean }): string => toolSpecs(false, false, grants).find(spec => spec.function.name === 'run_command')!.function.description
      expect(described({ git: false, research: false })).toContain('.git directory is read-only')
      expect(described({ git: true, research: false })).toContain('commit and branch locally')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses tools that are not in the allowlist', async () => {
    const root = workspace()
    try {
      for (const name of ['bash', 'powershell', 'Bash', 'browser_navigate', 'mcp__anything'])
        expect((await runTool(name, '{}', context(root))).output, name).toMatch(/^denied: Tool denied by policy/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('never runs a command on the host when the sandbox is missing', async () => {
    const root = workspace()
    try {
      const outcome = await runTool('run_command', JSON.stringify({ command: 'echo SHOULD_NOT_RUN_ON_HOST' }), context(root))
      expect(outcome.failed).toBe(true)
      expect(outcome.output).toMatch(/^denied: Sandbox unavailable/)
      expect(outcome.output).not.toContain('SHOULD_NOT_RUN_ON_HOST')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reads inside the workspace, refuses outside it, and hides secrets', async () => {
    const root = workspace()
    try {
      expect((await runTool('read_file', JSON.stringify({ path: 'src/index.ts' }), context(root))).output).toContain('export const value')
      expect((await runTool('read_file', JSON.stringify({ path: '../../Windows/win.ini' }), context(root))).output).toMatch(/^denied: path outside workspace/)
      const secret = await runTool('read_file', JSON.stringify({ path: '.env' }), context(root))
      expect(secret.output).toMatch(/^denied:/)
      expect(secret.output).not.toContain('super-secret-value')
      expect((await runTool('list_files', '{}', context(root))).output).not.toContain('.env')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('writes only where policy allows', async () => {
    const root = workspace()
    try {
      expect((await runTool('write_file', JSON.stringify({ path: 'src/new.ts', content: 'ok' }), context(root))).failed).toBe(false)
      expect((await runTool('write_file', JSON.stringify({ path: 'src/new.ts', content: 'ok' }), context(root, true))).output).toMatch(/^denied: Tool denied by policy/)
      expect((await runTool('write_file', JSON.stringify({ path: '../escape.ts', content: 'ok' }), context(root))).output).toMatch(/^denied: path outside workspace/)
      expect((await runTool('write_file', JSON.stringify({ path: '.git/hooks/pre-commit', content: 'ok' }), context(root))).output).toMatch(/^denied:/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
