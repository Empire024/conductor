// Fast, real-app recheck of S17's launcher-only claim: the durable-job option in the launcher
// (src/renderer/src/panes/LauncherPane.tsx, DurableJobLauncherOption in
// src/renderer/src/components/DurableJobsPane.tsx) must look like the rest of the launcher, using
// its own themed controls, not a native <select> and a bare <details>. This does not create a
// durable job or touch the local model, so it runs in well under a minute -- unlike
// scripts/smoke-v1-durable-ui.mjs, which drives the real local model and can take 20-40+ minutes
// and is the one this recheck is deliberately lighter than.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-launcher-durable-option.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'conductor-v1-launcher-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# launcher durable option recheck\n')

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
  await page.evaluate(name => window.conductor.projects.create(name), 'V1 launcher recheck')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'V1 launcher recheck' }).first().click()
  await page.locator('.launcher-grid').first().waitFor({ timeout: 20_000 })

  const option = page.locator('.launcher-durable-option')
  await option.first().waitFor({ timeout: 10_000 })
  record('S17-launcher-option', await option.count() > 0 ? 'PASS' : 'FAIL', `.launcher-durable-option present: ${await option.count() > 0}`)

  // Not a native <select> or a bare <details> anymore.
  const nativeSelectInOption = await option.locator('select').count()
  const bareDetails = await option.locator('details').count()
  record('S17-no-native-controls', nativeSelectInOption === 0 && bareDetails === 0 ? 'PASS' : 'FAIL', `native <select> inside the option: ${nativeSelectInOption}, bare <details>: ${bareDetails}`)

  // The model picker is themed pill buttons, one per configured local model, with exactly one active.
  const modelButtons = option.locator('.launcher-durable-models button')
  const modelCount = await modelButtons.count()
  const activeCount = await option.locator('.launcher-durable-models button.active').count()
  record('S17-model-pills', modelCount >= 2 && activeCount === 1 ? 'PASS' : 'FAIL', `model pill buttons: ${modelCount}, active: ${activeCount}`)
  await page.screenshot({ path: join(output, 's17-launcher-collapsed.png') })

  // Switching the pill selection moves the active state (no page reload, pure client state).
  const secondLabel = await modelButtons.nth(1).textContent()
  await modelButtons.nth(1).click()
  const nowActive = await modelButtons.nth(1).evaluate(el => el.classList.contains('active'))
  record('S17-model-pill-switch', nowActive ? 'PASS' : 'FAIL', `clicking pill "${secondLabel?.trim()}" made it active: ${nowActive}`)

  // The disclosure toggle is a real button (not <summary>), collapsed by default, and opens the form.
  const toggle = option.locator('.durable-job-launcher-toggle')
  const toggleIsButton = await toggle.evaluate(el => el.tagName).catch(() => '')
  const formHiddenBeforeOpen = await option.locator('.durable-job-launcher-form').count()
  await toggle.first().click()
  await option.locator('.durable-job-launcher-form').first().waitFor({ timeout: 5_000 })
  const objectiveVisible = await page.getByLabel('Job objective', { exact: false }).first().isVisible()
  record('S17-toggle-not-details', toggleIsButton === 'BUTTON' && formHiddenBeforeOpen === 0 ? 'PASS' : 'FAIL', `toggle element: ${toggleIsButton}, form present before opening: ${formHiddenBeforeOpen > 0}`)
  record('S17-toggle-opens-form', objectiveVisible ? 'PASS' : 'FAIL', `Job objective field visible after clicking the toggle: ${objectiveVisible}`)
  await page.screenshot({ path: join(output, 's17-launcher-expanded.png') })
} catch (error) {
  failed = error
  record('launcher-recheck-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { app?.process().kill() } catch {}
  console.log('\n=== LAUNCHER DURABLE OPTION RECHECK SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed || results.some(r => r.verdict !== 'PASS')) process.exit(1)
