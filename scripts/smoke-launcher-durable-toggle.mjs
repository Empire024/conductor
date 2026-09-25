// RV1 fix for durable-jobs-as-local-option: durable is a toggle on each local model's own launcher
// tile (LauncherPane.tsx .launcher-tile-durable-toggle), not a second "Local model for durable
// work" picker below the grid defaulting to Ornith (docs/verification/2026-09-25-rv1.md B4).
// Fast: stub models only, no local server or durable job started.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-launcher-durable-toggle.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'conductor-launcher-durable-toggle-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# launcher durable toggle smoke\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 3 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(name => window.conductor.projects.create(name), 'Launcher durable toggle smoke')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'Launcher durable toggle smoke' }).first().click()
  await page.locator('.launcher-grid').first().waitFor({ timeout: 20_000 })

  // No second model picker: the old "Local model for durable work" section is gone.
  const oldOption = await page.locator('.launcher-durable-option').count()
  record('no-second-picker-at-rest', oldOption === 0 ? 'PASS' : 'FAIL', `.launcher-durable-option present before any toggle click: ${oldOption > 0}`)
  const oldModels = await page.locator('.launcher-durable-models').count()
  record('no-model-pills', oldModels === 0 ? 'PASS' : 'FAIL', `.launcher-durable-models present anywhere: ${oldModels > 0}`)

  // Every local model tile in the grid has its own durable toggle.
  const tiles = page.locator('.launcher-tile')
  const tileCount = await tiles.count()
  const toggles = page.locator('.launcher-tile-durable-toggle')
  const toggleCount = await toggles.count()
  record('toggle-per-tile', tileCount >= 2 && toggleCount === tileCount ? 'PASS' : 'FAIL', `${tileCount} local-model tiles, ${toggleCount} durable toggles`)

  // Clicking the first tile's toggle opens a form for exactly that tile's model, no picker.
  const firstLabel = (await tiles.nth(0).locator('.launcher-tile-open strong').first().textContent())?.trim()
  await toggles.nth(0).click()
  await page.locator('.launcher-durable-option .durable-job-launcher-form').first().waitFor({ timeout: 5_000 })
  const formModel = (await page.locator('.launcher-durable-option .durable-job-launcher-form strong').first().textContent())?.trim()
  record('toggle-opens-its-own-model', formModel?.startsWith(firstLabel ?? '\0') ? 'PASS' : 'FAIL', `tile "${firstLabel}" toggled; form shows "${formModel}"`)
  const pickerInForm = await page.locator('.launcher-durable-option select, .launcher-durable-option .launcher-durable-models').count()
  record('form-has-no-picker', pickerInForm === 0 ? 'PASS' : 'FAIL', `a model picker inside the opened form: ${pickerInForm > 0}`)

  // Switching to a second tile's toggle re-scopes the form to that model, and only one is open.
  const secondLabel = (await tiles.nth(1).locator('.launcher-tile-open strong').first().textContent())?.trim()
  await toggles.nth(1).click()
  await page.waitForTimeout(200)
  const openForms = await page.locator('.launcher-durable-option .durable-job-launcher-form').count()
  const formModel2 = (await page.locator('.launcher-durable-option .durable-job-launcher-form strong').first().textContent())?.trim()
  record('switch-tile-switches-model', openForms === 1 && formModel2?.startsWith(secondLabel ?? '\0') ? 'PASS' : 'FAIL', `after toggling tile "${secondLabel}": open forms=${openForms}, shown model="${formModel2}"`)

  // Cancel closes the form without a stray second one appearing.
  await page.locator('.durable-job-launcher-form-cancel').first().click()
  await page.waitForTimeout(200)
  const afterCancel = await page.locator('.launcher-durable-option').count()
  record('cancel-closes-form', afterCancel === 0 ? 'PASS' : 'FAIL', `.launcher-durable-option present after Cancel: ${afterCancel > 0}`)

  await page.screenshot({ path: join(root, 'launcher-durable-toggle.png') })
} catch (error) {
  failed = error
  record('fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { app?.process().kill() } catch {}
  console.log('\n=== LAUNCHER DURABLE TOGGLE SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed || results.some(r => r.verdict === 'FAIL')) process.exit(1)
