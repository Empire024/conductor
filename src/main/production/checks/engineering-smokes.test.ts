import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createEvidenceSink } from '../evidence'
import { defaultCommandRunner } from '../index'
import { runEngineeringSmoke } from './engineering-smokes'

const scratch = mkdtempSync(join(tmpdir(), 'prod-smoke-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const evidence = createEvidenceSink(join(scratch, 'artifacts'), [])
const signal = new AbortController().signal

describe('engineering smoke step', { timeout: 20_000 }, () => {
  it('does nothing without a smoke command, and says so when no runner is wired', async () => {
    expect(await runEngineeringSmoke(null, defaultCommandRunner, { cwd: null, evidence, signal })).toBeNull()
    expect(await runEngineeringSmoke('npm run smoke', null, { cwd: null, evidence, signal })).toMatchObject({ status: 'skipped', detail: 'no command runner is wired for this run' })
  })

  it('runs the project command, keeps its log as evidence and reports the exit code', async () => {
    const passed = await runEngineeringSmoke(`"${process.execPath}" -e "console.log('smoke ok')"`, defaultCommandRunner, { cwd: scratch, evidence, signal })
    expect(passed).toMatchObject({ status: 'passed', exitCode: 0, detail: 'smoke ok' })
    expect(passed!.evidence).toHaveLength(1)
    const failed = await runEngineeringSmoke(`"${process.execPath}" -e "console.error('checkout broken'); process.exit(3)"`, defaultCommandRunner, { cwd: scratch, evidence, signal })
    expect(failed).toMatchObject({ status: 'failed', exitCode: 3, detail: 'checkout broken' })
    const slow = await runEngineeringSmoke(`"${process.execPath}" -e "setTimeout(() => {}, 10000)"`, defaultCommandRunner, { cwd: scratch, evidence, signal, timeoutMs: 300 })
    expect(slow).toMatchObject({ status: 'error', detail: 'timed out' })
  })
})
