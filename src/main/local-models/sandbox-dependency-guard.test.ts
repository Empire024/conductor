import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNoPackageInstall, containerRunArgs, SandboxPolicyError } from './sandbox.ts'
import { runTool } from './tools.ts'

/** A sandboxed `npx tsc --noEmit` once deleted this repository's node_modules and
 *  package-lock.json: npm reifies the tree before it runs anything, and with `--network none` it
 *  cannot finish what it has already torn down. Both halves of the fix are covered here — the
 *  command never reaches the container, and the container could not write those paths anyway. */
describe('sandbox dependency guard', () => {
  it('refuses package managers that rewrite the dependency tree, however they are spelled', () => {
    for (const command of [
      'npx tsc --noEmit',
      'cd /workspace && npx tsc --noEmit',
      'npm ci',
      'npm install --no-save',
      '/usr/bin/npm i vitest',
      'yarn add left-pad',
      'pnpm install',
      'bun add react',
      'echo hi && npm prune',
      'ls | npx vitest run',
      'CI=1 npm ci',
      'npm exec tsc'
    ]) {
      expect(() => assertNoPackageInstall(command), command).toThrow(SandboxPolicyError)
    }
  })

  it('leaves ordinary commands, and read-only package manager queries, alone', () => {
    for (const command of [
      'node ./node_modules/typescript/bin/tsc --noEmit',
      './node_modules/.bin/vitest run src/main/local-models/agent-loop.test.ts',
      'npm run build',
      'npm test',
      'npm ls --depth=0',
      'grep -rn "npx" src',
      'git status'
    ]) {
      expect(() => assertNoPackageInstall(command), command).not.toThrow()
    }
  })

  it('reports the refusal to the model with the command to run instead', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-guard-'))
    try {
      const result = await runTool('run_command', JSON.stringify({ command: 'npx tsc --noEmit' }), { workspace, readOnly: false, sandbox: null, timeoutSec: 5 })
      expect(result.failed).toBe(true)
      expect(result.output).toContain('denied')
      expect(result.output).toContain('node ./node_modules/typescript/bin/tsc')
    } finally { rmSync(workspace, { recursive: true, force: true }) }
  })

  it('binds the dependency tree and lockfile into the container read-only', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-guard-'))
    try {
      mkdirSync(join(workspace, 'node_modules'))
      writeFileSync(join(workspace, 'package-lock.json'), '{}')
      const args = containerRunArgs({ name: 'conductor-local-test', image: 'conductor-local-sandbox:1', workspace, sandbox: { image: 'conductor-local-sandbox:1', memory: '4g', cpus: '4', pids: 256, timeoutSec: 120, maxOutputBytes: 1024, tmpfsSizeMb: 512 }, masks: [], emptyFile: join(workspace, 'package-lock.json') })
      const mounts = args.filter((_argument, index) => args[index - 1] === '--mount')
      expect(mounts.some(mount => mount.includes('target=/workspace/node_modules') && mount.endsWith('readonly'))).toBe(true)
      expect(mounts.some(mount => mount.includes('target=/workspace/package-lock.json') && mount.endsWith('readonly'))).toBe(true)
      // A build that caches beside its dependencies still has somewhere to write.
      const tmpfs = args.filter((_argument, index) => args[index - 1] === '--tmpfs')
      expect(tmpfs.some(mount => mount.startsWith('/workspace/node_modules/.cache'))).toBe(true)
    } finally { rmSync(workspace, { recursive: true, force: true }) }
  })
})
