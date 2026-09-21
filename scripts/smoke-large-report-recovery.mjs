import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Actual Electron main/preload/UI and filesystem persistence. No provider is
// launched and no inference is used; this fixture exercises Project tasks only.
const root = await mkdtemp(join(tmpdir(), 'conductor-large-report-'))
const output = resolve('artifacts/large-report')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
delete env.CONDUCTOR_UPDATE_DEV

const app = await electron.launch({ args: ['--disable-gpu', resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const result = { actualElectron: true, providerBoundary: 'not exercised', inference: false, checks: [], errors: [] }
page.on('pageerror', error => result.errors.push(error.stack ?? error.message))
const check = label => { result.checks.push(label); console.log('PASS ' + label) }
const shot = async name => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))))
  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, name + '.png'), Buffer.from(image, 'base64'))
}
let project
const board = () => page.evaluate(id => window.conductor.projectTasks.get(id), project.id)
const taskRow = id => page.locator('.project-task[data-task-id="' + id + '"]')
const showTasks = async () => {
  const pane = page.locator('.project-backlog')
  if (!await pane.isVisible()) await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  await expect(pane).toBeVisible()
}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.projectTasks?.edit))
  project = await page.evaluate(() => window.conductor.projects.create('Large report smoke'))
  await page.reload()
  await page.locator('.project-row').filter({hasText: project.name}).click()
  await showTasks()
  await expect(page.locator('.process-status-summary .weekly-usage')).toContainText('Last 7 days')
  await expect(page.locator('.process-status-summary .weekly-usage strong')).toContainText('tokens')
  check('Desktop process summary reads weekly tokens through the real IPC bridge')
  const report = 'recovery:checkpoint Error: Invalid workspace document owner\n' + 'Detailed diagnostic stack frame\n'.repeat(800) + '<!-- diagnostic context -->'
  const input = page.getByRole('textbox', { name: 'New project task', exact: true })
  await input.fill(report)
  await expect(input).toHaveValue(report)
  await input.press('Control+Enter')
  await expect(input).toHaveValue('')
  const saved = (await board()).tasks.find(task => task.title === report)
  assert.ok(saved, 'Pasted large report persists without truncation')
  await taskRow(saved.id).locator('.project-task-title').click()
  const editor = page.getByRole('textbox', {name:'Edit task', exact:true})
  await expect(editor).toHaveValue(report)
  await editor.fill(report + '\nExtra detail')
  await editor.press('Control+Enter')
  assert.equal((await board()).tasks.find(task=>task.id===saved.id).title, report+'\nExtra detail')
  check('A report above 8000 characters can be pasted, saved, reopened and edited intact')
  await page.evaluate(async projectId => {
    const [session] = await window.conductor.sessions.list(projectId)
    const documents = [{workspaceId:'detached:deleted-window',files:[],activeId:null},{workspaceId:session.id,files:[],activeId:null}]
    await window.conductor.recovery.checkpoint({activeProjectId:projectId,activeSessionId:session.id,focusedGroupIds:{},sessionIdsByProject:{[projectId]:session.id},documents,sessions:[]})
  }, project.id)
  check('Stale detached document owner does not reject a valid recovery checkpoint')
  await shot('large-report')
  assert.deepEqual(result.errors, [])
} catch(error) {
  result.errors.push(error.stack ?? String(error));process.exitCode=1
  await shot('failure').catch(()=>{})
} finally {
  await app.close()
  await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
}
