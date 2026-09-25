// FX17 task-list-description-bullets: over a copy of the owner's real feature-list.md, the Tasks
// view and tasks.list count exactly the lines with their own checkbox; indented description
// bullets and paragraphs are not tasks.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx17-task-count.mjs
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, poll, record, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'fx17-task-count' })
watchdog(5 * 60)
await loadCheck()

const real = await readFile(join(REPO, 'feature-list.md'), 'utf8')
const checkbox = /^(?:[-*+]\s+|\d+[.)]\s+)?\[( |x|~|implemented|in progress|working|done)\]/i
let fenced = false
const boxes = []
for (const line of real.split(/\r?\n/)) {
  if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
  const match = !fenced && checkbox.exec(line)
  if (match) boxes.push(match[1].toLowerCase())
}
const expected = { total: boxes.length, done: boxes.filter(box => ['x', 'implemented', 'done'].includes(box)).length }

try {
  const { page: view } = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'FX17 real task list', files: { 'feature-list.md': real } })

  step('T1: the Tasks view header counts the checkbox lines')
  await call('tabs.open', { kind: 'tasks', focus: true })
  const header = view.locator('.project-backlog').filter({ hasText: 'FX17 real task list' }).locator('header span').filter({ hasText: /done/ }).first()
  await header.waitFor({ timeout: 30_000 })
  // The header reads 0/0 until the board has loaded.
  await poll(async () => /[1-9]\d*\/[1-9]\d* done/.test(await header.innerText()), { timeoutMs: 30_000, label: 'Tasks view counts loaded' })
  const shown = (await header.innerText()).trim()
  const [, completed, total] = /(\d+)\/(\d+) done/.exec(shown) ?? []
  record('T1', Number(total) === expected.total && Number(completed) === expected.done ? 'PASS' : 'FAIL', { shown, expectedTotal: expected.total, expectedDone: expected.done, lines: real.split(/\r?\n/).length }, await shot('T1-tasks-view'))

  step('T2: tasks.list agrees, and no task is an indented description line')
  const listed = await call('tasks.list', {})
  const all = listed.tasks ?? []
  const summary = { total: listed.summary?.total ?? all.length, completed: listed.summary?.completed ?? all.filter(task => task.status === 'done').length }
  const lines = real.split(/\r?\n/)
  const strays = all.filter(task => task.line && !checkbox.test(lines[task.line - 1] ?? '')).map(task => task.title.slice(0, 60))
  record('T2', summary.total === expected.total && summary.completed === expected.done && strays.length === 0 ? 'PASS' : 'FAIL', { total: summary.total, completed: summary.completed, strays: strays.length }, strays.slice(0, 5).join(' | '))
} catch (error) {
  await failed(error)
}
await finish()
