import { describe, expect, it } from 'vitest'
import { LOGIN_START_ARG, LoginItem, type LoginItemApp } from './login-item'

function fakeApp(initial: { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean } = { openAtLogin: false }): LoginItemApp & { writes: unknown[]; reads: unknown[] } {
  let current = { ...initial }
  const writes: unknown[] = []
  const reads: unknown[] = []
  return {
    writes, reads,
    getLoginItemSettings: options => { reads.push(options); return { ...current } },
    setLoginItemSettings: settings => { writes.push(settings); current = { openAtLogin: settings.openAtLogin, executableWillLaunchAtLogin: settings.openAtLogin } }
  }
}
const store = (): { values: Map<string, string>; getSetting(key: string): string | undefined; setSetting(key: string, value: string): void } => {
  const values = new Map<string, string>()
  return { values, getSetting: key => values.get(key), setSetting: (key, value) => { values.set(key, value) } }
}

describe('LoginItem', () => {
  it('is off until the owner turns it on', () => {
    const item = new LoginItem({ app: fakeApp(), platform: 'win32', execPath: 'C:\\Conductor\\Conductor.exe', argv: ['Conductor.exe'], system: true, store: store() })
    expect(item.state()).toEqual({ enabled: false, backend: 'system', startedAtLogin: false })
  })
  it('registers the installed exe with the login-start argument on Windows', () => {
    const app = fakeApp()
    const item = new LoginItem({ app, platform: 'win32', execPath: 'C:\\Conductor\\Conductor.exe', argv: [], system: true, store: store() })
    expect(item.set(true).enabled).toBe(true)
    expect(app.writes).toEqual([{ openAtLogin: true, path: 'C:\\Conductor\\Conductor.exe', args: [LOGIN_START_ARG] }])
    expect(app.reads.at(-1)).toEqual({ path: 'C:\\Conductor\\Conductor.exe', args: [LOGIN_START_ARG] })
    expect(item.set(false).enabled).toBe(false)
  })
  it('reads an entry disabled in Task Manager as off', () => {
    const item = new LoginItem({ app: fakeApp({ openAtLogin: true, executableWillLaunchAtLogin: false }), platform: 'win32', execPath: 'x', argv: [], system: true, store: store() })
    expect(item.enabled()).toBe(false)
  })
  it('uses the plain login item on macOS', () => {
    const app = fakeApp()
    new LoginItem({ app, platform: 'darwin', execPath: '/Applications/Conductor.app/Contents/MacOS/Conductor', argv: [], system: true, store: store() }).set(true)
    expect(app.writes).toEqual([{ openAtLogin: true }])
  })
  it('never touches the OS from a development or test build', () => {
    const app = fakeApp()
    const settings = store()
    const item = new LoginItem({ app, platform: 'win32', execPath: 'electron.exe', argv: [], system: false, store: settings })
    expect(item.set(true)).toEqual({ enabled: true, backend: 'simulated', startedAtLogin: false })
    expect(app.writes).toEqual([])
    expect(app.reads).toEqual([])
    expect(settings.values.get('startAtLoginSimulated')).toBe('true')
  })
  it('knows a run was started by the login item', () => {
    expect(new LoginItem({ app: fakeApp(), platform: 'win32', execPath: 'x', argv: ['x', LOGIN_START_ARG], system: true, store: store() }).startedAtLogin).toBe(true)
  })
})
