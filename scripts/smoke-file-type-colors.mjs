import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-filetypes-'))
const output = resolve('artifacts/file-type-colors')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_MODEL_CATALOG: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(10000)
const result = { checks: [], colors: [], errors: [] }
page.on('pageerror', error => result.errors.push(error.stack ?? error.message))

const contrast = (foreground, background) => {
  const luminance = (rgb) => rgb.slice(0, 3).reduce((sum, value, index) => {
    const n = value / 255
    return sum + (n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]
  }, 0)
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}
async function capture(name) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))))
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
}
// Reads the icon's own color plus the nearest opaque ancestor background, like the
// theme-sidebar smoke test does, so contrast is checked against what actually renders.
async function iconColorAndContrast(locator) {
  const info = await locator.evaluate((svg) => {
    const rgba = (value) => value.match(/[\d.]+/g).map(Number)
    const color = getComputedStyle(svg).color
    let bg = 'rgba(0,0,0,0)'
    for (let node = svg; node; node = node.parentElement) {
      const next = getComputedStyle(node).backgroundColor
      const parts = rgba(next)
      if (parts.length === 3 || parts[3] === 1) { bg = next; break }
    }
    return { color, foreground: rgba(color), surface: rgba(bg) }
  })
  return { ...info, contrast: contrast(info.foreground, info.surface) }
}

const SAMPLES = [
  ['app.ts', 'export const app = 1;\n'],
  ['App.tsx', 'export const App = () => null;\n'],
  ['main.js', 'module.exports = {};\n'],
  ['data.json', '{}\n'],
  ['theme.css', 'body { color: red; }\n'],
  ['README.md', '# Readme\n'],
  ['pipeline.yml', 'name: ci\n'],
  ['setup.py', 'print("hi")\n'],
  ['deploy.sh', 'echo hi\n'],
  ['install.ps1', 'Write-Host hi\n'],
  ['logo.svg', '<svg></svg>\n'],
  ['bundle.zip', 'PK'],
  ['package-lock.json', '{}\n'],
  ['.gitignore', 'node_modules\n']
]

try {
  await page.waitForFunction(() => Boolean(window.conductor?.projects))
  await page.evaluate(async () => { await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('day') })
  const project = await page.evaluate(() => window.conductor.projects.create('File types'))
  for (const [name, contents] of SAMPLES) await writeFile(join(project.path, name), contents)

  for (const variant of ['day', 'night']) {
    await page.evaluate(async (variant) => { await window.conductor.settings.setThemeVariant(variant) }, variant)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme-variant', variant)
    // A reload restores whatever session was already open; only the first pass lands on the project list.
    const projectRow = page.locator('.project-row').filter({ hasText: 'File types' })
    if (await projectRow.count()) await projectRow.click()
    // The Explorer control toggles visibility, so a reload that restored it already must not re-click it.
    if (!await page.locator('.explorer-sidebar .explorer-tree').count()) await page.locator('.activity-rail button[aria-label="Explorer"]').click()
    await expect(page.locator('.explorer-sidebar .explorer-tree')).toBeVisible()
    const explorerColors = {}
    for (const [name] of SAMPLES) {
      const row = page.locator('.explorer-row.file').filter({ hasText: name }).first()
      await expect(row).toBeVisible()
      const icon = row.locator('svg').first()
      const info = await iconColorAndContrast(icon)
      explorerColors[name] = info.color
      result.colors.push({ surface: 'explorer', variant, name, ...info })
      assert.ok(info.contrast >= 2.5, `Explorer icon for ${name} in ${variant} theme has low contrast ${info.contrast.toFixed(2)}: ${JSON.stringify(info)}`)
    }
    await capture('explorer-' + variant)
    result.checks.push(`${variant}: every sample extension renders a legible explorer icon color`)

    // Distinct file families should not all collapse onto the same color.
    const distinctHues = new Set(Object.values(explorerColors))
    assert.ok(distinctHues.size >= 6, `Expected several distinct hues across sample types in ${variant}, saw ${distinctHues.size}: ${JSON.stringify(explorerColors)}`)
    result.checks.push(`${variant}: sample file types render at least ${distinctHues.size} distinct icon colors, not one flat default`)

    // Open a couple of files as tabs and confirm the tab icon matches the explorer's color for the same file.
    for (const name of ['app.ts', 'theme.css', 'README.md']) {
      await page.locator('.explorer-row.file').filter({ hasText: name }).first().dblclick()
      const tab = page.locator('.file-tab').filter({ hasText: name }).first()
      await expect(tab).toBeVisible()
      const tabIcon = tab.locator('button[role="tab"] svg').first()
      const tabInfo = await iconColorAndContrast(tabIcon)
      result.colors.push({ surface: 'file-tab', variant, name, ...tabInfo })
      assert.equal(tabInfo.color, explorerColors[name], `File tab icon color for ${name} in ${variant} theme did not match the explorer (${tabInfo.color} vs ${explorerColors[name]})`)
      assert.ok(tabInfo.contrast >= 2.5, `File tab icon for ${name} in ${variant} theme has low contrast ${tabInfo.contrast.toFixed(2)}`)
    }
    result.checks.push(`${variant}: file tab icons match the explorer's color for the same file`)
    await capture('file-tabs-' + variant)

    // Ctrl+E picker: same file, same color again.
    await page.keyboard.press('Control+e')
    const search = page.getByRole('combobox', { name: 'Search files', exact: true })
    await expect(search).toBeFocused()
    await search.fill('app.ts')
    const option = page.locator('.file-picker-results [role=option]').filter({ hasText: 'app.ts' }).first()
    await expect(option).toBeVisible()
    const optionIcon = option.locator('svg').first()
    const optionInfo = await iconColorAndContrast(optionIcon)
    result.colors.push({ surface: 'file-picker', variant, name: 'app.ts', ...optionInfo })
    assert.equal(optionInfo.color, explorerColors['app.ts'], `Ctrl+E picker icon color for app.ts in ${variant} theme did not match the explorer`)
    assert.ok(optionInfo.contrast >= 2.5, `Ctrl+E picker icon for app.ts in ${variant} theme has low contrast ${optionInfo.contrast.toFixed(2)}`)
    result.checks.push(`${variant}: Ctrl+E picker icon matches the explorer's color for the same file`)
    await capture('file-picker-' + variant)
    await page.keyboard.press('Escape')
  }
  assert.deepEqual(result.errors, [])
} catch (error) {
  result.errors.push(error.stack ?? String(error))
  await capture('failure')
  process.exitCode = 1
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ checks: result.checks, errors: result.errors }, null, 2))
}
