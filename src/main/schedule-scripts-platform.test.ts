import { describe, expect, it } from 'vitest'
import { scheduleScriptLanguages, type ScheduleScript } from '../shared/schedules'
import { ScheduleScriptRunner } from './schedule-scripts'

describe('schedule script languages by platform', () => {
  it('offers PowerShell only on Windows', () => {
    expect(scheduleScriptLanguages('win32')).toEqual(['node', 'powershell'])
    expect(scheduleScriptLanguages('darwin')).toEqual(['node'])
    expect(scheduleScriptLanguages('linux')).toEqual(['node'])
  })

  it.runIf(process.platform !== 'win32')('refuses to run a PowerShell script off Windows without starting anything', async () => {
    let started = 0
    const runner = new ScheduleScriptRunner({ node: () => { started++; return { command: process.execPath, args: [] } }, powershell: () => { started++; return { command: 'powershell.exe', args: [] } } })
    const script = { name: 'check', language: 'powershell', content: 'Write-Output ok' } as ScheduleScript
    const output = await runner.run({ script, file: '/nonexistent/check.ps1', cwd: process.cwd(), env: {}, signal: new AbortController().signal })
    expect(output).toMatchObject({ exitCode: null, error: expect.stringMatching(/only on Windows/) })
    expect(started).toBe(0)
  })
})
