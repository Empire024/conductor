// VR8c (verify loop v3) local-anonymous-mode on the named build, real Dolphin on the running server.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8c-anon.mjs [--keep]
// A1: an anonymous and an ordinary Dolphin tab each write a file and answer with their own marker, and
//     each gets an unsent composer draft with a third marker; every file of the profile, the local
//     model root (changed since start) and the app's stdout is scanned while open, after close and
//     after a clean app.restart. A2: a second anonymous tab is left open and the instance is killed.
// A3: a synthetic Claude coworker (its own, non-owner credential) cannot read an anonymous local tab
//     and sees its title sealed; it reads its ordinary local tab (control); the owner reads anything.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, callRaw, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunchParked, relaunched, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr8c-anon', output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8c' })
watchdog(19 * 60)
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
const LOCAL_ROOT = 'D:\\ConductorLocal'
const since = Date.now() - 1000
const mark = prefix => prefix + randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()
const M = { anon: mark('ANONZ'), kept: mark('KEPTZ'), anonDraft: mark('ADRFZ'), keptDraft: mark('KDRFZ'), crash: mark('CRSHZ'), crashKept: mark('CKPTZ') }
console.log('markers', JSON.stringify(M))

const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'vr8c-' + process.pid, parent_tool_use_id: null, ...m })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.type === 'control_request') return send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: m.request.subtype === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }] } : {} } })
  if (m.type !== 'user') return
  const c = m.message.content, p = Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('') : c
  if (typeof p !== 'string') return
  if (p.includes('Conductor app control:')) writeFileSync(process.env.VR8C_CAPTURE, p)
  emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1', permissionMode: 'default' })
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'SYNTHETIC ok' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

/** Every file under `dir` (optionally changed since `newer`), skipping model weights. */
function walk(dir, newer = 0, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { if (!/^models$/i.test(entry.name)) walk(path, newer, out) }
    else if (entry.isFile()) { try { const s = statSync(path); if ((!newer || s.mtimeMs >= newer) && s.size < 512 * 1024 * 1024) out.push(path) } catch { /* vanished */ } }
  }
  return out
}
function carriers(files, marker) {
  const needles = [Buffer.from(marker, 'utf8'), Buffer.from(marker, 'utf16le')]
  return files.filter(path => { try { const bytes = readFileSync(path); return needles.some(needle => bytes.includes(needle)) } catch { return false } })
}
/** Where each marker is: profile, local model root, the workspace, the instance's stdout. */
function scan(inst, markers) {
  const sets = { profile: walk(inst.profile), localRoot: walk(LOCAL_ROOT, since), workspace: walk(inst.projectPath), stdout: [join(inst.root, 'app.log')].filter(existsSync) }
  const found = {}
  for (const [name, marker] of Object.entries(markers)) {
    found[name] = {}
    for (const [where, files] of Object.entries(sets)) {
      const hits = carriers(files, marker).map(path => path.slice((where === 'profile' ? inst.profile : where === 'workspace' ? inst.projectPath : where === 'localRoot' ? LOCAL_ROOT : inst.root).length + 1))
      if (hits.length) found[name][where] = hits
    }
  }
  return { counts: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length])), found }
}
const leaks = where => Object.fromEntries(Object.entries(where).filter(([key]) => key !== 'workspace'))

const answerOf = state => (state.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('')
async function turn(id, marker) {
  const started = Date.now()
  await call('agents.submit', { agentSessionId: id, prompt: `Use the write_file tool once to create the file note-${marker.slice(0, 5).toLowerCase()}.txt containing exactly: ${marker}\nThen reply with exactly this code and nothing else: ${marker}` })
  const state = await poll(async () => { const s = await call('agents.snapshot', { agentSessionId: id }); return ['completed', 'failed', 'interrupted', 'idle'].includes(s.phase) && Date.now() - started > 3000 && (answerOf(s) || s.phase === 'failed') ? s : null }, { timeoutMs: 4 * 60_000, intervalMs: 2000, label: `turn of ${id}` })
  return { phase: state.phase, seconds: Math.round((Date.now() - started) / 1000), answered: answerOf(state).includes(marker), tools: (state.items ?? []).filter(item => item.data?.type === 'tool').map(item => `${String(item.data.name).split('__').at(-1)}:${item.data.status}`) }
}
const openLocal = (title, anonymous) => openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title, ...(anonymous ? { anonymous: true } : {}) })
async function typeDraft(tabId, text) {
  await call('tabs.focus', { tabId })
  const view = await page()
  const box = view.locator('.pane-workspace textarea[aria-label^="Message"]:visible').first()
  await box.waitFor({ timeout: 15_000 })
  await box.click()
  await box.fill(text)
  await box.press('End')
  await sleep(1500)
  await box.evaluate(element => element.blur()) // blur flushes the draft
  await sleep(1500)
}

