import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// Tool-call timing (docs/perf-evidence/t3code-cloud-tool-timings.md) through the real app: the
// synthetic Codex app-server reports nine finished commands (each first seen complete, with its own
// 4 ms durationMs, one exiting 2). Parked window (CONDUCTOR_TEST_USER_DATA), no inference, no network.
const root = await mkdtemp(join(tmpdir(), 'conductor-tool-timings-'))
const output = resolve('artifacts/tool-timings')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const results = { synthetic: true, checks: [], failures: [] }
const launch = async () => {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.conductor?.toolTimings))
  return { app, page }
}
let { app, page } = await launch()
try {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await page.evaluate(() => window.conductor.projects.create('Tool timings'))
  await page.reload()
  await page.getByText('Tool timings', { exact: true }).first().click()
  await launcherTile(page, 'Codex').click()
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('synthetic:activity-groups')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), id)).phase).toBe('completed')

  const report = await page.evaluate(id => window.conductor.toolTimings.report({ agentSessionId: id, recent: 20 }), id)
  assert.equal(report.totals.calls, 9)
  assert.equal(report.totals.failures, 1)
  assert.equal(report.totals.inFlight, 0)
  // First seen finished: elapsed is unavailable (null), never 0; exec is Codex's own durationMs.
  assert.ok(report.recent.every(record => record.elapsedMs === null && record.elapsedSource === 'unavailable'))
  assert.ok(report.recent.every(record => record.execMs === 4 && record.execSource === 'provider'))
  assert.ok(report.recent.every(record => record.waitMs === null && record.waitSource === 'unavailable'))
  assert.deepEqual(report.coverage, { ...report.coverage, elapsed: 0, wait: 0, exec: 1 })
  assert.equal(report.failures[0].exitCodes[0], 2)
  assert.ok(report.recent.every(record => record.args.startsWith('pwsh.exe -NoProfile')))
  results.checks.push('Nine synthetic Codex commands recorded once each with provider exec, unavailable elapsed/wait, one failure with its exit code')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Usage', exact: true }).click()
  const section = panel.locator('.tool-timings-setting')
  await expect(section.locator('.tool-timings-summary')).toContainText('9 calls')
  await expect(section.locator('.tool-timings-summary')).toContainText('elapsed 0%')
  await expect(section.locator('tr[data-tool="PowerShell"] td').nth(3)).toHaveText('n/a')
  // The headline claims recorded structured calls only, and says what is not recorded.
  await expect(section.locator('.settings-section-title')).toContainText('Structured tool calls recorded')
  await expect(section.locator('.tool-timings-scope')).toContainText('Not recorded: raw CLI-view tabs, cloud coworkers')
  await expect(section.locator('.tool-timings-gaps')).toHaveAttribute('open', '')
  await expect(section.locator('.tool-timings-slowest li').first()).toContainText('exec · provider')
  await section.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'settings-usage.png'), fullPage: true })
  results.checks.push('Settings > Usage shows the breakdown, unmeasured elapsed as n/a, exec labelled by source, and what is not recorded')
  assert.deepEqual(errors, [])

  // Quit writes what was not yet durable to the exit file; the next launch merges it into the
  // main file once and removes it, so each call is read back exactly once.
  await app.close()
  const directory = join(root, 'profile', 'tool-timings')
  const keysIn = async name => (await readFile(join(directory, name), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line).key)
  const written = [...await keysIn('tool-timings.jsonl'), ...await keysIn('tool-timings.exit.jsonl')]
  assert.equal(new Set(written).size, 9)
  ;({ app, page } = await launch())
  await expect.poll(() => page.evaluate(() => window.conductor.toolTimings.report({}).then(report => report.totals.calls))).toBe(9)
  // The relaunch claimed the quit's exit file and deleted its claim once the rewrite was durable.
  await expect.poll(async () => (await readdir(directory)).filter(name => name.includes('.exit.'))).toEqual([])
  const merged = await keysIn('tool-timings.jsonl')
  assert.equal(merged.length, 9)
  assert.equal(new Set(merged).size, 9)
  results.checks.push('Records survive a restart exactly once: the exit file is claimed, merged into the main file, and no exit or claimed file remains')
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'failed.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close().catch(() => {})
}
console.log(JSON.stringify(results, null, 2))
