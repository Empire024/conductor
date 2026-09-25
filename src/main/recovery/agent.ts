import type { AgentRequest } from './watchdog'

/** What the headless recovery agent may do: read logs and code, run the installed exe and
 *  scripts. It may not edit files, commit, push, or delete anything (docs/recovery-mode.md). */
export const RECOVERY_AGENT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell']
export const RECOVERY_AGENT_DENIED_TOOLS = [
  'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git clean:*)', 'Bash(git checkout:*)', 'Bash(git stash:*)',
  'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(del:*)', 'Bash(rd:*)', 'Bash(Remove-Item:*)', 'Bash(format:*)', 'Bash(npm run dev:*)',
  'PowerShell(git push:*)', 'PowerShell(git commit:*)', 'PowerShell(git reset:*)', 'PowerShell(git clean:*)',
  'PowerShell(Remove-Item:*)', 'PowerShell(rm:*)', 'PowerShell(del:*)', 'PowerShell(rd:*)', 'PowerShell(npm run dev:*)'
]
export const RECOVERY_AGENT_MAX_TURNS = 40
export const RECOVERY_AGENT_TIMEOUT_MS = 10 * 60_000

const block = (text: string, max = 4000): string => {
  const trimmed = text.length > max ? `…${text.slice(-max)}` : text
  return '```\n' + trimmed.replace(/```/g, "'''") + '\n```'
}

/** The bounded prompt: the exact error, what was tried, the log tails and where everything lives. */
export function recoveryPrompt(request: AgentRequest, context: { userData: string; now: string }): string {
  const arm = request.arm
  const launch = arm?.launch
  const attempts = request.attempts.length
    ? request.attempts.map((attempt, index) => [
      `### Attempt ${index + 1}: ${attempt.exe} ${attempt.args.join(' ')}`,
      `started ${attempt.startedAt}${attempt.pid ? `, pid ${attempt.pid}` : ''}; ${attempt.error ? `spawn failed: ${attempt.error}` : attempt.exitCode === null || attempt.exitCode === undefined ? 'kept running but never answered app control' : `exited with code ${attempt.exitCode}`}`,
      attempt.outputPath ? `full output: ${attempt.outputPath}` : '',
      attempt.output ? block(attempt.output, 1500) : ''
    ].filter(Boolean).join('\n')).join('\n\n')
    : 'none'
  const logs = Object.entries(request.logs).map(([path, text]) => `### ${path}\n${block(text)}`).join('\n\n') || 'none captured'
  return [
    'You are Conductor\'s recovery agent. Conductor (a local Electron desktop app) stopped and did not come back. You run headless, unattended, with a time limit of about 8 minutes.',
    '',
    '## The exact error',
    request.error,
    '',
    '## Facts',
    `- now: ${context.now}`,
    `- stop kind the app recorded: ${arm?.kind ?? 'none (crash or kill)'}${arm ? ` at ${arm.at}` : ''}; version ${arm?.fromVersion || 'unknown'}${arm?.toVersion ? ` -> ${arm.toVersion}` : ''}`,
    `- old app pid: ${arm?.appPid ?? 'unknown'}`,
    `- how to start Conductor: ${launch ? `\`${launch.exe}\`${launch.args.length ? ` with arguments ${JSON.stringify(launch.args)}` : ''}` : 'unknown'}`,
    `- userData: ${context.userData} (control-owner.json there holds the running app's pid and control endpoint; runtime-host/host.log; recovery/watchdog.log)`,
    '- update installer cache: %LOCALAPPDATA%\\conductor-desktop-updater (pending\\ holds a downloaded installer)',
    '',
    '## Relaunch attempts already made',
    attempts,
    '',
    '## Log tails',
    logs,
    '',
    '## What to do',
    '1. Find why Conductor is not running or not answering: check running Conductor.exe processes (a hung one holds the single-instance lock), the logs above, the Windows Application event log, whether the installed exe exists, and the installer cache.',
    '2. Try to bring it back: start the installed exe (the command above), detached, so it keeps running after you exit. If a hung Conductor.exe blocks it, you may stop that process. Then check that control-owner.json names a new pid.',
    '3. Never: git commit, push, reset or clean; delete or edit anything under userData (conductor.db is the owner\'s journal); run `npm run dev`; install software; touch other apps.',
    '4. Reply with a short markdown diagnosis and nothing else: **Cause**, **Evidence** (paths, log lines, exit codes), **What I did**, **Is Conductor up now** (yes/no, pid), **What the owner should do** if it is still down.',
    `Your reply is saved to ${request.diagnosisPath}.`
  ].join('\n')
}

/** The headless Claude Code call: `claude -p` with the allowlist and bounded turns. The prompt goes
 *  on stdin: with the log tails it can outgrow a Windows command line. */
export function recoveryAgentArgs(): string[] {
  return [
    '-p',
    '--output-format', 'text',
    '--max-turns', String(RECOVERY_AGENT_MAX_TURNS),
    '--permission-mode', 'default',
    '--allowedTools', ...RECOVERY_AGENT_ALLOWED_TOOLS,
    '--disallowedTools', ...RECOVERY_AGENT_DENIED_TOOLS
  ]
}

/** The agent command: a test override (a JSON argv array, test profiles only), else `claude` on PATH. */
export function recoveryAgentCommand(options: { env: NodeJS.ProcessEnv; testProfile: boolean; resolveClaude(): string | null }): string[] | null {
  const override = options.env.CONDUCTOR_RECOVERY_AGENT_COMMAND
  if (override && options.testProfile) {
    try {
      const argv = JSON.parse(override) as unknown
      if (Array.isArray(argv) && argv.length && argv.every(part => typeof part === 'string' && part)) return argv as string[]
    } catch { /* fall through to none: a test must not reach the real CLI by accident */ }
    return null
  }
  // A test profile never calls the owner's real CLI unless the smoke says so explicitly.
  if (options.testProfile && options.env.CONDUCTOR_RECOVERY_REAL_AGENT !== '1') return null
  const claude = options.resolveClaude()
  return claude ? [claude] : null
}
