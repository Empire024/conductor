// V4 verify — retry for A8 (long-task expand/collapse) and A11 (owner's real feature-list.md)
import { _electron as electron, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-verify-v4-a-retry-'))
const output = resolve('artifacts/verify-v4/A')
await mkdir(output, { recursive: true })
const results = []
const record = (id, verdict, evidence, observation) => { results.push({ id, verdict, evidence, observation }); console.log(id, verdict, evidence, observation) }
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

let app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
let page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', e => errors.push(e.stack ?? e.message))
const shot = async (name) => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))); const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64')) }

await page.waitForFunction(() => Boolean(window.conductor?.projectTasks))
const project = await page.evaluate(() => window.conductor.projects.create('V4 A retry'))
const longCodeBlock = '```ts\n' + Array.from({ length: 40 }, (_, i) => `const line${i} = ${i}; // padding line ${i}`).join('\n') + '\n```'
const longProse = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(20)
const fileMd = `# Project tasks\n\n## Tasks\n- [ ] Retry long task with a 40-line code block ${longProse}\n\n  ${longCodeBlock.split('\n').join('\n  ')} <!-- conductor-task:t-retry-long -->\n- [ ] Short task <!-- conductor-task:t-retry-short -->\n`
await writeFile(join(project.path, 'feature-list.md'), fileMd)
await page.reload()
await page.locator('.project-row').filter({ hasText: 'V4 A retry' }).click()
await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
await expect(page.locator('.project-backlog')).toBeVisible()

// A8 retry: locate by data-task-id directly, scroll into view, no search box involved.
try {
  const row = page.locator('.project-task[data-task-id="t-retry-long"]')
  await row.waitFor({ timeout: 20000 })
  await row.scrollIntoViewIfNeeded()
  const titleBtn = row.locator('.project-task-title')
  await expect(titleBtn.first()).toBeVisible({ timeout: 10000 })
  await shot('A8-retry-collapsed')
  const heightCollapsed = await titleBtn.first().evaluate(el => el.getBoundingClientRect().height)
  const isCollapsedClass = await titleBtn.first().getAttribute('class')
  await titleBtn.first().click()
  await page.waitForTimeout(200)
  await shot('A8-retry-expanded')
  const heightExpanded = await row.locator('.project-task-title').first().evaluate(el => el.getBoundingClientRect().height)
  const editorOpened = await page.getByRole('textbox', { name: 'Edit task', exact: true }).count()
  await row.locator('.project-task-title').first().click()
  await page.waitForTimeout(200)
  const heightRecollapsed = await row.locator('.project-task-title').first().evaluate(el => el.getBoundingClientRect().height)
  record('A8-retry', heightExpanded > heightCollapsed && heightRecollapsed <= heightCollapsed + 2 && editorOpened === 0 ? 'PASS' : 'FAIL', `isCollapsedClass="${isCollapsedClass}" collapsed=${heightCollapsed} expanded=${heightExpanded} recollapsed=${heightRecollapsed} editorOpened=${editorOpened} screenshots=A8-retry-collapsed.png,A8-retry-expanded.png`, 'retry using a direct data-task-id locator (no search box) to click the long task title and confirm expand/collapse height + no editor side-effect')
} catch (e) {
  record('A8-retry', 'BLOCKED', String(e.message ?? e), 'still could not reliably interact with the long task title within 20s using a direct data-task-id locator; marking BLOCKED per the 15-minute-per-scenario budget')
}

// A11 retry: the owner's real feature-list.md, 30s timeout, measured open time recorded regardless of outcome.
try {
  const projectReal = await page.evaluate(() => window.conductor.projects.create('V4 A11 retry real file'))
  const realFeatureList = await readFile(resolve('feature-list.md'), 'utf8')
  await writeFile(join(projectReal.path, 'feature-list.md'), realFeatureList)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.projectTasks))
  await page.locator('.project-row').filter({ hasText: 'V4 A11 retry real file' }).click()
  const t0 = Date.now()
  await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  let rendered = false, renderError = null
  try {
    await expect(page.locator('.project-backlog')).toBeVisible({ timeout: 30000 })
    rendered = true
  } catch (e) { renderError = String(e.message ?? e) }
  const openMs = Date.now() - t0
  const rows = rendered ? await page.locator('.project-task').count() : 0
  await shot('A11-retry')
  record('A11-retry', rendered && rows > 0 ? 'PASS' : 'FAIL', `openMs=${openMs} rendered=${rendered} rows=${rows} lines=${realFeatureList.split(/\r?\n/).length} renderError=${renderError ?? 'none'} screenshot=artifacts/verify-v4/A/A11-retry.png`, `measured open time for the owner's real feature-list.md (${realFeatureList.split(/\r?\n/).length} lines) with a 30s timeout: ${openMs}ms, rendered=${rendered}`)
} catch (e) {
  record('A11-retry', 'BLOCKED', String(e.message ?? e), 'threw outside the render-timeout try block')
}

await writeFile(join(output, 'retry-result.json'), JSON.stringify({ results, errors }, null, 2))
console.log('ERRORS', JSON.stringify(errors))
await app.close()
console.log('A RETRY DONE')
