import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// Sticky bar (owner to-do 01b78446): the bar pins the owner's last prompt; when that prompt is
// fully in view already it pins the next message after it instead, with a short slide-in. A
// parked offline window (CONDUCTOR_TEST_USER_DATA) and the deterministic Codex fixture, so no
// inference. Run: node scripts/smoke-lock.mjs --timeout-min 5 -- node scripts/smoke-sticky-next-message.mjs
const root = await mkdtemp(join(tmpdir(), 'conductor-sticky-next-'))
const output = resolve('artifacts/sticky-next-message')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20_000)
const checks = []
const errors = []
const pass = name => { checks.push(name); console.log('PASS ' + name) }
page.on('pageerror', error => errors.push(error.stack ?? error.message))

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Sticky next'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Sticky next' }).click()
  await launcherTile(page, 'Codex').click()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async sid => { await window.conductor.structured.connect(sid) }, id)
  for (let turn = 0; turn < 6; turn++) {
    const before = (await page.evaluate(sid => window.conductor.structured.snapshot(sid), id)).sequence
    await page.evaluate(async sid => {
      const state = await window.conductor.structured.snapshot(sid)
      await window.conductor.structured.submit(sid, 'synthetic:stream', { ...state.settings, model: 'synthetic-model', effort: 'low' }, [])
    }, id)
    await expect.poll(async () => { const s = await page.evaluate(sid => window.conductor.structured.snapshot(sid), id); return s.phase === 'completed' && s.sequence > before }, { timeout: 30000 }).toBe(true)
  }
  const pane = page.locator('[data-structured-session="' + id + '"]')
  const pin = pane.locator('.sa-pinned-prompt')
  const timeline = pane.locator('.sa-timeline')
  await expect(pin).toBeVisible()

  // Rects of the last prompt and the card after it, relative to the timeline viewport.
  const probe = () => timeline.evaluate(el => {
    const view = el.getBoundingClientRect()
    const cards = [...el.querySelectorAll('[data-item-id]')]
    const users = cards.filter(card => card.querySelector?.('.sa-user') || card.classList.contains('sa-user') || card.className.includes('sa-role-user') || card.className.includes('sa-user'))
    const last = users.at(-1)
    const next = last ? cards[cards.indexOf(last) + 1] : null
    const box = card => card ? { top: card.getBoundingClientRect().top - view.top, bottom: card.getBoundingClientRect().bottom - view.top } : null
    return { height: view.height, last: box(last), next: box(next), nextText: next?.textContent?.slice(0, 40), scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, classes: cards.slice(-4).map(card => card.className) }
  })
  console.log(JSON.stringify(await probe()))

  // At the live end the last prompt is above the fold or the reply is below it: the prompt stays.
  await timeline.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(pin).toHaveAttribute('aria-label', /your last message/)
  pass('The last prompt stays stuck while it is out of view')

  // Scroll so the last prompt sits fully at the top of the viewport and the reply runs on below.
  await page.setViewportSize({ width: 1100, height: 410 })
  await timeline.evaluate(el => {
    const cards = [...el.querySelectorAll('[data-item-id]')]
    const users = cards.filter(card => /sa-user|role-user/.test(card.className))
    const last = users.at(-1)
    if (!last) throw new Error('no user card found: ' + cards.map(card => card.className).join(' | '))
    el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top - 4
  })
  const state = await probe()
  console.log(JSON.stringify(state))
  assert.ok(state.last && state.last.top >= 0 && state.last.bottom <= state.height, 'The last prompt is fully in view')
  await expect(pin).toHaveAttribute('aria-label', /the message after your last one/)
  await expect(pin).toHaveClass(/sa-pinned-changed/)
  const name = await pin.evaluate(el => getComputedStyle(el).animationName)
  assert.equal(name, 'sa-pinned-in')
  await page.screenshot({ path: join(output, 'sticky-next.png') })
  pass('With the prompt in view the bar sticks the next message and plays the slide-in')

  // Scroll back to the end: the prompt returns (no animation class required to be absent: it changed).
  await timeline.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(pin).toHaveAttribute('aria-label', /your last message/)
  pass('Scrolling the prompt out of view puts it back on the bar')
  assert.deepEqual(errors, [])
} catch (error) {
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
  await page.screenshot({ path: join(output, 'sticky-next-failed.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
  await app.close().catch(() => {})
  console.error(errors.join('\n'))
  process.exit(1)
}
await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
await app.close().catch(() => {})
console.log(JSON.stringify({ checks }, null, 2))
