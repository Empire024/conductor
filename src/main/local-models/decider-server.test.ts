import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECIDER_MODEL, DECIDER_PORT, DECIDER_THREADS, DeciderServer, deciderEnvironment, deciderInstalled, deciderPaths, LAYA_REVISION, LAYA_WEIGHTS_SHA256, type DeciderServerDeps } from './decider-server'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const KEY = 'a'.repeat(64)

/** A local root with the venv interpreter and the pinned checkpoint present (empty stand-in files). */
function root(installed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'decider-')); dirs.push(dir)
  const paths = deciderPaths(dir)
  if (installed) {
    mkdirSync(join(paths.python, '..'), { recursive: true }); writeFileSync(paths.python, '')
    const snapshot = join(paths.hfHome, 'hub', 'models--convaiinnovations--laya', 'snapshots', LAYA_REVISION, 'typed-decisions')
    mkdirSync(snapshot, { recursive: true }); writeFileSync(join(snapshot, 'model.safetensors'), '')
  }
  return paths
}

/** A fake laya-serve: healthy once `ready`, answering one typed choice. */
function fakes(options: { ready?: boolean } = {}) {
  const state = { ready: options.ready ?? true, alive: new Set<number>(), spawned: [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>, requests: [] as Array<{ url: string; init?: RequestInit }> }
  const spawn = vi.fn((file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), { pid: 4242 + state.spawned.length, exitCode: null as number | null })
    state.spawned.push({ file, args, env: opts.env })
    state.alive.add(child.pid)
    return child
  })
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    state.requests.push({ url, ...(init ? { init } : {}) })
    if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok', loaded: state.ready ? ['typed-decisions'] : [] }), { status: 200 })
    return new Response(JSON.stringify({ answers: { decision: { type: 'choice', choice: 'allow', probabilities: { allow: 0.6, deny: 0.4 }, confidence: 0.2 } } }), { status: 200, headers: { 'X-Inference-Time-Ms': '388.5' } })
  })
  const deps = (paths: ReturnType<typeof deciderPaths>, extra: Partial<DeciderServerDeps> = {}): DeciderServerDeps => ({
    paths, apiKey: () => KEY, log: () => {}, spawn: spawn as never, fetch: fetch as never, alive: pid => state.alive.has(pid), bindable: async () => true,
    kill: pid => { state.alive.delete(pid) }, selfPid: 1000, ...extra
  })
  return { state, spawn, fetch, deps }
}

