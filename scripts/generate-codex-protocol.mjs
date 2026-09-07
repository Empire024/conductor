import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// Developer-only schema generation: no provider turns, login changes, or network tool calls.
const executable = process.env.CONDUCTOR_CODEX_PATH || 'codex'
const expected = '0.153.4'
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
if (version !== `codex-cli ${expected}`) throw new Error(`Expected codex-cli ${expected}; got ${version}. Review compatibility before changing the baseline.`)
const output = resolve('src/main/providers/generated/codex')
execFileSync(executable, ['app-server', 'generate-ts', '--experimental', '--out', output], { windowsHide: true, timeout: 30_000, stdio: 'inherit' })
execFileSync(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', resolve(output, 'schema')], { windowsHide: true, timeout: 30_000, stdio: 'inherit' })
console.log(`Generated Codex ${expected} protocol; run adapter contract tests before publishing.`)
