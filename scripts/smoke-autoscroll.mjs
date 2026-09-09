import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import ts from 'typescript'

// Real Chromium mouse/keyboard gestures against the production autoscroll module.
// The isolated Electron page has no Conductor backend, provider or credentials.
const root = await mkdtemp(join(tmpdir(), 'conductor-autoscroll-'))
const main = join(root, 'main.cjs')
await writeFile(main, `const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(join(root, 'profile'))}); app.whenReady().then(() => { const window = new BrowserWindow({ width: 800, height: 600 }); window.loadURL('data:text/html,<html><body></body></html>'); });`)
const env = { CONDUCTOR_BACKGROUND_WINDOWS: '1', ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [main], env })
const checks = []
try {
  const page = await app.firstWindow()
  await page.setContent('<div id="surface" style="width:500px;height:300px;overflow:auto"><button id="action" style="width:220px;height:60px">Action</button><div data-autoscroll="off"><button id="tab" style="width:220px;height:60px">Tab</button></div><div style="height:2000px"></div></div>')
  const source = await readFile(resolve('src/renderer/src/autoscroll.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  await page.addScriptTag({ content: `const exports = {}; ${compiled}; window.disposeAutoscroll = exports.installAutoscroll(document);` })
  await page.evaluate(() => {
    window.actions = { click: 0, auxclick: 0, contextmenu: 0, tab: 0 }
    for (const type of ['click', 'auxclick', 'contextmenu']) document.querySelector('#action').addEventListener(type, () => window.actions[type]++)
    // Real workspace tabs own mousedown and prevent Chromium's native middle behavior.
    document.querySelector('#tab').addEventListener('mousedown', event => { if (event.button === 1) { event.preventDefault(); window.actions.tab++ } })
    document.querySelector('#tab').addEventListener('auxclick', event => event.preventDefault())
  })
  const action = page.locator('#action')
  const active = () => page.evaluate(() => document.body.classList.contains('autoscrolling'))
  const counts = () => page.evaluate(() => ({ ...window.actions }))
  await action.click({ button: 'middle' })
  assert.equal(await active(), true)
  assert.equal((await counts()).auxclick, 0)
  await action.click()
  assert.equal(await active(), false)
  assert.equal((await counts()).click, 0)
  await action.click()
  assert.equal((await counts()).click, 1)
  checks.push('Start and stop gestures do not fire underlying actions; the next deliberate click works')

  await action.click({ button: 'middle' })
  await action.click({ button: 'middle' })
  assert.equal(await active(), false)
  assert.equal((await counts()).auxclick, 0)
  await action.click({ button: 'middle' })
  await action.click({ button: 'right' })
  assert.equal(await active(), false)
  assert.equal((await counts()).auxclick, 0)
  assert.equal((await counts()).contextmenu, 0)
  checks.push('Middle/right stopping gestures consume auxiliary clicks and their context menu')

  for (const key of ['Enter', 'Space']) {
    await action.focus()
    await action.click({ button: 'middle' })
    const before = (await counts()).click
    await page.keyboard.press(key)
    assert.equal(await active(), false)
    assert.equal((await counts()).click, before)
    await page.keyboard.press(key)
    assert.equal((await counts()).click, before + 1)
  }
  await action.focus()
  await action.click({ button: 'middle' })
  const beforeRepeat = (await counts()).click
  await page.keyboard.down('Enter')
  await page.keyboard.down('Enter')
  assert.equal((await counts()).click, beforeRepeat)
  await page.keyboard.up('Enter')
  await page.keyboard.press('Enter')
  assert.equal((await counts()).click, beforeRepeat + 1)
  checks.push('Enter, held Enter and Space stop scrolling without activating the focused action; the next keypress works')

  await page.locator('#tab').click({ button: 'middle' })
  assert.equal(await active(), false)
  assert.equal((await counts()).tab, 1)
  checks.push('Excluded tab strips retain their original middle-click behavior')

  await action.click({ button: 'middle' })
  await page.keyboard.press('Escape')
  const beforeWheel = (await counts()).click
  await action.click({ button: 'middle' })
  await page.mouse.wheel(0, 0)
  await expect.poll(active).toBe(false)
  await action.click()
  assert.equal((await counts()).click, beforeWheel + 1)
  checks.push('Escape and wheel cancellation do not consume the next independent click')

  await action.click({ button: 'middle' })
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(650, 450)
  await page.mouse.up({ button: 'left' })
  const beforeNewGesture = (await counts()).click
  await action.click()
  assert.equal((await counts()).click, beforeNewGesture + 1)
  await page.evaluate(() => window.disposeAutoscroll())
  await action.dispatchEvent('auxclick', { button: 1 })
  assert.equal((await counts()).auxclick, 1)
  checks.push('An incomplete stop gesture cannot swallow a later click, and disposing removes all gesture handlers')
  console.log(JSON.stringify({ checks, failures: [] }, null, 2))
} finally {
  await app.close()
}