describe('the decider sidecar environment', () => {
  it('runs CPU only, on bounded threads, loopback, keyed, offline and pinned, without the parent\'s secrets', () => {
    const paths = deciderPaths('D:\\ConductorLocal')
    const env = deciderEnvironment(paths, 51440, KEY, { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', ANTHROPIC_API_KEY: 'secret', GH_TOKEN: 'secret', CUDA_VISIBLE_DEVICES: '0' })
    expect(env).toMatchObject({
      LAYA_HOST: '127.0.0.1', LAYA_PORT: '51440', LAYA_API_KEY: KEY, LAYA_DEVICE: 'cpu', CUDA_VISIBLE_DEVICES: '', LAYA_MODELS: 'typed-decisions',
      LAYA_THREADS: String(DECIDER_THREADS), OMP_NUM_THREADS: String(DECIDER_THREADS), MKL_NUM_THREADS: String(DECIDER_THREADS),
      LAYA_REVISION, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HOME: paths.hfHome, PATH: 'C:\\Windows'
    })
    expect(JSON.parse(env.LAYA_SHA256_DIGESTS!)).toEqual({ 'model.safetensors': LAYA_WEIGHTS_SHA256 })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(DECIDER_THREADS).toBeLessThanOrEqual(4)
  })
  it('knows whether the venv and the pinned checkpoint are on disk', () => {
    expect(deciderInstalled(root())).toEqual({ installed: true })
    expect(deciderInstalled(root(false)).reason).toMatch(/decider venv is not set up/)
  })
})

describe('DeciderServer', () => {
  it('starts lazily on the first decision, records itself and answers typed choices with the key', async () => {
    const paths = root(), f = fakes()
    const server = new DeciderServer(f.deps(paths))
    expect(server.status()).toMatchObject({ model: DECIDER_MODEL, role: 'decider', device: 'cpu', gpu: false, state: 'stopped', pid: null })
    expect(f.spawn).not.toHaveBeenCalled()
    const result = await server.predict({ tool: 'Bash' }, { decision: { type: 'choice', instructions: 'May it run?', criteria: { allow: 'a', deny: 'd' } } })
    expect(result).toMatchObject({ answers: { decision: { choice: 'allow' } }, inferenceMs: 388.5 })
    expect(f.state.spawned).toHaveLength(1)
    expect(f.state.spawned[0]).toMatchObject({ file: paths.python, args: ['-m', 'laya.serve'] })
    expect(JSON.parse(readFileSync(paths.runFile, 'utf8'))).toMatchObject({ pid: 4242, port: DECIDER_PORT, ownerPid: 1000 })
    const post = f.state.requests.find(request => request.url.endsWith('/v1/systemone'))!
    expect(post.url).toBe(`http://127.0.0.1:${DECIDER_PORT}/v1/systemone`)
    expect((post.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ model: 'typed-decisions', state: { tool: 'Bash' } })
    expect(server.status()).toMatchObject({ state: 'running', pid: 4242, port: DECIDER_PORT, startedByConductor: true })
    // Kept warm: the next decision uses the same process.
    await server.predict({}, { decision: { type: 'choice', instructions: 'q', criteria: { allow: 'a', deny: 'd' } } })
    expect(f.state.spawned).toHaveLength(1)
  })
  it('adopts a healthy sidecar another Conductor started, and leaves it running when this one quits', async () => {
    const paths = root(), f = fakes()
    f.state.alive.add(777)
    writeFileSync(paths.runFile, JSON.stringify({ pid: 777, port: 51441, startedAt: '2026-09-29T10:00:00Z', ownerPid: 2000 }))
    const server = new DeciderServer(f.deps(paths))
    await server.predict({}, { decision: { type: 'choice', instructions: 'q', criteria: { a: 'a' } } })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.state.requests.at(-1)!.url).toBe('http://127.0.0.1:51441/v1/systemone')
    server.dispose()
    expect(f.state.alive.has(777)).toBe(true)
    expect(existsSync(paths.runFile)).toBe(true)
  })
  it('stops the sidecar it started when the app quits, and on local.stop', async () => {
    const paths = root(), f = fakes()
    const server = new DeciderServer(f.deps(paths))
    await server.ensure()
    expect(await server.stop()).toMatch(/stopped the decider \(pid 4242\); the next decision starts it again/)
    expect(existsSync(paths.runFile)).toBe(false)
    await server.ensure()
    server.dispose()
    expect(f.state.alive.size).toBe(0)
    expect(existsSync(paths.runFile)).toBe(false)
  })
  it('replaces a stale record and refuses cleanly when it is not installed', async () => {
    const paths = root(), f = fakes()
    writeFileSync(paths.runFile, JSON.stringify({ pid: 999, port: 51440, startedAt: '2026-09-29T10:00:00Z', ownerPid: 2000 }))
    await new DeciderServer(f.deps(paths)).ensure()
    expect(f.state.spawned).toHaveLength(1)
    const missing = new DeciderServer(fakes().deps(root(false)))
    expect(missing.status()).toMatchObject({ state: 'not-installed' })
    await expect(missing.ensure()).rejects.toThrow(/decider unavailable: the decider venv is not set up/)
  })
  it('bounds a decision by its timeout', async () => {
    const paths = root(), f = fakes()
    const slow = vi.fn(async (url: string, init?: RequestInit) => url.endsWith('/health') ? f.fetch(url, init)
      : await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))))
    const server = new DeciderServer(f.deps(paths, { fetch: slow as never }))
    await expect(server.predict({}, { decision: {} }, { timeoutMs: 50 })).rejects.toThrow('the decider did not answer within 0 s')
  })
})
