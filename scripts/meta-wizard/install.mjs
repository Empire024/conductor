import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { TASK_NAME } from './paths.mjs'

// The per-user scheduled task that keeps the meta-wizard running (docs/meta-wizard.md): at logon,
// plus every 5 minutes with "ignore new instance", so a dead supervisor is back within 5 minutes.
// It runs in the owner's session (so it can start Conductor there and show toasts) through
// wscript.exe, which has no console window, and waits for node so the task sees its exit code.

const run = promisify(execFile)
const xmlEscape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The task definition. `start` is the first repetition (local ISO without zone). */
export function taskXml({ user, wscript, vbs, workingDirectory, start }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Conductor meta-wizard: keeps Conductor and its tasks alive (docs/meta-wizard.md in the Conductor checkout).</Description>
    <URI>\\${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>${xmlEscape(start)}</StartBoundary>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscript)}</Command>
      <Arguments>//B //NoLogo "${xmlEscape(vbs)}"</Arguments>
      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** Runs node hidden (window style 0) and waits for it, so its exit code is the task's. */
export function hiddenVbs({ node, script, userData }) {
  const quoted = value => `""${String(value).replace(/"/g, '')}""`
  return [
    "' Conductor meta-wizard: run the supervisor with no window (docs/meta-wizard.md).",
    'Set shell = CreateObject("WScript.Shell")',
    `WScript.Quit shell.Run("${quoted(node)} ${quoted(script)} run --user-data ${quoted(userData)}", 0, True)`,
    ''
  ].join('\r\n')
}

const localIso = date => { const pad = n => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` }

/** Copies the service out of the checkout, registers the task and starts it. */
export async function install({ checkout, serviceDir, userData, node = process.execPath, env = process.env, commit = null }) {
  if (process.platform !== 'win32') throw new Error('The meta-wizard service installs on Windows only')
  const scripts = join(serviceDir, 'scripts')
  await rm(scripts, { recursive: true, force: true })
  await mkdir(join(scripts, 'meta-wizard'), { recursive: true })
  await copyFile(join(checkout, 'scripts', 'meta-wizard.mjs'), join(scripts, 'meta-wizard.mjs'))
  for (const name of await readdir(join(checkout, 'scripts', 'meta-wizard'))) if (/\.mjs$/.test(name) && !/\.test\.mjs$/.test(name)) await copyFile(join(checkout, 'scripts', 'meta-wizard', name), join(scripts, 'meta-wizard', name))
  await writeFile(join(serviceDir, 'VERSION.json'), JSON.stringify({ installedAt: new Date().toISOString(), checkout, commit, node }, null, 2) + '\n')
  const vbs = join(serviceDir, 'run-hidden.vbs')
  await writeFile(vbs, hiddenVbs({ node, script: join(scripts, 'meta-wizard.mjs'), userData }), 'utf8')
  const user = `${env.USERDOMAIN ?? env.COMPUTERNAME}\\${env.USERNAME}`
  const wscript = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
  const xml = taskXml({ user, wscript, vbs, workingDirectory: serviceDir, start: localIso(new Date(Date.now() + 60_000)) })
  const xmlPath = join(tmpdir(), `conductor-meta-wizard-${process.pid}.xml`)
  // schtasks reads task XML as UTF-16 with a byte order mark.
  await writeFile(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))
  try {
    await run('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'], { windowsHide: true })
  } finally { await rm(xmlPath, { force: true }) }
  await run('schtasks.exe', ['/Run', '/TN', TASK_NAME], { windowsHide: true })
  return { task: TASK_NAME, serviceDir, vbs, user }
}

export async function uninstall() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  await run('schtasks.exe', ['/End', '/TN', TASK_NAME], { windowsHide: true }).catch(() => {})
  await run('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { windowsHide: true })
}

/** `{installed, status, lastRun, lastResult}` from schtasks, or `{installed:false}`. */
export async function taskStatus() {
  if (process.platform !== 'win32') return { installed: false, note: 'Windows only' }
  try {
    const { stdout } = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'], { windowsHide: true })
    const field = label => new RegExp(`^${label}:\\s*(.*)$`, 'mi').exec(stdout)?.[1]?.trim() ?? null
    return { installed: true, status: field('Status'), lastRun: field('Last Run Time'), lastResult: field('Last Result'), nextRun: field('Next Run Time') }
  } catch { return { installed: false } }
}

export const serviceDirFor = stateDirectory => join(stateDirectory, 'service')
export const checkoutOf = scriptPath => dirname(dirname(scriptPath))
