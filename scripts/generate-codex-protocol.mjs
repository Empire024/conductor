import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// Developer-only schema generation: no provider turns, login changes, or network tool calls.
// CONDUCTOR_CODEX_PATH may name a scratch CLI (scripts/probe-codex-catalog.mjs installs one), so
// the baseline can move before the owner's global CLI does.
const executable = process.env.CONDUCTOR_CODEX_PATH || 'codex'
const expected = '0.159.1'
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
if (version !== `codex-cli ${expected}`) throw new Error(`Expected codex-cli ${expected}; got ${version}. Review compatibility before changing the baseline.`)
const output = resolve('src/main/providers/generated/codex')
// Start from an empty tree: the generator only writes, so a type the CLI dropped would otherwise linger.
rmSync(output, { recursive: true, force: true })
execFileSync(executable, ['app-server', 'generate-ts', '--experimental', '--out', output], { windowsHide: true, timeout: 30_000, stdio: 'inherit' })
execFileSync(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', resolve(output, 'schema')], { windowsHide: true, timeout: 30_000, stdio: 'inherit' })
// The hashes docs/codex-compatibility.md records, taken before Git line-ending normalization.
for (const file of ['ClientRequest.ts', 'ServerNotification.ts', 'ServerRequest.ts', 'schema/codex_app_server_protocol.v2.schemas.json'])
  console.log(`${file} ${createHash('sha256').update(readFileSync(resolve(output, file))).digest('hex').toUpperCase()}`)
console.log(`Generated Codex ${expected} protocol; run node scripts/diff-codex-protocol.mjs and the adapter contract tests before publishing.`)
