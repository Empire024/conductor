// V4 A8 (long task expands and collapses) and A11 (the owner's real feature-list.md renders), ported
// onto scripts/verify-kit.mjs as the playwright-mode proof for FX13 verify-kit. The original,
// scripts/smoke-verify-v4-a-retry.mjs, ends in a bare `await app.close()` and is kept.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-kit-v4-a-retry.mjs [--hang-close] [--keep]
// --hang-close makes app.close() hang for good (before-quit and will-quit are prevented, the V4
// group B teardown) and proves safeClose cuts it at 20 s and leaves no process of the app behind.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLOSE_BOUND_MS, REPO, configure, current, failed, finish, launchParked, loadCheck, openProject, processAlive, record, safeClose, shot, step, watchdog } from './verify-kit.mjs'

const hangClose = process.argv.includes('--hang-close')
configure({ name: hangClose ? 'kit-v4-a-retry-hang-close' : 'kit-v4-a-retry' })
watchdog(5 * 60)
await loadCheck()

const longCode = '```ts\n' + Array.from({ length: 40 }, (_, i) => `const line${i} = ${i}; // padding line ${i}`).join('\n') + '\n```'
const longProse = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(20)
const fixtureList = `# Project tasks\n\n## Tasks\n- [ ] Retry long task with a 40-line code block ${longProse}\n\n  ${longCode.split('\n').join('\n  ')} <!-- conductor-task:t-retry-long -->\n- [ ] Short task <!-- conductor-task:t-retry-short -->\n`
// The rail button toggles: a second click on an open pane closes it (a harness artifact in the first port run).
const openTasks = async page => { if (!await page.locator('.project-backlog').isVisible()) await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click() }

try {
  const { page } = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })

  step('A8: long task expands and collapses on its title')
  await openProject({ name: 'Kit A retry', files: { 'feature-list.md': fixtureList } })
  await openTasks(page)
  await page.locator('.project-backlog').waitFor({ timeout: 15_000 })
  // By its text: data-task-id is the app's own id, not the conductor-task marker (why the original never matched).
  const row = page.locator('.project-task').filter({ hasText: 'Retry long task with a 40-line code block' }).first()
  await row.waitFor({ timeout: 20_000 })
  await row.scrollIntoViewIfNeeded()
  const title = () => row.locator('.project-task-title').first()
  const height = () => title().evaluate(element => element.getBoundingClientRect().height)
  const collapsed = await height()
  const collapsedShot = await shot('A8-collapsed')
  await title().click()
  await page.waitForTimeout(200)
  const expanded = await height()
  const expandedShot = await shot('A8-expanded')
  const editorOpened = await page.getByRole('textbox', { name: 'Edit task', exact: true }).count()
  await title().click()
  await page.waitForTimeout(200)
  const recollapsed = await height()
  record('A8', expanded > collapsed && recollapsed <= collapsed + 2 && editorOpened === 0 ? 'PASS' : 'FAIL', { collapsed, expanded, recollapsed, editorOpened }, `${collapsedShot}, ${expandedShot}`)

  step("A11: the owner's real feature-list.md renders")
  const real = await readFile(join(REPO, 'feature-list.md'), 'utf8')
  await openProject({ name: 'Kit A11 real file', files: { 'feature-list.md': real } })
  const started = Date.now()
  await openTasks(page)
  const rendered = await page.locator('.project-backlog').filter({ hasText: 'Kit A11 real file' }).locator('.project-task').first().waitFor({ timeout: 30_000 }).then(() => true, () => false)
  const openMs = Date.now() - started
  const rows = rendered ? await page.locator('.project-task').count() : 0
  record('A11', rendered && rows > 0 ? 'PASS' : 'FAIL', { openMs, rows, lines: real.split(/\r?\n/).length }, await shot('A11-real-feature-list'))

  const inst = current()
  const profileMarker = inst.profile
  if (hangClose) {
    step('forcing app.close() to hang')
    await inst.app.evaluate(({ app }) => { app.on('before-quit', event => event.preventDefault()); app.on('will-quit', event => event.preventDefault()) })
  }
  step('safeClose')
  const close = await safeClose(inst)
  const lingering = await processAlive(profileMarker)
  const cut = hangClose ? !close.graceful && close.closeMs >= CLOSE_BOUND_MS && close.closeMs < CLOSE_BOUND_MS + 10_000 : close.graceful
  record(hangClose ? 'kit-close-hang' : 'kit-close', cut && close.leftovers.length === 0 && !lingering ? 'PASS' : 'FAIL', { graceful: close.graceful, closeMs: close.closeMs, totalMs: close.ms, tree: close.tree, killed: close.killed.length, leftovers: close.leftovers.length, profileProcessesAlive: lingering }, hangClose ? 'app.close() prevented by before-quit/will-quit; the bound must cut it at 20 s' : 'plain close')
} catch (error) {
  await failed(error)
}
await finish()
