import { execFile } from 'node:child_process'
import type { LocalMachineReadiness, LocalReadinessCheck } from '../shared/always-on'

/**
 * Whether this computer is on when it is needed, with no one at it (feature always-on-machines):
 * it does not sleep on AC power, it gets past its sign-in screen after a reboot, Tailscale comes up
 * by itself, Conductor opens at login, and Conductor's own lock guards remote access once it does.
 *
 * Everything here only reads. Conductor never changes the owner's power plan, registry or sign-in;
 * each missing item names the step the owner takes. The Winlogon key is read one named value at a
 * time and never whole, because it can hold a plain-text DefaultPassword.
 *
 * The Mac half of the same feature is a node's readiness (src/main/remote-jobs/capabilities.ts).
 */

export interface CommandResult { code: number | null; stdout: string }
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>

export interface WindowsReadinessFacts {
  /** Seconds before sleep on AC power; 0 is never. null: powercfg did not say. */
  sleepAcSeconds: number | null
  hibernateAcSeconds: number | null
  tailscale: {
    state: 'running' | 'stopped' | 'absent' | null
    startType: 'auto' | 'manual' | 'disabled' | null
    /** Tailscale's "Run unattended" (ForceDaemon): the tailnet stays up with no one signed in. */
    unattended: boolean | null
  }
  autoLogon: { enabled: boolean | null; user: string | null }
}

export interface FailsafeFacts {
  /** Phone access is turned on in Settings > Phone. */
  phoneEnabled: boolean
  /** A 6-digit phone lock code is set (src/main/phone-lock.ts). */
  lockConfigured: boolean
}

export interface ReadinessInputs {
  platform: NodeJS.Platform
  /** Conductor's own login item; null when it could not be read. */
  conductorAtLogin: boolean | null
  failsafe: FailsafeFacts | null
  windows?: WindowsReadinessFacts
}

const WINLOGON = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
const TAILSCALE_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe'

export const BIOS_POWER_NOTE = 'Starting again after a power cut is a BIOS/UEFI setting ("Restore on AC power loss" or "AC Back", set to Power On). Conductor cannot read it; check it once in the firmware setup.'

/** "Current AC Power Setting Index: 0x00000384" -> 900. Localized output still ends with the AC then DC index. */
export function parsePowercfgAcSeconds(output: string): number | null {
  const labelled = /AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(output)
  if (labelled?.[1]) return parseInt(labelled[1], 16)
  const values = [...output.matchAll(/0x([0-9a-f]{8})\b/gi)].map(match => parseInt(match[1] ?? '', 16))
  // Minimum, maximum, increment, then the AC and DC indexes: the AC one is second to last.
  return values.length >= 5 ? values[values.length - 2] ?? null : null
}

/** sc query: "STATE : 4 RUNNING". The numbers are the same in every Windows language. */
export function parseScState(result: CommandResult): WindowsReadinessFacts['tailscale']['state'] {
  const state = /STATE\s*:\s*(\d+)/.exec(result.stdout)
  if (state) return state[1] === '4' ? 'running' : 'stopped'
  // 1060: the specified service does not exist.
  return result.code === 1060 || /1060/.test(result.stdout) ? 'absent' : null
}

/** sc qc: "START_TYPE : 2 AUTO_START" (2 automatic, also delayed; 3 manual; 4 disabled). */
export function parseScStartType(output: string): WindowsReadinessFacts['tailscale']['startType'] {
  const start = /START_TYPE\s*:\s*(\d+)/.exec(output)?.[1]
  return start === '2' ? 'auto' : start === '3' ? 'manual' : start === '4' ? 'disabled' : null
}

