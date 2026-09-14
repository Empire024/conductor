import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Verifies the host performance chip in the real app: it stays out of the status bar while the
// machine is quiet, appears once there is something to report (a local model server resident, or
// the machine itself under load), and expands into a panel naming CPU, memory, GPU and the
// processes responsible. The snapshot is injected through the same IPC shape the main process
// answers with, so the check does not depend on what this particular machine happens to be doing.
const root = await mkdtemp(join(tmpdir(), 'conductor-system-performance-'))
const output = resolve('artifacts/system-performance')
await mkdir(output, { recursive: true })
const fixture = join(root, 'metrics.json')
const env = { ...process.env, CONDUCTOR_TEST_SYSTEM_METRICS: fixture, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const quiet = {
  sampledAt: new Date().toISOString(),
  cpuPercent: 4, cpuCores: 24,
  memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 64 * 1024 ** 3,
  gpus: [], processes: [], localServers: [], unavailable: []
}
const busy = {
  ...quiet,
  cpuPercent: 63,
  memoryUsedBytes: 59.2 * 1024 ** 3,
  gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 5070', utilizationPercent: 88, memoryUsedBytes: 9872 * 1024 ** 2, memoryTotalBytes: 12227 * 1024 ** 2, temperatureC: 71 }],
  localServers: [
    { model: 'local/qwen3.6-35b-a3b', label: 'Qwen3.6 35B-A3B (local)', port: 51436, pid: 41440, running: true, cpuPercent: 41, memoryBytes: 23.49 * 1024 ** 3 },
    { model: 'local/qwen3.5-9b', label: 'Qwen3.5 9B (local)', port: 51435, pid: 28284, running: true, cpuPercent: 3, memoryBytes: 0.86 * 1024 ** 3 }
  ],
  processes: [
    { pid: 22872, name: 'Conductor', kind: 'conductor', label: 'Conductor (9 processes)', cpuPercent: 12, memoryBytes: 1.87 * 1024 ** 3 },
    { pid: 41440, name: 'llama-server', kind: 'local-model', label: 'Qwen3.6 35B-A3B (local)', cpuPercent: 41, memoryBytes: 23.49 * 1024 ** 3 },
    { pid: 9001, name: 'blender', kind: 'other', label: 'blender', cpuPercent: 22, memoryBytes: 3 * 1024 ** 3 }
  ]
}

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  await page.evaluate(() => window.conductor.projects.create('Performance smoke'))

  // The main process answers system:metrics from this file when CONDUCTOR_TEST_SYSTEM_METRICS
  // names one, so the chip can be shown an idle machine and then a loaded one in a single run.
  const inject = async snapshot => {
    await writeFile(fixture, JSON.stringify(snapshot), 'utf8')
    await page.waitForTimeout(5600)
  }

  await inject(quiet)
  assert.equal(await page.locator('.system-performance-chip').count(), 0, 'the chip must stay hidden while the machine is quiet')
  results.checks.push('hidden on an idle machine')

  await inject(busy)
  const chip = page.locator('.system-performance-chip')
  await chip.waitFor({ state: 'visible', timeout: 10_000 })
  const label = (await chip.innerText()).replace(/\s+/g, ' ').trim()
  assert.match(label, /63%/, 'the chip must report host CPU')
  assert.match(label, /88% GPU/, 'the chip must report GPU utilisation')
  results.checks.push(`chip reads: ${label}`)
  await page.screenshot({ path: join(output, 'chip.png') })
  results.screenshots.push(join(output, 'chip.png'))

  await chip.click()
  const panel = page.locator('.system-performance-popover')
  await panel.waitFor({ state: 'visible', timeout: 5000 })
  const panelText = (await panel.innerText()).replace(/\s+/g, ' ')
  for (const expected of ['This machine', '24 cores', 'Qwen3.6 35B-A3B (local)', 'Qwen3.5 9B (local)', 'blender', 'Conductor']) {
    assert.ok(panelText.includes(expected), `the expanded panel must name ${expected}; got: ${panelText}`)
  }
  assert.match(panelText, /23\.5 GB|23 GB/, 'the panel must show what the local model server is holding')
  results.checks.push('expanded panel names the machine, both local servers and the heaviest processes')
  await page.screenshot({ path: join(output, 'panel.png') })
  results.screenshots.push(join(output, 'panel.png'))

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  assert.equal(await panel.count(), 0, 'Escape must close the panel')
  results.checks.push('Escape closes the panel')

  assert.deepEqual(errors, [], `renderer errors: ${errors.join(', ')}`)
} finally {
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
