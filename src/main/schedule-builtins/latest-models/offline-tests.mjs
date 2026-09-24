// Latest models, step 5 (runWhen 'changed': only after an earlier script changed or failed):
// the offline tests that cover what moved. Runs the report's relevantTests (from
// compatibility-report.out; a fixed core list when that is missing) with
// `npx vitest run <files> --reporter=json` in the checkout and prints what passed and failed.
// These tests use the repository's synthetic fixtures; none of them contacts a provider.
//
// Deterministic: no durations or temp paths; failures sorted, messages cut to 300 characters.
// A failing test is a finding (exit 0); exit 1 only when vitest could not run or produced no report.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

const WINDOWS = process.platform === 'win32'
const TIMEOUT_MS = 15 * 60_000
const FALLBACK_TESTS = ['src/main/agent-manager.test.ts', 'src/main/providers/claude.test.ts', 'src/main/providers/claude-ui-fixture.test.ts', 'src/main/providers/codex.test.ts', 'src/shared/agent-model-selection.test.ts']
const root = process.cwd()
const log = message => process.stderr.write(`[offline-tests] ${message}\n`)
const finish = (value, code) => process.stdout.write(JSON.stringify(value, null, 2) + '\n', () => process.exit(code))

function selection() {
  const runDir = process.env.CONDUCTOR_SCHEDULE_RUN_DIR
  try {
    const report = JSON.parse(readFileSync(join(runDir, 'compatibility-report.out'), 'utf8'))
    if (Array.isArray(report.relevantTests)) return report.relevantTests
  } catch { log('compatibility-report.out is missing or invalid; running the core list') }
  return FALLBACK_TESTS
}
// Only plain repository test paths reach the command line: no traversal, spaces or shell characters.
const safe = file => typeof file === 'string' && /^src\/[\w./-]+\.test\.tsx?$/.test(file) && !file.includes('..') && existsSync(join(root, file))

function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (WINDOWS) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }) } catch { /* already gone */ } }
  else { try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already gone */ } } }
}

function vitest(files, outputFile) {
  const args = ['vitest', 'run', ...files, '--reporter=json', `--outputFile=${outputFile}`]
  const options = { cwd: root, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  // npx is a .cmd shim on Windows, which needs cmd.exe; every argument above is a validated path or a fixed flag.
  const child = WINDOWS
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"npx ${args.map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ')}"`], { ...options, windowsVerbatimArguments: true })
    : spawn('npx', args, { ...options, detached: true })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
  return new Promise(resolve => {
    const timer = setTimeout(() => { log('vitest timed out after 15 min'); killTree(child) }, TIMEOUT_MS)
    child.once('error', error => { clearTimeout(timer); resolve({ error: error.message, stderr }) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

const ANSI = /\u001b\[[0-9;]*m/g
function clean(message) {
  const rootPatterns = [root, root.split(sep).join('/')].filter(Boolean)
  let text = String(message ?? '').replace(ANSI, '')
  for (const path of rootPatterns) text = text.split(path).join('.')
  for (const path of [tmpdir(), tmpdir().split(sep).join('/')]) text = text.replace(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s'"\`)]*`, 'g'), '<tmp>')
  text = text.split('\n').map(line => line.trim()).filter(line => line && !/^at\s/.test(line)).join(' ').replace(/\s+/g, ' ')
  return text.length > 300 ? `${text.slice(0, 299)}…` : text
}

async function main() {
  const files = [...new Set(selection().filter(safe))].sort()
  if (!files.length) return finish({ ran: [], passed: 0, failed: 0, failures: [] }, 0)
  const scratch = process.env.CONDUCTOR_SCHEDULE_RUN_DIR ? null : mkdtempSync(join(tmpdir(), 'conductor-schedule-tests-'))
  const outputFile = join(process.env.CONDUCTOR_SCHEDULE_RUN_DIR || scratch, 'vitest.json')
  rmSync(outputFile, { force: true })
  const result = await vitest(files, outputFile)
  let report = null
  try { report = JSON.parse(readFileSync(outputFile, 'utf8')) } catch { /* reported below */ }
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  if (!report) {
    log(`vitest produced no JSON report (${result.error ?? `exit ${result.code}`}): ${result.stderr}`)
    return finish({ ran: files, error: result.error ? 'vitest could not start' : 'vitest produced no report' }, 1)
  }
  const failures = []
  for (const suite of report.testResults ?? []) {
    const file = relative(root, suite.name ?? '').split(sep).join('/')
    const failed = (suite.assertionResults ?? []).filter(test => test.status === 'failed')
    for (const test of failed) failures.push({ file, name: test.fullName || test.title || '(unnamed)', message: clean(test.failureMessages?.[0]) })
    if (!failed.length && suite.status === 'failed') failures.push({ file, name: '(file)', message: clean(suite.message) })
  }
  failures.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
  finish({ ran: files, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? failures.length, failures }, 0)
}

let packageName = null
try { packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name } catch { /* not a checkout */ }
if (packageName === 'conductor-desktop') await main()
else finish({ checkout: false }, 0)
