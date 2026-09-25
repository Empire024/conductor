// V1 verify S21: phone capture. Enables phone access in a parked desktop instance, pairs a real
// Chromium context at a phone viewport (390x844) the way a phone would (typing the pairing code
// into the real form), and drives #/ideas: full-screen editor with focus, autosave, list persistence.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-phone-ideas.mjs
import { _electron as electron, chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-v1-phone-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# V1 phone ideas smoke\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, browser, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 15 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  await page.evaluate(() => window.conductor.projects.create('V1 phone ideas'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  await page.locator('.project-row').filter({ hasText: 'V1 phone ideas' }).first().click()

  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'phone listener did not start: ' + desktop.message)
  const origin = desktop.primaryEndpoint
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  const code = desktop.pairing.code
  console.log('pairing code', code, 'origin', origin)

  browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, isMobile: true, hasTouch: true })
  const phone = await context.newPage()
  await phone.goto(origin + '/', { waitUntil: 'load' })
  await phone.locator('.code-input').first().waitFor({ timeout: 15_000 })
  await phone.locator('.code-input').first().fill(code)
  await phone.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect.poll(() => phone.evaluate(() => window.location.hash), { timeout: 15_000 }).not.toMatch(/pair/i)
  record('S21-pair', 'PASS', `paired at ${origin} from a 390x844 context, code ${code}`)
  await phone.screenshot({ path: join(output, 's21-paired-home.png') })

  await phone.goto(origin + '/#/ideas', { waitUntil: 'load' })
  await phone.waitForTimeout(500)
  const noFormNoTitleField = await phone.locator('form.pair-form, input[placeholder*="Title" i]').count()
  const focusedIsEditor = await phone.evaluate(() => { const el = document.activeElement; return Boolean(el) && (el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true') })
  await phone.screenshot({ path: join(output, 's21-ideas-new.png') })
  record('S21-full-screen-editor', noFormNoTitleField === 0 && focusedIsEditor ? 'PASS' : 'FAIL', `no form/title-field=${noFormNoTitleField === 0}, editor focused=${focusedIsEditor}`)

  await phone.keyboard.type('Phone idea capture line one\nSecond line from the phone')
  await phone.waitForTimeout(2500) // autosave debounce (IDEA_SAVE_DEBOUNCE_MS = 700ms in src/phone/app.js)
  // A real phone taps the in-note "Ideas" toolbar button (aria-label="Ideas", src/phone/app.js
  // ideaEditorScreen) which flushes the save and does a client-side hash route to #/ideas/list; a
  // hard page reload straight to that URL hits "Could not read the ideas. Unknown route." because
  // #/ideas/list is a client-side sub-route of the note screen, not a fresh-boot deep link.
  await phone.locator('.idea-bar-button[aria-label="Ideas"]').first().click()
  await phone.waitForTimeout(800)
  await phone.screenshot({ path: join(output, 's21-ideas-list.png') })
  let listHasIt = await phone.locator('text=Phone idea capture line one').count()
  if (!listHasIt) { await phone.waitForTimeout(1500); listHasIt = await phone.locator('text=Phone idea capture line one').count() }
  record('S21-autosave-and-list', listHasIt > 0 ? 'PASS' : 'FAIL', `idea visible in #/ideas/list after leaving (in-app nav) and returning: ${listHasIt > 0}`)
  // Also confirm the deep-link route note as its own (real, separate) finding.
  await phone.goto(origin + '/#/ideas/list', { waitUntil: 'load' })
  await phone.waitForTimeout(500)
  const deepLinkBroken = await phone.locator('text=Unknown route').count()
  await phone.screenshot({ path: join(output, 's21-deeplink-list.png') })
  record('S21-deeplink-list', deepLinkBroken > 0 ? 'FAIL (real)' : 'PASS', `hard-reloading straight to #/ideas/list: ${deepLinkBroken > 0 ? '"Could not read the ideas. Unknown route." -- a fresh page load cannot deep-link to the list route' : 'loaded fine'}`)

  // Bottom bar with familiar icons (owner spec §5-6).
  const tabBarIcons = await phone.locator('nav, .tab-bar, [class*=tab-bar]').first().locator('button, a').count().catch(() => 0)
  await phone.screenshot({ path: join(output, 's21-bottom-bar.png') })
  record('S21-bottom-bar', tabBarIcons > 0 ? 'PASS' : 'FAIL', `bottom bar buttons/links found: ${tabBarIcons}`)
} catch (error) {
  failed = error
  record('S21-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await browser?.close().catch(() => {})
  await Promise.race([app?.close().catch(() => {}), new Promise(r => setTimeout(r, 15_000))])
  try { app?.process().kill() } catch {}
  await writeFile(join(output, 's21-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S21 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed) process.exit(1)
