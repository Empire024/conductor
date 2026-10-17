import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Composer slash commands in Chat (docs/slash-commands.md), against the synthetic Codex App Server
// and Claude stream-json fixtures: a typed /permissions opens or sets the conversation mode instead
// of reaching the model (the reported bug), /compact and /review run as native Codex turns, a
// terminal-only or unknown command answers inline and keeps the draft, // sends a literal slash,
// and Claude's headless commands pass through to the CLI. CONDUCTOR_TEST_USER_DATA parks the window.
const root = await mkdtemp(join(tmpdir(), 'conductor-slash-commands-'))
const output = resolve('artifacts/slash-commands')
await mkdir(output, { recursive: true })
const capture = join(root, 'prompt.txt')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_CONTROL_CAPTURE: capture }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], screenshots: [] }
const shot = async (page, name) => { const path = join(output, name + '.png'); await page.screenshot({ path }); results.screenshots.push(path) }
let page
try {
  page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Slash commands smoke'))
  await page.evaluate(async projectId => {
    const [session] = await window.conductor.sessions.list(projectId)
    const layout = JSON.parse(JSON.stringify(session.layout))
    const find = node => Array.isArray(node?.tabs) ? node : (node?.children ?? []).map(find).find(Boolean)
    const group = find(layout.root)
    group.tabs = [
      { id: 'pane-codex', kind: 'agent', title: 'Codex slash', resourceId: 'agent-codex', state: { provider: 'codex', resume: false } },
      { id: 'pane-claude', kind: 'agent', title: 'Claude slash', resourceId: 'agent-claude', state: { provider: 'claude', resume: false, model: 'default', effort: 'auto' } }
    ]
    group.activeTabId = 'pane-codex'
    await window.conductor.sessions.save(session.id, layout, session.maximizedGroupId, session.closedTabs)
  }, project.id)
  await page.reload()
  await page.getByText('Slash commands smoke', { exact: true }).first().click()

  const pane = tabId => page.locator(`.pane-tab-content[data-performance-tab-id="${tabId}"] .structured-agent-pane`)
  const userTexts = async locator => {
    const id = await locator.getAttribute('data-structured-session')
    return page.evaluate(async sessionId => (await window.conductor.structured.snapshot(sessionId))?.items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text) ?? [], id)
  }
  const phase = async locator => { const id = await locator.getAttribute('data-structured-session'); return page.evaluate(async sessionId => (await window.conductor.structured.snapshot(sessionId))?.phase, id) }
  const settled = locator => expect.poll(() => phase(locator), { timeout: 20_000 }).toMatch(/^(idle|completed|failed|interrupted)$/)

  // ---- Codex ----
  const codex = pane('pane-codex')
  await codex.waitFor()
  const composer = codex.locator('.sa-composer textarea')
  const notice = codex.locator('.sa-command-notice')
  await composer.click()
  await expect(codex.locator('.sa-mode-trigger')).toBeEnabled({ timeout: 20_000 })
  await composer.fill('/')
  const menu = codex.locator('.sa-command-menu')
  await expect(menu).toBeVisible()
  const listed = await menu.locator('[role="option"] strong').allInnerTexts()
  for (const name of ['/permissions', '/model', '/compact', '/review', '/init', '/status', '/diff', '/new', '/help']) assert.ok(listed.includes(name), `Codex menu lists ${name}: ${listed.join(' ')}`)
  for (const name of ['/vim', '/logout', '/goal']) assert.ok(!listed.includes(name), `Codex menu leaves out unsupported ${name}`)
  await shot(page, '1-codex-menu')
  results.checks.push('Typing / in a Codex chat lists the supported commands (permissions, model, compact, review, init, status…) and leaves out terminal-only ones')

  await composer.fill('/perm')
  await expect(menu.locator('[role="option"][aria-selected="true"] strong')).toHaveText('/permissions')
  await composer.press('Enter')
  await expect(codex.locator('.sa-mode-menu')).toBeVisible()
  assert.equal(await composer.inputValue(), '')
  await shot(page, '2-codex-permissions-picker')
  await page.keyboard.press('Escape')
  results.checks.push('Choosing /permissions from the list opens the conversation mode picker')

  await composer.fill('/permissions read-only')
  await composer.press('Enter')
  await expect(codex.locator('.sa-mode-trigger')).toContainText('Read only')
  await expect(notice).toContainText('Mode set to Read only')
  assert.equal(await composer.inputValue(), '')
  await composer.fill('/approvals auto')
  await composer.press('Enter')
  await expect(codex.locator('.sa-mode-trigger')).toContainText('Auto')
  assert.deepEqual(await userTexts(codex), [], 'no /permissions text reached Codex')
  await shot(page, '3-codex-permissions-set')
  results.checks.push('Typed /permissions read-only and /approvals auto set the mode; nothing is sent to the model (the reported bug)')

  await composer.fill('/compact')
  await composer.press('Enter')
  await expect(notice).toContainText('Conversation compacted', { timeout: 20_000 })
  await composer.fill('/review focus on the parser')
  await composer.press('Enter')
  await expect(codex.locator('.sa-timeline')).toContainText('Synthetic review of custom: focus on the parser', { timeout: 20_000 })
  assert.deepEqual(await userTexts(codex), [], '/compact and /review are protocol calls, not messages')
  await shot(page, '4-codex-compact-review')
  results.checks.push('/compact runs thread/compact/start and /review runs review/start as native Codex turns, not messages')

  await composer.fill('/vim')
  await composer.press('Enter')
  await expect(notice).toHaveAttribute('data-tone', 'unsupported')
  await expect(notice).toContainText('terminal UI')
  assert.equal(await composer.inputValue(), '/vim', 'an unsupported command keeps the draft')
  await composer.fill('/frobnicate now')
  await composer.press('Enter')
  await expect(notice).toContainText('not a Codex or Conductor command')
  await shot(page, '5-codex-unsupported')
  results.checks.push('A terminal-only (/vim) or unknown command answers inline with the reason and keeps the draft')

  await composer.fill('/status')
  await composer.press('Enter')
  await expect(notice).toContainText('Codex')
  await expect(notice).toContainText('Mode: Auto')
  await expect(notice).toContainText('Session: ')
  await shot(page, '6-codex-status')
  results.checks.push('/status shows the runtime, model, mode, context, workspace and session inline')

  await composer.fill('//permissions is a word I typed')
  await composer.press('Enter')
  await expect.poll(() => userTexts(codex), { timeout: 20_000 }).toEqual([expect.stringContaining('/permissions is a word I typed')])
  await settled(codex)
  results.checks.push('// sends a literal slash message to the model')

  await composer.fill('/init')
  await composer.press('Enter')
  await expect.poll(async () => existsSync(capture) ? (await readFile(capture, 'utf8')) : '', { timeout: 20_000 }).toContain('Generate a file named AGENTS.md')
  results.checks.push('Codex /init sends the AGENTS.md generation prompt the Codex TUI sends')

  // ---- Claude ----
  await page.locator('.pane-tab').filter({ hasText: 'Claude slash' }).click()
  const claude = pane('pane-claude')
  await claude.waitFor()
  const claudeComposer = claude.locator('.sa-composer textarea')
  await claudeComposer.click()
  await expect(claude.locator('.sa-mode-trigger')).toBeEnabled({ timeout: 20_000 })
  await claudeComposer.fill('/')
  const claudeMenu = claude.locator('.sa-command-menu')
  await expect(claudeMenu).toBeVisible()
  // The fixture CLI reports one custom command; it is listed with the built-ins.
  await expect(claudeMenu.locator('[role="option"] strong', { hasText: '/fixture' })).toHaveCount(1, { timeout: 20_000 })
  const claudeListed = await claudeMenu.locator('[role="option"] strong').allInnerTexts()
  for (const name of ['/permissions', '/compact', '/context', '/init']) assert.ok(claudeListed.includes(name), `Claude menu lists ${name}`)
  assert.ok(!claudeListed.includes('/review'), 'Claude 2.1 has no /review')
  await claudeComposer.fill('/permissions')
  await claudeComposer.press('Enter')
  await expect(claude.locator('.sa-mode-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  assert.deepEqual(await userTexts(claude), [])
  await shot(page, '7-claude-permissions')
  results.checks.push('Claude /permissions opens the mode picker instead of the CLI’s "isn’t available in this environment"')

  await claudeComposer.fill('/compact keep the API notes')
  await claudeComposer.press('Enter')
  await expect.poll(() => userTexts(claude), { timeout: 20_000 }).toEqual([expect.stringContaining('/compact keep the API notes')])
  await expect.poll(async () => (await readFile(capture, 'utf8')), { timeout: 20_000 }).toContain('/compact keep the API notes')
  await claudeComposer.fill('/frobnicate')
  await claudeComposer.press('Enter')
  await expect(claude.locator('.sa-command-notice')).toContainText('not a Claude Code or Conductor command')
  await shot(page, '8-claude-passthrough')
  results.checks.push('Claude /compact passes through to the CLI as typed; a name the CLI did not report answers inline')

  assert.deepEqual(errors, [])
} catch (error) {
  // What the window showed when a check failed: its error bars, notices and the Codex projection.
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined)
    const state = await page.evaluate(async () => ({ errors: [...document.querySelectorAll('.sa-error-bar, .sa-command-notice')].map(node => node.textContent), sessions: await Promise.all([...document.querySelectorAll('[data-structured-session]')].map(async node => { const snapshot = await window.conductor.structured.snapshot(node.getAttribute('data-structured-session')); return { id: node.getAttribute('data-structured-session'), phase: snapshot?.phase, items: snapshot?.items.map(item => item.data.type + ':' + (item.data.message ?? item.data.text ?? item.data.phase ?? '')).slice(-20) } })) })).catch(reason => String(reason))
    console.error(JSON.stringify(state, null, 2))
  }
  throw error
} finally {
  await app.close()
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
}
console.log(JSON.stringify(results, null, 2))
