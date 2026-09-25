import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCompletionCriteria, unmetCriteria } from './completion-check'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'completion-check-')); dirs.push(d); return d }

describe('checkCompletionCriteria', () => {
  it('fails a line-count criterion when the file was never created (RV1 D5)', async () => {
    const cwd = dir()
    const checks = await checkCompletionCriteria(cwd, ['LOG.md has 100000 lines'])
    expect(checks).toEqual([{ criterion: 'LOG.md has 100000 lines', checked: true, met: false, detail: 'LOG.md does not exist (need at least 100000 line(s))' }])
    expect(unmetCriteria(checks)).toHaveLength(1)
  })

  it('passes a line-count criterion once the file has enough lines', async () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'INDEX.md'), Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const checks = await checkCompletionCriteria(cwd, ['INDEX.md has 150 lines', 'INDEX.md has at least 100 lines'])
    expect(checks.every(check => check.met)).toBe(true)
    expect(unmetCriteria(checks)).toHaveLength(0)
  })

  it('requires an exact count only when the criterion says "exactly"', async () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'a.txt'), 'x\ny\nz\n')
    const loose = await checkCompletionCriteria(cwd, ['a.txt has 2 lines'])
    expect(loose[0]).toMatchObject({ met: true }) // 3 >= 2
    const exact = await checkCompletionCriteria(cwd, ['a.txt has exactly 2 lines'])
    expect(exact[0]).toMatchObject({ met: false }) // 3 !== 2
  })

  it('checks plain existence', async () => {
    const cwd = dir()
    const before = await checkCompletionCriteria(cwd, ['report.json exists'])
    expect(before[0]).toMatchObject({ checked: true, met: false })
    writeFileSync(join(cwd, 'report.json'), '{}')
    const after = await checkCompletionCriteria(cwd, ['report.json exists'])
    expect(after[0]).toMatchObject({ checked: true, met: true })
  })

  it('leaves an unparseable criterion unchecked rather than blocking on it', async () => {
    const cwd = dir()
    const checks = await checkCompletionCriteria(cwd, ['the fix passes code review'])
    expect(checks).toEqual([{ criterion: 'the fix passes code review', checked: false, met: true, detail: 'not a mechanically checkable criterion' }])
    expect(unmetCriteria(checks)).toHaveLength(0)
  })
})
