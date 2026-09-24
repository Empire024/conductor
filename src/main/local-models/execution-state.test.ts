import { describe, expect, it } from 'vitest'
import { newExecutionState, observeExecution, recoveryHint } from './execution-state.ts'

describe('execution state recovery', () => {
  it('tells the model a missing path is missing instead of inviting another tool', () => {
    const hint = recoveryHint('apply_edits', `error: ENOENT: no such file or directory, open 'C:\\ws\\file.txt'`)
    expect(hint).toMatch(/^The path does not exist\. Do not try it with another tool/)
    expect(recoveryHint('read_file', 'File does not exist: notes.md')).toMatch(/path does not exist/)
    // Anchor mismatches keep their own, more specific hint.
    expect(recoveryHint('edit_file', 'old_text was not found in src/a.ts')).toMatch(/Read the current script/)
    expect(recoveryHint('run_command', 'exit code: 1')).toMatch(/Change the failed run_command approach/)
  })

  it('counts equivalent failures on the same source across tools', () => {
    const state = newExecutionState('t', 'paste your prompt')
    const path = '/workspace/file.txt'
    observeExecution(state, { id: '1', name: 'apply_edits', arguments: JSON.stringify({ path }) }, `error: ENOENT: no such file or directory, open 'C:\\ws\\file.txt'`, true)
    observeExecution(state, { id: '2', name: 'edit_file', arguments: JSON.stringify({ path }) }, `error: ENOENT: no such file or directory, open 'C:\\ws\\file.txt'`, true)
    observeExecution(state, { id: '3', name: 'read_file', arguments: JSON.stringify({ path }) }, `error: ENOENT: no such file or directory, realpath 'C:\\ws\\file.txt'`, true)
    expect(state.failures.map(failure => failure.across)).toEqual([3, 3, 3])
    expect(state.nextAction).toMatch(/path does not exist/)
  })
})
