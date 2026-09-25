// VR3 group T (docs/verification/2026-09-25-vr3.md), on a copy of the owner's real feature-list.md and
// the repo's real .conductor/loops:
//   T1  24e307fa + 3bbf4893: done tasks hidden by default, the real list renders fast, counts agree.
//   L1  logic-loops: loops in app control and in Project tasks + Scheduled tasks, no sidebar tab.
//   I1  4ab12812: each local model its own icon in the launcher, the Model picker and the tab strip.
//   T2  3bbf4893: done tasks older than 14 days are archived and the Archived count is right (V4 R1),
//       ageing activity rows in the profile's DB, then an app.restart (spawn mode, RV1 C10).
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr3-tasks.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, callRaw, configure, failed, finish, launchParked, loadCheck, openProject, page, poll, record, relaunched, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr3-tasks', output: process.env.VR3_OUT ?? 'artifacts/verification/2026-09-25-vr3' })
watchdog(18 * 60)
await loadCheck()

// The owner's real data: the main checkout's feature-list.md (not the worktree's HEAD copy) and seed loops.
const OWNER_REPO = process.env.VR3_OWNER_REPO ?? 'C:/Claude/conductor'
const featureList = readFileSync(join(OWNER_REPO, 'feature-list.md'), 'utf8')
const loopsDir = join(OWNER_REPO, '.conductor', 'loops')
const loopFiles = Object.fromEntries(readdirSync(loopsDir).filter(name => name.endsWith('.md')).map(name => [`.conductor/loops/${name}`, readFileSync(join(loopsDir, name), 'utf8')]))
const fileCounts = { bytes: Buffer.byteLength(featureList), open: (featureList.match(/^\s*- \[[ ~]\]/gm) ?? []).length, done: (featureList.match(/^\s*- \[x\]/gim) ?? []).length }

const rail = async (view, name) => {
  await view.locator('.activity-rail').getByRole('button', { name, exact: true }).first().click()
}
const headerCounts = async view => {
  const text = (await view.locator('section.project-backlog header span').first().textContent())?.trim() ?? ''
  const match = /(\d+)\/(\d+) done/.exec(text)
  return match ? { completed: Number(match[1]), total: Number(match[2]) } : null
}
const sectionCount = async (view, label) => {
  const section = view.locator(`section[aria-label="${label}"]`).first()
  if (!await section.count()) return null
  return Number((await section.locator('h3 span').first().textContent())?.trim())
}
const setToggle = async (view, label, on) => {
  const box = view.getByLabel(label, { exact: true }).first()
  if (await box.isChecked() !== on) await box.click()
}

