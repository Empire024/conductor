import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
const watchdog = setTimeout(async () => {
  console.error('WATCHDOG exceeded 200s at ' + lastStep)
  await writeFile(join(output, 'b4r-partial.json'), JSON.stringify({ lastStep }, null, 2)).catch(() => {})
  process.exit(2)
}, 200_000)
watchdog.unref()
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const b = args.at(-1)?.buttons ?? []; const i = b.findIndex(l => l === "Don't Save" || l === 'Stop work and quit'); return { response: i >= 0 ? i : 0, checkboxChecked: false } } }),
    new Promise((r) => setTimeout(r, 5000))
  ]).catch(() => {})
  let pid; try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 20000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}

const root = await mkdtemp(join(tmpdir(), 'conductor-v2b4r-'))
const capture = join(root, 'capture.txt')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
let result = { label: 'B4r', pass: false }
try {
  step('setting viewport 1600x1000')
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
  step('creating project')
  await page.evaluate(() => window.conductor.projects.create('B4r fixture'))
  await page.reload()
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.locator('.project-row').filter({ hasText: 'B4r fixture' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const composer = page.getByRole('textbox', { name: /Message Claude/i })
  await expect(composer).toBeEnabled({ timeout: 20000 })
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  step('sending SYNTHETIC PERMISSION ONCE')
  await composer.fill('SYNTHETIC PERMISSION ONCE')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const pending = page.locator('form.sa-interaction')
  await expect(pending.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled({ timeout: 20000 })

  step('typing SYNTHETIC B during approval')
  await composer.fill('SYNTHETIC B during approval')
  await page.screenshot({ path: join(output, 'b4r-1-typed.png'), fullPage: false })
  const buttons = await page.locator('.agent-prompt-controls button, .sa-composer button').evaluateAll(nodes => nodes.map(n => ({
    ariaLabel: n.getAttribute('aria-label'), text: n.textContent?.trim(), disabled: n.disabled, visible: !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length)
  })))
  step('buttons before Enter: ' + JSON.stringify(buttons))

  step('pressing Enter')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(output, 'b4r-2-after-enter.png'), fullPage: false })
  const snap1 = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
  const pendingInteraction = snap1.items.find(i => i.data.type === 'interaction' && i.data.interaction.status === 'pending')
  const pendingExists = await pending.count()
  const allowVisible = pendingExists ? await pending.getByRole('button', { name: 'Allow once', exact: true }).isVisible().catch(() => false) : false
  const allowEnabled = pendingExists ? await pending.getByRole('button', { name: 'Allow once', exact: true }).isEnabled().catch(() => false) : false
  const outerHtmlHead = pendingExists ? (await pending.evaluate(el => el.outerHTML).catch(() => '<err>')).slice(0, 600) : '<no form.sa-interaction>'
  step('after Enter: phase=' + snap1.phase + ' queuedPrompts=' + (snap1.queuedPrompts?.length ?? 0) + ' pendingSteering=' + (snap1.pendingSteering?.length ?? 0) + ' pendingInteraction=' + Boolean(pendingInteraction) + ' allowVisible=' + allowVisible + ' allowEnabled=' + allowEnabled)

  let allowClickError = null
  try {
    await pending.getByRole('button', { name: 'Allow once', exact: true }).click({ timeout: 10000 })
  } catch (error) { allowClickError = String(error?.message ?? error) }
  await page.screenshot({ path: join(output, 'b4r-3-after-allow.png'), fullPage: false })
  step('waiting 15s to observe final phase')
  await page.waitForTimeout(15000)
  const snap2 = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
  const captureText = await readFile(capture, 'utf8').catch(() => '<none>')

  result = {
    label: 'B4r', pass: true,
    record: {
      buttonsBeforeEnter: buttons,
      afterEnter: { phase: snap1.phase, queuedPrompts: snap1.queuedPrompts?.length ?? 0, pendingSteering: snap1.pendingSteering?.length ?? 0, pendingInteractionPresent: Boolean(pendingInteraction), formPresent: pendingExists > 0, allowVisible, allowEnabled, outerHtmlHead },
      allowClickError,
      finalPhaseAfter15s: snap2.phase,
      finalUserBubbles: snap2.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text),
      captureFileTail: captureText.slice(-500)
    }
  }
  console.log('RESULT ' + JSON.stringify(result.record))
} catch (error) {
  result = { label: 'B4r', pass: false, error: String(error?.stack ?? error), lastStep }
  console.error('FAIL B4r at [' + lastStep + ']: ' + error)
  await page.screenshot({ path: join(output, 'b4r-failure.png') }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await writeFile(join(output, 'b4r-result.json'), JSON.stringify(result, null, 2))
  await safeClose(app)
}
process.exit(0)
