import { describe, expect, it } from 'vitest'
import { workspaceWindowChrome } from './window-chrome'

describe('workspace window chrome', () => {
  it('stays frameless with its own buttons on Windows and Linux, parked or not', () => {
    for (const platform of ['win32', 'linux'] as const) for (const parked of [false, true]) {
      expect(workspaceWindowChrome(platform, parked)).toEqual({ frame: { frame: false }, webPreferences: {} })
    }
  })

  it('keeps the macOS traffic lights over the title bar and never throttles a parked window', () => {
    expect(workspaceWindowChrome('darwin', false)).toEqual({ frame: { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 } }, webPreferences: {} })
    expect(workspaceWindowChrome('darwin', true).webPreferences).toEqual({ backgroundThrottling: false })
    expect(workspaceWindowChrome('darwin', true).frame).not.toHaveProperty('frame')
  })
})
