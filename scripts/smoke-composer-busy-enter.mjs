import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// Owner, 2026-10-22: "i didnt send this message twice it auto sent". While a turn ran, ending the
// first line with Enter steered it into the turn, and the kept draft sent it again later.
// Offline raw Claude protocol -> real adapter/session IPC -> the real composer; parked window.
const root = await mkdtemp(join(tmpdir(), 'conductor-busy-enter-'))
const output = resolve('artifacts/composer-busy-enter')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN || 'out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [], root }
const check = name => { results.checks.push(name); console.log('ok -', name) }
let page
try {
  page = await app.firstWindow()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Busy enter fixture'))
  await page.reload()
  await page.getByText('Busy enter fixture', { exact: true }).first().click()
  await launcherTile(page, 'Claude').click()
  const pane = page.locator('.structured-agent-pane').first()
  await pane.waitFor()
  const id = await pane.getAttribute('data-structured-session')
  const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), id)
  const input = () => pane.getByRole('textbox', { name: /^Message / })
  const userTexts = async () => (await snapshot()).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)
  const steered = async () => ((await snapshot()).pendingSteering ?? []).map(prompt => prompt.text)
  const sentAnywhere = async text => [...await userTexts(), ...await steered()].filter(entry => entry.includes(text)).length

  await input().fill('SYNTHETIC STEERING WAIT')
  await expect(pane.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await input().press('Enter')
  await expect.poll(async () => (await snapshot()).phase).toBe('running')
  await expect.poll(async () => (await snapshot()).capabilities?.steering).toBe(true)
  check('Enter still sends when no turn is running')

  await expect(input()).toHaveAttribute('placeholder', /Ctrl\+Enter sends/)
  await input().click()
  await page.keyboard.type('cooking oil for rosin room 165 - 190 max ')
  await expect(pane.getByRole('button', { name: 'Steer', exact: true })).toBeEnabled()
  await page.keyboard.press('Enter')
  await page.keyboard.type('working temperature is 70')
  await page.waitForTimeout(1500)
  await expect(input()).toHaveValue('cooking oil for rosin room 165 - 190 max \nworking temperature is 70')
  assert.equal(await sentAnywhere('cooking oil'), 0, 'Enter during a running turn must not send anything')
  assert.equal((await snapshot()).phase, 'running')
  check('While a turn runs, Enter inserts a newline and nothing reaches the turn')

  await page.screenshot({ path: join(output, 'busy-newline.png'), fullPage: true })
  await page.keyboard.press('Control+Enter')
  // Keep typing straight after sending: the composer must not keep the words already sent.
  await page.keyboard.type(' next thought')
  await expect.poll(sentAnywhere.bind(null, 'cooking oil')).toBe(1)
  const sent = [...await userTexts(), ...await steered()].find(entry => entry.includes('cooking oil'))
  assert.equal(sent, 'cooking oil for rosin room 165 - 190 max \nworking temperature is 70')
  await expect.poll(async () => input().inputValue()).toMatch(/next thought$/)
  const left = await input().inputValue()
  assert.ok(!left.includes('cooking oil'), 'the sent words stayed in the composer: ' + JSON.stringify(left))
  check('Ctrl+Enter sends the whole message into the turn once, and typing on keeps only the new words')

  await page.waitForTimeout(1000)
  assert.equal(await sentAnywhere('cooking oil'), 1)
  assert.equal(await sentAnywhere('next thought'), 0)
  check('Nothing typed afterwards is sent without the owner sending it')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(results, null, 2))
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2) + '\n')
  await app.close()
}