try {
  const inst = await launchParked({ mode: 'spawn' })
  const project = await openProject({ name: 'VR3 tasks', git: true, files: { 'feature-list.md': featureList, ...loopFiles } })
  let view = await page(inst)

  // ---- T1: the owner's real list, done hidden by default, first paint time.
  try {
    step('T1 open Project tasks')
    const started = Date.now()
    await rail(view, 'Project tasks')
    const counts = await poll(async () => { const found = await headerCounts(view); return found && found.total > 0 ? found : null }, { timeoutMs: 30_000, intervalMs: 50, label: 'the task header counts' })
    const firstPaintMs = Date.now() - started
    const doneDefault = await view.getByLabel('Show done tasks', { exact: true }).first().isChecked()
    const doneSection = await view.locator('section[aria-label="Completed tasks"]').count()
    const todo = await sectionCount(view, 'Tasks to do'), doing = await sectionCount(view, 'Tasks in progress') ?? 0
    const renderedRows = await view.locator('section.project-backlog section[aria-label="Tasks to do"] > :not(h3):not(p)').count()
    const t1Shot = await shot('T1-real-list-default')
    await setToggle(view, 'Show done tasks', true)
    await poll(() => view.locator('section[aria-label="Completed tasks"]').count(), { timeoutMs: 10_000, label: 'the Done section' })
    const doneCount = await sectionCount(view, 'Completed tasks')
    const doneRows = await view.locator('section[aria-label="Completed tasks"] > :not(h3):not(p)').count()
    await setToggle(view, 'Show done tasks', false)
    const ok = !doneDefault && doneSection === 0 && firstPaintMs < 3000 && counts.completed === doneCount && counts.total - counts.completed === todo + doing && doneRows > 0
    record('T1', ok ? 'PASS' : 'FAIL', { firstPaintMs, header: counts, todo, doing, doneWhenShown: doneCount, doneRowsLoaded: doneRows, renderedTodoRows: renderedRows, file: fileCounts }, `${t1Shot}; control: Show done tasks reveals ${doneRows} done rows`)
  } catch (error) { await failed(error, 'T1') }

  // ---- L1: logic loops, in control and in both panels, no sidebar tab.
  try {
    step('L1 loops')
    const listed = await call('loops.list')
    const loops = Array.isArray(listed) ? listed : listed.loops ?? []
    const ids = loops.map(loop => loop.id).sort()
    const verify = await call('loops.get', { id: 'verify' })
    const verifyVersion = verify?.version ?? verify?.loop?.version ?? verify?.definition?.version
    const missing = await callRaw('loops.get', { id: 'vr3-no-such-loop' })
    const inPanel = async () => { const toggle = view.locator('section[aria-label="Logic loops"] .logic-loops-toggle').first(); await toggle.waitFor({ timeout: 15_000 }); return (await toggle.textContent())?.trim() }
    const tasksPanel = await inPanel()
    const l1Shot = await shot('L1-project-tasks')
    await rail(view, 'Scheduled tasks')
    const schedulesPanel = await inPanel()
    const l1Shot2 = await shot('L1-scheduled-tasks')
    const railNames = await view.locator('.activity-rail button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim() || ''))
    const loopRail = railNames.filter(name => /loop/i.test(name))
    const expected = Object.keys(loopFiles).map(file => file.replace(/^.*\//, '').replace(/\.md$/, '')).sort()
    const count = new RegExp(`\\b${expected.length}\\b`)
    const ok = JSON.stringify(ids) === JSON.stringify(expected) && Number(verifyVersion) === 3 && missing.status !== 200 && count.test(tasksPanel ?? '') && count.test(schedulesPanel ?? '') && loopRail.length === 0
    record('L1', ok ? 'PASS' : 'FAIL', { ids, verifyVersion, missingStatus: missing.status, tasksPanel, schedulesPanel, loopRail }, `${l1Shot}, ${l1Shot2}; rail: ${railNames.join(' | ')}; control: loops.get of a missing id -> ${missing.status} ${JSON.stringify(missing.body?.error ?? '').slice(0, 120)}`)
    await rail(view, 'Scheduled tasks')
  } catch (error) { await failed(error, 'L1') }

  // ---- I1: every local model its own icon on every surface.
  try {
    step('I1 icons')
    const closeView = view.getByRole('button', { name: 'Close workspace view' }).first()
    if (await closeView.count()) await closeView.click().catch(() => {})
    await view.locator('.launcher-grid').first().waitFor({ timeout: 30_000 })
    const launcher = await view.locator('.launcher-tile').evaluateAll(tiles => tiles.map(tile => ({ title: tile.querySelector('strong')?.textContent?.trim(), icon: tile.querySelector('.launch-icon [role="img"]')?.getAttribute('aria-label') })))
    await view.locator('.launcher-tile').filter({ hasText: 'Qwen 3.6 35B-A3B' }).first().locator('.launcher-tile-open').click()
    await view.getByRole('combobox', { name: 'Model' }).first().waitFor({ timeout: 30_000 })
    await view.getByRole('combobox', { name: 'Model' }).first().click()
    await view.getByRole('listbox', { name: 'Models' }).first().waitFor({ timeout: 10_000 })
    const picker = await view.getByRole('listbox', { name: 'Models' }).first().locator('[role="option"]').evaluateAll(options => options.map(option => ({ text: option.textContent?.trim().slice(0, 40), icon: option.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null })))
    const i1Shot = await shot('I1-model-picker')
    await view.keyboard.press('Escape')
    const tabIcons = await view.locator('[role="tab"], .pane-tab, .workspace-tab').evaluateAll(tabs => tabs.map(tab => tab.querySelector('[role="img"]')?.getAttribute('aria-label')).filter(Boolean))
    const localLauncher = launcher.filter(tile => /Ornith|Qwen|Dolphin/.test(tile.title ?? ''))
    const localPicker = picker.filter(option => /Ornith|Qwen|Dolphin/.test(option.text ?? ''))
    const claudePicker = picker.filter(option => /Claude|Opus|Sonnet|Haiku|Fable/i.test(option.text ?? ''))
    const distinct = list => new Set(list.map(entry => entry.icon)).size === list.length && list.every(entry => entry.icon)
    const ok = localLauncher.length >= 4 && distinct(localLauncher) && (localPicker.length < 2 || distinct(localPicker)) && tabIcons.includes('Qwen 3.6')
    record('I1', ok ? 'PASS' : 'FAIL', { launcher: localLauncher.map(tile => tile.icon), picker: localPicker.map(option => `${option.text}=${option.icon}`), pickerLocalCount: localPicker.length, claudeInPicker: claudePicker.map(option => option.icon).slice(0, 2), tabIcons }, `${i1Shot}; control: fixer smoke smoke-local-model-icons.mjs run separately`)
  } catch (error) { await failed(error, 'I1') }

  // ---- T2: age done tasks in the DB, restart, and check the Archived section.
  try {
    step('T2 age activity rows')
    const db = new DatabaseSync(join(inst.profile, 'conductor.db'))
    db.exec('PRAGMA busy_timeout = 10000')
    const doneTasks = db.prepare(`SELECT task_id, MIN(created_at) AS first FROM project_task_activity WHERE project_id = ? AND status = 'done' GROUP BY task_id ORDER BY task_id`).all(project.id)
    const old = doneTasks.slice(0, 30).map(row => row.task_id), recent = doneTasks.slice(30, 40).map(row => row.task_id)
    const back = days => new Date(Date.now() - days * 86_400_000).toISOString()
    const age = db.prepare('UPDATE project_task_activity SET created_at = ? WHERE project_id = ? AND task_id = ?')
    for (const id of old) age.run(back(20), project.id, id)
    for (const id of recent) age.run(back(13), project.id, id)
    db.close()
    step('T2 restart')
    const oldPid = inst.credential.pid
    await call('app.restart', { force: true })
    const seconds = await relaunched(inst, oldPid, { timeoutMs: 60_000 })
    view = await page(inst)
    await view.locator('.project-row').filter({ hasText: 'VR3 tasks' }).first().click()
    await rail(view, 'Project tasks')
    await poll(async () => { const found = await headerCounts(view); return found && found.total > 0 ? found : null }, { timeoutMs: 30_000, label: 'the task header after restart' })
    await setToggle(view, 'Show archived tasks', true)
    await setToggle(view, 'Show done tasks', true)
    await poll(() => view.locator('section[aria-label="Archived tasks"]').count(), { timeoutMs: 10_000, label: 'the Archived section' })
    const archived = await sectionCount(view, 'Archived tasks')
    const archivedRows = await view.locator('section[aria-label="Archived tasks"] > :not(h3):not(p)').count()
    const done = await sectionCount(view, 'Completed tasks')
    const t2Shot = await shot('T2-archived')
    const ok = archived === old.length && done === doneTasks.length - old.length
    record('T2', ok ? 'PASS' : 'FAIL', { doneTasks: doneTasks.length, aged20d: old.length, aged13d: recent.length, archivedHeading: archived, archivedRowsLoaded: archivedRows, doneHeading: done, restartS: seconds }, `${t2Shot}; control: the ${recent.length} tasks aged 13 d stay in Done`)
  } catch (error) { await failed(error, 'T2') }
} catch (error) { await failed(error) }
await finish()
