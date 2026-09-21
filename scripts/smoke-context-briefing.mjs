// Offline smoke: what Conductor appends to each prompt of one native conversation. Real Electron
// main, preload and renderer with the synthetic Claude fixture, which writes every prompt it
// receives to CONDUCTOR_TEST_CONTROL_CAPTURE. No model inference. The window is parked off-screen.
//
// Checks that the first prompt carries the whole briefing (memory protocol, task rules, app
// control, recalled memory), that a follow-up in the same runtime carries none of it and no
// memory it already received, that a memory learned since is sent once, and that a resumed
// conversation - a new process - is briefed again.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-briefing-smoke-'))
const output = resolve('artifacts/context-briefing')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = [], prompts = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const STATIC = ['Conductor keeps durable, project-scoped memory', 'Conductor project tasks: feature-list.md', 'Conductor app control: a first-party']
const MEMORY = 'The synthetic panel fixture keeps its wasOpen flag in panel.mjs'
const snapshot = id => page.evaluate(id => window.conductor.structured.snapshot(id), id)
const turn = async (id, text) => {
  await writeFile(capture, '')
  const before = await snapshot(id)
  await page.evaluate(async ({ id, text }) => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, text, { ...state.settings, model: 'synthetic-claude', effort: 'low' }, [])
  }, { id, text })
  await expect.poll(async () => { const state = await snapshot(id); return state.sequence > before.sequence && state.phase }).toBe('completed')
  const prompt = await readFile(capture, 'utf8')
  prompts.push({ text, bytes: prompt.length, staticBlocks: STATIC.filter(block => prompt.includes(block)).length, memory: prompt.includes(MEMORY) })
  return prompt
}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const project = await page.evaluate(() => window.conductor.projects.create('Briefing smoke'))
  await page.evaluate(input => window.conductor.memory.remember(input), { projectId: project.id, kind: 'semantic', gist: MEMORY, cues: ['panel', 'fixture', 'wasopen'] })
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Briefing smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')

  const first = await turn(id, 'SYNTHETIC B look at the panel fixture and its wasOpen flag')
  for (const block of STATIC) assert.ok(first.includes(block), 'first prompt carries ' + block)
  assert.ok(first.includes(MEMORY), 'first prompt carries the recalled memory')
  check('First prompt of a conversation carries the memory protocol, task rules, app control and recalled memory')

  const second = await turn(id, 'SYNTHETIC B continue with the panel fixture and wasOpen')
  assert.ok(second.startsWith('SYNTHETIC B continue with the panel fixture and wasOpen'), 'the owner text leads the prompt')
  for (const block of STATIC) assert.ok(!second.includes(block), 'follow-up must not repeat ' + block)
  assert.ok(!second.includes(MEMORY), 'follow-up must not repeat a memory the runtime already holds')
  check(`Follow-up in the same runtime carries none of it (${second.length} bytes against ${first.length})`)

  await page.evaluate(input => window.conductor.memory.remember(input), { projectId: project.id, kind: 'semantic', gist: 'The panel fixture test lives in panel.test.mjs', cues: ['panel', 'test', 'mocha'] })
  const third = await turn(id, 'SYNTHETIC B run the panel fixture test')
  assert.ok(third.includes('panel.test.mjs'), 'a memory learned since reaches the runtime')
  assert.ok(!third.includes(MEMORY), 'the memory it already holds is still not repeated')
  for (const block of STATIC) assert.ok(!third.includes(block))
  check('A memory learned since the last turn is sent once, alongside nothing the runtime already has')

  // A resumed conversation is a new process that knows nothing Conductor told the old one.
  await page.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.resume(id, state.settings) }, id)
  const fourth = await turn(id, 'SYNTHETIC B pick the panel fixture back up')
  for (const block of STATIC) assert.ok(fourth.includes(block), 'a resumed process is briefed again: ' + block)
  assert.ok(fourth.includes(MEMORY), 'a resumed process receives its memory again')
  check('A resumed conversation - a new native process - is briefed again')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), checks, prompts }, null, 2))
  console.log(JSON.stringify(prompts))
} finally {
  await app.close().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