/** reg query ... /v Name: "    AutoAdminLogon    REG_SZ    1". Missing value -> null. */
export function parseRegValue(output: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s*(.*)$`, 'im').exec(output)
  return match ? (match[1] ?? '').trim() : null
}

/** `tailscale debug prefs` is JSON; only ForceDaemon is read. */
export function parseTailscaleUnattended(output: string): boolean | null {
  const match = /"ForceDaemon"\s*:\s*(true|false)/.exec(output)
  return match ? match[1] === 'true' : null
}

export async function probeWindowsFacts(run: CommandRunner): Promise<WindowsReadinessFacts> {
  const safe = async (file: string, args: string[]): Promise<CommandResult> => {
    try { return await run(file, args) } catch { return { code: null, stdout: '' } }
  }
  const [standby, hibernate, query, config, autoAdmin, userName, prefs] = await Promise.all([
    safe('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']),
    safe('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'HIBERNATEIDLE']),
    safe('sc.exe', ['query', 'Tailscale']),
    safe('sc.exe', ['qc', 'Tailscale']),
    safe('reg', ['query', WINLOGON, '/v', 'AutoAdminLogon']),
    safe('reg', ['query', WINLOGON, '/v', 'DefaultUserName']),
    safe(TAILSCALE_CLI, ['debug', 'prefs'])
  ])
  const autoAdminValue = parseRegValue(autoAdmin.stdout, 'AutoAdminLogon')
  return {
    sleepAcSeconds: parsePowercfgAcSeconds(standby.stdout),
    hibernateAcSeconds: parsePowercfgAcSeconds(hibernate.stdout),
    tailscale: { state: parseScState(query), startType: parseScStartType(config.stdout), unattended: parseTailscaleUnattended(prefs.stdout) },
    // A missing value is a definite "off": reg answers, the value just is not there.
    autoLogon: { enabled: autoAdminValue === null ? (autoAdmin.code === null ? null : false) : autoAdminValue === '1', user: parseRegValue(userName.stdout, 'DefaultUserName') || null }
  }
}

const minutes = (seconds: number): string => seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`

export function assessReadiness(inputs: ReadinessInputs, now = new Date()): LocalMachineReadiness {
  const checks: LocalReadinessCheck[] = []
  const add = (id: LocalReadinessCheck['id'], label: string, ok: boolean | null, detail: string): void => { checks.push({ id, label, ok, detail }) }
  const notes: string[] = []
  const facts = inputs.windows
  if (inputs.platform === 'win32' && facts) {
    const { sleepAcSeconds: sleep, hibernateAcSeconds: hibernate } = facts
    const sleepOk = sleep === null ? null : sleep === 0 && (hibernate === null || hibernate === 0)
    const timers = [sleep ? `sleeps after ${minutes(sleep)}` : '', hibernate ? `hibernates after ${minutes(hibernate)}` : ''].filter(Boolean).join(' and ')
    add('sleep', 'Never sleeps on AC power', sleepOk,
      sleep === null ? 'powercfg did not say'
        : sleepOk ? 'sleep and hibernate are off on AC power'
          : `${timers} on AC power: Settings > System > Power > "When plugged in, put my device to sleep after" Never (or powercfg /change standby-timeout-ac 0 and powercfg /change hibernate-timeout-ac 0)`)
    const logon = facts.autoLogon
    add('boot-unlock', 'Signs in by itself after a reboot', logon.enabled,
      logon.enabled ? `Windows signs in automatically${logon.user ? ` as ${logon.user}` : ''}`
        : logon.enabled === false ? 'Windows waits at its sign-in screen after a reboot, so Conductor does not start: turn on automatic sign-in with Sysinternals Autologon (keeps the password encrypted) or netplwiz. If netplwiz has no checkbox, first turn off Settings > Accounts > Sign-in options > "Only allow Windows Hello sign-in"'
          : 'the Winlogon setting could not be read')
    const ts = facts.tailscale
    const service = ts.state === 'running' && ts.startType === 'auto'
    const survivesSignOut = ts.unattended === true || logon.enabled === true
    add('tailscale', 'Tailscale starts on its own', ts.state === null && ts.startType === null ? null : service && (ts.unattended !== false || logon.enabled === true),
      ts.state === 'absent' ? 'Tailscale is not installed'
        : ts.startType && ts.startType !== 'auto' ? `the Tailscale service starts ${ts.startType === 'manual' ? 'manually' : 'never (disabled)'}: Services > Tailscale > Startup type Automatic`
          : ts.state !== 'running' ? 'the Tailscale service is not running'
            : !survivesSignOut && ts.unattended === false ? 'the Tailscale service starts at boot, but the tailnet only connects once someone signs in: turn on "Run unattended" in the Tailscale menu, or automatic sign-in'
              : `the Tailscale service starts at boot${ts.unattended ? ' and runs unattended' : ''}`)
    notes.push(BIOS_POWER_NOTE)
  } else if (inputs.platform === 'darwin') {
    notes.push('Sleep, restart after a power cut, FileVault and automatic login on a Mac are read by nodes.probe for an execution node (docs/mac-node.md "Unattended operation").')
  }
  add('conductor', 'Conductor opens at login', inputs.conductorAtLogin,
    inputs.conductorAtLogin ? 'Conductor opens minimized at login' : inputs.conductorAtLogin === false ? 'turn on Settings > Machines > "Start Conductor when I log in"' : 'the login item could not be read')
  const fs = inputs.failsafe
  add('failsafe', 'Remote access needs the Conductor code', fs ? !fs.phoneEnabled || fs.lockConfigured : null,
    !fs ? 'phone access state is not known'
      : !fs.phoneEnabled ? 'phone access is off'
        : fs.lockConfigured ? 'every phone needs the 6-digit code again after any restart'
          : 'phone access is on without a code, so a paired phone gets straight in after an unattended start: set a 6-digit code in Settings > Phone')
  const missing = checks.filter(check => check.ok !== true).map(check => `${check.label}: ${check.detail}`)
  return { platform: inputs.platform, ready: checks.every(check => check.ok === true), checks, missing, notes, checkedAt: now.toISOString() }
}

export const execRunner: CommandRunner = (file, args) => new Promise(resolve => {
  execFile(file, args, { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
    // A non-zero exit carries its number; a missing program (ENOENT) or a timeout has none.
    const exit = (error as { code?: unknown } | null)?.code
    const code = !error ? 0 : typeof exit === 'number' ? exit : null
    resolve({ code, stdout: String(stdout ?? '') })
  })
})

export interface LocalReadinessDeps {
  platform?: NodeJS.Platform
  run?: CommandRunner
  conductorAtLogin(): boolean | null
  failsafe(): FailsafeFacts | null
  /** How long a probe answers repeat calls; the checks change only when the owner changes a setting. */
  cacheMs?: number
}

/** The readiness of the machine this Conductor runs on, probed at most every cacheMs. */
export function localReadiness(deps: LocalReadinessDeps): (options?: { refresh?: boolean }) => Promise<LocalMachineReadiness> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? execRunner
  const cacheMs = deps.cacheMs ?? 30_000
  let cached: { at: number; facts: WindowsReadinessFacts | undefined } | null = null
  let pending: Promise<WindowsReadinessFacts | undefined> | null = null
  return async options => {
    if (options?.refresh || !cached || Date.now() - cached.at > cacheMs) {
      pending ??= (platform === 'win32' ? probeWindowsFacts(run) : Promise.resolve(undefined)).finally(() => { pending = null })
      cached = { at: Date.now(), facts: await pending }
    }
    // Conductor's own items are read fresh, so the toggle shows at once.
    return assessReadiness({ platform, windows: cached.facts, conductorAtLogin: deps.conductorAtLogin(), failsafe: deps.failsafe() })
  }
}
