// VR5 group restart (feature-list.md resume-after-any-restart, FX25 b8fad15). Owner: "conductor
// restarted i left you running and no prompt ever reached you about that restart.. why did we even
// quit work? not restart automatically then continue work? you're the wizard".
// A parked wizard (wand on, fable fixture) sits idle waiting on the coworker it dispatched, whose turn
// hangs; the runtime host is on and the quit dialog takes the owner's default button ("Keep running in
// background"), as in the installed app. Restarts the wizard did NOT start:
//   R1  an update installed through the local update stub: a synthetic local feed build, checked,
//       downloaded and installed from the renderer's Restart to update (updates.install IPC)
//   R2a the owner's plain quit (main window close -> before-quit dialog) and a relaunch
//   R2b a crash: taskkill of this smoke's own app, then a relaunch
//   R2c with a downloaded update ready and the coworker running, the owner's quit holds on the
//       "Work is still running" dialog (nothing installs unasked); answered Stop work, and after the
//       relaunch nobody is resumed
// Pass: after each resuming restart the wizard gets exactly one "[Conductor] Conductor restarted
// (<reason>, <old> -> <new>); continue." and the coworker exactly one restart line, and both settle.
// Control: scripts/smoke-fx25-any-restart.mjs (crash, forced restart, Stop work; runtime host off).
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr5-restart.mjs [--only=R1,R2] [--keep]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, current, failed, findProcesses, finish, safeClose, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunchParked, relaunched, shot, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'

configure({ name: 'vr5-restart', output: 'artifacts/verification/2026-09-25-vr5' })
watchdog(18 * 60)
const only = new Set((process.argv.find(arg => arg.startsWith('--only='))?.slice(7) ?? 'R1,R2').split(','))

// FX25's fixture Claude: logs every prompt; a HANG prompt keeps its turn running until a restart line arrives.
const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'vr5-restart', parent_tool_use_id: null, ...message })
const model = 'claude-fable-5-1'
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: model, displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (typeof prompt === 'string') {
    writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
    appendFileSync(process.env.VR5_PROMPT_LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, prompt }) + '\\n')
  }
  emit({ type: 'system', subtype: 'init', model })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  if (typeof prompt === 'string' && prompt.includes('HANG') && !prompt.includes('restarted')) return
  const text = typeof prompt === 'string' && prompt.includes('restarted') ? 'continue-ack' : 'Short done.'
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

/** A synthetic local build the test-mode install seam "installs" (it only records it and relaunches). */
function seedFeed(profile, version) {
  const feed = join(profile, 'local-updates')
  mkdirSync(feed, { recursive: true })
  const installer = `Conductor-Setup-${version}.exe`, blockmap = `${installer}.blockmap`
  const bytes = Buffer.from(`VR5 synthetic installer ${version}\n`.repeat(64)), map = Buffer.from(`VR5 synthetic blockmap ${version}\n`)
  writeFileSync(join(feed, installer), bytes); writeFileSync(join(feed, blockmap), map)
  const sha = data => createHash('sha512').update(data).digest('base64')
  writeFileSync(join(feed, 'conductor-local-build.json'), JSON.stringify({ schemaVersion: 1, version, createdAt: new Date().toISOString(), commit: null, installer, blockmap, sha512: sha(bytes), size: bytes.length, blockmapSha512: sha(map), blockmapSize: map.length }, null, 2))
}

let inst, wizard, worker, promptLog
const prompts = () => (existsSync(promptLog) ? readFileSync(promptLog, 'utf8') : '').split('\n').filter(Boolean).map(line => JSON.parse(line))
const phase = async id => (await call('agents.status', { agentSessionId: id })).phase
const intentRow = () => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get('restartIntent')?.value || 'null') } finally { db.close() } }

async function hang() {
  // A restart that did not happen (a NOT RUN step) leaves the turn running: reuse it.
  if (await phase(worker) !== 'running') await call('agents.submit', { agentSessionId: worker, prompt: 'SYNTHETIC HANG until the restart' })
  await poll(async () => await phase(worker) === 'running', { timeoutMs: 30_000, label: 'coworker running' })
  await poll(async () => await phase(wizard) === 'completed', { timeoutMs: 30_000, label: 'wizard idle' })
  // The live record lists the working set every 5 s: wait for it, so a crash finds it.
  await poll(() => { const row = intentRow(); return row?.kind === 'running' && row.coworkers.includes(worker) && row.wizards.includes(wizard) }, { timeoutMs: 20_000, label: 'the live restart record naming the wizard and coworker' })
}

