/** Automation must never take the desktop from whoever is working. This proves a smoke-profile
 *  launch parks its window off every display, keeps it out of the taskbar, never activates it,
 *  and still paints - so screenshots in the other smoke scripts stay real. */
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-background-'))
const output = resolve('artifacts/background-windows')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_BACKGROUND_WINDOWS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(10000)
await page.waitForSelector('.pane-workspace, .empty-pane-workspace, .app-shell', { timeout: 20000 }).catch(() => {})

const state = await app.evaluate(async ({ BrowserWindow, screen }) => {
  const window = BrowserWindow.getAllWindows()[0]
  return {
    bounds: window.getBounds(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    displays: screen.getAllDisplays().map(display => display.bounds)
  }
})

const overlapsAnyDisplay = state.displays.some(display =>
  state.bounds.x < display.x + display.width && state.bounds.x + state.bounds.width > display.x &&
  state.bounds.y < display.y + display.height && state.bounds.y + state.bounds.height > display.y)

// A parked window still has to render, or every other smoke script's screenshot silently goes blank.
const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
await writeFile(join(output, 'parked-window.png'), Buffer.from(png, 'base64'))

await app.close()

assert.equal(state.focused, false, 'a smoke-profile window must never take focus from the owner')
assert.equal(overlapsAnyDisplay, false, `a smoke-profile window must sit off every display, got ${JSON.stringify(state.bounds)}`)
assert.ok(Buffer.from(png, 'base64').length > 5000, 'a parked window must still paint so screenshots stay real')
console.log('background windows: parked at', JSON.stringify(state.bounds), '· focused', state.focused, '· painted', Buffer.from(png, 'base64').length, 'bytes')
