import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Verifies the composer footer's Browser button (next to attach-file/image) opens/focuses a
// browser PANE TAB in the current workspace - the same surface the browser MCP tools drive
// (they resolve a webview by matching the pane tab id, filtered to kind 'browser', via
// AgentControl.tabs) - rather than the sidebar Browser panel, which those tools cannot reach.
// Also checks the pressed state follows the tab honestly: it must reflect whether that tab
// actually exists and is the one showing, including when it is closed from its own tab strip
// or backgrounded by switching to a different tab, and that the @browser mention shares the
// same activation path.
//
// Note on interaction: the button lives inside its own conversation's composer, in the same
// tab strip/group as the browser tab it opens (matching how the MCP tools' own auto-open adds
// the tab - see agent-control.ts's open()). Opening the browser tab therefore hides that
// composer, same as switching to any other tab would. A physical second click on the now-
// hidden button is not something a real pointer could ever do either, so the "closes on a
// second press while still showing" case is exercised by dispatching the same
// conductor:toggle-browser-tab event the button itself dispatches - it drives the identical
// App.tsx handler, just without fighting Playwright's visibility rules on a hidden button.
const root = await mkdtemp(join(tmpdir(), 'conductor-browser-button-'))
const output = resolve('artifacts/browser-composer-button')
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
  const project = await page.evaluate(() => window.conductor.projects.create('Browser button smoke'))
  await page.evaluate(async projectId => {
    const [session] = await window.conductor.sessions.list(projectId)
    const layout = JSON.parse(JSON.stringify(session.layout))
    const find = node => Array.isArray(node?.tabs) ? node : (node?.children ?? []).map(find).find(Boolean)
    const group = find(layout.root)
    group.tabs = [{ id: 'pane-one', kind: 'agent', title: 'Claude one', resourceId: 'agent-one', state: { provider: 'claude', resume: false, model: 'default', effort: 'auto' } }]
    group.activeTabId = 'pane-one'
    await window.conductor.sessions.save(session.id, layout, session.maximizedGroupId, session.closedTabs)
  }, project.id)
  await page.reload()
  await page.getByText('Browser button smoke', { exact: true }).first().click()
  await page.locator('.structured-agent-pane').first().waitFor()
  // Scoped to the Claude tab's own content by its fixed id, not ":visible" - the active pane
  // switches to the browser tab partway through this script, and a ":visible" locator would
  // silently start resolving to the wrong pane's DOM once that happens.
  const claudePane = page.locator('.pane-tab-content[data-performance-tab-id="pane-one"]')
  const browserButton = claudePane.locator('.agent-prompt-controls button[aria-label$="browser tab"]')
  const browserPaneTab = page.locator('.pane-tab').filter({ hasText: 'Browser' })
  const browserSidebarPanel = page.locator('.browser-sidebar')

  // Placement: right after the attach-file button, in the same footer as the image upload.
  const footerOrder = await claudePane.locator('.agent-prompt-controls').first().evaluate(footer =>
    [...footer.children].map(child => child.matches('.sa-image-upload') ? 'images' : child.getAttribute('aria-label')))
  assert.equal(footerOrder[0], 'images')
  assert.equal(footerOrder[1], 'Attach file context')
  assert.equal(footerOrder[2], 'Open browser tab')
  results.checks.push('Browser button sits in the composer footer right after attach-file and image controls')

  await expect(browserButton).toHaveAttribute('aria-pressed', 'false')
  await expect(browserButton).toHaveAttribute('aria-label', 'Open browser tab')
  await expect(browserPaneTab).toHaveCount(0)
  await page.screenshot({ path: join(output, '1-closed.png') })

  // Pressing it creates a real pane tab (kind 'browser'), the same surface AgentControl.tabs
  // resolves for the MCP tools - not the sidebar panel, which stays untouched.
  await browserButton.click()
  await expect(browserButton).toHaveAttribute('aria-pressed', 'true')
  await expect(browserButton).toHaveAttribute('aria-label', 'Close browser tab')
  await expect(browserPaneTab).toHaveCount(1)
  await expect(browserPaneTab).toHaveClass(/active/)
  const browserTabId = await browserPaneTab.getAttribute('data-control-tab-id')
  const browserContent = page.locator(`.pane-tab-content[data-performance-tab-id="${browserTabId}"]`)
  await expect(browserContent.locator('.browser-toolbar')).toBeVisible()
  await expect(browserSidebarPanel).toHaveCount(0)
  await page.screenshot({ path: join(output, '2-open-via-button.png') })
  results.checks.push('Clicking the composer Browser button opens a browser pane tab (not the sidebar panel) and turns the button pressed')

  // A second press (dispatched the same way the button itself does - see note above) closes
  // that same tab while it is still the one showing, and the workspace goes back to just Claude.
  await page.evaluate(() => window.dispatchEvent(new Event('conductor:toggle-browser-tab')))
  await expect(browserPaneTab).toHaveCount(0)
  await expect(browserButton).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: join(output, '3-closed-again.png') })
  results.checks.push('A second activation closes the browser pane tab while it is showing and clears the pressed state')

  // Re-open, then switch to the other (agent) tab without closing the browser tab: it still
  // exists but is no longer the one showing, so the button must go unpressed - not a local
  // click-count boolean, the real layout state.
  await browserButton.click()
  await expect(browserPaneTab).toHaveCount(1)
  await page.locator('.pane-tab').filter({ hasText: 'Claude one' }).click()
  await expect(browserButton).toHaveAttribute('aria-pressed', 'false')
  await expect(browserPaneTab).toHaveCount(1)
  await expect(browserPaneTab).not.toHaveClass(/active/)
  results.checks.push('Switching away to another tab backgrounds the browser tab (still open, not focused) and the button reflects that honestly')

  // Pressing it again (physically clickable now, since Claude's pane is the one showing)
  // focuses the existing tab instead of creating a second one.
  await browserButton.click()
  await expect(browserPaneTab).toHaveCount(1)
  await expect(browserPaneTab).toHaveClass(/active/)
  results.checks.push('Pressing the button while the tab exists but is backgrounded focuses it instead of opening a second browser tab')

  // Closing it from its own tab strip (not the composer button) must also clear the pressed
  // state once Claude's pane is showing again - proving the button tracks the real tab,
  // wherever it gets closed from.
  await browserPaneTab.locator('.tab-close').click()
  await expect(browserPaneTab).toHaveCount(0)
  await expect(browserButton).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: join(output, '4-closed-from-tab-strip.png') })
  results.checks.push('Closing the browser tab from its own tab strip is reflected in the composer button, proving it tracks the real tab')

  // The @browser composer mention shares the same activation path and must still work.
  // A plain CSS locator, not getByRole: choosing @browser hides this pane (same as any other
  // tab switch), and elements under display:none drop out of the accessibility tree entirely,
  // so a role-based query would stop resolving right when we need to read the cleared value.
  const composer = claudePane.locator('.sa-composer textarea')
  await composer.fill('@browser')
  await page.locator('.sa-command-menu button', { hasText: 'browser' }).click()
  await expect(browserPaneTab).toHaveCount(1)
  await expect(browserButton).toHaveAttribute('aria-pressed', 'true')
  assert.equal(await composer.inputValue(), '', '@browser must not be sent as literal text')
  await page.screenshot({ path: join(output, '5-open-via-mention.png') })
  results.checks.push('@browser composer mention opens the same browser pane tab through the shared activation path, without sending literal text')

  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
