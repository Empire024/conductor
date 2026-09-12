import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  let nextId = 1
  class Contents {
    id = nextId++; url = ''; navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    on(): void {} once(): void {} off(): void {}
    setWindowOpenHandler(): void {}
    isDestroyed(): boolean { return false }
    async loadURL(url: string): Promise<void> { this.url = url }
    getURL(): string { return this.url }
    getTitle(): string { return '' }
    isLoading(): boolean { return false }
    reload(): void {}
  }
  class View {
    webContents = new Contents(); visible = false
    setVisible(value: boolean): void { this.visible = value }
    setBounds(): void {}
  }
  class Window {
    webContents = new Contents(); visible = false; children = new Set<View>(); closed?: () => void
    contentView = { addChildView: (view: View) => this.children.add(view), removeChildView: (view: View) => this.children.delete(view) }
    isDestroyed(): boolean { return false }
    isVisible(): boolean { return this.visible }
    showInactive(): void { this.visible = true }
    getContentBounds(): object { return { x: 0, y: 0, width: 800, height: 600 } }
    on(): void {}
    close(): void { /* Native close completion can arrive in a later event-loop turn. */ }
  }
  return { View, Window }
})
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, WebContentsView: fake.View, webContents: { fromId: () => undefined } }))
import { BrowserViews } from './browser-views'

async function setup() {
  const owner = new fake.Window(), detached: InstanceType<typeof fake.Window>[] = []
  const manager = new BrowserViews({ tabs: () => [], openBrowserTab: async () => {}, rendererPath: 'C:/out/index.html', createDetachedWindow: (_project, closed) => {
    const window = new fake.Window(); window.closed = closed; detached.push(window); return window as never
  } })
  await manager.mount(owner as never, { projectId: 'project-a', surfaceId: 'surface-a', initialUrl: 'https://example.test', bounds: { x: 0, y: 40, width: 800, height: 560 }, visible: true })
  return { manager, owner, detached }
}

describe('browser native-window completion races', () => {
  it('does not let a late detached close hide an already reattached pane', async () => {
    const { manager, owner, detached } = await setup()
    manager.present('project-a', 'detached')
    manager.present('project-a', 'pane')
    detached[0]!.closed!()
    expect([...owner.children][0]?.visible).toBe(true)
    expect((await manager.command('project-a', { type: 'reload' })).presentation).toBe('pane')
  })

  it('does not let an old window completion orphan a newer detached presentation', async () => {
    const { manager, detached } = await setup()
    manager.present('project-a', 'detached')
    manager.present('project-a', 'background')
    manager.present('project-a', 'detached')
    detached[0]!.closed!()
    expect((await manager.command('project-a', { type: 'reload' })).presentation).toBe('detached')
    expect([...detached[1]!.children][0]?.visible).toBe(true)
  })
})
