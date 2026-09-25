// FX14 (4ab12812, V4 U4): every surface that shows a local model uses that model's own glyph
// (ProviderIcon.tsx LOCAL_MODEL_GLYPHS), not one shared chip. Checks the new-tab launcher tiles,
// then opens one local tab and checks its tab strip and session bar icon. Parked, stub models
// only: no local server is started and nothing is downloaded.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-local-model-icons.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'conductor-local-model-icons-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
const shots = resolve('artifacts/fx14')
await mkdir(projectPath, { recursive: true })
await mkdir(shots, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# local model icons smoke\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const expected = { 'Ornith 1.5 9B': 'Ornith 1.5', 'Qwen 3.5 9B': 'Qwen 3.5', 'Qwen 3.6 35B-A3B': 'Qwen 3.6', 'Dolphin X1 8B': 'Dolphin X1' }
let app, page, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 3 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(name => window.conductor.projects.create(name), 'Local model icons smoke')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'Local model icons smoke' }).first().click()
  await page.locator('.launcher-grid').first().waitFor({ timeout: 20_000 })

  const tiles = await page.locator('.launcher-grid').first().evaluate(grid => [...grid.querySelectorAll('button, .launcher-tile')]
    .map(tile => ({ title: tile.querySelector('strong')?.textContent?.trim() ?? '', icon: tile.querySelector('.launch-icon [role="img"]')?.getAttribute('aria-label') ?? '', svg: tile.querySelector('.launch-icon svg')?.getAttribute('class') ?? '' }))
    .filter(tile => tile.title))
  const local = Object.keys(expected).map(title => ({ title, tile: tiles.find(tile => tile.title.startsWith(title)) }))
  for (const { title, tile } of local) record('launcher:' + title, tile?.icon === expected[title] ? 'PASS' : 'FAIL', `tile icon "${tile?.icon ?? 'missing'}", expected "${expected[title]}"`)
  const distinct = new Set(local.map(entry => entry.tile?.icon)).size
  record('launcher-distinct', distinct === local.length ? 'PASS' : 'FAIL', `${distinct} distinct icons over ${local.length} local tiles`)
  await page.screenshot({ path: join(shots, 'launcher-local-icons.png') })

  // Open one local model tab: its tab strip and session bar carry that model's glyph too.
  const tile = page.locator('.launcher-grid button').filter({ hasText: 'Qwen 3.6 35B-A3B' }).first()
  await tile.click()
  await page.waitForTimeout(1500)
  const strip = await page.evaluate(() => [...document.querySelectorAll('[role="tab"], .pane-tab, .workspace-tab')]
    .map(tab => tab.querySelector('[role="img"]')?.getAttribute('aria-label')).filter(Boolean))
  record('tab-strip', strip.includes('Qwen 3.6') ? 'PASS' : 'FAIL', `tab icons: ${JSON.stringify(strip)}`)
  const bar = await page.locator('.sa-session-bar [role="img"]').first().getAttribute('aria-label').catch(() => null)
  record('session-bar', bar === 'Qwen 3.6' ? 'PASS' : 'FAIL', `session bar icon "${bar}"`)
  await page.screenshot({ path: join(shots, 'local-tab-icon.png') })
  console.log('screenshots in ' + shots)
} catch (error) {
  failed = error
  record('fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { app?.process().kill() } catch {}
  console.log('\n=== LOCAL MODEL ICONS SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed || results.some(r => r.verdict === 'FAIL')) process.exit(1)
