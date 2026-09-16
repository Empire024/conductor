import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const trays: Array<{ tooltip: string; menu: unknown; destroyed: boolean }> = []
  const menus: Array<Array<{ label: string; click(): void }>> = []
  class FakeTray {
    readonly record = { tooltip: '', menu: null as unknown, destroyed: false }
    constructor() { trays.push(this.record) }
    setToolTip(tooltip: string): void { this.record.tooltip = tooltip }
    setContextMenu(menu: unknown): void { this.record.menu = menu }
    destroy(): void { this.record.destroyed = true }
  }
  return { trays, menus, FakeTray }
})

vi.mock('electron', () => ({
  Tray: electron.FakeTray,
  Menu: { buildFromTemplate: (items: Array<{ label: string; click(): void }>) => { electron.menus.push(items); return items } },
  nativeImage: { createFromPath: (path: string) => ({ path }) }
}))

import type { HostTray, HostTrayItem, LifecycleEvent } from './host-lifecycle'

const { electronTray, installHostLifecycle, nameList } = await import('./host-lifecycle')

interface Harness {
  listeners: Map<string, Array<(event: LifecycleEvent) => void>>
  trays: Array<{ tooltip: string; items: HostTrayItem[]; destroyed: boolean }>
  quits: number
  shown: number
  asked: string[]
}

/** The tray click and the before-quit hook both run an async question; let it settle. */
const settle = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

