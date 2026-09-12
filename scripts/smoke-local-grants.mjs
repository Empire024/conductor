import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Verifies the two grant buttons a local model conversation gets in its composer footer:
// repository writes (git) and deep web research. Both are off unless the owner presses them,
// both persist on the conversation so a reopened pane shows what was granted, and neither is
// offered to a cloud provider's conversation, whose runtime has no sandbox to grant anything in.
const root = await mkdtemp(join(tmpdir(), 'conductor-local-grants-'))
const output = resolve('artifacts/local-grants')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Local grants smoke'))
  await page.evaluate(async projectId => {
    const [session] = await window.conductor.sessions.list(projectId)
    const layout = JSON.parse(JSON.stringify(session.layout))
    const find = node => Array.isArray(node?.tabs) ? node : (node?.children ?? []).map(find).find(Boolean)
    const group = find(layout.root)
    group.tabs = [
      { id: 'pane-local', kind: 'agent', title: 'Qwen', resourceId: 'agent-local', state: { provider: 'local', resume: false, model: 'default', effort: 'auto' } },
      { id: 'pane-claude', kind: 'agent', title: 'Claude', resourceId: 'agent-claude', state: { provider: 'claude', resume: false, model: 'default', effort: 'auto' } }
    ]
    group.activeTabId = 'pane-local'
    await window.conductor.sessions.save(session.id, layout, session.maximizedGroupId, session.closedTabs)
  }, project.id)
  await page.reload()
  await page.getByText('Local grants smoke', { exact: true }).first().click()
  await page.locator('.structured-agent-pane').first().waitFor()

  const localPane = page.locator('.pane-tab-content[data-performance-tab-id="pane-local"]')
  const gitButton = localPane.locator('.agent-prompt-controls button[aria-label$="repository writes"]')
  const researchButton = localPane.locator('.agent-prompt-controls button[aria-label$="deep web research"]')

  await expect(gitButton).toHaveAttribute('aria-pressed', 'false')
  await expect(researchButton).toHaveAttribute('aria-pressed', 'false')
  await expect(gitButton).toHaveAttribute('aria-label', 'Enable repository writes')
  await expect(researchButton).toHaveAttribute('aria-label', 'Enable deep web research')
  await page.screenshot({ path: join(output, '1-ungranted.png') })
  results.screenshots.push('1-ungranted.png')
  results.checks.push('A local conversation opens with both grants off')

  await gitButton.click()
  await researchButton.click()
  await expect(gitButton).toHaveAttribute('aria-pressed', 'true')
  await expect(researchButton).toHaveAttribute('aria-pressed', 'true')
  await expect(gitButton).toHaveAttribute('aria-label', 'Disable repository writes')
  await page.screenshot({ path: join(output, '2-granted.png') })
  results.screenshots.push('2-granted.png')
  results.checks.push('Pressing each button grants it and the pressed state is exposed to assistive tech')

  // The grant is conversation state, not pane state: it has to survive a reload.
  const saved = await page.evaluate(() => window.conductor.structured.snapshot('agent-local'))
  assert.equal(saved?.settings?.localGit, true, 'git grant must be persisted on the conversation')
  assert.equal(saved?.settings?.localResearch, true, 'research grant must be persisted on the conversation')
  await page.reload()
  await page.getByText('Local grants smoke', { exact: true }).first().click()
  await localPane.locator('.agent-prompt-controls').first().waitFor()
  await expect(gitButton).toHaveAttribute('aria-pressed', 'true')
  await expect(researchButton).toHaveAttribute('aria-pressed', 'true')
  results.checks.push('Both grants survive a reload, so a reopened pane shows what this conversation was actually granted')

  await gitButton.click()
  await expect(gitButton).toHaveAttribute('aria-pressed', 'false')
  assert.equal((await page.evaluate(() => window.conductor.structured.snapshot('agent-local')))?.settings?.localGit, false)
  results.checks.push('A grant can be withdrawn again from the same button')

  // A cloud conversation has no sandbox to grant anything in, so it is offered neither button.
  await page.locator('.pane-tab').filter({ hasText: 'Claude' }).first().click()
  const claudePane = page.locator('.pane-tab-content[data-performance-tab-id="pane-claude"]')
  await claudePane.locator('.agent-prompt-controls').first().waitFor()
  await expect(claudePane.locator('.agent-prompt-controls button[aria-label$="repository writes"]')).toHaveCount(0)
  await expect(claudePane.locator('.agent-prompt-controls button[aria-label$="deep web research"]')).toHaveCount(0)
  await page.screenshot({ path: join(output, '3-claude-has-neither.png') })
  results.screenshots.push('3-claude-has-neither.png')
  results.checks.push('A Claude conversation is offered neither grant button')

  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