/** After a restart: what the wizard and coworker were sent since `before`, judged against `reason`. */
async function judgeResume(id, before, reason, evidence) {
  const sent = () => prompts().slice(before)
  const toWizard = () => sent().filter(p => p.prompt.includes('This wizard tab was brought back'))
  const toWorker = () => sent().filter(p => /Conductor restarted \(/.test(p.prompt) && !p.prompt.includes('This wizard tab was brought back'))
  const arrived = await poll(() => toWizard().length && toWorker().length, { timeoutMs: 45_000, label: 'the continue messages' }).then(() => true, () => false)
  await sleep(4000)
  const settled = await poll(async () => await phase(wizard) === 'completed' && await phase(worker) === 'completed', { timeoutMs: 30_000, label: 'both settled' }).then(() => true, () => false)
  const wizardText = toWizard()[0]?.prompt.slice(0, 300) ?? null, workerText = toWorker()[0]?.prompt.slice(0, 200) ?? null
  const numbers = { wizardMessages: toWizard().length, workerMessages: toWorker().length, settled, wizardPhase: await phase(wizard), workerPhase: await phase(worker), wizardText, workerText }
  const ok = arrived && settled && toWizard().length === 1 && toWorker().length === 1 && reason.test(wizardText ?? '') && /; continue\./.test(wizardText ?? '')
  record(id, ok ? 'PASS' : 'FAIL', numbers, `${evidence}; ${await shot(`${id}-after`).catch(() => 'no screenshot')}`)
}

try {
  await loadCheck()
  const logs = mkdtempSync(join(tmpdir(), 'vr5-restart-prompts-'))
  promptLog = join(logs, 'prompts.jsonl')
  inst = await launchParked({ mode: 'spawn', name: 'vr5-restart', fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_TEST_STOP_DECISION: 'background', CONDUCTOR_UPDATE_DEV: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: join(logs, 'capture.txt'), VR5_PROMPT_LOG: promptLog } })
  await openProject({ name: 'VR5 restart', git: true })
  const view = await page(inst)

  step('wizard: wand on, one settled turn')
  wizard = (await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'VR5 Wizard' })).resourceId
  await view.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'SYNTHETIC WIZARD START', settings)
  }, wizard)
  await poll(() => prompts().some(p => p.prompt.includes('SYNTHETIC WIZARD START') && p.prompt.includes('Conductor app control:')), { timeoutMs: 30_000, label: 'the wizard briefing' })
  const briefing = prompts().find(p => p.prompt.includes('SYNTHETIC WIZARD START')).prompt
  const wizardAuth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  await poll(async () => await phase(wizard) === 'completed', { timeoutMs: 30_000, label: 'wizard settled' })
  const opened = await (await fetch(wizardAuth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + wizardAuth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tabs.open', args: { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'VR5 Coworker', focus: false } }) })).json()
  worker = opened.result?.resourceId ?? opened.result?.agentSessionId
  if (!worker) throw new Error(`the wizard could not dispatch its coworker: ${JSON.stringify(opened).slice(0, 400)}`)
  await poll(() => call('agents.status', { agentSessionId: worker }), { timeoutMs: 30_000, label: 'coworker mounted' })

  if (only.has('R1')) {
    step('R1 update installed through the local update stub')
    await hang()
    const version = `99.0.0-local.${Date.now()}`
    seedFeed(inst.profile, version)
    const r1view = await page(inst)
    const checked = await r1view.evaluate(() => window.conductor.updates.check())
    const downloaded = await withDeadline(r1view.evaluate(() => window.conductor.updates.download()), 60_000)
    const ready = await poll(async () => { const s = await (await page(inst)).evaluate(() => window.conductor.updates.getState()); return s.phase === 'ready' ? s : null }, { timeoutMs: 60_000, label: 'update ready' }).catch(error => ({ error: String(error.message).slice(0, 300) }))
    if (ready.error) {
      record('R1', 'NOT RUN (harness)', { checked: { phase: checked?.phase, availableVersion: checked?.availableVersion, message: checked?.message }, downloaded: downloaded.ok ? downloaded.value?.phase : String(downloaded.error ?? 'timed out') }, `the synthetic local build never reached ready: ${ready.error}`)
    } else {
      const before = prompts().length, pidBefore = inst.credential.pid
      void (await page(inst)).evaluate(() => window.conductor.updates.install()).catch(() => {})
      await relaunched(inst, pidBefore, { timeoutMs: 60_000 })
      const stub = existsSync(join(inst.profile, 'installer-stub.json')) ? JSON.parse(readFileSync(join(inst.profile, 'installer-stub.json'), 'utf8')) : null
      await judgeResume('R1', before, new RegExp(`Conductor restarted \\(update installed[^)]*-> ${version.replace(/\./g, '\\.')}\\)`), `installer stub ${stub?.version ?? 'none'}; log ${inst.root}\\app.log`)
    }
  }

  if (only.has('R2')) {
    step('R2a the owner quits (main window close) and reopens')
    await hang()
    let before = prompts().length
    void (await page(inst)).evaluate(() => window.conductor.window.close()).catch(() => {})
    await relaunchParked(inst)
    await judgeResume('R2a', before, /Conductor restarted \(the owner quit and reopened Conductor, /, 'main-window close, dialog answered with the default Keep running')

    step('R2b crash')
    await hang()
    before = prompts().length
    spawnSync('taskkill', ['/PID', String(inst.credential.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    await relaunchParked(inst, { env: { CONDUCTOR_TEST_DIALOGS: 'hold' } })
    await judgeResume('R2b', before, /Conductor restarted \(crash,/, 'taskkill /T /F of this smoke\'s own app pid')

    step('R2c a ready update and running work: the quit asks; Stop work resumes nobody')
    await hang()
    seedFeed(inst.profile, `99.0.1-local.${Date.now()}`)
    const r2view = await page(inst)
    await r2view.evaluate(() => window.conductor.updates.check())
    await withDeadline(r2view.evaluate(() => window.conductor.updates.download()), 60_000)
    const updatePhase = await poll(async () => { const s = await (await page(inst)).evaluate(() => window.conductor.updates.getState()); return s.phase === 'ready' ? s.phase : null }, { timeoutMs: 60_000, label: 'second update ready' }).catch(() => 'not ready')
    const stubBefore = existsSync(join(inst.profile, 'installer-stub-history.jsonl')) ? readFileSync(join(inst.profile, 'installer-stub-history.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
    void r2view.evaluate(() => window.conductor.window.close()).catch(() => {})
    const pending = await poll(async () => (await call('app.state', {}, { projectId: null })).pendingQuitConfirmation ?? null, { timeoutMs: 20_000, label: 'pendingQuitConfirmation' }).catch(() => null)
    const heldShot = await shot('R2c-quit-asks').catch(() => 'no screenshot')
    const stubDuring = existsSync(join(inst.profile, 'installer-stub-history.jsonl')) ? readFileSync(join(inst.profile, 'installer-stub-history.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
    before = prompts().length
    if (pending) await call('app.quit.confirm', { stopWork: true }, { projectId: null })
    await relaunchParked(inst, { env: { CONDUCTOR_TEST_DIALOGS: undefined } })
    await sleep(15_000)
    const after = prompts().slice(before).filter(p => p.prompt.includes('restarted'))
    const numbers = { updatePhase, pendingQuitConfirmation: pending ? JSON.stringify(pending).slice(0, 200) : null, installsBefore: stubBefore, installsWhileAsking: stubDuring, restartMessagesAfterStopWork: after.length, wizardPhase: await phase(wizard), workerPhase: await phase(worker) }
    record('R2c', pending && stubDuring === stubBefore && after.length === 0 ? 'PASS' : 'FAIL', numbers, heldShot)
  }
} catch (error) {
  await failed(error)
} finally {
  // The runtime host and fixture processes of this run carry its temp root on their command lines.
  const inst0 = current()
  if (inst0) {
    await withDeadline((async () => {
      await safeClose(inst0)
      for (const leftover of await findProcesses(inst0.root)) spawnSync('taskkill', ['/PID', String(leftover.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    })(), 60_000)
  }
  await finish()
}
