import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalUpdateBuilder } from './local-update-build'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); vi.unstubAllEnvs() })

const checkout = (name: string, manifest: Record<string, unknown>, complete = true): string => {
  const root = mkdtempSync(join(tmpdir(), name))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest), 'utf8')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'build-local-update.mjs'), '// fixture\n', 'utf8')
  if (complete) { mkdirSync(join(root, 'node_modules', 'electron-builder'), { recursive: true }); writeFileSync(join(root, 'node_modules', 'electron-builder', 'cli.js'), '// fixture\n', 'utf8') }
  return root
}

describe('local update builds', () => {
  it('refuses any workspace that is not an installable Conductor checkout', () => {
    const builder = new LocalUpdateBuilder()
    const empty = mkdtempSync(join(tmpdir(), 'local-update-empty-'))
    roots.push(empty)
    expect(builder.unsupported(empty)).toMatch(process.platform === 'win32' ? /build-local-update\.mjs/ : /Windows/)
    if (process.platform !== 'win32') return // The remaining guards are only reachable where builds run.
    expect(builder.unsupported(checkout('local-update-foreign-', { name: 'some-other-app' }))).toMatch(/not the Conductor desktop app/)
    expect(builder.unsupported(checkout('local-update-bare-', { name: 'conductor-desktop' }, false))).toMatch(/electron-builder is not installed/)
    expect(builder.unsupported(checkout('local-update-ready-', { name: 'conductor-desktop' }))).toBeNull()
    // A refused workspace never reaches the point of spawning anything.
    expect(() => builder.start(empty)).toThrow()
    expect(builder.status().state).toBe('idle')
  })
  it("publishes a test instance’s build into the test profile’s feed, never the installed app’s", async () => {
    if (process.platform !== 'win32') return
    const root = checkout('local-update-feed-', { name: 'conductor-desktop' })
    writeFileSync(join(root, 'scripts', 'build-local-update.mjs'), "const at = process.argv.indexOf('--feed-dir'); console.log('Local update ready: 0.1.1-local.1'); console.log('Feed: ' + (at > 0 ? process.argv[at + 1] : 'owner feed'))\n", 'utf8')
    const feed = join(root, 'profile', 'local-updates')
    const builder = new LocalUpdateBuilder({ feedDirectory: () => feed })
    builder.start(root)
    await vi.waitFor(() => expect(builder.status().state).toBe('succeeded'), { timeout: 20_000 })
    expect(builder.status().feedDirectory).toBe(feed)
  })
  // app.update({commit, smoke}): an exact commit in its own clean worktree, then its smokes.
  const repository = (): { root: string; candidates: string; feed: string; git: (...args: string[]) => string } => {
    // By its long name: git names worktrees that way, and the hosted runner's temp folder arrives as
    // C:UsersRUNNER~1, so a short-named expectation would never equal the path the build reports.
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'local-update-candidate-')))
    roots.push(base)
    const root = join(base, 'conductor'), candidates = join(base, 'candidates'), feed = join(base, 'feed')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'conductor-desktop', scripts: { test: 'node scripts/full-suite.mjs' } }), 'utf8')
    writeFileSync(join(root, 'scripts', 'full-suite.mjs'), "console.log('FULL BATCH SUITE PASSED')\n", 'utf8')
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.conductor-scratch/\n', 'utf8')
    // The fixture build records what the real one does: the commit it was built from and whether the tree was dirty.
    writeFileSync(join(root, 'scripts', 'build-local-update.mjs'), [
      "import { execFileSync } from 'node:child_process'", "import { mkdirSync, writeFileSync } from 'node:fs'",
      "const feed = process.argv[process.argv.indexOf('--feed-dir') + 1]",
      "const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()",
      'mkdirSync(feed, { recursive: true })',
      "writeFileSync(feed + '/conductor-local-build.json', JSON.stringify({ version: '0.1.1-local.7', commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) }))",
      "console.log('Local update ready: 0.1.1-local.7'); console.log('Feed: ' + feed)"
    ].join('\n'), 'utf8')
    writeFileSync(join(root, 'scripts', 'smoke-lock.mjs'), "import { spawnSync } from 'node:child_process'\nconst at = process.argv.indexOf('--')\nconst [command, ...rest] = process.argv.slice(at + 1)\nprocess.exit(spawnSync(command, rest, { stdio: 'inherit' }).status ?? 1)\n", 'utf8')
    writeFileSync(join(root, 'scripts', 'smoke-ok.mjs'), "console.log('checks 3/3 passed')\n", 'utf8')
    writeFileSync(join(root, 'scripts', 'smoke-background-windows.mjs'), "console.log('PARKED WINDOW GUARD PASSED')\n", 'utf8')
    writeFileSync(join(root, 'scripts', 'smoke-bad.mjs'), "for (let i = 0; i < 30; i++) console.log('line ' + i)\nconsole.error('FAIL: the grant card never appeared')\nprocess.exit(1)\n", 'utf8')
    mkdirSync(join(root, 'node_modules', 'electron-builder'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'electron-builder', 'cli.js'), '// fixture\n', 'utf8')
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture'); git('config', 'core.autocrlf', 'false')
    git('add', '.'); git('commit', '-q', '-m', 'fixture')
    return { root, candidates, feed, git }
  }

  it('builds an exact commit in a clean worktree with a real node_modules, runs its smokes, and marks a failed smoke not verified', async () => {
    if (process.platform !== 'win32') return
    const { root, candidates, feed, git } = repository()
    const head = git('rev-parse', 'HEAD')
    // Another agent's unfinished edit in the checkout must not reach the build.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'conductor-desktop', edited: true }), 'utf8')
    const builder = new LocalUpdateBuilder({ feedDirectory: () => feed, candidatesDirectory: () => candidates })
    expect(builder.start(root, { commit: 'HEAD', smoke: ['smoke-ok', 'scripts/smoke-bad.mjs'] })).toMatchObject({ state: 'running', commit: head, stage: 'worktree', verified: false })
    await vi.waitFor(() => expect(builder.status().state).not.toBe('running'), { timeout: 60_000, interval: 200 })
    const status = builder.status()
    const worktree = join(candidates, head.slice(0, 7))
    expect(status).toMatchObject({ state: 'succeeded', commit: head, worktree, stage: 'done', version: '0.1.1-local.7', verified: false })
    expect(status.message).toMatch(/NOT verified: smoke-bad failed/)
    expect(() => builder.offer('wizard', true)).toThrow(/not passed verification/)
    expect(status.smokes.map(smoke => [smoke.name, smoke.state, smoke.exitCode])).toEqual([['smoke-background-windows', 'passed', 0], ['smoke-ok', 'passed', 0], ['smoke-bad', 'failed', 1]])
    expect(status.smokes[2]!.tail!.at(-1)).toBe('FAIL: the grant card never appeared')
    expect(status.smokes[2]!.tail!.length).toBeLessThanOrEqual(20)
    expect(readFileSync(status.verificationLog!, 'utf8')).toContain('FULL BATCH SUITE PASSED')
    expect(existsSync(status.smokes[0]!.log!)).toBe(true)
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(worktree, 'node_modules', 'electron-builder', 'cli.js'))).toBe(true)

    // A second build of the same commit reuses that worktree; all smokes passing verifies it.
    builder.start(root, { commit: head, smoke: ['smoke-ok'], builder: 'test-builder' })
    await vi.waitFor(() => expect(builder.status().state).not.toBe('running'), { timeout: 60_000, interval: 200 })
    expect(builder.status()).toMatchObject({ state: 'succeeded', worktree, verified: true, stage: 'done' })
    expect(builder.status().log.join('\n')).toMatch(/Reusing the clean worktree/)
    expect(() => builder.offer('other-agent', false)).toThrow(/Only the builder or a wizard/)
    expect(builder.offer('test-builder', false).verified).toBe(true)
    expect(builder.offer('wizard', true).verified).toBe(true)
  }, 150_000)

  it('refuses a candidate it cannot build faithfully before building anything', async () => {
    if (process.platform !== 'win32') return
    const { root, candidates, feed, git } = repository()
    const builder = new LocalUpdateBuilder({ feedDirectory: () => feed, candidatesDirectory: () => candidates })
    expect(() => builder.validate(root, { smoke: ['smoke-ok'] })).toThrow(/smoke needs commit/)
    expect(() => builder.validate(root, { commit: 'no-such-ref' })).toThrow(/No commit no-such-ref/)
    expect(() => builder.validate(root, { commit: '--upload-pack=x' })).toThrow(/must be a sha or ref/)
    expect(() => builder.validate(root, { commit: 'HEAD', smoke: ['node -e 1'] })).toThrow(/scripts\/smoke-\*\.mjs/)
    expect(() => builder.validate(root, { commit: 'HEAD', smoke: ['smoke-lock'] })).toThrow(/scripts\/smoke-\*\.mjs/)
    expect(() => builder.validate(root, { commit: 'HEAD', smoke: ['smoke-missing'] })).toThrow(/has no scripts\/smoke-missing\.mjs/)
    expect(builder.validate(root, {})).toBeUndefined()
    const head = git('rev-parse', 'HEAD'), worktree = join(candidates, head.slice(0, 7))
    git('worktree', 'add', '--detach', worktree, head)
    writeFileSync(join(worktree, 'package.json'), '{}', 'utf8')
    expect(() => builder.start(root, { commit: head })).toThrow(/uncommitted changes/)
    execFileSync('git', ['checkout', '--', 'package.json'], { cwd: worktree, windowsHide: true })
    mkdirSync(join(worktree, 'node_modules'))
    symlinkSync(join(root, 'node_modules', 'electron-builder'), join(worktree, 'node_modules', 'electron-builder'), 'junction')
    expect(() => builder.start(root, { commit: head })).toThrow(/junction in node_modules \(node_modules\/electron-builder\)/)
    expect(builder.status().state).toBe('idle')
  })
  it('blocks a failed batch before packaging and names the commit and builder to contact', async () => {
    if (process.platform !== 'win32') return
    const { root, candidates, feed, git } = repository()
    writeFileSync(join(root, 'scripts', 'full-suite.mjs'), "console.error('FAIL batch regression'); process.exit(1)\n", 'utf8')
    git('add', '.'); git('commit', '-q', '-m', 'failing batch')
    const head = git('rev-parse', 'HEAD')
    const builder = new LocalUpdateBuilder({ feedDirectory: () => feed, candidatesDirectory: () => candidates })
    builder.start(root, { commit: head, builder: 'agent-to-contact' })
    await vi.waitFor(() => expect(builder.status().state).toBe('failed'), { timeout: 60000, interval: 200 })
    expect(builder.status()).toMatchObject({ verified: false, stage: 'test', message: expect.stringContaining('agent-to-contact') })
    expect(builder.status().message).toContain(head.slice(0, 10))
    expect(readFileSync(builder.status().verificationLog!, 'utf8')).toContain('FAIL batch regression')
    expect(existsSync(join(feed, 'conductor-local-build.json'))).toBe(false)
  })
})
