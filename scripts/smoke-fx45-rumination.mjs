// FX45: two bounded attempts at VR9f's real Dolphin research question and one current-question
// regression. The deterministic forced-rumination case lives in fx45-rumination.test.ts; this
// parked run explicitly records whether stochastic rumination occurred. No model downloads.
// Run only under smoke-lock after the current build/slot is granted and other llama servers stop:
// node scripts/smoke-lock.mjs --timeout-min 22 -- node scripts/smoke-fx45-rumination.mjs
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, outputDir, poll, record, step, watchdog } from './verify-kit.mjs'

configure({ name: 'fx45-rumination', output: 'C:/Claude/conductor/artifacts/verification/2026-09-27-fx45' })
watchdog(21 * 60)
const MODEL = 'local/dolphin-x1-8b'
const SETTLED = new Set(['completed', 'failed', 'interrupted', 'idle'])
const llama = async () => (await listProcesses()).list.filter(p => /^llama-server(\.exe)?$/i.test(p.name)).map(p => p.pid)
const servers = () => call('local.servers')

try {
  step('server admission')
  const before = { os: await llama() }
  if (before.os.length) throw new Error(`A llama server is already running: ${JSON.stringify(before)}`)
  await loadCheck()
  const inst = await launchParked({ mode: 'playwright', args: ['--disable-gpu'], env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  const registered = await servers()
  if (registered.length) throw new Error(`A model server appeared before this run: ${JSON.stringify(registered)}`)
  record('admission', 'INFO', { ...before, registered }, 'one configured Dolphin server will be started through the parked app')
  await openProject({ name: 'FX45 parked', files: { 'README.md': '# FX45 verification\n' } })
  const projection = id => {
    const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true })
    try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) }
    finally { db.close() }
  }
  const runs = [
    ['research-1', 'look up online what caused the big blackout in spain and portugal last year and give me a summary with sources'],
    ['research-2', 'look up online what caused the big blackout in spain and portugal last year and give me a summary with sources'],
    ['current', "who's running the federal reserve these days? cite a page you opened"]
  ]
  let actualRumination = 0
  for (const [label, prompt] of runs) {
    step(label)
    const tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: `FX45 ${label}` })
    const started = Date.now()
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt })
    const status = await poll(async () => {
      const p = projection(tab.resourceId)
      const s = await call('agents.status', { agentSessionId: tab.resourceId })
      return SETTLED.has(s.phase) && (p.items ?? []).some(item => item.data?.type === 'text' && item.data.role === 'user') ? s : null
    }, { timeoutMs: label === 'research-1' ? 10 * 60_000 : 5 * 60_000, intervalMs: 2000, label })
    const saved = projection(tab.resourceId)
    const items = (saved.items ?? []).map(item => item.data).filter(Boolean)
    const answers = items.filter(item => item.type === 'text' && item.role === 'assistant' && item.text).map(item => item.text)
    const notices = items.filter(item => item.type === 'notice').map(item => item.message)
    const ruminated = notices.some(message => /model was reasoning in circles|two replies reasoning in circles/i.test(message))
    if (ruminated) actualRumination++
    const maxAnswer = Math.max(0, ...answers.map(answer => answer.length))
    const sawWeb = items.some(item => item.type === 'tool' && /^web_(?:search|read)$/.test(String(item.name).split('__').at(-1)))
    const hasSource = answers.some(answer => /https?:\/\//.test(answer))
    const containsDraft = answers.some(answer => answer.length >= 2500 || /wait,? let me (?:rethink|reconsider)|on second thought/i.test(answer))
    const result = { label, phase: status.phase, seconds: Math.round((Date.now() - started) / 1000), ruminated, maxAnswer, answers: answers.length, sawWeb, hasSource, containsDraft }
    writeFileSync(join(outputDir(), `${label}.projection.json`), JSON.stringify(saved, null, 2))
    writeFileSync(join(outputDir(), `${label}.answer.json`), JSON.stringify({ prompt, result, answers, notices }, null, 2))
    record(label, status.phase === 'completed' && sawWeb && hasSource && !containsDraft ? 'PASS' : 'FAIL', result, `${label}.projection.json; real rumination ${ruminated ? 'observed' : 'not observed'}`)
    await call('tabs.close', { tabId: tab.id }).catch(() => undefined)
  }
  record('actual-rumination', actualRumination ? 'PASS' : 'NOT RUN (no stochastic rumination in two research attempts)', { observed: actualRumination, researchAttempts: 2 }, 'forced end-to-end test is deterministic; live occurrence is stochastic')
  record('server-after', 'INFO', { registered: await servers(), os: await llama() }, 'parked app closes at finish')
} catch (error) { await failed(error) }
await finish()
