import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronFake = vi.hoisted(() => {
  let nextContentsId = 20
  class Emitter {
    listeners = new Map<string, Array<(...args: any[]) => void>>()
    on(name: string, fn: (...args: any[]) => void): this { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); return this }
    once(name: string, fn: (...args: any[]) => void): this { const once = (...args: any[]): void => { this.off(name, once); fn(...args) }; return this.on(name, once) }
    off(name: string, fn: (...args: any[]) => void): this { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== fn)); return this }
    emit(name: string, ...args: any[]): void { for (const fn of [...this.listeners.get(name) ?? []]) fn(...args) }
    listenerCount(name: string): number { return this.listeners.get(name)?.length ?? 0 }
  }
  class FakeContents extends Emitter {
    id = nextContentsId++
    url = ''; title = ''; loading = false; destroyed = false
    emulation?: { viewSize: { width: number; height: number }; scale: number }
    popup?: (details: { url: string }) => unknown
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} }
    async loadURL(url: string): Promise<void> { this.url = url; this.emit('did-navigate'); this.emit('did-stop-loading') }
    getURL(): string { return this.url }
    getTitle(): string { return this.title }
    isLoading(): boolean { return this.loading }
    isDestroyed(): boolean { return this.destroyed }
    getType(): string { return 'window' }
    setWindowOpenHandler(handler: (details: { url: string }) => unknown): void { this.popup = handler }
    reload(): void {}
    openDevTools(): void {}
    enableDeviceEmulation(parameters: { viewSize: { width: number; height: number }; scale: number }): void { this.emulation = parameters }
    async executeJavaScript(): Promise<string> { return 'null' }
    capturePage(): never { throw new Error('not used') }
    close(): void { this.destroyed = true; this.emit('destroyed') }
  }
  const created: FakeView[] = []
  class FakeView {
    webContents = new FakeContents(); bounds = { x: 0, y: 0, width: 0, height: 0 }; visible = false
    constructor(readonly options: { webPreferences: { partition: string } }) { created.push(this) }
    setBounds(bounds: typeof this.bounds): void { this.bounds = bounds }
    setVisible(visible: boolean): void { this.visible = visible }
  }
  class FakeWindow extends Emitter {
    destroyed = false; visible = false; webContents = new FakeContents(); children: FakeView[] = []
    constructor(readonly options: Record<string, unknown> = {}) { super(); windows.push(this) }
    contentView = { addChildView: (view: FakeView): void => { if (!this.children.includes(view)) this.children.push(view) }, removeChildView: (view: FakeView): void => { this.children = this.children.filter(item => item !== view) } }
    isDestroyed(): boolean { return this.destroyed }
    isVisible(): boolean { return this.visible }
    showInactive(): void { this.visible = true }
    getContentBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 900, height: 700 } }
    close(): void { this.destroyed = true; this.emit('closed') }
  }
  const windows: FakeWindow[] = []
  return { created, windows, FakeWindow, FakeView, reset: (): void => { created.splice(0); windows.splice(0); nextContentsId = 20 } }
})

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(electronFake.FakeWindow, { getAllWindows: () => [] }),
  WebContentsView: electronFake.FakeView,
  webContents: { fromId: () => undefined }
}))

import { BrowserViews } from './browser-views'

const { created, windows, FakeWindow } = electronFake
beforeEach(() => electronFake.reset())

