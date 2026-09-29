import { _electron as electron, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Relay roll (feature-list codex-credit-burn 3): a relay tab stays a short-lived session. Eight
// messages go to one relay, always addressed to the id it was opened with; each synthetic Codex
// turn reports a context 25k tokens larger than the last. Past the 60k bound Conductor continues
// the relay in a fresh native session (a successor tab whose first prompt is a short brief), the
// owner's messages to the old id are forwarded there, and no relay call ever reads more than one
// step past the bound (without the roll the eighth message would read 200k). A throwaway test
// profile; CONDUCTOR_TEST_USER_DATA parks the window off every display. Run through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-relay-roll.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-relay-roll-'))
const output = resolve('artifacts/relay-roll')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Relay roll smoke\n')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures'),
  CONDUCTOR_BACKGROUND_WINDOWS: '1'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const BOUND = 60_000, STEP = 25_000, MESSAGES = 8
const checks = [], evidence = { turns: [], tabs: [] }
const check = label => { checks.push(label); console.log('PASS ' + label) }
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const ok = async (auth, method, args, scope) => { const r = await request(auth, method, args, scope); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }

const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const settled = async id => expect.poll(async () => (await snapshot(id))?.phase, { timeout: 30000 }).toMatch(/^(completed|idle)$/)

try {
  await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30000 }).toBe(true)
  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const project = await ok(owner, 'projects.open', { path: projectPath, name: 'Relay roll smoke' })
  const scope = { projectId: project.id }
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'Relay roll smoke' }).first().click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000))

  const opened = await ok(owner, 'tabs.open', { kind: 'agent', provider: 'codex', title: 'P0 bridge to the review room', role: 'relay' }, scope)
  const first = opened.resourceId ?? opened.agentSessionId
  const agentTabs = async () => (await ok(owner, 'tabs.list', {}, scope)).filter(tab => tab.kind === 'agent')
  assert.equal((await snapshot(first)).settings.effort, 'medium')
  check(`A relay tab opened as ${first} on medium effort (role relay)`)

  let current = first
  for (let message = 1; message <= MESSAGES; message++) {
    // The synthetic runtime offers only its own model at low effort, known once it has started:
    // after the first turn the relay is set to it, as an owner's model choice would.
    if (message === 2) await page.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.saveSettings(id, { ...state.settings, model: 'synthetic-model', effort: 'low' }) }, first)
    const before = (await agentTabs()).length
    const steered = await ok(owner, 'agents.steer', { agentSessionId: first, prompt: `synthetic:relay-context\nVerdict ${message} from room A: pass it to room B.` }, scope)
    assert.equal(steered.agentSessionId, current, `message ${message} reached the relay's current session`)
    if (current !== first) assert.equal(steered.forwardedFrom, first)
    await settled(current)
    const status = await ok(owner, 'agents.status', { agentSessionId: current }, scope)
    const used = status.context?.used
    assert.ok(Number.isFinite(used), `message ${message}: the relay reported its context (${JSON.stringify(status.context)})`)
    evidence.turns.push({ message, agentSessionId: current, forwarded: steered.forwardedFrom ?? null, contextUsed: used })
    console.log(`message ${message} -> ${current}${steered.forwardedFrom ? ' (forwarded from ' + first + ')' : ''}: context ${used}`)
    if (used >= BOUND) {
      // Past the bound: a successor tab opens and its brief turn runs in a fresh session.
      await expect.poll(async () => (await agentTabs()).length, { timeout: 20000 }).toBe(before + 1).catch(async error => {
        const state = await snapshot(current)
        console.log('no roll; the relay says:', JSON.stringify({ phase: state?.phase, runtimeId: state?.runtimeId, notices: state?.items.filter(item => ['notice', 'error'].includes(item.data.type)).map(item => item.data.message).slice(-5), usage: state?.items.filter(item => item.data.type === 'usage').map(item => ({ runtimeId: item.runtimeId, limits: item.data.limits })).slice(-2) }))
        throw error
      })
      const tabs = await agentTabs()
      const next = tabs.find(tab => !evidence.tabs.some(seen => seen.agentSessionId === tab.resourceId) && tab.resourceId !== current && tab.resourceId !== first)?.resourceId
      assert.ok(next, 'the successor tab is listed')
      await settled(next)
      const state = await snapshot(next)
      const brief = state.items.find(item => item.data.type === 'text' && item.data.role === 'user')?.data.text ?? ''
      assert.ok(brief.startsWith('[Conductor] Fresh session: this tab continues the relay'), 'the successor starts from the brief')
      assert.ok(brief.length < 2500, `the brief is short (${brief.length} characters)`)
      assert.ok(brief.includes(`Its context reached ${used.toLocaleString('en-US')} tokens`))
      const nextStatus = await ok(owner, 'agents.status', { agentSessionId: next }, scope)
      const old = await snapshot(current)
      assert.ok(old.items.some(item => item.data.type === 'notice' && item.data.message.includes('Conductor rolled it to a fresh native session')), 'the old tab says where it went')
      evidence.tabs.push({ agentSessionId: current, rolledAt: used, successor: next, briefCharacters: brief.length, successorContext: nextStatus.context?.used ?? null })
      check(`Message ${message}: context ${used} passed the ${BOUND} bound; the relay continued in ${next}, whose brief (${brief.length} chars) left it at ${nextStatus.context?.used} tokens`)
      current = next
    } else {
      await page.waitForTimeout(500)
      assert.equal((await agentTabs()).length, before, `message ${message}: no roll under the bound`)
    }
  }
  const peak = Math.max(...evidence.turns.map(turn => turn.contextUsed))
  assert.ok(evidence.tabs.length >= 3, `the relay rolled at least three times (${evidence.tabs.length})`)
  const briefs = evidence.tabs.map(hop => hop.briefCharacters)
  assert.ok(Math.max(...briefs) - Math.min(...briefs) < 200, `the brief does not grow down the chain (${briefs.join(', ')} characters)`)
  assert.ok(peak <= BOUND + STEP, `no relay call read more than one step past the bound (peak ${peak})`)
  assert.ok(evidence.turns.filter(turn => turn.agentSessionId !== first).every(turn => turn.forwarded === first), 'every later message addressed to the first id was forwarded')
  check(`${MESSAGES} messages to ${first}: ${evidence.tabs.length} rolls, peak context ${peak} tokens (without the roll the last call would read ${STEP * MESSAGES})`)
  const listed = await ok(owner, 'agents.list', {}, scope)
  for (const hop of evidence.tabs) assert.equal(listed.find(entry => entry.agentSessionId === hop.agentSessionId)?.superseded?.by, hop.successor, `${hop.agentSessionId} is superseded by ${hop.successor}`)
  check('agents.list marks every rolled session superseded by its successor')
  await page.locator('.pane-tabs').first().screenshot({ path: join(output, '1-rolled-tabs.png') })
  assert.deepEqual(errors, [])
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, evidence, errors }, null, 2))
  await app.close().catch(() => {})
}
