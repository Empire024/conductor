/** Cheap, deterministic proof that the local-model boundary holds. Two groups:
 *
 *  - Host-side policy tests always run. They prove that file tools stay inside the workspace,
 *    that secrets are withheld, and above all that a missing sandbox refuses execution instead
 *    of falling back to Windows.
 *  - Container tests need Docker. Without it they are reported as skipped, never as passed. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, readApiKey, DEFAULT_SANDBOX, modelFilePath } from '../../src/main/local-models/config.ts'
import type { SandboxConfig } from '../../src/main/local-models/config.ts'
import { childEnvironment, onSystemDrive, sessionWorkspace, systemDrive } from '../../src/main/local-models/paths.ts'
import type { LocalLayout } from '../../src/main/local-models/paths.ts'
import { DockerSandbox, containerRunArgs, dockerAvailable, execArgs, sandboxImageExists } from '../../src/main/local-models/sandbox.ts'
import { runTool } from '../../src/main/local-models/tools.ts'
import { llamaServerArgs } from '../../src/main/local-models/llama.ts'
import { rejectsAnonymous } from '../../src/main/local-models/llama.ts'

interface Check { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }

const results: Check[] = []
const record = (name: string, ok: boolean, detail: string): void => { results.push({ name, state: ok ? 'pass' : 'fail', detail }) }
const skip = (name: string, detail: string): void => { results.push({ name, state: 'skip', detail }) }

const denied = (output: string): boolean => /^denied:/.test(output.trim())

async function hostPolicyChecks(workspace: string): Promise<void> {
  const noSandbox = { workspace, readOnly: false, sandbox: null, timeoutSec: 30 }

  // The single most important property: no host fallback. With no sandbox, execution is refused.
  const fallback = await runTool('run_command', JSON.stringify({ command: 'echo SHOULD_NOT_RUN_ON_HOST' }), noSandbox)
  record('no host fallback when the sandbox is unavailable', denied(fallback.output) && !fallback.output.includes('SHOULD_NOT_RUN_ON_HOST'), fallback.output.slice(0, 120))

  const shell = await runTool('powershell', JSON.stringify({ command: 'whoami' }), noSandbox)
  record('host shell tool is not dispatchable', denied(shell.output), shell.output.slice(0, 120))

  for (const path of ['../../Windows/win.ini', '..\\..\\Windows\\win.ini', 'C:\\Windows\\win.ini', '/etc/passwd', '//server/share/file', '~/.ssh/id_rsa', '/workspace/../../etc/passwd']) {
    const outcome = await runTool('read_file', JSON.stringify({ path }), noSandbox)
    record(`path traversal denied: ${path}`, denied(outcome.output), outcome.output.slice(0, 80))
  }

  // Symlink/junction escape: a link created inside the workspace must not widen it.
  const escape = mkdtempSync(join(tmpdir(), 'conductor-outside-'))
  writeFileSync(join(escape, 'outside.txt'), 'OUTSIDE_SECRET_MARKER', 'utf8')
  const link = join(workspace, 'conductor-escape-link')
  let linked = false
  try { symlinkSync(escape, link, 'junction'); linked = true } catch { /* Directory junctions may be unavailable; the lexical checks above still run. */ }
  if (linked) {
    const outcome = await runTool('read_file', JSON.stringify({ path: 'conductor-escape-link/outside.txt' }), noSandbox)
    record('symlink/junction escape denied', denied(outcome.output) && !outcome.output.includes('OUTSIDE_SECRET_MARKER'), outcome.output.slice(0, 80))
    rmSync(link, { force: true, recursive: true })
  } else skip('symlink/junction escape denied', 'junction creation unavailable on this host')
  rmSync(escape, { force: true, recursive: true })

  // Secret files inside the workspace are withheld from both read and write.
  const secret = join(workspace, '.env')
  const existed = await (async () => { try { const { existsSync } = await import('node:fs'); return existsSync(secret) } catch { return false } })()
  if (!existed) writeFileSync(secret, 'API_TOKEN=conductor-security-test\n', 'utf8')
  const readSecret = await runTool('read_file', JSON.stringify({ path: '.env' }), noSandbox)
  record('workspace secret file withheld', denied(readSecret.output) && !readSecret.output.includes('conductor-security-test'), readSecret.output.slice(0, 80))
  if (!existed) rmSync(secret, { force: true })

  const gitWrite = await runTool('write_file', JSON.stringify({ path: '.git/hooks/pre-commit', content: '#!/bin/sh\n' }), noSandbox)
  record('git metadata is not writable', denied(gitWrite.output), gitWrite.output.slice(0, 80))

  const readOnlyWrite = await runTool('write_file', JSON.stringify({ path: 'conductor-readonly-probe.txt', content: 'x' }), { ...noSandbox, readOnly: true })
  record('read-only mode refuses writes', denied(readOnlyWrite.output), readOnlyWrite.output.slice(0, 80))

  // Argument construction: the container is never granted the things that would undo it.
  const args = containerRunArgs({ name: 'conductor-local-test', image: DEFAULT_SANDBOX.image, workspace, sandbox: DEFAULT_SANDBOX, masks: [], emptyFile: join(workspace, 'package.json') }).join(' ')
  record('container runs with --network none', args.includes('--network none'), '')
  record('container drops all capabilities and new privileges', args.includes('--cap-drop ALL') && args.includes('no-new-privileges'), '')
  record('container runs as a non-root user with a read-only root', args.includes('--user 10001:10001') && args.includes('--read-only'), '')
  record('container has memory, cpu and pid limits', args.includes('--memory') && args.includes('--cpus') && args.includes('--pids-limit'), '')
  record('container mounts no docker socket or host root', !/docker\.sock|npipe|:\/host|source=\/,/.test(args), '')
  record('command argv keeps model text as one argument', execArgs('conductor-local-test', 'rm -rf / # attacker text', 30).at(-1) === 'rm -rf / # attacker text', '')
  record('exec argv passes through bash inside the container only', execArgs('conductor-local-test', 'id', 30).includes('bash'), '')

  const llama = llamaServerArgs({ id: 'local/test', label: '', repo: 'a/b', revision: 'x', file: 'a.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'a'.repeat(64), port: 51435, contextTokens: 32768, gpuLayers: 10, extraArgs: [] }, 'a'.repeat(64), 'a.gguf')
  record('llama.cpp binds to 127.0.0.1 only', llama[llama.indexOf('--host') + 1] === '127.0.0.1', '')
  record('llama.cpp requires an API key and disables the web UI', llama.includes('--api-key') && llama.includes('--no-webui'), '')
  record('llama.cpp gets no tool, MCP, agent or RPC flags', !llama.some(arg => /--mcp|--agent|--rpc|--tools/.test(arg)), '')
  let rejected = false
  try { llamaServerArgs({ id: 'local/test', label: '', repo: 'a/b', revision: 'x', file: 'a.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'a'.repeat(64), port: 51435, contextTokens: 32768, gpuLayers: 10, extraArgs: ['--rpc', '127.0.0.1:9000'] }, 'a'.repeat(64), 'a.gguf') } catch { rejected = true }
  record('llama.cpp refuses re-enabling flags from config', rejected, '')
}

async function serverChecks(): Promise<void> {
  let config: ReturnType<typeof loadConfig>
  try { config = loadConfig() } catch { skip('model servers bind to 127.0.0.1 only', 'local stack is not set up'); return }
  const apiKey = readApiKey()
  const { execFile } = await import('node:child_process')
  for (const model of Object.values(config.models)) {
    const listening = await new Promise<string>(resolve => execFile('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? '')))
    const rows = listening.split(/\r?\n/).filter(line => line.includes(`:${model.port} `) && /LISTENING/i.test(line))
    if (!rows.length) { skip(`${model.id} listens on 127.0.0.1 only`, 'server is not running'); skip(`${model.id} rejects requests without the API key`, 'server is not running'); continue }
    record(`${model.id} listens on 127.0.0.1 only`, rows.every(row => row.includes(`127.0.0.1:${model.port}`)), rows.map(row => row.trim().split(/\s+/)[1] ?? '').join(' '))
    record(`${model.id} rejects requests without the API key`, await rejectsAnonymous(model.port), '')
    void apiKey
  }
}

async function containerChecks(workspace: string, sandboxConfig: SandboxConfig): Promise<void> {
  const docker = await dockerAvailable()
  const containerTests = [
    'workspace is the working directory', 'sandbox user is not root', 'Windows user profile unreachable',
    'C: drive unreachable', 'ssh directory unreachable', 'host secret environment variables absent',
    '/etc is not writable', 'powershell.exe unavailable', 'cmd.exe unavailable', 'docker socket unavailable',
    'docker CLI unavailable', 'network access unavailable', 'parent of /workspace holds nothing useful'
  ]
  if (!docker.available) { for (const name of containerTests) skip(name, docker.reason ?? 'docker unavailable'); return }
  if (!await sandboxImageExists(sandboxConfig.image)) { for (const name of containerTests) skip(name, `sandbox image missing: ${sandboxConfig.image}`); return }
  const sandbox = new DockerSandbox(`security-${process.pid}`, workspace, sandboxConfig)
  try {
    const run = async (command: string): Promise<{ out: string; code: number }> => {
      const result = await sandbox.exec(command, 20)
      return { out: (result.stdout + result.stderr).trim(), code: result.exitCode }
    }
    const pwd = await run('pwd')
    record('workspace is the working directory', pwd.out === '/workspace', pwd.out)
    const who = await run('id -u; whoami || true')
    record('sandbox user is not root', !who.out.startsWith('0'), who.out.replace(/\s+/g, ' '))
    record('Windows user profile unreachable', (await run('ls /mnt/c/Users /c/Users /host_mnt 2>/dev/null | head -5')).out === '', '')
    record('C: drive unreachable', (await run('ls "C:\\\\" 2>/dev/null | head -3')).out === '', '')
    record('ssh directory unreachable', (await run('ls ~/.ssh /root/.ssh 2>/dev/null | head -3')).out === '', '')
    // Names only; values are never printed by this suite.
    const secrets = await run('env | grep -v "^NPM_CONFIG_CACHE=/tmp/npm$" | grep -Ei "^(ANTHROPIC|OPENAI|AWS|AZURE|GITHUB|GH|HF|NPM|PYPI|DOCKER|SSH_AUTH)" | cut -d= -f1 | tr "\\n" " "')
    record('host secret environment variables absent', secrets.out === '', secrets.out)
    record('/etc is not writable', (await run('touch /etc/conductor-test 2>&1; test -e /etc/conductor-test && echo WRITABLE || echo refused')).out.includes('refused'), '')
    record('powershell.exe unavailable', (await run('command -v powershell.exe powershell pwsh || echo missing')).out.includes('missing'), '')
    record('cmd.exe unavailable', (await run('command -v cmd.exe || echo missing')).out.includes('missing'), '')
    record('docker socket unavailable', (await run('test -S /var/run/docker.sock && echo PRESENT || echo missing')).out.includes('missing'), '')
    record('docker CLI unavailable', (await run('command -v docker || echo missing')).out.includes('missing'), '')
    const network = await run('timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>&1; echo exit=$?')
    record('network access unavailable', !network.out.includes('exit=0'), network.out.replace(/\s+/g, ' ').slice(0, 80))
    const parent = await run('ls / | tr "\\n" " "')
    record('parent of /workspace holds nothing useful', !/Users|host_mnt|\bc\b/.test(parent.out), parent.out.slice(0, 120))
  } finally {
    await sandbox.stop()
  }
}

/** Storage placement is part of the boundary now: the data root must be off the system drive,
 *  and only the specific session workspace may ever cross into a container. */
function storageChecks(root: LocalLayout | undefined, sandboxConfig: SandboxConfig): void {
  if (!root) { skip('local data root is not on the system drive', 'local root is not configured'); return }
  record('local data root is not on the system drive', !onSystemDrive(root.root), `${root.root} (system drive ${systemDrive()})`)
  for (const [name, directory] of Object.entries(root)) record(`${name} directory is off the system drive`, !onSystemDrive(directory), directory)
  const environment = childEnvironment({})
  record('child temp and cache resolve to the local root', ['TMP', 'TEMP', 'TMPDIR', 'XDG_CACHE_HOME', 'HF_HOME', 'LLAMA_CACHE'].every(key => (environment[key] ?? '').toLowerCase().startsWith(root.root.toLowerCase())), '')
  try {
    const config = loadConfig()
    const files = Object.values(config.models).map(modelFilePath)
    record('model files live under the local root', files.every(file => file.toLowerCase().startsWith(root.models.toLowerCase())), files.map(file => file.slice(0, 60)).join(' '))
  } catch { skip('model files live under the local root', 'local stack is not set up') }
  const workspace = sessionWorkspace('security-check')
  const args = containerRunArgs({ name: 'conductor-local-test', image: sandboxConfig.image, workspace, sandbox: sandboxConfig, masks: [], emptyFile: join(root.runtime, 'masked-empty') }).join(' ')
  record('agent workspace lives under the local root', workspace.toLowerCase().startsWith(root.workspaces.toLowerCase()), workspace)
  record('only the session workspace is mounted', args.includes(`type=bind,source=${workspace.replace(/\\/g, '/')},target=/workspace`), '')
  record('no system drive path crosses the sandbox boundary', !args.split(' ').some(arg => /^type=bind,source=/i.test(arg) && arg.toLowerCase().includes(`source=${systemDrive().toLowerCase()}/`)), '')
  record('no drive root is mounted', !/source=[a-z]:\/,/i.test(args), '')
  let refused = false
  try { containerRunArgs({ name: 'conductor-local-test', image: sandboxConfig.image, workspace: `${systemDrive()}\\`, sandbox: sandboxConfig, masks: [], emptyFile: join(root.runtime, 'masked-empty') }) } catch { refused = true }
  record('mounting a drive root is refused', refused, '')
}

export async function runSecuritySuite(options: { workspace: string; root?: LocalLayout }): Promise<boolean> {
  let sandboxConfig: SandboxConfig = DEFAULT_SANDBOX
  try { sandboxConfig = loadConfig().sandbox } catch { /* Defaults are enough for the boundary checks. */ }
  mkdirSync(options.workspace, { recursive: true })
  storageChecks(options.root, sandboxConfig)
  await hostPolicyChecks(options.workspace)
  await containerChecks(options.workspace, sandboxConfig)
  await serverChecks()
  for (const check of results) process.stdout.write(`${check.state.toUpperCase().padEnd(4)} ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`)
  const failed = results.filter(check => check.state === 'fail').length
  const skipped = results.filter(check => check.state === 'skip').length
  process.stdout.write(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped\n`)
  return failed === 0
}
