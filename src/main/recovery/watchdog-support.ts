import type { RecoveryReport } from './protocol'
import type { WatchdogConfig } from './watchdog'

/** The app's AppUserModelID (index.ts setAppUserModelId), so the toast shows as Conductor's. */
export const CONDUCTOR_APP_ID = 'io.conductor.desktop'

/** A WinRT toast from PowerShell. Title and body travel in the environment, never in the command text. */
export function toastScript(appId = CONDUCTOR_APP_ID): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$escape = { param($text) [System.Security.SecurityElement]::Escape($text) }',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>" + (& $escape $env:CONDUCTOR_TOAST_TITLE) + "</text><text>" + (& $escape $env:CONDUCTOR_TOAST_BODY) + "</text></binding></visual></toast>")',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`
  ].join('; ')
}

const TIMING_KEYS = ['pollMs', 'restartWaitMs', 'installWaitMs', 'installMaxMs', 'crashWaitMs', 'attemptWaitMs', 'afterAgentWaitMs', 'maxRecoveries', 'recoveryWindowMs'] as const

/** Test profiles only: shorter waits (CONDUCTOR_RECOVERY_TIMINGS, JSON) and the attempt executables
 *  (CONDUCTOR_RECOVERY_TEST_EXES, a JSON array) the parked smoke uses to make a relaunch fail. */
export function watchdogTimings(env: NodeJS.ProcessEnv, testProfile: boolean): Partial<WatchdogConfig> {
  if (!testProfile) return {}
  const result: Partial<WatchdogConfig> = {}
  try {
    const raw = JSON.parse(env.CONDUCTOR_RECOVERY_TIMINGS ?? '{}') as Record<string, unknown>
    for (const key of TIMING_KEYS) { const value = raw[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value }
    if (Array.isArray(raw.backoffMs) && raw.backoffMs.every(value => typeof value === 'number' && value >= 0)) result.backoffMs = raw.backoffMs as number[]
  } catch { /* defaults */ }
  try {
    const exes = JSON.parse(env.CONDUCTOR_RECOVERY_TEST_EXES ?? 'null') as unknown
    if (Array.isArray(exes) && exes.length && exes.every(exe => typeof exe === 'string' && exe)) result.relaunchExes = exes as string[]
  } catch { /* the armed exe */ }
  return result
}

/** The markdown record of one recovery, appended after the agent's diagnosis when there is one. */
export function recoveryMarkdown(report: RecoveryReport): string {
  const lines = [
    `# Conductor recovery ${report.id}`,
    '',
    `- **Outcome:** ${report.outcome === 'relaunched' ? 'relaunched by the watchdog' : report.outcome === 'agent-recovered' ? 'brought back by the recovery agent' : 'still down: start Conductor by hand'}${report.readyPid ? ` (pid ${report.readyPid})` : ''}`,
    `- **Error:** ${report.error}`,
    `- **Stop:** ${report.kind} of pid ${report.appPid}${report.fromVersion ? `, version ${report.fromVersion}` : ''}${report.toVersion ? ` -> ${report.toVersion}` : ''}`,
    `- **When:** ${report.at}`,
    ''
  ]
  if (report.attempts.length) {
    lines.push('## Relaunch attempts', '')
    report.attempts.forEach((attempt, index) => {
      lines.push(`${index + 1}. \`${attempt.exe}\` at ${attempt.startedAt}: ${attempt.ready ? 'answered app control' : attempt.error ? `could not start (${attempt.error})` : attempt.exitCode === null || attempt.exitCode === undefined ? 'ran but never answered' : `exited with code ${attempt.exitCode}`}${attempt.outputPath ? ` — output: ${attempt.outputPath}` : ''}`)
    })
    lines.push('')
  }
  if (report.agent) {
    lines.push('## Recovery agent', '', `- command: \`${report.agent.command.join(' ') || '(none)'}\` in ${report.agent.cwd}`, `- exit: ${report.agent.exitCode ?? 'none'}${report.agent.timedOut ? ' (timed out)' : ''}${report.agent.error ? `; ${report.agent.error}` : ''}`, `- diagnosis: ${report.agent.diagnosisPath}`, '')
  }
  return lines.join('\n')
}
