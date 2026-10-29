import { spawn as spawnChild } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_MODELS, isCloudModel, type CloudRunSummary } from '../../shared/cloud'
import { CloudRuns, clientEnv, cloudArgs, findResult, parseTranscript, readCreateLog, readSessionEvidence, type CloudExec, type CloudGit, type CloudPty, type CloudSpawn, type ResultSibling } from './runs'

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
  const state = { refs: [] as string[], calls: [] as string[][], inProject: [] as string[][], localBranches: [] as string[], messages: {} as Record<string, string> }
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
    if (args[0] === 'log') return state.messages[args[4]!] ?? ''
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

  it('offers the newest model of each tier, Opus by default, and still accepts ids it offered before', () => {
    expect(CLOUD_MODELS.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'])
    expect(CLOUD_MODELS.find(model => model.isDefault)?.id).toBe('claude-opus-5-5')
    for (const id of ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5']) expect(isCloudModel(id)).toBe(true)
    expect(isCloudModel('claude-haiku-4-5')).toBe(false)
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
    await expect(runs.fetch(run.id)).rejects.toThrow(/not pushed claude\/fixture-note \(or it with a suffix\) yet/)
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
    expect(findResult(lines, 'claude/add-note', [])).toEqual({ branch: 'claude/add-note-ogcvln', head: 'b2', pr: 3, ambiguous: [], verify: [] })
    expect(findResult(lines, 'claude/add-note-ogcvln', [])).toMatchObject({ branch: 'claude/add-note-ogcvln' })
    expect(findResult(lines, null, ['refs/heads/claude/old'])).toMatchObject({ branch: 'claude/add-note-ogcvln', pr: 3 })
    expect(findResult(lines, null, [])).toMatchObject({ branch: null, ambiguous: ['claude/old', 'claude/add-note-ogcvln'] })
    expect(findResult(lines, 'claude/add-notes', ['refs/heads/claude/old', 'refs/heads/claude/add-note-ogcvln'])).toMatchObject({ branch: null })
  })

  describe('branch correlation between concurrent runs', () => {
    const audit = 'claude/t3code-cloud-runtime-audit', timing = 'claude/t3code-tool-timing-analysis', threads = 'claude/t3code-thread-separation'
    const known = [{ ref: 'refs/heads/claude/older', sha: 'o1' }]
    const sibling = (hint: string | null, extra: Partial<ResultSibling> = {}): ResultSibling => ({ hint, known, settled: false, ...extra })

    it('gives the one pushed branch only to the run it was hinted for, then each run its own', () => {
      // The owner's case: three runs started together; the audit pushed first.
      let lines = ['o1\trefs/heads/claude/older', `a1\trefs/heads/${audit}-y4xpuw110fa4b`, 'a1\trefs/pull/41/head'].join('\n')
      expect(findResult(lines, audit, known, { siblings: [sibling(timing), sibling(threads)] })).toMatchObject({ branch: `${audit}-y4xpuw110fa4b`, head: 'a1', pr: 41 })
      for (const [hint, others] of [[timing, [audit, threads]], [threads, [audit, timing]]] as const) {
        expect(findResult(lines, hint, known, { siblings: others.map(other => sibling(other)) })).toEqual({ branch: null, head: null, pr: null, ambiguous: [], verify: [] })
        // Even with no other run in sight, a hinted run never takes an unrelated single new head.
        expect(findResult(lines, hint, known)).toMatchObject({ branch: null, ambiguous: [] })
      }
      // The timing analysis pushes later and gets its own branch; the thread run still waits.
      lines += `\nt2\trefs/heads/${timing}-3aqudf`
      expect(findResult(lines, timing, known, { siblings: [sibling(audit), sibling(threads)] })).toMatchObject({ branch: `${timing}-3aqudf`, head: 't2', pr: null })
      expect(findResult(lines, audit, known, { siblings: [sibling(timing), sibling(threads)] })).toMatchObject({ branch: `${audit}-y4xpuw110fa4b` })
      expect(findResult(lines, threads, known, { siblings: [sibling(audit), sibling(timing)] })).toMatchObject({ branch: null, ambiguous: [] })
    })

    it('keeps the single-new-head fallback for a run without a hint only when no concurrent run could own it', () => {
      const lines = ['o1\trefs/heads/claude/older', `a1\trefs/heads/${audit}-y4xpuw110fa4b`].join('\n')
      const head = { branch: `${audit}-y4xpuw110fa4b`, sha: 'a1' }
      // Sequential, as before: nothing else ran, so the one new head is this run's (and is checked).
      expect(findResult(lines, null, known)).toMatchObject({ branch: head.branch, verify: [head] })
      // A run that started after the push saw it already; it does not contest it.
      expect(findResult(lines, null, known, { siblings: [sibling(null, { known: [...known, { ref: `refs/heads/${head.branch}`, sha: 'a1' }] })] })).toMatchObject({ branch: head.branch })
      // A branch another run's hint names is that run's, not the fallback's.
      expect(findResult(lines, null, known, { siblings: [sibling(audit)] })).toMatchObject({ branch: null, ambiguous: [] })
      // Two hintless runs in flight: the head could be either's; neither claims it until its commits say.
      const contested = findResult(lines, null, known, { siblings: [sibling(null)] })
      expect(contested).toEqual({ branch: null, head: null, pr: null, ambiguous: [head.branch], verify: [head] })
      expect(findResult(lines, null, known, { siblings: [sibling(null)], evidence: { [`${head.branch}@a1`]: 'ours' } })).toMatchObject({ branch: head.branch, verify: [] })
      expect(findResult(lines, null, known, { siblings: [sibling(null)], evidence: { [`${head.branch}@a1`]: 'other' } })).toMatchObject({ branch: null, ambiguous: [] })
      // A foreign push (another session signed it) is not taken even when sequential.
      expect(findResult(lines, null, known, { evidence: { [`${head.branch}@a1`]: 'other' } })).toMatchObject({ branch: null })
      // Which heads existed at the start is unknown: no head counts as new.
      expect(findResult(lines, null, null)).toMatchObject({ branch: null, ambiguous: [], verify: [] })
    })

    it('ignores stale refs of an earlier run with the same task, and longer task names that only share the prefix', () => {
      const lines = ['s1\trefs/heads/claude/fix-old111', 'x1\trefs/heads/claude/fix-tests-x1', 'e1\trefs/heads/claude/fix'].join('\n')
      // fix-old111 and fix were on origin, untouched, when the run started; fix-tests-x1 is another task.
      const before = [{ ref: 'refs/heads/claude/fix-old111', sha: 's1' }, { ref: 'refs/heads/claude/fix', sha: 'e1' }]
      expect(findResult(lines, 'claude/fix', before)).toMatchObject({ branch: null, ambiguous: [] })
      // The session pushed onto the existing name: its sha moved, so that is this run's.
      expect(findResult(lines.replace('e1\t', 'e2\t'), 'claude/fix', before)).toMatchObject({ branch: 'claude/fix', head: 'e2' })
      // A store from before shas were kept still accepts the exact name, but not a stale suffixed one.
      expect(findResult(lines, 'claude/fix', ['refs/heads/claude/fix-old111', 'refs/heads/claude/fix'])).toMatchObject({ branch: 'claude/fix' })
      expect(findResult(lines.replace('e1\trefs/heads/claude/fix', ''), 'claude/fix', ['refs/heads/claude/fix-old111'])).toMatchObject({ branch: null })
    })

    it('does not guess between several branches that fit the hint; session evidence or an exact hint settles it', () => {
      const lines = ['a1\trefs/heads/claude/fix-aaa111', 'b1\trefs/heads/claude/fix-bbb222'].join('\n')
      const both = findResult(lines, 'claude/fix', [])
      expect(both).toMatchObject({ branch: null, ambiguous: ['claude/fix-aaa111', 'claude/fix-bbb222'] })
      expect(both.verify).toEqual([{ branch: 'claude/fix-aaa111', sha: 'a1' }, { branch: 'claude/fix-bbb222', sha: 'b1' }])
      expect(findResult(lines, 'claude/fix', [], { evidence: { 'claude/fix-aaa111@a1': 'none', 'claude/fix-bbb222@b1': 'ours' } })).toMatchObject({ branch: 'claude/fix-bbb222' })
      expect(findResult(lines, 'claude/fix', [], { evidence: { 'claude/fix-aaa111@a1': 'other', 'claude/fix-bbb222@b1': 'none' } })).toMatchObject({ branch: 'claude/fix-bbb222' })
      // Two runs told the same name: one push fits both, so neither takes it on the name alone.
      const one = 'a1\trefs/heads/claude/fix-aaa111'
      expect(findResult(one, 'claude/fix', [], { siblings: [sibling('claude/fix', { known: [] })] })).toMatchObject({ branch: null, ambiguous: ['claude/fix-aaa111'], verify: [{ branch: 'claude/fix-aaa111', sha: 'a1' }] })
      // A run told the longer name exactly owns it over one whose shorter hint it only extends.
      const exact = 'c1\trefs/heads/claude/fix-tests'
      expect(findResult(exact, 'claude/fix', [], { siblings: [sibling('claude/fix-tests', { known: [] })] })).toMatchObject({ branch: null, ambiguous: [] })
      expect(findResult(exact, 'claude/fix-tests', [], { siblings: [sibling('claude/fix', { known: [] })] })).toMatchObject({ branch: 'claude/fix-tests' })
    })

    it('reads which session signed the commits on a branch', () => {
      const sign = (session: string): string => `Fix it\n\nClaude-Session: https://claude.ai/code/${session}\n`
      expect(readSessionEvidence(`${sign('session_01AUDIT')}\x1e`, 'session_01AUDIT')).toBe('ours')
      expect(readSessionEvidence(`${sign('session_01TIMING')}\x1e`, 'session_01AUDIT')).toBe('other')
      // An unsigned head over another session's commit: that may be the base, so it decides nothing.
      expect(readSessionEvidence(`Merge\x1e${sign('session_01TIMING')}\x1e`, 'session_01AUDIT')).toBe('none')
      expect(readSessionEvidence(`Merge\x1e${sign('session_01AUDIT')}\x1e${sign('session_01TIMING')}\x1e`, 'session_01AUDIT')).toBe('ours')
      expect(readSessionEvidence('', 'session_01AUDIT')).toBe('none')
      // A longer id that merely starts with this one is another session.
      expect(readSessionEvidence(`${sign('session_01AUDITX')}\x1e`, 'session_01AUDIT')).toBe('other')
    })

    /** A CLI that creates a session per prompt with the branch hint the test names, and refuses attaching. */
    const scriptedCli = (hints: Record<string, string | null>): CloudSpawn => (_file, args) => {
      let exit: (event: { exitCode: number }) => void = () => undefined
      let data: (chunk: string) => void = () => undefined
      setTimeout(() => {
        const debugFile = args[args.indexOf('--debug-file') + 1]
        if (args[0] === '--cloud' && args[1]! in hints && debugFile) {
          const hint = hints[args[1]!]
          const payload = hint ? `Creating session with payload: {"session_context":{"outcomes":[{"git_info":{"branches":["${hint}"]}}],"model":"claude-opus-5-5"}}\n` : ''
          writeFileSync(debugFile, `${payload}Successfully created remote session: session_01${args[1]!.toUpperCase()}\n`)
          exit({ exitCode: 0 })
        } else if (args[0] === '--cloud') { data('Attaching to an existing cloud session is not enabled for your account\r\n'); exit({ exitCode: 1 }) }
        else exit({ exitCode: 1 })
      }, 20)
      return { onData: listener => { data = listener }, onExit: listener => { exit = listener }, write: () => undefined, resize: () => undefined, kill: () => undefined }
    }
    const settle = (ms = 400): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

    it('follows three simultaneous runs: each gets its own branch when it pushes, none takes another\'s', async () => {
      const origin = fakeOrigin()
      origin.state.refs = ['o1\trefs/heads/claude/older']
      const runs = make({ git: origin.git, prefixArgs: [], spawn: scriptedCli({ audit, timing, threads }) })
      const [a, t, h] = ['audit', 'timing', 'threads'].map(prompt => start(runs, { prompt }))
      await until(() => [a, t, h].every(run => runs.get(run!.id).status === 'running' && runs.get(run!.id).branchHint !== null), 'three sessions')
      origin.state.refs.push(`a1\trefs/heads/${audit}-y4xpuw110fa4b`, 'a1\trefs/pull/41/head')
      await until(() => runs.get(a!.id).status === 'pushed', 'the audit push')
      await settle()
      expect(runs.get(a!.id)).toMatchObject({ branch: `${audit}-y4xpuw110fa4b`, headCommit: 'a1', prUrl: 'https://github.com/Empire024/conductor/pull/41' })
      for (const run of [t!, h!]) expect(runs.get(run.id)).toMatchObject({ status: 'running', branch: null, headCommit: null, prUrl: null })
      await expect(runs.fetch(t!.id)).rejects.toThrow(new RegExp(`not pushed ${timing} \\(or it with a suffix\\) yet`))
      // The timing analysis pushes later: it gets its own branch, the audit keeps its.
      origin.state.refs.push(`t2\trefs/heads/${timing}-3aqudf`)
      await until(() => runs.get(t!.id).status === 'pushed', 'the timing push')
      await settle()
      expect(runs.get(t!.id)).toMatchObject({ branch: `${timing}-3aqudf`, headCommit: 't2', prUrl: null })
      expect(runs.get(a!.id).branch).toBe(`${audit}-y4xpuw110fa4b`)
      expect(runs.get(h!.id)).toMatchObject({ status: 'running', branch: null })
    })

    it('lets two hintless runs claim the one new head only by the session that signed it', async () => {
      const origin = fakeOrigin()
      const runs = make({ git: origin.git, prefixArgs: [], spawn: scriptedCli({ first: null, second: null }) })
      const [one, two] = ['first', 'second'].map(prompt => start(runs, { prompt }))
      await until(() => [one, two].every(run => runs.get(run!.id).status === 'running'), 'two sessions')
      origin.state.refs = ['n1\trefs/heads/claude/new-work-abc123']
      await settle()
      for (const run of [one!, two!]) expect(runs.get(run.id)).toMatchObject({ status: 'running', branch: null })
      await expect(runs.fetch(one!.id)).rejects.toThrow(/cannot be told apart.*claude\/new-work-abc123/)
      // Evidence is fetched without a destination: no ref of the project moves.
      expect(origin.state.calls).toContainEqual(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', 'refs/heads/claude/new-work-abc123'])
      // The next commit is signed by the second session: it is that run's, and only that run's.
      origin.state.refs = ['n2\trefs/heads/claude/new-work-abc123']
      origin.state.messages.n2 = `Work\n\nClaude-Session: https://claude.ai/code/${runs.get(two!.id).sessionId}\x1e`
      await until(() => runs.get(two!.id).status === 'pushed', 'the signed push')
      await settle()
      expect(runs.get(two!.id)).toMatchObject({ branch: 'claude/new-work-abc123', headCommit: 'n2' })
      expect(runs.get(one!.id)).toMatchObject({ status: 'running', branch: null })
    })

    it('retracts associations the old fallback cached, and keeps a correct branch that was merged and deleted', async () => {
      const at = Date.now()
      const base = { projectId: 'p', workspaceId: 'w', title: 't', prompt: 'p', model: 'claude-opus-5-5', effort: null, ref: null, cwd: project, attached: false, liveView: false, confirmedModel: null, transcriptAt: null, transcriptEntries: 0, usage: null, startedBy: 'owner', createdAt: at, updatedAt: at, endedAt: null, exitCode: null, error: null }
      // What the old fallback left behind: all three runs on the audit's branch and pull request.
      const wrong = { status: 'pushed', branch: `${audit}-y4xpuw110fa4b`, headCommit: 'a1', prUrl: 'https://github.com/Empire024/conductor/pull/41', worktreePath: join(root, 'worktrees', 'x'), fetchedCommit: 'a1' }
      writeFileSync(join(root, 'runs.json'), JSON.stringify([
        { ...base, ...wrong, id: 'cloud_audit', branchHint: audit, sessionId: 'session_01AUDIT', sessionUrl: 'https://claude.ai/code/session_01AUDIT' },
        { ...base, ...wrong, id: 'cloud_timing', branchHint: timing, sessionId: 'session_01TIMING', sessionUrl: 'https://claude.ai/code/session_01TIMING' },
        { ...base, ...wrong, id: 'cloud_threads', branchHint: threads, sessionId: 'session_01THREADS', sessionUrl: 'https://claude.ai/code/session_01THREADS' },
        { ...base, ...wrong, id: 'cloud_merged', branchHint: 'claude/merged-work', branch: 'claude/merged-work-zz9', headCommit: 'm1', prUrl: 'https://github.com/Empire024/conductor/pull/9', sessionId: 'session_01MERGED', sessionUrl: 'https://claude.ai/code/session_01MERGED', cwd: join(project, 'elsewhere') }
      ]))
      const origin = fakeOrigin()
      origin.state.refs = [`a1\trefs/heads/${audit}-y4xpuw110fa4b`, 'a1\trefs/pull/41/head', `t2\trefs/heads/${timing}-3aqudf`]
      const runs = make({ git: origin.git })
      await until(() => runs.get('cloud_timing').branch === `${timing}-3aqudf` && runs.get('cloud_threads').status === 'running', 'the corrections')
      expect(runs.get('cloud_audit')).toMatchObject({ status: 'pushed', branch: `${audit}-y4xpuw110fa4b`, prUrl: 'https://github.com/Empire024/conductor/pull/41', fetchedCommit: 'a1' })
      // The timing run moves to its own branch, without the audit's pull request or fetched worktree.
      expect(runs.get('cloud_timing')).toMatchObject({ status: 'pushed', headCommit: 't2', prUrl: null, worktreePath: null, fetchedCommit: null })
      // The thread run has pushed nothing: it is running again, with nothing claimed.
      expect(runs.get('cloud_threads')).toMatchObject({ status: 'running', branch: null, headCommit: null, prUrl: null, worktreePath: null, fetchedCommit: null })
      // A branch that fits its own hint and left origin (merged, deleted) stays the run's result.
      expect(runs.get('cloud_merged')).toMatchObject({ status: 'pushed', branch: 'claude/merged-work-zz9', prUrl: 'https://github.com/Empire024/conductor/pull/9' })
    })
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
