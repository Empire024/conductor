import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// A long paste folds into a "[Pasted text #N: L lines]" chip and is sent as attached context.
// Isolated synthetic provider; the window is parked off-screen by CONDUCTOR_TEST_USER_DATA.
const root = await mkdtemp(join(tmpdir(), 'conductor-pasted-text-'))
const output = resolve('artifacts/pasted-text')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow()
const errors = []
const results = { synthetic: true, checks: [], failures: [] }
page.on('pageerror', error => errors.push(error.message))
const composer = () => page.getByRole('textbox', { name: /^Message / }).last()
const snapshot = id => page.evaluate(id => window.conductor.structured.snapshot(id), id)
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Pasted text project'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Pasted text project' }).click()
  await page.locator('.structured-agent-pane:visible, .launcher-grid:visible').first().waitFor()
  if (!await page.locator('.structured-agent-pane:visible').count()) await page.locator('.launcher-grid:visible button').filter({ hasText: 'Codex' }).click()
  await expect(composer()).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')

  await composer().fill('Kept draft')
  await composer().press('End')
  await page.keyboard.insertText('x'.repeat(128_001))
  await expect(page.getByRole('alert')).toContainText('128,000')
  await expect(composer()).toHaveValue('Kept draft')
  await expect(page.locator('.sa-context-chips > span')).toHaveCount(0)
  results.checks.push('A paste too large for one attachment is refused by name and keeps the draft')

  const prompt = 'SYNTHETIC B: without tools, report the fixture result. '
  await composer().fill(prompt)
  await composer().press('End')
  await page.keyboard.insertText(Array.from({ length: 612 }, (_, index) => 'log line ' + index).join('\n'))
  await expect(composer()).toHaveValue(prompt + '[Pasted text #1: 612 lines]')
  await expect(page.locator('.sa-context-chips')).toContainText('Pasted text #1: 612 lines')
  await page.locator('.sa-context-chips button').filter({ hasText: 'Pasted text #1' }).click()
  await expect(page.getByRole('dialog')).toContainText('log line 611')
  await page.screenshot({ path: join(output, 'inspect.png') })
  await page.getByRole('button', { name: 'Put back in the message as text', exact: true }).click()
  await expect(composer()).toHaveValue(new RegExp('^' + prompt + 'log line 0\\n'))
  await expect(page.locator('.sa-context-chips > span')).toHaveCount(0)
  results.checks.push('The chip is inspectable and can be put back into the message as text')

  await composer().fill(prompt)
  await composer().press('End')
  await page.keyboard.insertText(Array.from({ length: 40 }, (_, index) => 'second ' + index).join('\n'))
  await expect(page.locator('.sa-context-chips')).toContainText('Pasted text #1: 40 lines')
  await page.getByRole('button', { name: 'Remove context Pasted text #1: 40 lines', exact: true }).click()
  await expect(composer()).toHaveValue(prompt)
  results.checks.push('Removing the chip also removes its placeholder')

  await composer().press('End')
  await page.keyboard.insertText(Array.from({ length: 612 }, (_, index) => 'log line ' + index).join('\n'))
  await expect(page.locator('.sa-context-chips')).toContainText('Pasted text #1: 612 lines')
  await page.screenshot({ path: join(output, 'chip.png') })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(composer()).toHaveValue('')
  await expect(page.locator('.sa-context-chips > span')).toHaveCount(0)
  await expect.poll(async () => (await snapshot(id)).phase).toBe('completed')
  const sent = (await snapshot(id)).items.find(item => item.data.type === 'text' && item.data.role === 'user')
  assert.equal(sent.data.text, prompt.trim() + ' [Pasted text #1: 612 lines]')
  assert.ok(sent.data.attachments.some(attachment => attachment.name === 'Pasted text #1: 612 lines' && attachment.content === undefined))
  await expect(page.locator('.sa-message-attachments')).toContainText('Pasted text #1: 612 lines')
  await expect(page.locator('.sa-timeline')).not.toContainText('log line 611')
  await page.screenshot({ path: join(output, 'timeline.png') })
  results.checks.push('The paste is sent as attached context and the timeline keeps it as an attachment, not inline')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
