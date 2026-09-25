// RV1 B1-B4,B6: durable-job launcher option across theme (dark/light), narrow window sizes, and
// keyboard-only access. Adapted from scripts/smoke-v1-launcher-durable-option.mjs (do not edit that
// file). Stub model only, no local model or Electron durable job started -- fast.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-b-launcher-variants.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-b-'))
const output = resolve('artifacts/verification/2026-09-25-rv1/B')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# rv1 B variants\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 5 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(name => window.conductor.projects.create(name), 'RV1 B variants')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'RV1 B variants' }).first().click()
  await page.locator('.launcher-grid').first().waitFor({ timeout: 20_000 })
  const option = page.locator('.launcher-durable-option')
  await option.first().waitFor({ timeout: 10_000 })

  const shootTheme = async (variant, id) => {
    await page.evaluate(v => window.conductor.settings.setThemeVariant(v), variant)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(output, `${id}-collapsed.png`) })
    const toggle = option.locator('.durable-job-launcher-toggle')
    await toggle.first().click()
    await option.locator('.durable-job-launcher-form').first().waitFor({ timeout: 5_000 })
    await page.screenshot({ path: join(output, `${id}-expanded.png`) })
    const bodyText = await page.evaluate(() => document.body.innerText)
    const mojibake = bodyText.includes('â€')
    record(id, mojibake ? 'FAIL' : 'PASS', `theme=${variant}: mojibake(â€) in DOM text = ${mojibake}; screenshots ${id}-collapsed.png / ${id}-expanded.png`)
    await toggle.first().click().catch(() => {})
    await page.waitForTimeout(200)
  }
  await shootTheme('night', 'B1-dark')
  await shootTheme('day', 'B2-light')
  await page.evaluate(() => window.conductor.settings.setThemeVariant('night'))
  await page.waitForTimeout(200)

  // B3: narrow window sizes, no overlap/clipping.
  for (const [w, h, id] of [[900, 700, 'B3-900x700'], [1280, 800, 'B3-1280x800']]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(200)
    const toggle = option.locator('.durable-job-launcher-toggle')
    await toggle.first().click()
    await option.locator('.durable-job-launcher-form').first().waitFor({ timeout: 5_000 })
    const box = await option.first().boundingBox()
    const withinViewport = box ? (box.x >= 0 && box.y >= 0 && box.x + box.width <= w) : false
    const overlap = await option.evaluate(el => {
      const r = el.getBoundingClientRect()
      const siblings = Array.from(document.querySelectorAll('.launcher-grid *'))
      return siblings.some(s => {
        if (el.contains(s) || s.contains(el) || s === el) return false
        const rr = s.getBoundingClientRect()
        if (rr.width === 0 || rr.height === 0) return false
        return !(rr.right <= r.left || rr.left >= r.right || rr.bottom <= r.top || rr.top >= r.bottom)
      })
    })
    await page.screenshot({ path: join(output, `${id}.png`) })
    record(id, withinViewport && !overlap ? 'PASS' : 'FAIL', `viewport ${w}x${h}: withinViewport=${withinViewport}, overlap=${overlap}`)
    await toggle.first().click().catch(() => {})
    await page.waitForTimeout(200)
  }
  await page.setViewportSize({ width: 1400, height: 900 })

  // B4: default local model + control type/font-size vs launcher grid.
  const modelButtons = option.locator('.launcher-durable-models button')
  const modelCount = await modelButtons.count()
  const activeLabel = await option.locator('.launcher-durable-models button.active').first().textContent().catch(() => null)
  const isToggleOnEntry = await option.evaluate(el => Boolean(el.querySelector('.launcher-durable-models'))).catch(() => false)
  const gridFontSize = await page.locator('.launcher-grid').first().evaluate(el => getComputedStyle(el).fontSize).catch(() => null)
  const optionFontSize = await option.first().evaluate(el => getComputedStyle(el).fontSize).catch(() => null)
  await page.screenshot({ path: join(output, 'B4-model-default.png') })
  record('B4', modelCount >= 1 ? 'INFO' : 'FAIL', `defaults to active pill "${activeLabel?.trim()}" among ${modelCount} pills (a toggle on the local-model entry, not a second picker: separateModelsSubsection=${isToggleOnEntry}); grid fontSize=${gridFontSize}, option fontSize=${optionFontSize}`)

  // B6: keyboard-only access - Tab to the toggle, Space/Enter to open, focus ring visible.
  const toggle = option.locator('.durable-job-launcher-toggle')
  await toggle.first().evaluate(el => el.blur())
  await page.keyboard.press('Tab')
  let attempts = 0
  let focusedIsToggle = await toggle.first().evaluate(el => el === document.activeElement).catch(() => false)
  while (!focusedIsToggle && attempts < 30) {
    await page.keyboard.press('Tab')
    focusedIsToggle = await toggle.first().evaluate(el => el === document.activeElement).catch(() => false)
    attempts++
  }
  const focusRingVisible = focusedIsToggle ? await toggle.first().evaluate(el => {
    const cs = getComputedStyle(el)
    return cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px'
  }).catch(() => false) : false
  await page.screenshot({ path: join(output, 'B6-focus.png') })
  await page.keyboard.press('Space')
  await page.waitForTimeout(300)
  const formOpenedViaKeyboard = await option.locator('.durable-job-launcher-form').count() > 0
  record('B6', focusedIsToggle && formOpenedViaKeyboard ? 'PASS' : 'FAIL', `reached toggle via Tab after ${attempts} presses=${focusedIsToggle}, focus ring visible=${focusRingVisible}, Space opened the form=${formOpenedViaKeyboard}`)
} catch (error) {
  failed = error
  record('B-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { app?.process().kill() } catch {}
  await writeFile(join(output, 'b-variants-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== B VARIANTS SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed) process.exit(1)
