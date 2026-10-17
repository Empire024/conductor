import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANGE_QUIET_WINDOW_MS, QuietWindow, coveredFilesOf, filterCommitPaths, isCoveredChange } from './change-filter'

describe('commit path filter', () => {
  const covered = coveredFilesOf({ stack: { infrastructureFiles: ['.htaccess', 'config/nginx.conf'], emailTemplates: ['emails/welcome.md'] } as never })

  it('ignores docs, scratch files, tests and repository metadata', () => {
    for (const path of [
      'docs/production-agent.md', 'README.md', 'notes/plan.mdx', '.conductor-scratch/run.log', 'src/cart.test.ts', 'src/cart.spec.js',
      'tests/e2e/checkout.php', 'src/__tests__/cart.ts', 'test/fixtures/a.json', 'CHANGELOG', 'LICENSE.txt', '.github/workflows/ci.yml', '.gitignore', 'Docs\\guide.html',
    ]) expect(isCoveredChange(path, covered), path).toBe(false)
  })

  it('counts source files and every file a fingerprint hash reads, even a .md or .txt one', () => {
    for (const path of ['wp-content/themes/haf/functions.php', 'src/index.ts', 'package-lock.json', 'requirements.txt', '.htaccess', 'config/nginx.conf', 'emails/welcome.md', './composer.lock'])
      expect(isCoveredChange(path, covered), path).toBe(true)
  })

  it('a commit range triggers only when one of its files is covered', () => {
    expect(filterCommitPaths(['docs/a.md', '.conductor-scratch/x.json', 'src/a.test.ts'], covered)).toEqual({ triggers: false, covered: [], ignored: ['docs/a.md', '.conductor-scratch/x.json', 'src/a.test.ts'] })
    expect(filterCommitPaths(['docs/a.md', 'package-lock.json'], covered)).toMatchObject({ triggers: true, covered: ['package-lock.json'] })
    expect(filterCommitPaths([], covered).triggers).toBe(false)
  })
})

describe('quiet window', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('a burst of changes fires once, a quiet window after the last one', () => {
    const window = new QuietWindow(CHANGE_QUIET_WINDOW_MS, 3 * CHANGE_QUIET_WINDOW_MS, () => Date.now())
    const fire = vi.fn()
    window.touch('p', fire)
    vi.advanceTimersByTime(4 * 60_000)
    window.touch('p', fire)
    vi.advanceTimersByTime(4 * 60_000)
    window.touch('p', fire)
    vi.advanceTimersByTime(CHANGE_QUIET_WINDOW_MS - 1)
    expect(fire).not.toHaveBeenCalled()
    expect(window.isPending('p')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(window.isPending('p')).toBe(false)
  })

  it('a steady stream still fires by the maximum wait, and keys are independent', () => {
    const window = new QuietWindow(10_000, 30_000, () => Date.now())
    const a = vi.fn(), b = vi.fn()
    for (let i = 0; i < 6; i++) { window.touch('a', a); vi.advanceTimersByTime(5_000) }
    expect(a).toHaveBeenCalledTimes(1)
    window.touch('b', b)
    window.cancel('b')
    vi.advanceTimersByTime(60_000)
    expect(b).not.toHaveBeenCalled()
    window.touch('b', b)
    window.clear()
    vi.advanceTimersByTime(60_000)
    expect(b).not.toHaveBeenCalled()
  })
})