describe('installHostLifecycle', () => {
  let state: { enabled: boolean; listening: boolean; attachedPeers: string[] }
  let answer: boolean
  let harness: Harness

  const install = (platform: NodeJS.Platform = 'win32', options: { withTray?: boolean; installBeforeQuit?: boolean } = {}) => {
    harness = { listeners: new Map(), trays: [], quits: 0, shown: 0, asked: [] }
    const app = {
      on(event: string, listener: (event: LifecycleEvent) => void) {
        harness.listeners.set(event, [...(harness.listeners.get(event) ?? []), listener])
        return app
      }
    }
    const createTray = (): HostTray => {
      const record = { tooltip: '', items: [] as HostTrayItem[], destroyed: false }
      harness.trays.push(record)
      return {
        update: (tooltip, items) => { record.tooltip = tooltip; record.items = items },
        destroy: () => { record.destroyed = true }
      }
    }
    return installHostLifecycle(app, {
      hosting: () => state,
      showWindow: () => { harness.shown++ },
      confirm: async message => { harness.asked.push(message); return answer },
      quit: () => { harness.quits++ },
      platform,
      ...(options.withTray === false ? {} : { createTray }),
      ...(options.installBeforeQuit ? { installBeforeQuit: true } : {})
    })
  }

  const closeLastWindow = (): void => {
    for (const listener of harness.listeners.get('window-all-closed') ?? []) listener({ preventDefault: () => undefined })
  }

  beforeEach(() => {
    state = { enabled: true, listening: true, attachedPeers: [] }
    answer = true
    electron.trays.length = 0
    electron.menus.length = 0
  })

  it('keeps today\'s behaviour when hosting is off: the last window closing quits', () => {
    state = { enabled: false, listening: false, attachedPeers: [] }
    const lifecycle = install()
    expect(lifecycle.keepAlive()).toBe(false)
    closeLastWindow()
    expect(harness.quits).toBe(1)
    expect(harness.trays).toHaveLength(0)
  })

  it('stays alive behind a tray while it is hosting', () => {
    const lifecycle = install()
    expect(lifecycle.keepAlive()).toBe(true)
    closeLastWindow()
    expect(harness.quits).toBe(0)
    expect(harness.trays).toHaveLength(1)
    expect(harness.trays[0]?.tooltip).toBe('Conductor is hosting')
  })

  it('quits when hosting is switched on but the listener is not up', () => {
    state = { enabled: true, listening: false, attachedPeers: ['LAPTOP'] }
    install()
    closeLastWindow()
    expect(harness.quits).toBe(1)
  })

  it('leaves macOS alone: it never quit on the last window and it still does not', () => {
    state = { enabled: false, listening: false, attachedPeers: [] }
    install('darwin')
    closeLastWindow()
    expect(harness.quits).toBe(0)
  })

  it('names the machines it is hosting for in the tray', () => {
    state = { enabled: true, listening: true, attachedPeers: ['LAPTOP', 'TABLET'] }
    install()
    closeLastWindow()
    expect(harness.trays[0]?.tooltip).toBe('Conductor is hosting for LAPTOP and TABLET')
  })

  it('offers a way back in and a way out', () => {
    install()
    closeLastWindow()
    const items = harness.trays[0]!.items
    expect(items.map(item => item.label)).toEqual(['Open Conductor', 'Stop hosting and quit'])
    items[0]!.click()
    expect(harness.shown).toBe(1)
    // Opening a window means the tray is no longer the only way back.
    expect(harness.trays[0]?.destroyed).toBe(true)
  })

  it('stops hosting and quits from the tray once the question is answered', async () => {
    state = { enabled: true, listening: true, attachedPeers: ['LAPTOP'] }
    install()
    closeLastWindow()
    harness.trays[0]!.items[1]!.click()
    await settle()
    expect(harness.asked).toEqual(['Stop hosting for LAPTOP? Their attached tabs will disconnect; work already running here continues until you close it.'])
    expect(harness.quits).toBe(1)
  })

  it('does not quit when the owner says no', async () => {
    state = { enabled: true, listening: true, attachedPeers: ['LAPTOP'] }
    answer = false
    install()
    closeLastWindow()
    harness.trays[0]!.items[1]!.click()
    await settle()
    expect(harness.quits).toBe(0)
  })

  it('asks nothing when nobody is attached', async () => {
    const lifecycle = install()
    expect(await lifecycle.confirmStopHosting()).toBe(true)
    expect(harness.asked).toEqual([])
  })

  it('asks before disconnecting the machines that are attached', async () => {
    state = { enabled: true, listening: true, attachedPeers: ['LAPTOP', 'TABLET', 'PHONE'] }
    const lifecycle = install()
    expect(await lifecycle.confirmStopHosting()).toBe(true)
    expect(harness.asked).toEqual(['Stop hosting for LAPTOP, TABLET and PHONE? Their attached tabs will disconnect; work already running here continues until you close it.'])
  })

  it('takes the tray away when hosting stops', () => {
    const lifecycle = install()
    closeLastWindow()
    expect(harness.trays[0]?.destroyed).toBe(false)
    state = { enabled: false, listening: false, attachedPeers: [] }
    lifecycle.refresh()
    expect(harness.trays[0]?.destroyed).toBe(true)
  })

  it('puts the tray back when the window closes again', () => {
    const lifecycle = install()
    closeLastWindow()
    lifecycle.windowOpened()
    closeLastWindow()
    expect(harness.trays).toHaveLength(2)
    expect(harness.trays[1]?.destroyed).toBe(false)
  })

  it('keeps the process alive even where no tray could be created', () => {
    const lifecycle = install('linux', { withTray: false })
    closeLastWindow()
    expect(lifecycle.keepAlive()).toBe(true)
    expect(harness.quits).toBe(0)
  })

  it('leaves the tray behind when it is disposed', () => {
    const lifecycle = install()
    closeLastWindow()
    lifecycle.dispose()
    expect(harness.trays[0]?.destroyed).toBe(true)
  })

  it('answers a malformed hosting report as not hosting rather than throwing', () => {
    state = { enabled: true, listening: true, attachedPeers: undefined as unknown as string[] }
    const lifecycle = install()
    expect(lifecycle.keepAlive()).toBe(true)
    closeLastWindow()
    expect(harness.trays[0]?.tooltip).toBe('Conductor is hosting')
  })

  it('holds the quit back to ask, only when it was asked to own that event', async () => {
    state = { enabled: true, listening: true, attachedPeers: ['LAPTOP'] }
    install('win32', { installBeforeQuit: true })
    let prevented = false
    for (const listener of harness.listeners.get('before-quit') ?? []) listener({ preventDefault: () => { prevented = true } })
    await settle()
    expect(prevented).toBe(true)
    expect(harness.asked).toHaveLength(1)
    expect(harness.quits).toBe(1)
  })

  it('does not touch before-quit unless it was asked to', () => {
    install()
    expect(harness.listeners.has('before-quit')).toBe(false)
  })
})

describe('nameList', () => {
  it.each([
    [[], ''],
    [['LAPTOP'], 'LAPTOP'],
    [['LAPTOP', 'TABLET'], 'LAPTOP and TABLET'],
    [['LAPTOP', 'TABLET', 'PHONE'], 'LAPTOP, TABLET and PHONE'],
    [['  ', 'LAPTOP'], 'LAPTOP']
  ])('reads %j as a sentence', (names, expected) => {
    expect(nameList(names)).toBe(expected)
  })
})

describe('electronTray', () => {
  it('drives a real tray through the same small interface', () => {
    electron.trays.length = 0
    electron.menus.length = 0
    const tray = electronTray('C:\\icon.png')
    const click = vi.fn()
    tray.update('Conductor is hosting', [{ label: 'Open Conductor', click }])
    expect(electron.trays[0]?.tooltip).toBe('Conductor is hosting')
    electron.menus[0]![0]!.click()
    expect(click).toHaveBeenCalled()
    tray.destroy()
    expect(electron.trays[0]?.destroyed).toBe(true)
  })
})
