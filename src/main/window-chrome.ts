import type { BrowserWindowConstructorOptions } from 'electron'

/** Where macOS draws the traffic lights: vertically centred in the 39 px title bar, which leaves
 *  them the first 78 px of it (styles.css `.titlebar.mac`). */
export const TRAFFIC_LIGHTS = { x: 14, y: 13 } as const

/**
 * The frame of a workspace window. Windows and Linux get no native frame, and the title bar draws
 * its own minimize, maximize and close buttons. macOS keeps its native traffic lights over the
 * title bar (titleBarStyle hidden), and the title bar leaves them room instead of drawing its own.
 * A parked automation window on macOS is occluded, which would pause its rendering, so it is not
 * throttled in the background.
 */
export function workspaceWindowChrome(platform: NodeJS.Platform, parked: boolean): { frame: Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'trafficLightPosition'>; webPreferences: Pick<NonNullable<BrowserWindowConstructorOptions['webPreferences']>, 'backgroundThrottling'> } {
  if (platform !== 'darwin') return { frame: { frame: false }, webPreferences: {} }
  return { frame: { titleBarStyle: 'hidden', trafficLightPosition: { ...TRAFFIC_LIGHTS } }, webPreferences: parked ? { backgroundThrottling: false } : {} }
}
