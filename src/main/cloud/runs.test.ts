import { spawn as spawnChild } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudRunSummary } from '../../shared/cloud'
import { CloudRuns, clientEnv, cloudArgs, findResult, parseTranscript, readCreateLog, type CloudExec, type CloudGit, type CloudPty, type CloudSpawn } from './runs'

const fixture = join(process.cwd(), 'scripts/fixtures/cloud-cli.cjs')

/** The fixture client over pipes: the same bytes a PTY would carry, without a console. */
const pipeSpawn: CloudSpawn = (file, args, options) => {
  const child = spawnChild(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  return {
    onData: listener => { child.stdout.on('data', listener); child.stderr.on('data', listener) },
    onExit: listener => { child.on('exit', code => listener({ exitCode: code ?? -1 })) },
    write: data => { child.stdin.write(data) },
    resize: () => undefined,
    kill: () => { child.kill() }
  }
}
const pipeExec: CloudExec = (file, args, options) => new Promise(resolve => {
  const child = spawnChild(file, args, { cwd: options.cwd, env: options.env })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  child.on('exit', code => resolve({ code: code ?? 1, output: output.trim() }))
})

const until = async (check: () => boolean, what: string, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** origin as git ls-remote shows it, changed by the test as the "cloud" pushes. */
function fakeOrigin() {
  const state = { refs: [] as string[], calls: [] as string[][], inProject: [] as string[][], localBranches: [] as string[] }
  const git: CloudGit = async (cwd, args) => {
    state.calls.push(args)
    if (!cwd.includes('teleport')) state.inProject.push(args)
    if (args[0] === 'ls-remote') return state.refs.filter(line => args.includes('refs/pull/*/head') || !line.includes('refs/pull/')).join('\n')
    if (args[0] === 'remote') return 'https://github.com/Empire024/conductor.git\n'
    if (args[0] === 'for-each-ref') return state.localBranches.join('\n')
    // The teleport checked the session's branch out as a new local branch.
    if (args[0] === 'branch' && args[1] === '--show-current') { state.localBranches.push('claude/fixture-note-ogcvln'); return 'claude/fixture-note-ogcvln\n' }
    if (args[0] === 'branch' && args[1] === '-D') state.localBranches = state.localBranches.filter(name => name !== args[2])
    if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[3]!, { recursive: true })
    if (args[0] === 'rev-parse') return 'abc123\n'
    if (args[0] === 'merge-base') return 'base000\n'
    if (args[0] === 'diff') return ' NOTE.md | 1 +\n'
    return ''
  }
  return { state, git }
}

describe('cloud runs', () => {
  let root: string, project: string, config: string
  let opened: CloudRuns[] = []
  const make = (options: Partial<ConstructorParameters<typeof CloudRuns>[0]> = {}): CloudRuns => {
    const runs = new CloudRuns({
      root, executable: () => process.execPath, prefixArgs: [fixture], spawn: pipeSpawn, exec: pipeExec, pollMs: 50, watchMs: 50,
      git: async () => '', ...options, env: { CLAUDE_CONFIG_DIR: config, CLOUD_FIXTURE_TURN_MS: '300', ...options.env }
    })
    opened.push(runs)
    return runs
  }
  const start = (runs: CloudRuns, patch: Record<string, unknown> = {}): CloudRunSummary => runs.start({ projectId: 'p', workspaceId: 'w', cwd: project, prompt: 'Add a one-line note', startedBy: 'agent_1', ...patch })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cloud-runs-'))
    project = mkdtempSync(join(tmpdir(), 'cloud-project-'))
    config = mkdtempSync(join(tmpdir(), 'cloud-config-'))
    opened = []
  })
  afterEach(async () => {
    for (const runs of opened) runs.dispose()
    // A killed client or teleport still holds its folder for a moment on Windows.
    await new Promise(resolve => setTimeout(resolve, 300))
    for (const dir of [root, project, config]) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  it('asks the CLI for a cloud session with the chosen model, effort, base and a debug log', () => {
    expect(cloudArgs({ prompt: 'Add a note', model: 'claude-sonnet-5', effort: 'high', ref: 'main', title: 'Note' }, 'x.log'))
      .toEqual(['--cloud', 'Add a note', '--model', 'claude-sonnet-5', '--effort', 'high', '--ref', 'main', '--name', 'Note', '--debug-file', 'x.log'])
    expect(cloudArgs({ prompt: 'p', model: 'claude-opus-5-5', effort: null, ref: null, title: 't' }, 'd')).not.toContain('--effort')
  })

  it('refuses models, efforts and refs it cannot pass on', () => {
    const runs = make()
    expect(() => start(runs, { model: 'gpt-6' })).toThrow(/cloud model/)
    expect(() => start(runs, { effort: 'ultra' })).toThrow(/effort/)
    expect(() => start(runs, { ref: 'main; rm -rf /' })).toThrow(/ref/)
    expect(() => start(runs, { prompt: '  ' })).toThrow(/prompt/)
    expect(() => start(runs, { cwd: join(project, 'missing') })).toThrow(/not on this machine/)
    expect(runs.list()).toEqual([])
  })

  it('creates the session, finds it has no live view, follows it on origin and pulls its transcript', async () => {
    const origin = fakeOrigin()
    const changes: CloudRunSummary[] = []
    const runs = make({ git: origin.git, onChanged: summary => changes.push(summary) })
    const run = start(runs, { model: 'claude-haiku-4-5-20251001', title: 'Note' })
    expect(run).toMatchObject({ status: 'starting', attached: true, model: 'claude-haiku-4-5-20251001', title: 'Note', startedBy: 'agent_1', cwd: project })
    await until(() => runs.get(run.id).liveView === false, 'the attach gate')
    const created = runs.get(run.id)
    expect(created).toMatchObject({ status: 'running', attached: false, confirmedModel: 'claude-haiku-4-5-20251001', branchHint: 'claude/fixture-note' })
    expect(created.sessionUrl).toBe(`https://claude.ai/code/${created.sessionId}`)
    expect(runs.screen(run.id)).toMatch(/Attaching to an existing cloud session is not enabled/)

    // The cloud pushes its branch (with a suffix) and opens a pull request.
    origin.state.refs = ['aaa\trefs/heads/claude/older', 'c86d864\trefs/heads/claude/fixture-note-ogcvln', 'c86d864\trefs/pull/7/head']
    await until(() => runs.get(run.id).status === 'pushed', 'the push')
    expect(runs.get(run.id)).toMatchObject({ branch: 'claude/fixture-note-ogcvln', headCommit: 'c86d864', prUrl: 'https://github.com/Empire024/conductor/pull/7' })

    // The first push pulls the transcript by itself, through a teleport in the run's own worktree.
    await until(() => runs.get(run.id).transcriptEntries > 0, 'the transcript')
    expect(origin.state.calls).toContainEqual(['worktree', 'add', '--detach', join(root, 'teleport', run.id), 'HEAD'])
    expect(origin.state.calls).toContainEqual(['checkout', '--detach'])
    expect(origin.state.calls).toContainEqual(['branch', '-D', 'claude/fixture-note-ogcvln'])
    expect(origin.state.localBranches).toEqual([])
    const entries = await runs.transcript(run.id)
    expect(entries.map(entry => entry.role)).toEqual(['user', 'tool', 'result', 'assistant'])
    expect(runs.get(run.id)).toMatchObject({ confirmedModel: 'claude-opus-5-5', usage: { messages: 2, outputTokens: 240, cacheReadTokens: 2000 } })
    expect(changes.some(change => change.status === 'running')).toBe(true)

    // Steering is refused by the CLI on this account, with the link to do it by hand.
    await expect(runs.send(run.id, 'more')).rejects.toThrow(new RegExp(`not enabled for your account.*${created.sessionUrl}`))
    expect(() => runs.interrupt(run.id)).toThrow(/No live client/)
    expect(() => runs.attach(run.id)).toThrow(/cannot attach a live client/)
    const stopped = await runs.stop(run.id)
    expect(stopped).toMatchObject({ status: 'stopped', note: expect.stringContaining(created.sessionUrl!) })
  })

  it('attaches a live client where the account allows it, and steers, interrupts and stops it', async () => {
    const runs = make({ env: { CLOUD_FIXTURE_ATTACH: '1' } })
    const run = start(runs)
    await until(() => runs.get(run.id).liveView === null && runs.get(run.id).attached && runs.screen(run.id).includes('cloud session attached'), 'the live client')
    await runs.send(run.id, 'Also mention the date')
    await until(() => runs.screen(run.id).includes('Working…'), 'a working turn')
    runs.interrupt(run.id)
    await until(() => runs.screen(run.id).includes('Interrupted by user'), 'the interruption')
    await runs.send(run.id, 'Again')
    await until(() => runs.screen(run.id).includes('Received: Again'), 'the reply')
    const stopped = await runs.stop(run.id)
    expect(stopped.note).toMatch(/interrupted/)
    await until(() => !runs.get(run.id).attached, 'the client to close')
    expect(runs.get(run.id).status).toBe('stopped')
  })

  it('answers the folder trust question once, so the run stays unattended', () => {
    const writes: string[] = []
    let feed: (data: string) => void = () => undefined
    const fake: CloudPty = { onData: listener => { feed = listener }, onExit: () => undefined, write: data => { writes.push(data) }, resize: () => undefined, kill: () => undefined }
    vi.useFakeTimers()
    try {
      const runs = make({ spawn: () => fake })
      start(runs)
      feed('Quick safety check: Is this a project you created or one you trust?\r\n❯ 1. No, exit\r\n  2. Yes, I trust this folder\r\n')
      vi.advanceTimersByTime(200); feed('\x1b[0m'); vi.advanceTimersByTime(800)
      expect(writes).toEqual(['\x1b[B', '\r'])
    } finally { vi.useRealTimers() }
  })

  it('reports a client that exits before any session exists as failed, with what it said', async () => {
    const runs = make({ prefixArgs: ['-e', 'console.log("Error: not logged in"); process.exit(1)', '--'] })
    const run = start(runs)
    await until(() => runs.get(run.id).status === 'failed', 'the failure')
    expect(runs.get(run.id).error).toMatch(/exited \(1\)[\s\S]*not logged in/)
  })

  it('fetches the pushed branch into its own detached worktree and never touches the working tree', async () => {
    const origin = fakeOrigin()
    const runs = make({ git: origin.git })
    const run = start(runs)
    await until(() => runs.get(run.id).status === 'running', 'the session')
    await expect(runs.fetch(run.id)).rejects.toThrow(/not pushed a branch/)
    origin.state.refs = ['c86d864\trefs/heads/claude/fixture-note-x']
    const result = await runs.fetch(run.id)
    expect(result).toMatchObject({ commit: 'abc123', ref: 'refs/heads/claude/fixture-note-x', branch: 'claude/fixture-note-x', diffStat: 'NOTE.md | 1 +' })
    expect(result.worktreePath).toBe(join(root, 'worktrees', run.id))
    expect(origin.state.calls).toContainEqual(['fetch', '--no-tags', 'origin', '+refs/heads/claude/fixture-note-x:refs/remotes/origin/claude/fixture-note-x'])
    expect(origin.state.calls).toContainEqual(['worktree', 'add', '--detach', result.worktreePath, 'abc123'])
    for (const args of origin.state.inProject) expect(['checkout', 'switch', 'merge', 'push', 'reset', 'rebase', 'commit', 'pull']).not.toContain(args[0])
    expect(runs.get(run.id)).toMatchObject({ worktreePath: result.worktreePath, fetchedCommit: 'abc123' })
  })

  it('finds the session branch on origin: the named one, one with a suffix, or the one new head', () => {
    const lines = ['a1\trefs/heads/claude/old', 'b2\trefs/heads/claude/add-note-ogcvln', 'b2\trefs/pull/3/head', 'c3\trefs/heads/main'].join('\n')
    expect(findResult(lines, 'claude/add-note', [])).toEqual({ branch: 'claude/add-note-ogcvln', head: 'b2', pr: 3, ambiguous: [] })
    expect(findResult(lines, 'claude/add-note-ogcvln', [])).toMatchObject({ branch: 'claude/add-note-ogcvln' })
    expect(findResult(lines, null, ['refs/heads/claude/old'])).toMatchObject({ branch: 'claude/add-note-ogcvln', pr: 3 })
    expect(findResult(lines, null, [])).toMatchObject({ branch: null, ambiguous: ['claude/old', 'claude/add-note-ogcvln'] })
    expect(findResult(lines, 'claude/add-notes', ['refs/heads/claude/old', 'refs/heads/claude/add-note-ogcvln'])).toMatchObject({ branch: null })
  })

  it('reads the session, model and branch from the debug log the real CLI writes', () => {
    const log = [
      '2026-09-25T17:03:26.012Z [DEBUG] "Creating session with payload: {\\n  \\"title\\": \\"Cloud E2E\\",\\n  \\"session_context\\": {\\n    \\"outcomes\\": [\\n      {\\n        \\"git_info\\": {\\n          \\"branches\\": [\\n            \\"claude/add-cloud-coworker-log\\"\\n          ]\\n        }\\n      }\\n    ],\\n    \\"model\\": \\"claude-opus-5-5\\"\\n  }\\n}"',
      '2026-09-25T17:03:26.776Z [DEBUG] Successfully created remote session: session_01R3e2LmvwSW9r973sJNkhoW'
    ].join('\n')
    expect(readCreateLog(log)).toEqual({ sessionId: 'session_01R3e2LmvwSW9r973sJNkhoW', model: 'claude-opus-5-5', branchHint: 'claude/add-cloud-coworker-log' })
    expect(readCreateLog('')).toEqual({ sessionId: null, model: null, branchHint: null })
  })

  it('turns a teleported conversation into entries and usage, without the teleport\'s own notes', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', timestamp: 't', message: { content: 'Do it' } }),
      JSON.stringify({ type: 'attachment', message: {} }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }, content: [{ type: 'text', text: 'Done' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a.txt' }] }] } }),
      JSON.stringify({ type: 'user', message: { content: 'This session is being continued from another machine.' } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      'not json'
    ].join('\n')
    const parsed = parseTranscript(jsonl)
    expect(parsed.entries.map(entry => [entry.role, entry.text])).toEqual([['user', 'Do it'], ['assistant', 'Done'], ['tool', 'Bash {"command":"ls"}'], ['result', 'a.txt']])
    expect(parsed.usage).toEqual({ inputTokens: 2, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 7, messages: 1 })
    expect(parsed.model).toBe('claude-opus-5-5')
  })

  it('reads runs back after a restart: a started session is followed again, an unfinished creation failed', async () => {
    const at = Date.now()
    const base = { projectId: 'p', workspaceId: 'w', title: 't', prompt: 'p', model: 'claude-opus-5-5', effort: null, ref: null, cwd: project, liveView: false, confirmedModel: null, branchHint: 'claude/x', branch: null, headCommit: null, prUrl: null, transcriptAt: null, transcriptEntries: 0, usage: null, worktreePath: null, fetchedCommit: null, startedBy: 'owner', createdAt: at, updatedAt: at, endedAt: null, exitCode: null, error: null }
    writeFileSync(join(root, 'runs.json'), JSON.stringify([
      { ...base, id: 'cloud_a', status: 'running', attached: true, sessionId: 'session_01AAAAAAAAAAAA', sessionUrl: 'https://claude.ai/code/session_01AAAAAAAAAAAA' },
      { ...base, id: 'cloud_b', status: 'starting', attached: true, sessionId: null, sessionUrl: null }
    ]))
    const origin = fakeOrigin()
    origin.state.refs = ['d4\trefs/heads/claude/x-1']
    const runs = make({ git: origin.git })
    expect(runs.get('cloud_b')).toMatchObject({ status: 'failed', attached: false, error: expect.stringMatching(/closed before/) })
    expect(runs.get('cloud_a').attached).toBe(false)
    await until(() => runs.get('cloud_a').status === 'pushed', 'the resumed watch')
    expect(runs.get('cloud_a').branch).toBe('claude/x-1')
    expect(() => runs.get('cloud_a', 'other-project')).toThrow(/No cloud run/)
    expect(JSON.parse(readFileSync(join(root, 'runs.json'), 'utf8')).length).toBe(2)
  })

  it('gives the client the owner environment without the marks of a session that launched the app', () => {
    expect(clientEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'keep', HOME: 'h' })).toEqual({ PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'keep', HOME: 'h' })
  })
})
