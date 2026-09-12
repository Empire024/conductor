import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Narrow lifecycle probe for the hidden main-owned browser host. It creates one idle browser
// session in an isolated profile, asks Electron to quit through the real app lifecycle, records
// every app/window transition in the main process, and force-cleans only after preserving a
// timeout inventory. It never submits a model prompt or touches an owner profile.
const root = await mkdtemp(join(tmpdir(), 'conductor-browser-quit-'))
const output = resolve('artifacts/browser-quit-diagnostic')
const capture = join(root, 'mcp-config.json')
const lifecycle = join(root, 'lifecycle.jsonl')
const slot = JSON.parse(await readFile(resolve('artifacts/fixer-coordination/electron-slot.json'), 'utf8'))
const buildIdentity = String(slot.build ?? 'unknown-build').replace(/[^a-zA-Z0-9._-]+/g, '-')
const evidenceId = `${buildIdentity}-generation${slot.generation}`
await mkdir(output, { recursive: true })
const report = { build: slot.build, generation: slot.generation, syntheticProvider: true, root, quit: {}, lifecycle: [], failures: [] }

const site = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Quit diagnostic</title><h1>Useful parked browser</h1>')
})
await new Promise(resolvePort => site.listen(0, '127.0.0.1', resolvePort))
const origin = `http://127.0.0.1:${site.address().port}`
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_BROWSER_MCP_CAPTURE: capture,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_BACKGROUND_WINDOWS: '1'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

let app
let child
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  child = app.process()
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const project = await page.evaluate(() => window.conductor.projects.create('Browser quit diagnostic'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const pane = page.locator('.structured-agent-pane:visible')
  await expect(pane.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const sessionId = await pane.getAttribute('data-structured-session')
  assert.ok(sessionId)
  await pane.getByRole('button', { name: 'Enable browser tools', exact: true }).click()
  await page.evaluate(id => window.conductor.structured.connect(id), sessionId)
  await expect.poll(() => readFile(capture, 'utf8').then(text => text.includes('conductor-browser')).catch(() => false)).toBe(true)
  const config = JSON.parse(await readFile(capture, 'utf8'))
  const server = config.mcpServers['conductor-browser']
  let rpcId = 0
  const rpc = async (method, params) => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(!body.error, JSON.stringify(body.error))
    return body.result
  }
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'quit-diagnostic', version: '1' } })
  const navigation = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: origin } })
  assert.notEqual(navigation.isError, true)
  const dimensions = await rpc('tools/call', { name: 'browser_evaluate', arguments: { code: '({width:innerWidth,height:innerHeight,body:document.body.getBoundingClientRect().width})' } })
  const viewport = JSON.parse(dimensions.content[0].text)
  assert.ok(viewport.width > 0 && viewport.height > 0 && viewport.body > 0, JSON.stringify(viewport))
  report.viewport = viewport

  await app.evaluate(({ app: electronApp, BrowserWindow }, path) => {
    const fs = process.getBuiltinModule('node:fs')
    const windowState = window => ({
      id: window.id,
      title: window.getTitle(),
      visible: window.isVisible(),
      focusable: window.isFocusable(),
      destroyed: window.isDestroyed(),
      bounds: window.getBounds()
    })
    const record = (event, details = {}) => {
      try { fs.appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n') }
      catch {}
    }
    const observeWindow = window => {
      const initial = windowState(window)
      record('window-observed', { window: initial })
      window.on('close', event => record('window-close', { defaultPrevented: event.defaultPrevented, window: windowState(window) }))
      window.on('closed', () => record('window-closed', { id: initial.id, title: initial.title }))
      window.webContents.on('render-process-gone', (_event, details) => record('renderer-gone', { id: initial.id, reason: details.reason }))
    }
    BrowserWindow.getAllWindows().forEach(observeWindow)
    electronApp.on('browser-window-created', (_event, window) => { record('browser-window-created'); observeWindow(window) })
    electronApp.on('before-quit', event => record('before-quit', { defaultPrevented: event.defaultPrevented, windows: BrowserWindow.getAllWindows().map(windowState) }))
    electronApp.on('window-all-closed', () => record('window-all-closed'))
    electronApp.on('will-quit', event => record('will-quit', { defaultPrevented: event.defaultPrevented, windows: BrowserWindow.getAllWindows().map(windowState) }))
    electronApp.on('quit', (_event, code) => record('quit', { code }))
    process.on('uncaughtExceptionMonitor', error => record('uncaught-exception', { error: error.stack ?? String(error) }))
    process.on('unhandledRejection', reason => record('unhandled-rejection', { error: reason instanceof Error ? reason.stack : String(reason) }))
    record('quit-requested', { windows: BrowserWindow.getAllWindows().map(windowState) })
    electronApp.quit()
  }, lifecycle).catch(error => {
    // A successful quit can close the evaluation transport before it acknowledges the call.
    report.quit.evaluateError = String(error)
  })

  const exited = new Promise(resolveExit => {
    if (child.exitCode !== null) resolveExit({ code: child.exitCode, signal: child.signalCode })
    else child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  const outcome = await Promise.race([exited.then(exit => ({ exited: true, exit })), new Promise(resolveTimeout => setTimeout(() => resolveTimeout({ exited: false }), 10_000))])
  report.quit.outcome = outcome
  if (!outcome.exited) {
    report.quit.timeoutWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
      id: window.id,
      title: window.getTitle(),
      visible: window.isVisible(),
      focusable: window.isFocusable(),
      destroyed: window.isDestroyed(),
      bounds: window.getBounds()
    }))).catch(error => ({ error: String(error) }))
    // `ChildProcess.kill()` on Windows can retire Playwright's loader while leaving Chromium's
    // process tree orphaned. Ask the isolated Electron main process to force-exit first; the
    // wrapper's outer cleanup remains a final guard.
    await app.evaluate(({ app: electronApp }) => electronApp.exit(2)).catch(error => { report.quit.exitEvaluateError = String(error) })
    report.quit.forcedExit = await Promise.race([exited, new Promise(resolveTimeout => setTimeout(() => resolveTimeout({ timeout: true }), 5_000))])
    if (child.exitCode === null) child.kill()
  }
} catch (error) {
  report.failures.push(error.stack ?? String(error))
  await app?.evaluate(({ app: electronApp }) => electronApp.exit(2)).catch(() => {})
  if (child?.exitCode === null) child.kill()
} finally {
  report.lifecycle = await readFile(lifecycle, 'utf8').then(text => text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(() => [])
  await writeFile(join(output, `report-${evidenceId}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  await new Promise(resolveClose => site.close(resolveClose))
}

console.log(JSON.stringify(report, null, 2))
if (report.failures.length) process.exitCode = 1
