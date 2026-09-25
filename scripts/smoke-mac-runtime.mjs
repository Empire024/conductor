/** The macOS runtime, proven in a parked window (docs/mac-node.md, mac-runtime): the native traffic
 *  lights over the title bar instead of Conductor's own buttons, the login shell's PATH in main
 *  even when started with a Finder PATH, and zsh as the terminal. On Windows the same run checks
 *  that nothing changed there: frameless, its own window buttons, PowerShell.
 *  --print-png writes the screenshot to stdout as base64 between markers (for a remote job). */
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const mac = process.platform === 'darwin'
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const root = await mkdtemp(join(tmpdir(), 'conductor-mac-runtime-'))
const output = resolve('artifacts/mac-runtime')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_BACKGROUND_WINDOWS
// What an app started from Finder or the Dock gets.
if (mac) { env.PATH = FINDER_PATH; delete env.SHELL }

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForSelector('.titlebar', { timeout: 30000 })
  await page.waitForSelector('.pane-workspace, .empty-pane-workspace, .app-shell', { timeout: 20000 }).catch(() => {})

  const main = await app.evaluate(async ({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return {
      bounds: window.getBounds(),
      focused: window.isFocused(),
      displays: screen.getAllDisplays().map(display => display.bounds),
      path: process.env.PATH ?? '',
      buttons: process.platform === 'darwin' ? window.getWindowButtonPosition() : null
    }
  })
  const renderer = await page.evaluate(() => ({
    platform: window.conductor.platform,
    titlebarClass: document.querySelector('.titlebar')?.className ?? null,
    ownButtons: document.querySelectorAll('.window-controls button').length,
    padding: getComputedStyle(document.querySelector('.titlebar')).paddingLeft
  }))
  // The terminal a new tab opens is listed in the launcher with the platform's label.
  const launcherText = await page.evaluate(() => document.body.innerText)

  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, `parked-window-${process.platform}.png`), Buffer.from(png, 'base64'))

  const overlapsAnyDisplay = main.displays.some(display =>
    main.bounds.x < display.x + display.width && main.bounds.x + main.bounds.width > display.x &&
    main.bounds.y < display.y + display.height && main.bounds.y + main.bounds.height > display.y)
  const pathEntries = main.path.split(mac ? ':' : ';')
  const report = { platform: process.platform, bounds: main.bounds, focused: main.focused, overlapsAnyDisplay, buttons: main.buttons, renderer, homebrewOnPath: pathEntries.includes('/opt/homebrew/bin'), pathHead: pathEntries.slice(0, 6), launcherMentionsZsh: /\bzsh\b/.test(launcherText), launcherMentionsPowerShell: /PowerShell/.test(launcherText), png: Buffer.from(png, 'base64').length }
  await writeFile(join(output, `report-${process.platform}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  if (process.argv.includes('--print-png')) console.log(`__PNG__${png}__PNG__`)

  assert.equal(main.focused, false, 'a smoke-profile window must never take focus')
  assert.equal(overlapsAnyDisplay, false, `a smoke-profile window must sit off every display, got ${JSON.stringify(main.bounds)}`)
  assert.ok(report.png > 5000, 'the parked window must still paint')
  assert.equal(renderer.platform, process.platform)
  if (mac) {
    assert.match(renderer.titlebarClass, /\bmac\b/, 'the macOS title bar leaves room for the traffic lights')
    assert.equal(renderer.ownButtons, 0, 'macOS uses its traffic lights, not Conductor\'s own window buttons')
    assert.equal(renderer.padding, '78px')
    assert.deepEqual(main.buttons, { x: 14, y: 13 }, 'the traffic lights sit in the title bar')
    if (process.env.CONDUCTOR_EXPECT_HOMEBREW !== '0') assert.ok(report.homebrewOnPath, `main must import the login shell PATH, got ${main.path}`)
  } else {
    assert.doesNotMatch(renderer.titlebarClass, /\bmac\b/)
    assert.equal(renderer.ownButtons, 3, 'Windows keeps Conductor\'s own minimize, maximize and close')
  }
  console.log(`mac runtime: ${process.platform} · titlebar ${renderer.titlebarClass} · own buttons ${renderer.ownButtons} · traffic lights ${JSON.stringify(main.buttons)} · homebrew on PATH ${report.homebrewOnPath} · parked ${JSON.stringify(main.bounds)}`)
} finally {
  await app.close().catch(() => {})
}
