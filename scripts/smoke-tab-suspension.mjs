import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Inactive conversation tabs are suspended (src/renderer/src/layout/tab-keep-alive.ts): their
// views unmount while the conversations stay registered and running in main, and a view rebuilds
// from the durable snapshot when its tab is selected again. Offline and parked, against the real
// app and the synthetic Codex runtime, this checks what must survive that round trip: the draft,
// the timeline's scroll position, a pending approval, and the tab's needs-attention indicator,
// including for a conversation that has been suspended since a restart-style reload.
const root = await mkdtemp(join(tmpdir(), 'conductor-tab-suspension-'))
const output = resolve('artifacts/tab-suspension')
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
  const project = await page.evaluate(() => window.conductor.projects.create('Suspension fixture'))
  await page.evaluate(async projectId => {
    const [session] = await window.conductor.sessions.list(projectId)
    const layout = JSON.parse(JSON.stringify(session.layout))
    const find = node => Array.isArray(node?.tabs) ? node : (node?.children ?? []).map(find).find(Boolean)
    const group = find(layout.root)
    group.tabs = ['a', 'b', 'c'].map(id => ({ id: 'pane-' + id, kind: 'agent', title: 'Codex ' + id.toUpperCase(), resourceId: 'agent-' + id, state: { provider: 'codex', resume: false, model: 'default', effort: 'auto' } }))
    group.activeTabId = 'pane-a'
    await window.conductor.sessions.save(session.id, layout, session.maximizedGroupId, session.closedTabs)
  }, project.id)
  const open = async () => {
    await page.reload()
    await page.waitForFunction(() => Boolean(window.conductor?.structured))
    await page.getByText('Suspension fixture', { exact: true }).first().click()
    await page.locator('.pane-tab-content:visible .structured-agent-pane').waitFor()
  }
  const visible = page.locator('.pane-tab-content:visible')
  const composer = () => visible.getByRole('textbox', { name: /message|prompt/i }).last()
  const select = async id => {
    await page.locator(`.pane-tab[data-control-tab-id="pane-${id}"]`).click()
    await expect(visible.locator('.structured-agent-pane')).toHaveAttribute('data-structured-session', 'agent-' + id)
    await expect(composer()).toBeEnabled({ timeout: 20_000 })
  }
  const snapshot = id => page.evaluate(agent => window.conductor.structured.snapshot(agent), id)
  const shot = async name => { const path = join(output, name + '.png'); await page.screenshot({ path }); results.screenshots.push(path) }

  await open()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(1)
  // The suspended conversations were still registered with main, as their mounted panes would have.
  await expect.poll(() => page.evaluate(() => window.conductor.agents.activityPhases(['agent-b', 'agent-c'])).then(phases => Object.keys(phases).sort()), { timeout: 15_000 }).toEqual(['agent-b', 'agent-c'])
  results.checks.push('Only the selected conversation mounts a view; the suspended ones are registered with main all the same')

  // A long timeline in A, read from the middle, with an unsent draft.
  await composer().fill('synthetic:perf-stream')
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot('agent-a'))?.phase, { timeout: 60_000 }).toBe('completed')
  const timeline = visible.locator('.sa-timeline')
  const read = () => timeline.evaluate(element => ({ top: Math.round(element.scrollTop), max: element.scrollHeight - element.clientHeight }))
  await timeline.hover()
  await page.mouse.wheel(0, -Math.round((await read()).max / 2))
  await page.waitForTimeout(400)
  const before = await read()
  assert.ok(before.top > 200 && before.top < before.max - 400, 'the timeline is read from the middle: ' + JSON.stringify(before))
  await composer().fill('Draft kept across suspension')

  // B waits on an approval (Edit mode keeps the card instead of Auto answering it).
  await select('b')
  await expect(page.locator('.structured-agent-pane')).toHaveCount(1)
  const draftKey = 'conductor.structured.draft.' + JSON.stringify([project.id, 'agent-a'])
  assert.match(await page.evaluate(key => localStorage.getItem(key) ?? '', draftKey), /Draft kept across suspension/)
  results.checks.push('Leaving a conversation writes its draft to storage at once, not after the typing pause')
  await visible.getByRole('button', { name: 'Conversation mode', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /Edit/ }).click()
  await expect(visible.getByRole('button', { name: 'Conversation mode', exact: true })).toHaveText('Edit')
  await composer().fill('synthetic:approval')
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await visible.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 20_000 })

  await select('c')
  const tabB = page.locator('.pane-tab[data-control-tab-id="pane-b"]')
  await expect(tabB).toHaveClass(/needs-attention/)
  results.checks.push('A suspended conversation waiting for approval keeps its needs-attention indicator')

  await select('a')
  await expect(composer()).toHaveValue('Draft kept across suspension')
  await expect.poll(async () => Math.abs((await read()).top - before.top), { timeout: 5_000 }).toBeLessThan(60)
  const after = await read()
  assert.ok(after.top < after.max - 400, 'the restored view did not jump to the bottom: ' + JSON.stringify(after))
  await shot('restored-scroll-and-draft')
  results.checks.push('Returning to a suspended conversation restores its draft and the scroll position it was read at')

  // A restart-style reload with C selected: B has been suspended since startup.
  await select('c')
  await open()
  await expect(visible.locator('.structured-agent-pane')).toHaveAttribute('data-structured-session', 'agent-c')
  await expect(page.locator('.structured-agent-pane')).toHaveCount(1)
  await expect(tabB).toHaveClass(/needs-attention/, { timeout: 15_000 })
  await shot('needs-attention-after-reload')
  results.checks.push('After a reload, a conversation suspended from startup shows its needs-attention indicator from main\'s record')

  await select('b')
  await visible.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(async () => (await snapshot('agent-b'))?.phase, { timeout: 20_000 }).toBe('completed')
  await expect(tabB).not.toHaveClass(/needs-attention/)
  results.checks.push('The pending approval is still there and answerable when its tab is selected again')

  assert.deepEqual(errors, [])
  console.log(JSON.stringify(results, null, 2))
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
