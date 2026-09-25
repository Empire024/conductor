// VR7 D2 + E1 + E2: a real Dolphin (local/dolphin-x1-8b) conversation in a parked Conductor, no research
// toggle, three NEW owner-style questions (not in scripts/local-models/questions.json):
//   D2a current event, D2b "find X online and summarize with sources", D2c a follow-up on D2b.
// Owner: "did we fix dolphin? was uselesss. i want it to be able to answer questions, scour internet etc
// just like any other model". Graded by question-set.mjs's rules (web_search and a cited https source for
// current; web_search + web_read for research) and the answers are saved for the verifier to read.
// E1 (3477066e, owner: "let's add a cost approximation to local models (watts used)"): the turns end with a
// measured energy notice; the timeline card shows Wh and a cost equal to Wh/1000 x the kWh price.
// E2: the price is editable under Usage & limits; the card's cost follows and survives a reload.
// One llama.cpp server machine-wide: a server running before this smoke is used as it is and never
// stopped; one this run's app started is stopped at the end (only pids that were not there before).
//   node scripts/smoke-lock.mjs --timeout-min 30 -- node scripts/smoke-verify-vr7-local.mjs
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gradeAnswer } from './local-models/question-set.mjs'
import { call, configure, failed, finish, findProcesses, launchParked, loadCheck, openProject, openTab, outputDir, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr7-local', output: process.env.VR7_OUT ?? 'artifacts/verification/2026-09-26-vr7' })
watchdog(28 * 60)
await loadCheck()
const MODEL = 'local/dolphin-x1-8b'
const serversBefore = new Set((await findProcesses('llama-server')).filter(entry => /^llama-server/i.test(entry.name)).map(entry => entry.pid))
console.log(`llama-server before: ${[...serversBefore].join(', ') || 'none'}`)

const conversations = [
  { id: 'vr7-current', questions: [{ id: 'D2a', kind: 'current', prompt: 'who won the most recent formula 1 grand prix, and which race was it?' }] },
  { id: 'vr7-research', questions: [
    { id: 'D2b', kind: 'research', prompt: 'can you find some reviews of the steam deck oled online and sum up the pros and cons? include links' },
    { id: 'D2c', kind: 'followup', prompt: 'which of those reviews was the most critical and what was their main complaint?' }
  ] }
]
const toolName = name => /web_?search/i.test(name) ? 'web_search' : /web_?(fetch|read)/i.test(name) ? 'web_read' : name
const transcript = []
let inst
try {
  inst = await launchParked({ mode: 'playwright', name: 'vr7-local', env: { CONDUCTOR_OFFLINE_TESTS: undefined, CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'VR7 local' }, inst)
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
  let firstTab = null
  for (const conversation of conversations) {
    const tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: conversation.id }, { inst, mountTimeoutMs: 60_000 })
    firstTab ??= tab
    let seen = 0
    for (const question of conversation.questions) {
      step(`${question.id}: ${question.prompt}`)
      const started = Date.now()
      await call('agents.submit', { agentSessionId: tab.resourceId, prompt: question.prompt }, { inst })
      const users = () => (projection(tab.resourceId).items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user').length
      const status = await poll(async () => { const current = await call('agents.status', { agentSessionId: tab.resourceId }, { inst }); return ['completed', 'failed', 'interrupted', 'idle'].includes(current.phase) && Date.now() - started > 3000 && users() > seen ? current : null }, { timeoutMs: 8 * 60_000, intervalMs: 2000, label: `${question.id} settled` })
      const items = (projection(tab.resourceId).items ?? []).map(item => item.data).filter(Boolean)
      const userAt = items.map((item, index) => item.type === 'text' && item.role === 'user' ? index : -1).filter(index => index >= 0)
      const part = items.slice(userAt[seen] + 1, userAt[seen + 1] ?? items.length)
      seen++
      const tools = part.filter(item => item.type === 'tool').map(item => ({ name: toolName(item.name), input: typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? {}), failed: item.status === 'failed', output: String(item.output ?? '').slice(0, 2000) }))
      const answer = part.filter(item => item.type === 'text' && item.role === 'assistant').map(item => item.text).join('')
      const energy = part.find(item => item.type === 'notice' && item.payload?.localEnergy)?.payload.localEnergy ?? null
      const grade = gradeAnswer({ ...question, expect: {} }, { answer, tools, phase: status.phase === 'idle' ? 'completed' : status.phase })
      // Cited links must come from what the tools actually returned, not be made up.
      const cited = [...new Set(answer.match(/https?:\/\/[^\s)\]>"']+/g) ?? [])].map(url => url.replace(/[.,;:]+$/, ''))
      const toolText = tools.map(tool => `${tool.input} ${tool.output}`).join(' ')
      const grounded = cited.filter(url => toolText.includes(url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 40)))
      const seconds = Math.round((Date.now() - started) / 1000)
      transcript.push({ id: question.id, prompt: question.prompt, phase: status.phase, seconds, answer, tools, cited, grounded, energy, grade })
      writeFileSync(join(outputDir(), 'vr7-local-answers.json'), JSON.stringify(transcript, null, 2))
      record(question.id, grade.pass ? 'PASS' : 'FAIL', { seconds, tools: grade.tools, cited: cited.length, citedFromTools: grounded.length, energyWh: energy?.totalWh ?? null }, `${grade.failures.join('; ') || 'graded pass (verifier reads the answer)'}; answer: ${answer.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
  }

  step('E1: the first turn\'s energy in the timeline')
  const view = await page(inst)
  await call('tabs.focus', { tabId: firstTab.id }, { inst }).catch(error => console.log(`tabs.focus: ${error.message.slice(0, 200)}`))
  const card = view.locator('.sa-local-energy[data-energy="measured"]').first()
  await card.waitFor({ state: 'attached', timeout: 30_000 })
  await card.scrollIntoViewIfNeeded().catch(() => {})
  const reading = transcript[0].energy
  const moneyOf = text => { const match = /≈\s*\$([\d.]+)\s*this turn/.exec(text); return match ? Number(match[1]) : null }
  const before = (await card.textContent()) ?? ''
  const expected = reading ? reading.totalWh / 1000 * 0.2 : null
  const shown = moneyOf(before)
  const close = (a, b) => a !== null && b !== null && Math.abs(a - b) <= Math.max(b * 0.06, 1e-7)
  const e1 = Boolean(reading?.measured && reading.gpuWh > 0 && reading.totalWh > reading.gpuWh && reading.samples > 0 && close(shown, expected))
  const e1Shot = await shot('e1-energy-card', inst)
  record('E1-energy-real-turn', e1 ? 'PASS' : 'FAIL', { measured: reading?.measured ?? null, totalWh: reading?.totalWh ?? null, gpuWh: reading?.gpuWh ?? null, avgGpuW: reading?.averageGpuWatts ?? null, samples: reading?.samples ?? null, shownCost: shown, expectedCost: expected }, `card: "${before.trim().slice(0, 240)}"; ${e1Shot}`)

  step('E2: change the kWh price under Usage & limits')
  // The conversation's View usage opens the Usage dialog; its Energy section holds the price editor.
  await view.locator('button.sa-usage-link:visible').first().click({ timeout: 15_000 })
  const usage = view.locator('.sa-local-energy-totals').first()
  await usage.waitFor({ timeout: 15_000 })
  const input = usage.getByLabel('Price per kWh')
  await input.waitFor({ timeout: 15_000 })
  await input.fill('0.4')
  await usage.getByRole('button', { name: 'Save' }).click()
  await sleep(1000)
  const after = (await card.textContent()) ?? ''
  const totalsText = (await usage.textContent().catch(() => '')) ?? ''
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor))
  await call('tabs.focus', { tabId: firstTab.id }, { inst }).catch(() => {})
  const reloaded = view.locator('.sa-local-energy[data-energy="measured"]').first()
  await reloaded.waitFor({ state: 'attached', timeout: 30_000 })
  const afterReload = (await reloaded.textContent()) ?? ''
  const stored = await view.evaluate(() => localStorage.getItem('conductor.localEnergyPrice'))
  const e2 = close(moneyOf(after), shown * 2) && close(moneyOf(afterReload), shown * 2) && !/default price/.test((await reloaded.getAttribute('title')) ?? '')
  const e2Shot = await shot('e2-price-edited', inst)
  record('E2-price-editable', e2 ? 'PASS' : 'FAIL', { before: shown, after: moneyOf(after), afterReload: moneyOf(afterReload), stored }, `totals: "${totalsText.replace(/\s+/g, ' ').slice(0, 240)}"; ${e2Shot}`)
} catch (error) { await failed(error, 'local') }
// Stop only the llama-server this run's app started.
const started = (await findProcesses('llama-server').catch(() => [])).filter(entry => /^llama-server/i.test(entry.name) && !serversBefore.has(entry.pid))
for (const entry of started) spawnSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
console.log(`llama-server started by this run and stopped: ${started.map(entry => entry.pid).join(', ') || 'none'}`)
await finish()
