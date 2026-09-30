import { spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Owner alerts: a Windows toast (never a window, never focus) and, while the app answers, a phone
// push through supervisor.alert. A test profile writes toasts.jsonl instead of showing one.

/** The app's AppUserModelID (src/main/recovery/watchdog-support.ts), so the toast shows as Conductor's. */
const APP_ID = 'io.conductor.desktop'

/** A WinRT toast from PowerShell. Title and body travel in the environment, never in the command text. */
export const TOAST_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$escape = { param($text) [System.Security.SecurityElement]::Escape($text) }',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>" + (& $escape $env:CONDUCTOR_TOAST_TITLE) + "</text><text>" + (& $escape $env:CONDUCTOR_TOAST_BODY) + "</text></binding></visual></toast>")',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`
].join('; ')

export function createToaster({ dir, testProfile, spawnImpl = spawn }) {
  return async function toast(title, body) {
    if (testProfile) {
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, 'toasts.jsonl'), JSON.stringify({ at: new Date().toISOString(), title, body }) + '\n', 'utf8')
      return 'written to toasts.jsonl (test profile)'
    }
    if (process.platform !== 'win32') return 'no toast off Windows'
    return new Promise(done => {
      const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', TOAST_SCRIPT], {
        env: { ...process.env, CONDUCTOR_TOAST_TITLE: title.slice(0, 120), CONDUCTOR_TOAST_BODY: body.slice(0, 600) }, stdio: 'ignore', windowsHide: true
      })
      const timer = setTimeout(() => { child.kill(); done('toast timed out') }, 20_000)
      child.on('error', error => { clearTimeout(timer); done(`toast failed: ${error.message}`) })
      child.on('exit', code => { clearTimeout(timer); done(code === 0 ? 'toast shown' : `toast exited ${code}`) })
    })
  }
}
