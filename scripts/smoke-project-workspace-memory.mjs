// Switching away from a project and back must land on the workspace the owner last had open in
// that project, not always its first one. The memory is per project, survives an app restart, and
// falls back to the first workspace when the remembered one is gone.
//
// Same harness as smoke-mixed-project-activity.mjs: the real Electron UI over SQLite. Every launch
// here sets CONDUCTOR_TEST_USER_DATA, so the window is parked far off-screen and never takes focus.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-workspace-memory-'))
const output = resolve('artifacts/project-workspace-memory')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const errors = []
const failures = []
const observed = {}
const check = (name, actual, expected) => {
  observed[name] = actual
  if (actual === expected) console.log(`PASS ${name}: ${actual}`)
  else { failures.push(`${name}: expected ${expected}, observed ${actual}`); console.log(`FAIL ${name}: expected ${expected}, observed ${actual}`) }
}

const launch = async () => {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.sidebar-section.projects-section').waitFor()
  const shot = async (name) => {
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'))
  }
  return {
    app,
    page,
    shot,
    row: (name) => page.locator('.project-row').filter({ hasText: name }),
    // The workspace tab the app actually has on screen.
    open: () => page.locator('.session-tab.active .session-tab-name').innerText()
  }
}

let session = await launch()
try {
  await session.page.evaluate(() => window.conductor.projects.create('Alpha'))
  await session.page.evaluate(() => window.conductor.projects.create('Beta'))
} finally {
  await session.app.close().catch(() => {})
}

session = await launch()
let { app, page, shot, row, open } = session
try {
  const addWorkspace = async (count) => {
    await page.locator('.session-add').click()
    await expect(page.locator('.session-tab')).toHaveCount(count)
  }
  // The workspace a project starts with is just called 'Workspace', so every match here is exact.
  const selectWorkspace = async (name) => {
    await page.locator('.session-tab-name').filter({ hasText: new RegExp(`^${name}$`) }).click()
    await expect.poll(open).toBe(name)
  }

  // Beta gets three workspaces and the owner settles on the third; Alpha gets two and settles on
  // the second. Neither is the first one in view, so a fallback to loaded[0] would be visible.
  await row('Beta').click()
  await addWorkspace(2)
  await addWorkspace(3)
  await selectWorkspace('Workspace 3')

  await row('Alpha').click()
  await addWorkspace(2)
  await selectWorkspace('Workspace 2')

  await row('Beta').click()
  check('returning to Beta', await open(), 'Workspace 3')
  await shot('back-in-beta')
  await row('Alpha').click()
  check('returning to Alpha keeps its own workspace', await open(), 'Workspace 2')
  await shot('back-in-alpha')

  // Each project remembers separately, and a fresh selection replaces the old memory.
  await row('Beta').click()
  await selectWorkspace('Workspace')
  await row('Alpha').click()
  await row('Beta').click()
  check('a new selection replaces the remembered workspace', await open(), 'Workspace')

  await selectWorkspace('Workspace 3')
  await row('Alpha').click()
} finally {
  await app.close().catch(() => {})
}

// The memory is a recovery checkpoint, so it has to survive a restart: Alpha reopens on its own
// last workspace, and Beta still remembers the one it was left on.
session = await launch()
;({ app, page, shot, row, open } = session)
try {
  check('the project restored at startup', await page.locator('.project-row.active').innerText().then((value) => value.trim()), 'Alpha')
  check('its workspace restored at startup', await open(), 'Workspace 2')
  await row('Beta').click()
  check('the other project remembered across the restart', await open(), 'Workspace 3')
  await shot('after-restart')

  // Closing the remembered workspace moves the app to its neighbour, and that neighbour is what
  // the project is remembered on: coming back must never land on a workspace that is gone, nor
  // silently reset to the first one.
  await page.locator('.session-tab.active .session-tab-close').click()
  await expect(page.locator('.session-tab')).toHaveCount(2)
  check('closing the remembered workspace moves to its neighbour', await open(), 'Workspace 2')
  await row('Alpha').click()
  await row('Beta').click()
  check('returning after the close', await open(), 'Workspace 2')
} finally {
  await app.close().catch(() => {})
}

console.log(JSON.stringify({ root, observed, failures, errors }, null, 2))
assert.deepEqual(failures, [])
assert.deepEqual(errors, [])