describe('main-owned project browser surfaces', () => {
  it('creates a parked project guest with a real viewport for authorized background MCP access', async () => {
    const openBrowserTab = vi.fn(async () => {})
    const manager = new BrowserViews({ tabs: () => [], openBrowserTab, rendererPath: 'C:/out/index.html' })
    const view = await manager.view({ projectId: 'project-a', sessionId: 'workspace-a', agentSessionId: 'agent-a' })
    expect(view.tabId).toBe('project-browser:project-a')
    expect(created).toHaveLength(1)
    expect(created[0]?.visible).toBe(true)
    expect(created[0]?.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(windows).toHaveLength(1)
    expect(windows[0]?.children).toEqual([created[0]])
    expect(windows[0]?.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, x: -32_000, y: -32_000 })
    expect(openBrowserTab).not.toHaveBeenCalled()
    const owner = new FakeWindow()
    const mounted = await manager.mount(owner as never, { projectId: 'project-a', surfaceId: 'surface-a', initialUrl: 'https://example.test', bounds: { x: 5, y: 10, width: 500, height: 600 }, visible: true })
    expect(mounted.webContentsId).toBe(created[0]?.webContents.id)
    expect(owner.children).toEqual([created[0]])
    expect(windows[0]?.destroyed).toBe(true)
  })

  it('keeps the same guest through hide, expand, detach, background and project changes', async () => {
    const detached: Array<InstanceType<typeof FakeWindow>> = []
    const states: number[] = []
    const manager = new BrowserViews({
      tabs: () => [], openBrowserTab: async () => {}, rendererPath: 'C:/out/index.html',
      createDetachedWindow: (_projectId, onClosed) => { const window = new FakeWindow(); window.once('closed', onClosed); detached.push(window); return window as never },
      publishState: state => states.push(state.webContentsId)
    })
    const owner = new FakeWindow()
    const base = { projectId: 'project-a', surfaceId: 'project-browser:project-a', initialUrl: 'http://localhost:4173', bounds: { x: 48, y: 80, width: 286, height: 620 }, viewport: { width: 390, height: 844 }, visible: true }
    const first = await manager.mount(owner as never, base)
    const id = first.webContentsId
    expect(created[0]?.options.webPreferences.partition).toBe('persist:conductor-browser-project-a')
    expect(created[0]?.visible).toBe(true)
    expect(created[0]?.webContents.emulation?.viewSize).toEqual({ width: 390, height: 844 })
    expect(created[0]?.webContents.emulation?.scale).toBeCloseTo(286 / 390)

    manager.update(owner as never, { ...base, visible: false })
    expect(created[0]?.visible).toBe(false)
    manager.update(owner as never, { ...base, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false })
    expect(created[0]?.bounds).toEqual({ x: 48, y: 80, width: 286, height: 620 })
    manager.update(owner as never, { ...base, bounds: { x: 48, y: 39, width: 1100, height: 760 }, visible: true })
    expect(created[0]?.bounds.width).toBe(1100)
    expect(manager.present('project-a', 'detached').webContentsId).toBe(id)
    expect(detached[0]?.children[0]).toBe(created[0])
    expect(detached[0]?.visible).toBe(true)
    expect(manager.present('project-a', 'background').webContentsId).toBe(id)
    expect(created[0]?.visible).toBe(false)

    await manager.mount(new FakeWindow() as never, { ...base, projectId: 'project-b', surfaceId: 'project-browser:project-b' })
    expect(created[1]?.options.webPreferences.partition).toBe('persist:conductor-browser-project-b')
    expect((await manager.view({ projectId: 'project-a', sessionId: 'workspace-a', agentSessionId: 'agent-a' })).tabId).toBe('project-browser:project-a')
    expect(created[0]?.webContents.id).toBe(id)
    expect(states.every(value => value === id || value === created[1]?.webContents.id)).toBe(true)
  })

  it('denies popups on the owned guest and never creates a second guest for a remount', async () => {
    const manager = new BrowserViews({ tabs: () => [], openBrowserTab: async () => {}, rendererPath: 'C:/out/index.html' })
    const owner = new FakeWindow()
    const request = { projectId: 'project-a', surfaceId: 'surface-a', initialUrl: 'https://example.com', bounds: { x: 1, y: 2, width: 300, height: 400 }, visible: true }
    const first = await manager.mount(owner as never, request)
    const second = await manager.mount(owner as never, { ...request, bounds: { ...request.bounds, width: 500 } })
    expect(second.webContentsId).toBe(first.webContentsId)
    expect(created).toHaveLength(1)
    expect(created[0]?.webContents.popup?.({ url: 'https://evil.test' })).toEqual({ action: 'deny' })
  })

  it('never resurrects a parking host while the application is closing', async () => {
    const manager = new BrowserViews({ tabs: () => [], openBrowserTab: async () => {}, rendererPath: 'C:/out/index.html' })
    const owner = new FakeWindow()
    await manager.mount(owner as never, { projectId: 'project-a', surfaceId: 'surface-a', initialUrl: 'https://example.test', bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true })
    expect(windows).toHaveLength(1)

    manager.releaseWindow(owner as never, true)

    expect(windows).toHaveLength(1)
    expect(owner.children).toEqual([])
    expect(created[0]?.visible).toBe(false)
  })
})
