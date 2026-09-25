import { describe, expect, it } from 'vitest'
import { assessReadiness, BIOS_POWER_NOTE, localReadiness, parsePowercfgAcSeconds, parseRegValue, parseScStartType, parseScState, parseTailscaleUnattended, probeWindowsFacts, type CommandResult, type CommandRunner, type WindowsReadinessFacts } from './machine-readiness'

const powercfg = (ac: string, dc = '0x00000000', english = true): string => [
  'Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)',
  '  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)',
  '    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)',
  '      Minimum Possible Setting: 0x00000000',
  '      Maximum Possible Setting: 0xffffffff',
  '      Possible Settings increment: 0x00000001',
  '      Possible Settings units: Seconds',
  english ? `    Current AC Power Setting Index: ${ac}` : `    Aktueller Index für Wechselstromeinstellung: ${ac}`,
  english ? `    Current DC Power Setting Index: ${dc}` : `    Aktueller Index für Gleichstromeinstellung: ${dc}`
].join('\r\n')

const SC_RUNNING = 'SERVICE_NAME: Tailscale \r\n        TYPE               : 10  WIN32_OWN_PROCESS  \r\n        STATE              : 4  RUNNING \r\n'
const SC_STOPPED = 'SERVICE_NAME: Tailscale \r\n        STATE              : 1  STOPPED \r\n'
const SC_MISSING = '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n'
const qc = (start: string): string => `[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: Tailscale\r\n        START_TYPE         : ${start}\r\n        BINARY_PATH_NAME   : "C:\\Program Files\\Tailscale\\tailscaled.exe"\r\n`
const REG_MISSING = 'ERROR: The system was unable to find the specified registry key or value.\r\n'
const reg = (name: string, value: string): string => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`

/** A fake Windows: each command answers from the table, keyed by program and its arguments. */
function fakeWindows(table: Record<string, CommandResult>): { run: CommandRunner; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async (file, args) => {
      const key = `${file.split('\\').pop()} ${args.join(' ')}`
      calls.push(key)
      const hit = Object.entries(table).find(([pattern]) => key.includes(pattern))
      if (!hit) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return hit[1]
    }
  }
}

const ready = (overrides: Record<string, CommandResult> = {}): Record<string, CommandResult> => ({
  STANDBYIDLE: { code: 0, stdout: powercfg('0x00000000') },
  HIBERNATEIDLE: { code: 0, stdout: powercfg('0x00000000') },
  'query Tailscale': { code: 0, stdout: SC_RUNNING },
  'qc Tailscale': { code: 0, stdout: qc('2   AUTO_START') },
  'AutoAdminLogon': { code: 0, stdout: reg('AutoAdminLogon', '1') },
  'DefaultUserName': { code: 0, stdout: reg('DefaultUserName', 'stilj') },
  'debug prefs': { code: 0, stdout: '{\n\t"WantRunning": true,\n\t"ForceDaemon": true,\n}' },
  ...overrides
})

describe('parsers', () => {
  it('reads the AC sleep timeout in seconds, in English and from localized output', () => {
    expect(parsePowercfgAcSeconds(powercfg('0x00000000'))).toBe(0)
    expect(parsePowercfgAcSeconds(powercfg('0x00000708', '0x00000384'))).toBe(1800)
    expect(parsePowercfgAcSeconds(powercfg('0x00000384', '0x00000000', false))).toBe(900)
    expect(parsePowercfgAcSeconds('Invalid Parameters -- try "/?" for help')).toBeNull()
  })
  it('reads the service state and start type by number', () => {
    expect(parseScState({ code: 0, stdout: SC_RUNNING })).toBe('running')
    expect(parseScState({ code: 0, stdout: SC_STOPPED })).toBe('stopped')
    expect(parseScState({ code: 1060, stdout: SC_MISSING })).toBe('absent')
    expect(parseScState({ code: null, stdout: '' })).toBeNull()
    expect(parseScStartType(qc('2   AUTO_START  (DELAYED)'))).toBe('auto')
    expect(parseScStartType(qc('3   DEMAND_START'))).toBe('manual')
    expect(parseScStartType(qc('4   DISABLED'))).toBe('disabled')
  })
  it('reads one registry value and treats a missing one as absent', () => {
    expect(parseRegValue(reg('AutoAdminLogon', '1'), 'AutoAdminLogon')).toBe('1')
    expect(parseRegValue(reg('DefaultUserName', 'Juraj Dubovec'), 'DefaultUserName')).toBe('Juraj Dubovec')
    expect(parseRegValue(REG_MISSING, 'AutoAdminLogon')).toBeNull()
  })
  it('reads Tailscale unattended mode', () => {
    expect(parseTailscaleUnattended('{"ForceDaemon": true}')).toBe(true)
    expect(parseTailscaleUnattended('{"ForceDaemon": false}')).toBe(false)
    expect(parseTailscaleUnattended('')).toBeNull()
  })
})

describe('probeWindowsFacts', () => {
  it('only reads, and never the whole Winlogon key', async () => {
    const fake = fakeWindows(ready())
    await probeWindowsFacts(fake.run)
    expect(fake.calls.every(call => /^(powercfg \/query|sc\.exe (query|qc)|reg query|tailscale\.exe debug prefs)/.test(call))).toBe(true)
    const winlogon = fake.calls.filter(call => call.includes('Winlogon'))
    expect(winlogon).toHaveLength(2)
    expect(winlogon.every(call => / \/v (AutoAdminLogon|DefaultUserName)$/.test(call))).toBe(true)
    expect(fake.calls.join('\n')).not.toMatch(/DefaultPassword|\/change|\/setacvalueindex| add | config /i)
  })
  it('is ready when every piece is in place', async () => {
    const facts = await probeWindowsFacts(fakeWindows(ready()).run)
    const result = assessReadiness({ platform: 'win32', windows: facts, conductorAtLogin: true, failsafe: { phoneEnabled: true, lockConfigured: true } })
    expect(result.checks.map(check => [check.id, check.ok])).toEqual([['sleep', true], ['boot-unlock', true], ['tailscale', true], ['conductor', true], ['failsafe', true]])
    expect(result.ready).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.notes).toContain(BIOS_POWER_NOTE)
    expect(result.checks.find(check => check.id === 'boot-unlock')!.detail).toContain('as stilj')
  })
  it('names each missing step in words', async () => {
    const facts = await probeWindowsFacts(fakeWindows(ready({
      STANDBYIDLE: { code: 0, stdout: powercfg('0x00000708') },
      HIBERNATEIDLE: { code: 0, stdout: powercfg('0x00002a30') },
      'qc Tailscale': { code: 0, stdout: qc('3   DEMAND_START') },
      'AutoAdminLogon': { code: 1, stdout: REG_MISSING },
      'DefaultUserName': { code: 1, stdout: REG_MISSING }
    })).run)
    expect(facts.autoLogon).toEqual({ enabled: false, user: null })
    const result = assessReadiness({ platform: 'win32', windows: facts, conductorAtLogin: false, failsafe: { phoneEnabled: true, lockConfigured: false } })
    expect(result.ready).toBe(false)
    expect(result.missing).toHaveLength(5)
    expect(result.missing[0]).toMatch(/^Never sleeps on AC power: sleeps after 30 min and hibernates after 180 min on AC power: .*Never/)
    expect(result.missing[1]).toMatch(/sign-in screen .*Autologon/)
    expect(result.missing[2]).toMatch(/starts manually: Services > Tailscale > Startup type Automatic/)
    expect(result.missing[3]).toMatch(/Start Conductor when I log in/)
    expect(result.missing[4]).toMatch(/set a 6-digit code in Settings > Phone/)
  })
  it('asks for Tailscale unattended mode only when nobody signs in automatically', async () => {
    const manualSignIn = await probeWindowsFacts(fakeWindows(ready({ 'debug prefs': { code: 0, stdout: '{"ForceDaemon": false}' }, 'AutoAdminLogon': { code: 0, stdout: reg('AutoAdminLogon', '0') } })).run)
    const tailscale = assessReadiness({ platform: 'win32', windows: manualSignIn, conductorAtLogin: true, failsafe: null }).checks.find(check => check.id === 'tailscale')!
    expect(tailscale.ok).toBe(false)
    expect(tailscale.detail).toMatch(/Run unattended/)
    const autoSignIn = await probeWindowsFacts(fakeWindows(ready({ 'debug prefs': { code: 0, stdout: '{"ForceDaemon": false}' } })).run)
    expect(assessReadiness({ platform: 'win32', windows: autoSignIn, conductorAtLogin: true, failsafe: null }).checks.find(check => check.id === 'tailscale')!.ok).toBe(true)
  })
  it('says "unknown" rather than guessing when a tool is missing', async () => {
    const facts = await probeWindowsFacts(fakeWindows({}).run)
    expect(facts).toEqual({ sleepAcSeconds: null, hibernateAcSeconds: null, tailscale: { state: null, startType: null, unattended: null }, autoLogon: { enabled: null, user: null } })
    const result = assessReadiness({ platform: 'win32', windows: facts, conductorAtLogin: null, failsafe: null })
    expect(result.checks.every(check => check.ok === null)).toBe(true)
    expect(result.ready).toBe(false)
    expect(result.missing).toHaveLength(5)
  })
  it('reports Tailscale absent', async () => {
    const facts = await probeWindowsFacts(fakeWindows(ready({ 'query Tailscale': { code: 1060, stdout: SC_MISSING }, 'qc Tailscale': { code: 1060, stdout: SC_MISSING } })).run)
    const check = assessReadiness({ platform: 'win32', windows: facts, conductorAtLogin: true, failsafe: null }).checks.find(entry => entry.id === 'tailscale')!
    expect(check).toMatchObject({ ok: false, detail: 'Tailscale is not installed' })
  })
})

describe('failsafe', () => {
  it('is satisfied by the phone lock, or by phone access being off', () => {
    const check = (failsafe: { phoneEnabled: boolean; lockConfigured: boolean }): boolean | null => assessReadiness({ platform: 'linux', conductorAtLogin: true, failsafe }).checks.find(entry => entry.id === 'failsafe')!.ok
    expect(check({ phoneEnabled: true, lockConfigured: true })).toBe(true)
    expect(check({ phoneEnabled: false, lockConfigured: false })).toBe(true)
    expect(check({ phoneEnabled: true, lockConfigured: false })).toBe(false)
  })
})

describe('localReadiness', () => {
  it('probes once per cache window but reads the login item fresh', async () => {
    const fake = fakeWindows(ready())
    let atLogin = false
    const read = localReadiness({ platform: 'win32', run: fake.run, conductorAtLogin: () => atLogin, failsafe: () => ({ phoneEnabled: false, lockConfigured: false }) })
    const [first] = await Promise.all([read(), read()])
    expect(first.checks.find(check => check.id === 'conductor')!.ok).toBe(false)
    const probes = fake.calls.length
    atLogin = true
    const second = await read()
    expect(fake.calls.length).toBe(probes)
    expect(second.checks.find(check => check.id === 'conductor')!.ok).toBe(true)
    expect(second.ready).toBe(true)
    await read({ refresh: true })
    expect(fake.calls.length).toBe(probes * 2)
  })
  it('runs no Windows commands on macOS', async () => {
    const fake = fakeWindows(ready())
    const result = await localReadiness({ platform: 'darwin', run: fake.run, conductorAtLogin: () => true, failsafe: () => null })()
    expect(fake.calls).toEqual([])
    expect(result.checks.map(check => check.id)).toEqual(['conductor', 'failsafe'])
    expect(result.notes[0]).toMatch(/nodes\.probe/)
  })
})
