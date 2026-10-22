#!/usr/bin/env node
// The detached repair runner (docs/startup-diagnostics.md, part 2), started by the meta-wizard:
//   node repair-run.mjs <repair dir>/request.json
// 1. git worktree add -b <branch> <checkout>/../conductor-repairs/<id> HEAD (never the shared tree);
// 2. robocopy the checkout's node_modules into it, a real copy (a junction makes electron-builder
//    drop dependencies);
// 3. the repair agent, cwd the worktree, prompt on stdin, killed with its whole tree at the limit;
// 4. report.md (the agent's stdout) and result.json; active.json is removed on exit.
// Plain Node, no dependencies: it is copied out with the meta-wizard and run from there.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { repairEnv } from './repair.mjs'

const requestPath = process.argv[2]
const log = message => { try { process.stdout.write(`${new Date().toISOString()} [repair-run ${process.pid}] ${message}\n`) } catch { /* no log */ } }
const writeJson = (path, value) => { const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); renameSync(temporary, path) }
const git = (args, cwd) => new Promise((done, fail) => execFile('git', args, { cwd, windowsHide: true, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new Error(`git ${args.join(' ')}: ${String(stderr || error.message).trim()}`)) : done(String(stdout))))

let request
try { request = JSON.parse(readFileSync(requestPath, 'utf8')) } catch (error) { log(`cannot read the request ${requestPath}: ${error.message}`); process.exit(2) }

const startedAt = new Date().toISOString()
const result = { id: request.id, startedAt, finishedAt: null, exitCode: null, timedOut: false, error: null, branch: request.branch, worktree: request.worktree, base: null, commits: [], command: request.command ? request.command[0] : null, report: join(request.dir, 'report.md') }
const reportPath = result.report
try { writeJson(request.activePath, { pid: process.pid, id: request.id, startedAt }) } catch (error) { log(`active.json: ${error.message}`) }

/** Copies node_modules with robocopy /E (a real copy). Exit codes below 8 are success. */
function copyNodeModules(from, to) {
  return new Promise(done => {
    const child = spawn('robocopy.exe', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/MT:16'], { stdio: 'ignore', windowsHide: true })
    child.on('error', error => done(`robocopy failed to start: ${error.message}`))
    child.on('exit', code => done(code !== null && code < 8 ? null : `robocopy exited with code ${code}`))
  })
}

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGKILL')
  } catch { /* already gone */ }
}

/** The agent: prompt on stdin, stdout is the report. Resolves `{exitCode, timedOut, error, stdout, stderr}`. */
function runAgent(command, prompt, cwd, timeoutMs) {
  return new Promise(done => {
    let stdout = '', stderr = '', timedOut = false, child
    try { child = spawn(command[0], command.slice(1), { cwd, env: repairEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) } catch (error) { done({ exitCode: null, timedOut, error: `the agent failed to start: ${error.message}`, stdout, stderr }); return }
    const timer = setTimeout(() => { timedOut = true; log(`time limit (${Math.round(timeoutMs / 60_000)} min): killing the agent tree ${child.pid}`); killTree(child) }, timeoutMs)
    child.stdout.on('data', chunk => { if (stdout.length < 2_000_000) stdout += chunk })
    child.stderr.on('data', chunk => { if (stderr.length < 50_000) stderr += chunk })
    child.stdin.on('error', () => { /* the agent may not read stdin */ })
    child.stdin.end(prompt)
    let settled = false
    const finish = (exitCode, error = null) => { if (settled) return; settled = true; clearTimeout(timer); done({ exitCode, timedOut, error, stdout, stderr }) }
    child.once('error', error => finish(null, `the agent failed: ${error.message}`))
    child.once('close', code => finish(code))
  })
}

async function main() {
  const { checkout, worktree, branch } = request
  result.base = (await git(['rev-parse', 'HEAD'], checkout)).trim()
  mkdirSync(dirname(worktree), { recursive: true })
  log(`worktree ${worktree} on ${branch} from ${result.base}`)
  await git(['worktree', 'add', '-b', branch, worktree, result.base], checkout)
  const modules = join(checkout, 'node_modules')
  if (existsSync(modules)) {
    log('copying node_modules (robocopy /E)')
    const copyError = await copyNodeModules(modules, join(worktree, 'node_modules'))
    if (copyError) log(`node_modules: ${copyError}`)
    else if (lstatSync(join(worktree, 'node_modules')).isSymbolicLink()) log('node_modules is a link; electron-builder would drop dependencies')
  } else log('the checkout has no node_modules to copy')
  if (!request.command) {
    result.error = request.noAgentReason || 'no repair agent command'
    writeFileSync(reportPath, `# Repair agent did not run\n\n${result.error}.\n`, 'utf8')
    return
  }
  const prompt = readFileSync(request.promptPath, 'utf8')
  log(`agent: ${request.command[0]} (limit ${Math.round(request.timeoutMs / 60_000)} min)`)
  const run = await runAgent(request.command, prompt, worktree, request.timeoutMs)
  result.exitCode = run.exitCode
  result.timedOut = run.timedOut
  if (run.error) result.error = run.error
  else if (run.timedOut) result.error = `killed after ${Math.round(request.timeoutMs / 60_000)} minutes`
  const body = run.stdout.trim() || `The agent wrote nothing to stdout.${run.stderr.trim() ? `\n\nstderr:\n\n\`\`\`\n${run.stderr.trim().slice(-4000)}\n\`\`\`` : ''}`
  writeFileSync(reportPath, `${body}\n`, 'utf8')
  log(`agent finished: exit ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}`)
}

try { await main() } catch (error) {
  result.error = error?.message ?? String(error)
  log(`failed: ${error?.stack ?? error}`)
  try { if (!existsSync(reportPath)) writeFileSync(reportPath, `# Repair did not run\n\n${result.error}\n`, 'utf8') } catch { /* nothing more to do */ }
}
try {
  if (result.base) {
    const lines = (await git(['log', '--format=%H %s', `${result.base}..${request.branch}`], request.checkout)).split('\n').map(line => line.trim()).filter(Boolean)
    result.commits = lines.map(line => ({ sha: line.slice(0, 40), subject: line.slice(41) }))
  }
} catch (error) { log(`commits: ${error.message}`) }
result.finishedAt = new Date().toISOString()
try { writeJson(join(request.dir, 'result.json'), result) } catch (error) { log(`result.json: ${error.message}`) }
try { if (JSON.parse(readFileSync(request.activePath, 'utf8')).pid === process.pid) rmSync(request.activePath, { force: true }) } catch { /* not ours, or gone */ }
log('done')
