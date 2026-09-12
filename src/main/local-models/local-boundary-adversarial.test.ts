import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from './tools.ts'

// Independent integration review: the host file bridge must honor the same hidden
// directory policy as Docker masks, even when the child filename looks ordinary.
describe('local file bridge adversarial review', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  it('does not expose an ordinary child of a withheld secret directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'local-boundary-review-'))
    roots.push(workspace)
    await mkdir(join(workspace, 'secret-vault'))
    await writeFile(join(workspace, 'secret-vault', 'ordinary.txt'), 'synthetic-private-canary')
    const context = { workspace, readOnly: true, sandbox: null, timeoutSec: 1 }
    for (const [tool, args] of [
      ['read_file', { path: 'secret-vault/ordinary.txt' }],
      ['search', { path: 'secret-vault', pattern: 'synthetic-private-canary' }]
    ] as const) {
      const result = await runTool(tool, JSON.stringify(args), context)
      expect(result.failed, `${tool} must refuse the withheld ancestor`).toBe(true)
      expect(result.output).not.toContain('synthetic-private-canary')
    }
  })
})
