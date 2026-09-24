import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Long conversations and the CLI drawer, in a parked, offline launch (CONDUCTOR_TEST_USER_DATA: the
// window sits off every display and never takes focus). A Claude conversation replays the fixture's
// SYNTHETIC LONG turn, so its projection holds the latest 2000 items and older ones exist only in
// the journal. Checks, against the real renderer and store:
//   - the pane renders only a recent window, and scrolling up pages earlier activity in, past the
//     resident projection into the journal, keeping the card being read where it was;
//   - Copy transcript copies the whole stored conversation as Markdown without scrolling;
//   - Ctrl+F finds a message that only the journal holds and pages it into view;
//   - CLI opens the native CLI in a drawer under the chat; hiding and showing it keeps the same PTY;
//     while a turn runs the drawer shows it live, read-only; Continue in Chat hands back.
// --only=cli runs just the drawer checks on a short conversation.
const cliOnly = process.argv.includes('--only=cli')
const events = cliOnly ? 20 : Number(process.argv.find(arg => arg.startsWith('--events='))?.slice(9) ?? 6000)
const root = await mkdtemp(join(tmpdir(), 'conductor-history-smoke-'))
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const errors = []
const check = label => console.log('ok -', label)
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  // Copies land here, never on the owner's system clipboard; toasts and CLI status are kept for diagnostics.
  const instrument = () => page.evaluate(() => {
    window.__copied = []; navigator.clipboard.writeText = async text => { window.__copied.push(text) }
    window.__toasts = []; window.addEventListener('conductor:toast', event => window.__toasts.push(String(event.detail)))
    window.__cli = []; window.conductor.nativeCli.onStatus(state => window.__cli.push(state))
  })
  await instrument()
  await page.evaluate(() => window.conductor.projects.create('History fixture'))
  await page.getByText('History fixture', { exact: true }).first().click()
  // A conversation opened the way the owner opens one: the new tab's launcher.
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).first().click()
  const visible = page.locator('.pane-tab-content:visible')
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30_000 })
  const id = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const open = async () => {
    await page.reload()
    await page.waitForFunction(() => Boolean(window.conductor?.structured))
    await instrument()
    await page.getByText('History fixture', { exact: true }).first().click()
    await visible.locator('.structured-agent-pane').waitFor({ timeout: 30_000 })
  }
  const composer = () => visible.getByRole('textbox', { name: /message/i }).last()
  const snapshot = () => page.evaluate(agent => window.conductor.structured.snapshot(agent).then(state => ({ phase: state?.phase, view: state?.view, truncated: state?.truncated, first: state?.items[0]?.sequence, ids: state?.items.map(item => item.id) })), id)
  await composer().fill('SYNTHETIC LONG ' + events)
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot()).phase, { timeout: 600_000, intervals: [250] }).toBe('completed')
  await open()
  await expect(composer()).toBeEnabled({ timeout: 30_000 })
  const resident = await snapshot()
  assert.equal(resident.truncated || cliOnly, true, 'the fixture conversation must outgrow the resident projection')
  const timeline = visible.locator('.sa-timeline')
  if (!cliOnly) {
  // 1. Only a recent window renders; scrolling up pages the rest in, anchored.
  const rendered = () => timeline.evaluate(el => el.querySelectorAll('[data-item-id]').length)
  const initial = await rendered()
  assert.ok(initial > 0 && initial <= 400, `initial render should be a recent window, got ${initial} cards`)
  check(`opens on a recent window (${initial} cards of a truncated conversation)`)
  // Scrolls to the top and, in the same task (before any observer or render can run), notes the
  // card at the top of the view, so the anchor is measured before the page lands.
  const scrollUp = () => timeline.evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }))
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
    const top = el.getBoundingClientRect().top
    const card = [...el.querySelectorAll('[data-item-id]')].find(node => node.getBoundingClientRect().bottom > top + 1 && node.getBoundingClientRect().height > 0)
    return card ? { key: card.getAttribute('data-item-id'), offset: Math.round(card.getBoundingClientRect().top - top) } : null
  })
  let olderSeen = false, anchored = 0
  for (let step = 0; step < 60 && !olderSeen; step++) {
    const before = await rendered()
    const anchor = await scrollUp()
    await expect.poll(rendered, { timeout: 20_000 }).toBeGreaterThan(before).catch(() => {})
    // The card at the top of the view before the page landed is still there, at the same place.
    if (anchor?.key) {
      const moved = await timeline.evaluate((el, key) => { const card = el.querySelector(`[data-item-id="${CSS.escape(key)}"]`); return card ? Math.round(card.getBoundingClientRect().top - el.getBoundingClientRect().top) : null }, anchor.key)
      if (moved !== null) { assert.ok(Math.abs(moved - anchor.offset) <= 2, `paging moved the card being read by ${moved - anchor.offset}px`); anchored++ }
    }
    olderSeen = await timeline.evaluate((el, ids) => [...el.querySelectorAll('[data-item-id]')].some(card => !ids.includes(card.getAttribute('data-item-id'))), resident.ids)
  }
  assert.ok(anchored > 0, 'no paging step could be checked for anchoring')
  assert.ok(olderSeen, 'scrolling up never reached activity older than the resident projection')
  check(`scrolling up pages earlier activity in from the journal, anchored (${await rendered()} cards, ${anchored} anchored steps)`)

  // 2. Copy transcript: the whole stored conversation, without scrolling.
  await open()
  await visible.getByRole('button', { name: 'Copy transcript', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(1)
  const markdown = await page.evaluate(() => window.__copied[0])
  assert.match(markdown, /^# /)
  assert.ok(markdown.includes('## You\n\nSYNTHETIC LONG ' + events), 'the transcript starts with the first prompt')
  assert.ok(markdown.includes('## Step 1: tracing the panel state'), 'the transcript holds the first reply, which only the journal keeps')
  assert.match(markdown, /- `Bash` `npx vitest run /)
  assert.ok(!markdown.includes('Synthetic output line'), 'tool output stays out of the transcript')
  check(`Copy transcript copies the whole conversation (${Math.round(markdown.length / 1024)} KB of Markdown)`)

  // 3. Ctrl+F reaches a message only the journal holds.
  await composer().click()
  await page.keyboard.press('Control+f')
  const findBox = visible.locator('.sa-find input')
  await expect(findBox).toBeVisible()
  await findBox.fill('Step 2: tracing')
  await expect(visible.locator('.sa-find-count')).toHaveText(/^\d+ of \d+$/, { timeout: 20_000 })
  await expect.poll(() => timeline.evaluate(el => { const card = el.querySelector('.sa-find-current'); if (!card) return false; const box = card.getBoundingClientRect(), view = el.getBoundingClientRect(); return box.bottom > view.top && box.top < view.bottom }), { timeout: 20_000 }).toBe(true)
  check('Ctrl+F finds a message only the journal holds and pages it into view')
  await page.keyboard.press('Escape')
  }

  // 4. The CLI drawer: the native CLI under the chat, never restarted by hiding it.
  await open()
  await visible.getByRole('button', { name: 'CLI', exact: true }).click()
  const terminal = visible.locator('.sa-cli-drawer .native-cli-pane:not(.sa-cli-live) .native-cli-terminal')
  await expect(terminal).toContainText('Synthetic native CLI', { timeout: 20_000 }).catch(async error => {
    console.log('drawer:', await visible.locator('.sa-cli-drawer').evaluate(el => el.innerText.slice(0, 600)).catch(() => 'none'))
    console.log('toasts:', await page.evaluate(() => window.__toasts)); console.log('cli:', JSON.stringify(await page.evaluate(() => window.__cli)))
    console.log('snapshot view:', (await snapshot()).view)
    throw error
  })
  await expect(visible.locator('.structured-agent-pane')).toBeVisible()
  await expect(composer()).toBeDisabled()
  await expect(visible.locator('.sa-cli-owned')).toContainText('native CLI')
  await terminal.click()
  await page.keyboard.type('marker-typed-before-hide')
  await expect(terminal).toContainText('marker-typed-before-hide')
  await terminal.evaluate(el => { el.dataset.smokeIdentity = 'first' })
  await visible.locator('.sa-session-bar').getByRole('button', { name: 'CLI', exact: true }).click()
  await expect(visible.locator('.sa-cli-drawer')).toBeHidden()
  await visible.locator('.sa-session-bar').getByRole('button', { name: 'CLI', exact: true }).click()
  await expect(terminal).toBeVisible()
  assert.equal(await terminal.evaluate(el => el.dataset.smokeIdentity), 'first', 'showing the drawer again must reuse the same terminal')
  await expect(terminal).toContainText('marker-typed-before-hide')
  check('CLI opens the native CLI in a drawer under the chat; hide and show keep the same PTY, typing works')
  await visible.getByRole('button', { name: 'Continue in Chat', exact: true }).first().click()
  await expect(composer()).toBeEnabled({ timeout: 20_000 })
  await expect(visible.locator('.sa-cli-drawer')).toHaveCount(0)
  assert.equal((await snapshot()).view, 'visual')
  check('Continue in Chat stops the CLI and hands the conversation back')

  // 5. While a turn runs, the drawer shows it live and read-only.
  await composer().fill('SYNTHETIC STEER START')
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot()).phase, { timeout: 30_000 }).toBe('running')
  await visible.locator('.sa-session-bar').getByRole('button', { name: 'CLI', exact: true }).click()
  const live = visible.locator('.sa-cli-live')
  await expect(live).toBeVisible()
  await expect(live.getByRole('button', { name: 'Open native CLI' })).toBeDisabled()
  await expect(live.locator('.native-cli-terminal')).toContainText('SYNTHETIC STEER START', { timeout: 20_000 })
  await expect(live.locator('.native-cli-terminal')).toContainText('running')
  assert.equal((await snapshot()).view, 'visual', 'watching a running turn must not hand the conversation to the CLI')
  check('while a turn runs, CLI shows it live and read-only without taking the conversation')
  await composer().focus()
  await page.keyboard.press('Escape')
  await expect(live.getByRole('button', { name: 'Open native CLI' })).toBeEnabled({ timeout: 20_000 })
  check('once the turn settles the drawer offers the native CLI')
  assert.deepEqual(errors, [])
} finally {
  await app.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
