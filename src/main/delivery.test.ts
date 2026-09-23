import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryService, normalizeDeliveryPath, parseDeliveryConfig, parseGithubRemote, parsePorcelain, workflowRunsOnPush, type DeliveryRunOptions } from './delivery'
import type { DeliveryRun } from '../shared/delivery'

const SHA = 'a'.repeat(40)
const REBASED = 'b'.repeat(40)
type Reply = { code?: number | null; stdout?: string; lines?: string[] }
type Handler = Reply | Reply[] | ((options: DeliveryRunOptions, args: string[]) => Reply | Promise<Reply>)

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function harness(setup: { replies?: Record<string, Handler>; files?: Record<string, string>; workflow?: boolean; github?: Record<string, unknown | unknown[]>; token?: string | null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'delivery-test-'))
  roots.push(base)
  const root = join(base, 'repo')
  const temp = join(base, 'tmp')
  mkdirSync(root, { recursive: true }); mkdirSync(temp)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }))
  if (setup.workflow !== false) { mkdirSync(join(root, '.github', 'workflows'), { recursive: true }); writeFileSync(join(root, '.github', 'workflows', 'release.yml'), 'on: push') }
  for (const [path, content] of Object.entries(setup.files ?? {})) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content) }
  const replies: Record<string, Handler> = {
    'git rev-parse --show-toplevel': { stdout: `${root}\n` },
    'git symbolic-ref --quiet --short HEAD': { stdout: 'main\n' },
    'git rev-parse --absolute-git-dir': { stdout: join(root, '.git') },
    'git remote get-url origin': { stdout: 'https://github.com/owner/app.git\n' },
    'git status --porcelain=v1 -z --untracked-files=all': { stdout: ' M src/a.ts\0' },
    'git rev-list --left-right --count origin/main...HEAD': { stdout: '0\t0\n' },
    'git rev-parse HEAD': { stdout: `${SHA}\n` },
    'git diff --binary': (options, args) => { writeFileSync(args.find(arg => arg.startsWith('--output='))!.slice('--output='.length), 'diff --git a/x b/x\n'); return {} },
    'git worktree add': (_options, args) => { mkdirSync(args[3]!, { recursive: true }); return {} },
    ...setup.replies
  }
  const calls: { command: string; args: string[]; cwd: string }[] = []
  const run = vi.fn(async (command: string, args: string[], options: DeliveryRunOptions) => {
    calls.push({ command, args, cwd: options.cwd })
    const line = [command, ...args].join(' ')
    const key = Object.keys(replies).filter(prefix => line === prefix || line.startsWith(`${prefix} `)).sort((a, b) => b.length - a.length)[0]
    let handler = key ? replies[key]! : {}
    if (Array.isArray(handler)) handler = handler.length > 1 ? handler.shift()! : handler[0]!
    const reply = typeof handler === 'function' ? await handler(options, args) : handler
    for (const output of reply.lines ?? []) options.onLine(output)
    return { code: reply.code === undefined ? 0 : reply.code, stdout: reply.stdout ?? '' }
  })
  const github: Record<string, unknown | unknown[]> = {
    '/actions/runs?head_sha=': { workflow_runs: [{ id: 7, path: '.github/workflows/release.yml', name: 'Release Conductor', status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/app/actions/runs/7', created_at: '2026-09-22T10:00:10Z', run_started_at: '2026-09-22T10:00:10Z' }] },
    '/releases?per_page=10': [{ tag_name: 'v1.2.3', html_url: 'https://github.com/owner/app/releases/tag/v1.2.3', target_commitish: SHA, published_at: '2026-09-22T10:10:00Z', assets: [{ name: 'Conductor-Setup-1.2.3.exe' }, { name: 'Conductor-Setup-1.2.3.exe.blockmap' }, { name: 'latest.yml' }] }],
    ...setup.github
  }
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const key = Object.keys(github).filter(fragment => url.includes(fragment)).sort((a, b) => b.length - a.length)[0]
    if (!key) return new Response('not found', { status: 404 })
    let body = github[key]
    if (Array.isArray(body) && body.length && body[0] instanceof Response) body = body.length > 1 ? body.shift() : body[0]
    if (body instanceof Response) return body.clone()
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  let clock = Date.parse('2026-09-22T10:00:00Z')
  const sleeps: number[] = []
  const service = new DeliveryService({
    run, fetch: fetchFake as unknown as typeof fetch, githubToken: async () => setup.token === undefined ? 'token' : setup.token,
    now: () => new Date(clock), sleep: async ms => { sleeps.push(ms); clock += ms }, tempDir: () => temp
  })
  const ran = (prefix: string): boolean => calls.some(call => [call.command, ...call.args].join(' ').startsWith(prefix))
  const ship = async (request: { message: string; paths?: string[]; publish?: boolean } = { message: 'Ship it' }): Promise<DeliveryRun> => {
    const started = service.ship('p1', root, { publish: true, ...request }, { kind: 'agent', agentSessionId: 's1', title: 'Agent' })
    return service.wait('p1', started.id, 5000)
  }
  return { service, root, temp, calls, requests, sleeps, ran, ship, replies }
}

const stageStates = (run: DeliveryRun): Record<string, string> => Object.fromEntries(run.stages.map(stage => [stage.id, stage.state]))

describe('local delivery by default', () => {
  it('tests, builds and commits without touching the network, and says so', async () => {
    const h = harness()
    const run = await h.ship({ message: 'Local step', publish: false })
    expect(run.error).toBeNull()
    expect(run.state).toBe('delivered')
    expect(run.publish).toBe(false)
    expect(stageStates(run)).toEqual({ preflight: 'passed', test: 'passed', build: 'passed', commit: 'passed', push: 'skipped', release: 'skipped' })
    expect(run.commit).toBe(SHA)
    expect(run.stages[4]!.detail).toMatch(/Local delivery: commit aaaaaaa stays on this machine/)
    expect(run.stages[5]!.detail).toMatch(/app\.update/)
    expect(h.ran('npm test')).toBe(true)
    expect(h.ran('git commit')).toBe(true)
    expect(h.ran('git fetch')).toBe(false)
    expect(h.ran('git push')).toBe(false)
    expect(h.requests).toHaveLength(0)
    expect(run.stages[0]!.detail).toContain('local delivery (no push, no release)')
  })

  it('needs no remote for a local commit, and refuses a clean tree', async () => {
    const h = harness({ replies: { 'git remote get-url origin': { code: 2, stdout: '' } } })
    expect((await h.ship({ message: 'No remote yet', publish: false })).state).toBe('delivered')
    const clean = harness({ replies: { 'git status --porcelain=v1 -z --untracked-files=all': { stdout: '' } } })
    expect((await clean.ship({ message: 'x', publish: false })).error).toMatch(/Nothing to commit: the working tree is clean/)
    expect((await clean.ship({ message: 'x', publish: true })).error).toMatch(/no local commits are ahead/)
  })

  it('starts a dispatch-only release workflow with the token when publishing, and says what to do without one', async () => {
    const dispatchOnly = { '.github/workflows/release.yml': 'on:\n  workflow_dispatch:\njobs: {}\n' }
    const h = harness({ files: dispatchOnly, github: { '/actions/workflows/release.yml/dispatches': new Response(null, { status: 204 }) } })
    const run = await h.ship()
    expect(run.state).toBe('delivered')
    expect(run.releaseTag).toBe('v1.2.3')
    const dispatch = h.requests.find(request => request.url.endsWith('/actions/workflows/release.yml/dispatches'))
    expect(dispatch?.headers).toMatchObject({ Authorization: 'Bearer token' })
    expect(run.stages[5]!.log).toContain('Started release.yml on main')
    const anonymous = harness({ files: dispatchOnly, token: null })
    const failed = await anonymous.ship()
    expect(failed.state).toBe('failed')
    expect(failed.error).toMatch(/only runs on request and no GitHub token/)
    expect(anonymous.requests.some(request => request.url.includes('/dispatches'))).toBe(false)
    // The older push-triggered shape is left to run itself.
    expect((await harness().ship()).stages[5]!.log).not.toContain('Started release.yml on main')
  })

  it('reads whether a workflow runs on push', () => {
    expect(workflowRunsOnPush('on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n')).toBe(true)
    expect(workflowRunsOnPush('on: [push, workflow_dispatch]')).toBe(true)
    expect(workflowRunsOnPush('on: push\n')).toBe(true)
    expect(workflowRunsOnPush('# runs on push? no\non:\n  workflow_dispatch:\njobs:\n  push:\n    runs-on: x\n')).toBe(false)
    expect(workflowRunsOnPush('on:\n  workflow_dispatch:\n')).toBe(false)
  })
})

describe('DeliveryService pipeline', () => {
  it('delivers the whole tree through a verified release', async () => {
    const h = harness()
    const snapshots: DeliveryRun[] = []
    h.service.onChanged(run => snapshots.push(run))
    const run = await h.ship()
    expect(run.error).toBeNull()
    expect(run.state).toBe('delivered')
    expect(stageStates(run)).toEqual({ preflight: 'passed', test: 'passed', build: 'passed', commit: 'passed', push: 'passed', release: 'passed' })
    expect(run).toMatchObject({ commit: SHA, releaseTag: 'v1.2.3', releaseUrl: 'https://github.com/owner/app/releases/tag/v1.2.3', workflowRunUrl: 'https://github.com/owner/app/actions/runs/7' })
    expect(h.ran('git fetch origin main')).toBe(true)
    expect(h.ran('npm test')).toBe(true)
    expect(h.ran('npm run build')).toBe(true)
    expect(h.ran('git add -A')).toBe(true)
    const commit = h.calls.find(call => call.args[0] === 'commit')!
    expect(commit.args.slice(0, 2)).toEqual(['commit', '-F'])
    expect(commit.args).not.toContain('Ship it')
    expect(commit.args).not.toContain('--no-verify')
    expect(h.ran('git push origin HEAD:main')).toBe(true)
    expect(h.ran('git worktree')).toBe(false)
    expect(h.requests[0]!.headers).toMatchObject({ Authorization: 'Bearer token', Accept: 'application/vnd.github+json', 'User-Agent': 'Conductor' })
    expect(snapshots.at(-1)!.state).toBe('delivered')
    snapshots[0]!.stages[0]!.log.push('mutated')
    expect(h.service.current('p1')!.stages[0]!.log).not.toContain('mutated')
  })

  it('verifies a path subset in an isolated worktree and removes it even when tests fail', async () => {
    const h = harness({
      files: { 'src/new file.ts': 'export {}' },
      replies: {
        'git status --porcelain=v1 -z --untracked-files=all': { stdout: ' M src/a.ts\0?? src/new file.ts\0 M other/agent.ts\0' },
        'npm test': { code: 1, lines: ['RUN v3', ' FAIL src/a.test.ts > adds', 'AssertionError: expected 1 to be 2', 'Test Files 1 failed'] }
      }
    })
    const run = await h.ship({ message: 'Only mine', paths: ['src/a.ts', 'src/new file.ts'] })
    expect(run.state).toBe('failed')
    expect(stageStates(run)).toMatchObject({ preflight: 'passed', test: 'failed', build: 'pending', commit: 'pending' })
    expect(run.error).toMatch(/Tests failed.*isolated worktree/)
    expect(run.error).toContain('FAIL src/a.test.ts > adds')
    const add = h.calls.find(call => call.args[0] === 'worktree' && call.args[1] === 'add')!
    const tree = add.args[3]!
    expect(h.calls.find(call => call.command === 'npm')!.cwd).toBe(tree)
    expect(h.calls.find(call => call.args[0] === 'apply')!.cwd).toBe(tree)
    expect(h.calls.find(call => call.args[0] === 'diff')!.args).toEqual(expect.arrayContaining(['HEAD', '--', 'src/a.ts', 'src/new file.ts']))
    expect(h.ran(`git worktree remove --force ${tree}`)).toBe(true)
    expect(existsSync(tree)).toBe(false)
    expect(h.ran('git commit')).toBe(false)
  })

  it('commits only the requested paths after isolated verification passes', async () => {
    const h = harness({ replies: { 'git status --porcelain=v1 -z --untracked-files=all': { stdout: ' M src/a.ts\0 M other/agent.ts\0' } } })
    const run = await h.ship({ message: 'Mine', paths: ['src/a.ts'] })
    expect(run.state).toBe('delivered')
    expect(run.stages[1]!.detail).toMatch(/isolated worktree/)
    expect(h.ran('git add -A -- src/a.ts')).toBe(true)
    expect(h.calls.find(call => call.args[0] === 'commit')!.args.slice(-2)).toEqual(['--', 'src/a.ts'])
    expect(h.ran('git worktree remove --force')).toBe(true)
  })

  it('stops before committing when tests fail in the working tree', async () => {
    const h = harness({ replies: { 'npm test': { code: 1, lines: ['src/x.ts(3,1): error TS2322: nope'] } } })
    const run = await h.ship()
    expect(run.state).toBe('failed')
    expect(run.error).toContain('error TS2322')
    expect(run.error).toContain('in the working tree')
    expect(h.ran('git commit')).toBe(false)
    expect(h.ran('git push')).toBe(false)
    expect(run.stages.some(stage => stage.state === 'running')).toBe(false)
  })

  it('skips a test stage the project config disables', async () => {
    const h = harness({ files: { '.conductor/delivery.json': JSON.stringify({ test: null }) } })
    const run = await h.ship()
    expect(run.state).toBe('delivered')
    expect(run.stages[1]).toMatchObject({ state: 'skipped', detail: expect.stringMatching(/Disabled/) })
    expect(h.ran('npm test')).toBe(false)
  })

  it('rebases once onto a moved remote and pushes again', async () => {
    const h = harness({
      replies: {
        'git push origin HEAD:main': [{ code: 1, lines: [' ! [rejected]        HEAD -> main (fetch first)', 'error: failed to push some refs'] }, { code: 0 }],
        'git rev-parse HEAD': [{ stdout: SHA }, { stdout: SHA }, { stdout: REBASED }]
      }
    })
    const run = await h.ship()
    expect(run.state).toBe('delivered')
    expect(h.ran('git pull --rebase --autostash origin main')).toBe(true)
    expect(h.calls.filter(call => call.args[0] === 'push')).toHaveLength(2)
    expect(run.commit).toBe(REBASED)
    expect(run.stages[4]!.detail).toMatch(/rebasing/)
  })

  it('aborts a conflicting rebase and says the commit is still local', async () => {
    const h = harness({
      replies: {
        'git push origin HEAD:main': { code: 1, lines: [' ! [rejected] HEAD -> main (non-fast-forward)'] },
        'git pull --rebase': { code: 1, lines: ['CONFLICT (content): Merge conflict in src/a.ts'] },
        'git diff --name-only --diff-filter=U': { stdout: 'src/a.ts\n' }
      }
    })
    const run = await h.ship()
    expect(run.state).toBe('failed')
    expect(h.ran('git rebase --abort')).toBe(true)
    expect(run.error).toMatch(/conflicts in: src\/a\.ts/)
    expect(run.error).toMatch(/still local/)
    expect(h.calls.filter(call => call.args[0] === 'push')).toHaveLength(1)
  })

  it('surfaces the failing workflow annotations', async () => {
    const h = harness({
      github: {
        '/actions/runs?head_sha=': { workflow_runs: [{ id: 7, path: '.github/workflows/release.yml', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/app/actions/runs/7' }] },
        '/actions/runs/7/jobs': { jobs: [{ id: 99, name: 'windows-release', conclusion: 'failure', steps: [{ name: 'Test', conclusion: 'failure' }] }] },
        '/check-runs/99/annotations': [{ title: 'npm test failures 1', message: 'FAIL src/main/x.test.ts > breaks on CI' }]
      }
    })
    const run = await h.ship()
    expect(run.state).toBe('failed')
    expect(run.stages[5]!.state).toBe('failed')
    expect(run.error).toContain('FAIL src/main/x.test.ts > breaks on CI')
    expect(run.error).toContain('at step "Test"')
    expect(run.stages[5]!.log.join('\n')).toContain('breaks on CI')
  })

  it('treats a cancelled release workflow as superseded', async () => {
    const h = harness({ github: { '/actions/runs?head_sha=': { workflow_runs: [{ id: 7, path: '.github/workflows/release.yml', status: 'completed', conclusion: 'cancelled', html_url: 'u' }] } } })
    const run = await h.ship()
    expect(run.state).toBe('cancelled')
    expect(run.error).toMatch(/superseded by a newer push/)
    expect(run.stages.some(stage => stage.state === 'running')).toBe(false)
  })

  it('fails when the release lacks latest.yml', async () => {
    const h = harness({ github: { '/releases?per_page=10': [{ tag_name: 'v1.2.3', html_url: 'r', target_commitish: SHA, assets: [{ name: 'Conductor-Setup-1.2.3.exe' }, { name: 'Conductor-Setup-1.2.3.exe.blockmap' }] }] } })
    const run = await h.ship()
    expect(run.state).toBe('failed')
    expect(run.error).toMatch(/missing assets matching latest\.yml/)
    expect(run.releaseTag).toBe('v1.2.3')
  })

  it('waits for the workflow run to appear and complete, polling at the token interval', async () => {
    const h = harness({
      github: {
        '/actions/runs?head_sha=': [
          new Response(JSON.stringify({ workflow_runs: [] })),
          new Response(JSON.stringify({ workflow_runs: [{ id: 7, path: '.github/workflows/release.yml@refs/heads/main', status: 'in_progress', html_url: 'w' }] })),
          new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
          new Response(JSON.stringify({ workflow_runs: [{ id: 7, path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success', html_url: 'w', run_started_at: '2026-09-22T10:00:10Z' }] }))
        ]
      }
    })
    const run = await h.ship()
    expect(run.state).toBe('delivered')
    expect(h.sleeps).toEqual([20_000, 20_000, 30_000])
  })

  it('gives up when no workflow run appears within five minutes', async () => {
    const h = harness({ token: null, github: { '/actions/runs?head_sha=': { workflow_runs: [] } } })
    const run = await h.ship()
    expect(run.state).toBe('failed')
    expect(run.error).toMatch(/within 5 minutes/)
    expect(h.sleeps.every(ms => ms === 45_000)).toBe(true)
  })

  it('skips the release stage when the project has no release workflow', async () => {
    const h = harness({ workflow: false })
    const run = await h.ship()
    expect(run.state).toBe('delivered')
    expect(run.stages[5]).toMatchObject({ state: 'skipped', detail: expect.stringMatching(/release\.yml/) })
    expect(h.requests).toHaveLength(0)
  })

  it('refuses a second delivery for the same project or folder while one runs', async () => {
    let release!: () => void
    const h = harness({ replies: { 'npm test': () => new Promise<Reply>(resolve => { release = () => resolve({}) }) } })
    const first = h.service.ship('p1', h.root, { message: 'one' }, { kind: 'owner' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(() => h.service.ship('p1', h.root, { message: 'two' }, { kind: 'owner' })).toThrow(first.id)
    expect(() => h.service.ship('p2', h.root, { message: 'two' }, { kind: 'owner' })).toThrow(/already running/)
    release()
    expect((await h.service.wait('p1', first.id, 5000)).state).toBe('delivered')
  })

  it('refuses paths that escape the repository', async () => {
    for (const path of ['../outside.ts', 'C:\\Windows\\x', '/etc/passwd', 'src/../../x']) {
      const h = harness()
      const run = await h.ship({ message: 'x', paths: [path] })
      expect(run.state).toBe('failed')
      expect(run.stages[0]!.state).toBe('failed')
      expect(h.ran('git add')).toBe(false)
    }
  })

  it('refuses paths without changes and a clean tree with nothing ahead', async () => {
    const unchanged = harness()
    expect((await unchanged.ship({ message: 'x', paths: ['src/b.ts'] })).error).toMatch(/no changes to deliver: src\/b\.ts/)
    const clean = harness({ replies: { 'git status --porcelain=v1 -z --untracked-files=all': { stdout: '' } } })
    const run = await clean.ship()
    expect(run.error).toMatch(/Nothing to deliver/)
    expect(clean.ran('npm test')).toBe(false)
  })

  it('pushes local commits without committing when the tree is clean', async () => {
    const h = harness({ replies: { 'git status --porcelain=v1 -z --untracked-files=all': { stdout: '' }, 'git rev-list --left-right --count origin/main...HEAD': { stdout: '0\t2\n' } } })
    const run = await h.ship()
    expect(run.state).toBe('delivered')
    expect(run.stages[3]!.state).toBe('skipped')
    expect(h.ran('git commit')).toBe(false)
    expect(h.ran('git push origin HEAD:main')).toBe(true)
  })

  it('treats an empty paths list as push-only, verifying HEAD apart from the uncommitted tree', async () => {
    const h = harness({ replies: { 'git rev-list --left-right --count origin/main...HEAD': { stdout: '0\t1\n' } } })
    const run = await h.ship({ message: 'Push what is committed', paths: [] })
    expect(run.state).toBe('delivered')
    expect(run.stages[3]!.state).toBe('skipped')
    expect(h.ran('git add')).toBe(false)
    expect(h.ran('git commit')).toBe(false)
    expect(h.ran('git diff --binary')).toBe(false)
    expect(h.ran('git worktree remove --force')).toBe(true)
    expect(h.ran('git push origin HEAD:main')).toBe(true)
    expect(run.releaseTag).toBe('v1.2.3')
    const nothing = harness()
    expect((await nothing.ship({ message: 'x', paths: [] })).error).toMatch(/no paths were selected/)
  })

  it('cancels a running test, aborting its process', async () => {
    let aborted = false
    const h = harness({ replies: { 'npm test': options => new Promise<Reply>(resolve => options.signal.addEventListener('abort', () => { aborted = true; resolve({ code: null }) })) } })
    const started = h.service.ship('p1', h.root, { message: 'x' }, { kind: 'owner' })
    await vi.waitFor(() => expect(h.service.current('p1')!.stages[1]!.state).toBe('running'))
    const cancelled = h.service.cancel('p1')!
    expect(cancelled.state).toBe('cancelled')
    expect(aborted).toBe(true)
    expect(stageStates(cancelled)).toMatchObject({ test: 'failed', commit: 'pending' })
    const run = await h.service.wait('p1', started.id, 5000)
    expect(run.state).toBe('cancelled')
    expect(h.ran('git commit')).toBe(false)
  })

  it('fails preflight on a wrong branch or a bad config', async () => {
    const branch = harness({ replies: { 'git symbolic-ref --quiet --short HEAD': { stdout: 'feature\n' } } })
    expect((await branch.ship()).error).toMatch(/On branch feature/)
    const config = harness({ files: { '.conductor/delivery.json': '{"tests": null}' } })
    expect((await config.ship()).error).toMatch(/unknown key\(s\): tests/)
  })
})

describe('DeliveryService.status', () => {
  it('reports a non-repository as unavailable without throwing', async () => {
    const h = harness({ replies: { 'git rev-parse --show-toplevel': { code: 128, lines: ['fatal: not a git repository'] } } })
    const status = await h.service.status('p1', h.root)
    expect(status).toMatchObject({ available: false, reason: expect.stringMatching(/not a Git repository/), files: [] })
  })

  it('reads branch, upstream, counts, head, files and the GitHub remote', async () => {
    const h = harness({
      replies: {
        'git rev-parse --abbrev-ref --symbolic-full-name @{u}': { stdout: 'origin/main\n' },
        'git rev-list --left-right --count @{u}...HEAD': { stdout: '1\t3\n' },
        'git log -1 --format=%H%x00%s': { stdout: `${SHA}\0Subject line\n` },
        'git remote get-url origin': { stdout: 'git@github.com:owner/app.git\n' },
        'git status --porcelain=v1 -z --untracked-files=all': { stdout: 'R  new name.ts\0old name.ts\0?? a b.txt\0' }
      }
    })
    const status = await h.service.status('p1', h.root)
    expect(status).toMatchObject({ available: true, branch: 'main', upstream: 'origin/main', behind: 1, ahead: 3, head: SHA, headSubject: 'Subject line', github: { owner: 'owner', repo: 'app' }, releaseWorkflow: true })
    expect(status.files).toEqual([{ path: 'new name.ts', index: 'R', worktree: '' }, { path: 'a b.txt', index: '?', worktree: '?' }])
  })
})

describe('delivery helpers', () => {
  it('parses porcelain with renames and spaces', () => {
    expect(parsePorcelain('R  dir/new file.ts\0dir/old file.ts\0 M  lead.ts\0AM x y\0D  gone.ts\0')).toEqual([
      { path: 'dir/new file.ts', index: 'R', worktree: '', from: 'dir/old file.ts' },
      { path: ' lead.ts', index: '', worktree: 'M', from: null },
      { path: 'x y', index: 'A', worktree: 'M', from: null },
      { path: 'gone.ts', index: 'D', worktree: '', from: null }
    ])
  })

  it('parses GitHub remotes in https and ssh forms', () => {
    expect(parseGithubRemote('https://github.com/Empire024/conductor.git')).toEqual({ owner: 'Empire024', repo: 'conductor' })
    expect(parseGithubRemote('https://token@github.com/o/r')).toEqual({ owner: 'o', repo: 'r' })
    expect(parseGithubRemote('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' })
    expect(parseGithubRemote('ssh://git@github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' })
    expect(parseGithubRemote('https://gitlab.com/o/r.git')).toBeNull()
  })

  it('normalizes and rejects delivery paths', () => {
    expect(normalizeDeliveryPath('.\\src\\a.ts')).toBe('src/a.ts')
    expect(() => normalizeDeliveryPath('a/../../b')).toThrow(/leaves the repository/)
    expect(() => normalizeDeliveryPath('D:/x')).toThrow(/absolute/)
    expect(() => normalizeDeliveryPath('.git/config')).toThrow(/\.git/)
  })

  it('validates the delivery config strictly', () => {
    expect(parseDeliveryConfig(null)).toEqual({ branch: 'main', remote: 'origin' })
    expect(parseDeliveryConfig('{"build":["npm","run","build:fast"],"release":{"assets":[".zip"]}}')).toMatchObject({ build: ['npm', 'run', 'build:fast'], release: { assets: ['.zip'] } })
    expect(() => parseDeliveryConfig('{"test":"npm test"}')).toThrow(/argv array/)
    expect(() => parseDeliveryConfig('{"branch":"--force"}')).toThrow(/branch/)
    expect(() => parseDeliveryConfig('{"release":{"workflow":"../x"}}')).toThrow(/workflow/)
    expect(() => parseDeliveryConfig('nope')).toThrow(/not valid JSON/)
  })
})
