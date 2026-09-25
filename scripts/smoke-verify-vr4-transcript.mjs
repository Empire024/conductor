// VR4 T1 (docs/verification/2026-09-25-vr4.md), 24e307fa Copy transcript. Owner: "enable me one click to
// just copy the entire chat transcript without scrolling up". A fixture Claude conversation whose first
// prompt carries a marker grows past the 20,000-event journal floor (d9ae618); one click on Copy
// transcript must copy from that first prompt, before and after an app.restart (spawn mode). The page's
// clipboard write is intercepted, so the owner's clipboard is never touched.
//   Control: a short conversation copies from its first prompt (the harness reads the copy right).
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr4-transcript.mjs
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunched, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr4-transcript', output: 'C:/Claude/conductor/artifacts/verification/2026-09-25-vr4' })
watchdog(18 * 60)
await loadCheck()
const FIRST = 'VR4-FIRST-PROMPT-5519', SECOND = 'VR4-SECOND-PROMPT-7730', SHORT = 'VR4-SHORT-FIRST-2231'

try {
  const inst = await launchParked({ mode: 'spawn', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'VR4 transcript' })
  const settle = (id, label) => poll(async () => { const status = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted'].includes(status.phase) ? status : null }, { timeoutMs: 6 * 60_000, intervalMs: 2000, label })
  const maxSequence = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return db.prepare('select max(sequence) as top, count(*) as kept from structured_events where session_id = ?').get(id) } finally { db.close() } }
  /** One click on the tab's Copy transcript; returns what the page tried to put on the clipboard. */
  const copy = async (tab) => {
    const view = await page(inst)
    await view.evaluate(() => { window.__vr4Copied = []; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__vr4Copied.push(text) } }) })
    await view.locator(`.pane-tab[data-control-tab-id="${tab.id}"]`).click()
    const pane = view.locator(`.structured-agent-pane[data-structured-session="${tab.resourceId}"]`)
    await pane.getByRole('button', { name: 'Copy transcript' }).click()
    return poll(() => view.evaluate(() => window.__vr4Copied[0] ?? null), { timeoutMs: 60_000, label: 'the copied transcript' })
  }
  const judge = text => ({ chars: text.length, hasFirst: text.includes(FIRST), firstAt: text.indexOf(FIRST), hasSecond: text.includes(SECOND), hasLast: text.includes('Synthetic long conversation:') })

  step('T1 a conversation past 20,000 events')
  const tab = await openTab({ provider: 'claude', title: 'VR4 long transcript' })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: `SYNTHETIC LONG 12000 ${FIRST} - the first thing I asked.` })
  await settle(tab.resourceId, 'turn 1')
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: `SYNTHETIC LONG 12000 ${SECOND} - the second thing I asked.` })
  await settle(tab.resourceId, 'turn 2')
  const journal = maxSequence(tab.resourceId)

  const short = await openTab({ provider: 'claude', title: 'VR4 short transcript' })
  await call('agents.submit', { agentSessionId: short.resourceId, prompt: `SYNTHETIC LONG 40 ${SHORT}` })
  await settle(short.resourceId, 'short turn')

  try {
    step('T1 copy before the restart')
    const text = await copy(tab)
    await shot('T1-copied')
    const seen = judge(text)
    const control = await copy(short)
    const controlOk = control.includes(SHORT)
    const pass = journal.top > 20_000 && seen.hasFirst && seen.hasSecond && seen.hasLast && controlOk
    record('T1', pass ? 'PASS' : 'FAIL', { lastSequence: journal.top, journalRowsKept: journal.kept, ...seen, control: { shortCopiedFromFirst: controlOk } }, `head: ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
  } catch (error) { await failed(error, 'T1') }

  try {
    step('T1 copy after app.restart')
    const oldPid = inst.credential.pid
    await call('app.restart', {}).catch(() => {})
    await relaunched(inst, oldPid, { timeoutMs: 90_000 })
    await openProject({ name: 'VR4 transcript', path: inst.projectPath }).catch(() => {})
    const text = await copy(tab)
    const seen = judge(text)
    record('T1 restart', seen.hasFirst && seen.hasSecond && seen.hasLast ? 'PASS' : 'FAIL', { lastSequence: maxSequence(tab.resourceId).top, ...seen }, `head: ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
  } catch (error) { await failed(error, 'T1 restart') }
} catch (error) { await failed(error, 'T-setup') }
await finish()
