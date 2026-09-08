import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClaudeTaskOutput } from './claude-task-output'
it('captures a bounded background output tail and refuses files belonging to another task/session', async () => {
  const base = join(tmpdir(), 'claude'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'conductor-output-test-'))
  try {
    const directory = join(root, 'session-1', 'tasks'); await mkdir(directory, { recursive: true })
    const path = join(directory, 'task-1.output'); await writeFile(path, 'x'.repeat(40000) + ' finished')
    const result = await readClaudeTaskOutput(path, 'task-1', 'session-1')
    expect(result.output).toHaveLength(32000); expect(result.output?.endsWith(' finished')).toBe(true); expect(result.outputTruncated).toBe(true)
    expect((await readClaudeTaskOutput(path, 'task-1', 'other-session')).outputError).toMatch(/belong/)
    expect((await readClaudeTaskOutput(path, 'other-task', 'session-1')).outputError).toMatch(/belong/)
    await rm(path); expect((await readClaudeTaskOutput(path, 'task-1', 'session-1')).outputError).toMatch(/no longer/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