try {
  const capture = join(tmpdir(), `vr8c-capture-${process.pid}.txt`)
  const inst = await launchParked({ mode: 'spawn', env: { VR8C_CAPTURE: capture }, fixtures: { 'fake-claude.mjs': fakeClaude } })
  const servers0 = await call('local.servers')
  const llama0 = servers0.map(server => ({ pid: server.pid, model: server.model }))
  record('env', 'INFO', { servers: llama0 }, 'local.servers seen by the parked instance at start')

  await openProject({ name: 'VR8c anonymous', files: { 'README.md': '# VR8c anonymous\n' } })

  // ---------------------------------------------------------------- A1
  step('A1: open anonymous + ordinary Dolphin tabs, one marker turn each')
  const anon = await openLocal('Anonymous VR8c', true), kept = await openLocal('Ordinary VR8c', false)
  const anonTurn = await turn(anon.resourceId, M.anon)
  const keptTurn = await turn(kept.resourceId, M.kept)
  console.log('turns', JSON.stringify({ anonTurn, keptTurn }))
  step('A1: drafts + marks')
  await typeDraft(kept.id, 'draft ' + M.keptDraft)
  await typeDraft(anon.id, 'draft ' + M.anonDraft)
  const view = await page()
  const tabMark = await view.locator('.pane-tab-anonymous').count(), composerMark = await view.locator('.sa-anonymous-mark:visible').count()
  const markShot = await shot('a1-anonymous-marks')
  await sleep(4000) // let debounced layout/draft/journal writes land
  step('A1: scan while open')
  const open1 = scan(inst, M)
  const ownerRead = answerOf(await call('agents.snapshot', { agentSessionId: anon.resourceId })).includes(M.anon)
  step('A1: close the anonymous tab, then clean app.restart')
  const closed = await call('tabs.close', { tabId: anon.id }).then(() => 'tabs.close').catch(async error => { console.log('tabs.close:', error.message); await call('agents.finish', { agentSessionId: anon.resourceId }); return 'agents.finish' })
  await sleep(3000)
  const afterClose = scan(inst, M)
  const readable = await callRaw('agents.snapshot', { agentSessionId: anon.resourceId })
  const pid1 = inst.credential.pid
  await call('app.restart', { force: true })
  await relaunched(inst, pid1, { timeoutMs: 60_000 })
  await sleep(8000)
  const listed = await call('agents.list')
  const restored = { anon: listed.some(entry => entry.agentSessionId === anon.resourceId), kept: listed.some(entry => entry.agentSessionId === kept.resourceId) }
  const afterRestart = scan(inst, M)
  const numbersA1 = { anonTurn, keptTurn, tabMark, composerMark, closedWith: closed, readableAfterClose: readable.status === 200 && !readable.body.error, restored, scanned: afterRestart.counts,
    open: open1.found, afterClose: afterClose.found, afterRestart: afterRestart.found }
  const anonLeak = [open1, afterClose, afterRestart].some(s => Object.keys(leaks(s.found.anon)).length || Object.keys(leaks(s.found.anonDraft)).length)
  const control = Boolean(afterRestart.found.kept.profile?.length) && restored.kept
  const a1Pass = anonTurn.answered && !anonLeak && !restored.anon && !numbersA1.readableAfterClose && tabMark > 0 && composerMark > 0 && ownerRead && control
  record('A1', a1Pass ? 'PASS' : 'FAIL', numbersA1, `control kept marker in ${JSON.stringify(afterRestart.found.kept)}; kept draft ${JSON.stringify(afterRestart.found.keptDraft ?? {})}; anon file ${JSON.stringify(afterRestart.found.anon.workspace ?? [])}; screenshot ${markShot}`)

  // ---------------------------------------------------------------- A3
  step('A3: synthetic Claude coworker with its own credential')
  const claude = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Claude coworker' })
  await writeFile(inst.env.VR8C_CAPTURE, '')
  await call('agents.submit', { agentSessionId: claude.resourceId, prompt: 'hello' })
  const briefing = await poll(async () => { const text = await readFile(inst.env.VR8C_CAPTURE, 'utf8').catch(() => ''); return text.includes('Conductor app control:') && text }, { timeoutMs: 45_000, label: 'coworker briefing' })
  const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  const as = async (method, args = {}) => { const r = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(60_000) }); const body = await r.json(); return { status: r.status, ok: r.status === 200 && !body.error, error: body.error ? JSON.stringify(body.error).slice(0, 300) : null, result: body.result } }
  const coAnon = await as('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, title: 'SECRET-TITLE-VR8C', anonymous: true })
  const coKept = await as('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, title: 'Kept by coworker' })
  const coAnonId = coAnon.result?.resourceId, coKeptId = coKept.result?.resourceId
  await sleep(2000)
  const readAnon = await as('agents.snapshot', { agentSessionId: coAnonId })
  const historyAnon = await as('agents.history', { agentSessionId: coAnonId })
  const readKept = await as('agents.snapshot', { agentSessionId: coKeptId })
  const coTabs = await as('tabs.list')
  const ownerTabs = await call('tabs.list')
  const sealed = (coTabs.result ?? []).find(tab => tab.resourceId === coAnonId)?.title, ownerTitle = ownerTabs.find(tab => tab.resourceId === coAnonId)?.title
  const ownerReadCo = await callRaw('agents.snapshot', { agentSessionId: coAnonId })
  const a3 = { opened: { anon: coAnon.ok, kept: coKept.ok, anonError: coAnon.error }, readAnon: readAnon.ok, readAnonError: readAnon.error, historyAnon: historyAnon.ok, readKept: readKept.ok, sealedTitle: sealed, ownerTitle, ownerRead: ownerReadCo.status === 200 && !ownerReadCo.body.error, ownerReadA1: ownerRead }
  const a3Pass = coAnon.ok && !readAnon.ok && /anonymous/i.test(readAnon.error ?? '') && !historyAnon.ok && readKept.ok && sealed === 'Anonymous local conversation' && ownerTitle === 'SECRET-TITLE-VR8C' && a3.ownerRead && ownerRead
  record('A3', a3Pass ? 'PASS' : 'FAIL', a3, 'control: the same coworker credential reads its ordinary local tab')

  // ---------------------------------------------------------------- A2
  step('A2: anonymous tab left open, instance killed')
  const anon2 = await openLocal('Anonymous crash', true), kept2 = await openLocal('Ordinary crash', false)
  const t2a = await turn(anon2.resourceId, M.crash), t2k = await turn(kept2.resourceId, M.crashKept)
  await sleep(4000)
  const beforeKill = scan(inst, { crash: M.crash, crashKept: M.crashKept })
  const pid2 = inst.credential.pid
  const killed = spawnSync('taskkill', ['/PID', String(pid2), '/T', '/F'], { encoding: 'utf8' })
  await relaunchParked(inst)
  await sleep(8000)
  const listed2 = await call('agents.list')
  const restored2 = { anon: listed2.some(entry => entry.agentSessionId === anon2.resourceId), kept: listed2.some(entry => entry.agentSessionId === kept2.resourceId) }
  const afterCrash = scan(inst, M)
  const crashLeak = [beforeKill].concat([afterCrash]).some(s => Object.keys(leaks(s.found.crash ?? {})).length) || Object.keys(leaks(afterCrash.found.anon)).length || Object.keys(leaks(afterCrash.found.anonDraft)).length
  const a2Pass = t2a.answered && !crashLeak && !restored2.anon && restored2.kept && Boolean(afterCrash.found.crashKept.profile?.length)
  record('A2', a2Pass ? 'PASS' : 'FAIL', { t2a, t2k, killExit: killed.status, restored: restored2, beforeKill: beforeKill.found, afterCrash: afterCrash.found, scanned: afterCrash.counts }, 'control: ordinary crash-tab restored and its marker in the profile')
  await shot('a2-after-crash')
} catch (error) {
  await failed(error)
}
await finish()
