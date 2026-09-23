import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'

const root = await mkdtemp(join(tmpdir(), 'conductor-settings-navigation-'))
const output = resolve('artifacts/swarm-2026-09-23/settings')
await mkdir(output, { recursive: true })
const results = { checks: [], screenshots: [], errors: [] }
const check = message => { results.checks.push(message); console.log('PASS ' + message) }
const env = {
  ...process.env,
  CONDUCTOR_BACKGROUND_WINDOWS: '1',
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

// The controller serializes smoke runs; the fixture itself never activates its window.
let app
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => results.errors.push(error.message))
  page.setDefaultTimeout(15_000)
  await page.waitForFunction(() => Boolean(window.conductor?.settings))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(1280, 800)
  })
  await page.evaluate(async () => {
    await window.conductor.settings.setZoom(1.1)
    await window.conductor.settings.setThemeAuto(false)
    await window.conductor.settings.setThemeVariant('night')
  })
  await page.reload()
  const opener = page.getByRole('button', { name: 'Settings', exact: true })
  await opener.click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  const nav = panel.getByRole('navigation', { name: 'Settings sections' })
  const title = panel.getByRole('heading', { level: 2 })
  const search = panel.getByRole('textbox', { name: 'Search settings' })
  await expect(title).toHaveText('General')
  await expect(search).toBeFocused()
  check('First opening selects General and focuses search')
  const pages = ['General', 'Appearance', 'Sounds', 'Usage', 'Machines', 'Phone', 'Updates', 'Runtimes', 'Debug']
  for (const variant of ['night', 'day']) {
    await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
    await panel.getByRole('button', { name: variant === 'day' ? 'Day' : 'Night', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-variant', variant)
    for (const name of pages) {
      await nav.getByRole('button', { name, exact: true }).click()
      await expect(title).toHaveText(name)
      await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page')
      if (name === 'Machines') await expect(panel.locator('.remote-card').first()).toBeVisible()
      if (name === 'Phone') await expect(panel.locator('.phone-access-settings input').first()).toBeAttached()
      const geometry = await panel.evaluate(element => {
        const page = element.querySelector('.settings-page')
        const nav = element.querySelector('.settings-sidebar')
        const rect = element.getBoundingClientRect()
        return { panelWidth: element.clientWidth, panelScrollWidth: element.scrollWidth, pageWidth: page.clientWidth, pageScrollWidth: page.scrollWidth, navHeight: nav.clientHeight, navScrollHeight: nav.scrollHeight, x: rect.x, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight }
      })
      assert.ok(geometry.panelScrollWidth <= geometry.panelWidth + 1, JSON.stringify({ name, geometry }))
      assert.ok(geometry.pageScrollWidth <= geometry.pageWidth + 1, JSON.stringify({ name, geometry }))
      assert.ok(geometry.navScrollHeight <= geometry.navHeight + 1, 'Navigation must not scroll')
      assert.ok(geometry.x >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight, 'Settings must stay inside viewport')
      const filename = `${variant}-${name.toLowerCase()}.png`
      await page.screenshot({ path: join(output, filename) })
      results.screenshots.push(filename)
    }
    check(`${variant}: all nine pages render inside 1280x800 at 110% zoom without horizontal overflow`)
  }
  await nav.getByRole('button', { name: 'General', exact: true }).click()
  await panel.locator('.settings-page').evaluate(element => { element.scrollTop = element.scrollHeight })
  assert.equal(await panel.locator('.settings-sidebar').evaluate(element => element.scrollTop), 0)
  await expect(panel.getByRole('slider', { name: 'Interface zoom' })).toBeVisible()
  check('The page body scrolls to its final controls while navigation stays in place')
  await search.fill('hidden files')
  await expect(nav.locator('[data-search-match="true"]')).toHaveCount(1)
  await expect(nav.getByRole('button', { name: 'General', exact: true })).toHaveAttribute('data-search-match', 'true')
  await expect(nav.locator('[data-search-match="false"]')).toHaveCount(8)
  assert.ok(Number(await nav.getByRole('button', { name: 'Appearance' }).evaluate(element => getComputedStyle(element).opacity)) < 1)
  await search.fill('tailscale')
  await expect(nav.locator('[data-search-match="true"]')).toHaveCount(2)
  await search.fill('not-a-setting')
  await expect(panel.getByRole('status')).toHaveText('No matching sections. Try another word.')
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(panel).toBeVisible()
  check('Search matches control labels, dims other pages, handles no results, and Escape clears it')

  await nav.getByRole('button', { name: 'General', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(title).toHaveText('Appearance')
  await page.keyboard.press('ArrowUp')
  await expect(title).toHaveText('General')
  await page.keyboard.press('ArrowUp')
  await expect(title).toHaveText('Debug')
  await page.keyboard.press('Home')
  await expect(title).toHaveText('General')
  check('Arrow keys move between pages, wrap, and Home selects General')

  await nav.getByRole('button', { name: 'Phone', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await expect(title).toHaveText('Phone')
  check('Escape closes Settings, restores focus, and reopening remembers Phone')
  await panel.getByRole('button', { name: 'Close settings' }).focus()
  await page.keyboard.press('Shift+Tab')
  assert.ok(await panel.evaluate(element => element.contains(document.activeElement)))
  await panel.getByRole('button', { name: 'Close settings' }).click()
  await expect(panel).toHaveCount(0)
  await opener.click()
  await page.locator('.settings-scrim').click({ position: { x: 2, y: 2 } })
  await expect(panel).toHaveCount(0)
  check('Focus stays inside the dialog and both close button and scrim close it')
  assert.deepEqual(results.errors, [])
} catch (error) {
  results.failure = String(error?.stack ?? error)
  throw error
} finally {
  if (app) await cleanupFixtureApp(app, results)
  await writeFile(join(output, 'smoke-results.json'), JSON.stringify(results, null, 2) + '\n')
}
