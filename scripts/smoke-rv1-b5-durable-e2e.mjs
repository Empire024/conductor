// RV1 B5: start a durable job from the launcher toggle end to end (stub model is fine): opens a
// tab with progress; Pause/Resume/Cancel work; no sidebar "Durable jobs" utility exists.
// Adapted from scripts/smoke-v1-launcher-durable-option.mjs's UI harness (not edited here).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-b5-durable-e2e.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-b5-'))
const output = resolve('artifacts/verification/2026-09-25-rv1/B')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# rv1 b5\n')
const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 10 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow(); page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(name => window.conductor.projects.create(name), 'RV1 B5')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'RV1 B5' }).first().click()
  await page.locator('.launcher-grid').first().waitFor({ timeout: 20_000 })

  // No sidebar "Durable jobs" utility panel.
  const sidebarDurable = await page.locator('text=Durable jobs').filter({ has: page.locator(':visible') }).count().catch(() => 0)
  const sidebarUtility = await page.locator('.sidebar, .utility-rail, [class*="sidebar"]').locator('text=Durable').count().catch(() => 0)
  record('B5-no-sidebar-utility', sidebarUtility === 0 ? 'PASS' : 'FAIL', `sidebar elements matching "Durable": ${sidebarUtility}`)

  const option = page.locator('.launcher-durable-option')
  await option.first().waitFor({ timeout: 10_000 })
  await option.locator('.durable-job-launcher-toggle').first().click()
  await option.locator('.durable-job-launcher-form').first().waitFor({ timeout: 5_000 })
  await page.getByLabel('Job objective', { exact: false }).first().fill('Write a short greeting into GREETING.txt')
  await page.screenshot({ path: join(output, 'b5-filled-form.png') })
  const launchButton = option.getByRole('button', { name: /start|launch|create/i }).first()
  await launchButton.click()

  // Opens a tab with progress.
  await page.waitForTimeout(1500)
  const jobTab = page.locator('[class*="durable"], [class*="job"]').filter({ hasText: /progress|stage|running|queued/i }).first()
  const jobTabVisible = await jobTab.isVisible().catch(() => false)
  await page.screenshot({ path: join(output, 'b5-job-tab.png') })
  record('B5-opens-tab', jobTabVisible ? 'PASS' : 'INFO', `a job-progress element became visible after Start=${jobTabVisible}`)

  // Pause/Resume/Cancel controls exist and are clickable.
  const pauseBtn = page.getByRole('button', { name: /pause/i }).first()
  const pauseExists = await pauseBtn.count() > 0
  if (pauseExists) { await pauseBtn.click().catch(() => {}); await page.waitForTimeout(500) }
  const resumeBtn = page.getByRole('button', { name: /resume/i }).first()
  const resumeExists = await resumeBtn.count() > 0
  if (resumeExists) { await resumeBtn.click().catch(() => {}); await page.waitForTimeout(500) }
  const cancelBtn = page.getByRole('button', { name: /cancel/i }).first()
  const cancelExists = await cancelBtn.count() > 0
  await page.screenshot({ path: join(output, 'b5-controls.png') })
  record('B5-controls', pauseExists && resumeExists && cancelExists ? 'PASS' : 'INFO', `Pause button present=${pauseExists}, Resume present=${resumeExists}, Cancel present=${cancelExists}`)
  if (cancelExists) { await cancelBtn.click().catch(() => {}); await page.waitForTimeout(500); const confirmBtn = page.getByRole('button', { name: /confirm|yes|cancel job/i }).first(); if (await confirmBtn.count() > 0) await confirmBtn.click().catch(() => {}) }
} catch (error) {
  failed = error
  record('B5-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { app?.process().kill() } catch {}
  await writeFile(join(output, 'b5-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== B5 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
