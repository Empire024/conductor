// VR2 group machine (feature-list.md always-on-machines, Windows half and Conductor's failsafe).
//   A1  "we need that machine to be on when we need it to be on no matter what": machines.list's
//       readiness for this real PC against ground truth read here independently (PowerShell
//       Get-Service, the Winlogon AutoAdminLogon value only, powercfg AC indices, tailscale prefs);
//       the failsafe check is amber with phone access on and no code, green once a code is set.
//       control: the ground-truth reads themselves.
//   A3  "a password ... as a security failsafe in Conductor": the wrong-code counter and a lockout
//       survive unattended starts (--conductor-login-start after a quit): 2 wrong codes, restart,
//       the count goes on and the backoff holds; 5 in all lock out, the lockout survives another
//       unattended start, and only the desktop reset lets the right code in.
//       control: the right code unlocks at once before any failure.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr2-machine.mjs [--only=A1|A3]
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, loadCheck, openProject, owner, page, poll, record, shot, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'
import { pairPhone, phoneClient } from './verify-phone-kit.mjs'

configure({ name: 'vr2-machine', output: process.env.VR2_OUT ?? 'artifacts/verification/2026-09-25-vr2' })
watchdog(12 * 60)
const only = (process.argv.find(arg => arg.startsWith('--only=')) ?? '').slice(7)
const want = id => !only || only === id
const CODE = '935170', WRONG = ['111111', '222222', '333333', '444444', '555555']

const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const ps = command => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).stdout.trim()
const acIndex = setting => { const match = /AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(spawnSync('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', setting], { encoding: 'utf8', windowsHide: true }).stdout); return match ? parseInt(match[1], 16) : null }
/** Quits the app the way the owner's window close does. */
async function quitApp(inst) {
  const pid = inst.credential.pid
  await withDeadline((await page(inst)).evaluate(() => { window.close(); return true }), 5000)
  if (await poll(() => !isAlive(pid), { timeoutMs: 30_000, intervalMs: 250, label: 'quit' }).then(() => true, () => false)) return
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`], { windowsHide: true })
  await poll(() => !isAlive(pid), { timeoutMs: 30_000, intervalMs: 250, label: 'quit after CloseMainWindow' })
}
/** An unattended start of the same profile: what the login item runs after a power cut. */
async function loginStart(inst) {
  const oldPid = inst.credential.pid
  await quitApp(inst)
  if (inst.browser) { await withDeadline(inst.browser.close(), 5000); inst.browser = null; inst.page = null }
  const log = openSync(join(inst.root, 'app.log'), 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${inst.cdpPort}`, BUILD, '--conductor-login-start'], { env: inst.env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  inst.pids.add(child.pid)
  await owner(inst, { notPid: oldPid, timeoutMs: 60_000 })
  const view = await page(inst)
  const state = await poll(async () => { const value = await view.evaluate(() => window.conductor.phone.state()); return value.listening ? value : null }, { timeoutMs: 30_000, label: 'the phone listener after the login start' })
  return { view, client: phoneClient(`https://127.0.0.1:${new URL(state.primaryEndpoint).port}`) }
}

try {
  await loadCheck()
  const inst = await launchParked({ mode: 'spawn', name: 'vr2-machine', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  let view = await page(inst)
  await openProject({ name: 'VR2 machine' }) // machines.list is scoped to a project
  const readiness = async () => { const machines = await call('machines.list', {}); return (Array.isArray(machines) ? machines : machines.machines ?? []).find(machine => machine.kind === 'local')?.readiness }
  const checkOf = (value, id) => value?.checks?.find(check => check.id === id)

  if (want('A1')) {
    step('A1 ground truth, read independently')
    const truth = {
      sleepAc: acIndex('STANDBYIDLE'), hibernateAc: acIndex('HIBERNATEIDLE'),
      tailscale: ps("$s = Get-Service Tailscale -ErrorAction SilentlyContinue; if ($s) { \"$($s.Status)|$($s.StartType)\" } else { 'absent' }"),
      autoLogon: ps("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoAdminLogon -ErrorAction SilentlyContinue).AutoAdminLogon"),
      tailscaleUnattended: /"?ForceDaemon"?\s*:\s*true/.test(spawnSync('C:\\Program Files\\Tailscale\\tailscale.exe', ['debug', 'prefs'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).stdout ?? '')
    }
    const expected = {
      sleep: truth.sleepAc === null ? null : truth.sleepAc === 0 && (truth.hibernateAc === null || truth.hibernateAc === 0),
      'boot-unlock': truth.autoLogon === '1',
      tailscale: truth.tailscale === 'absent' ? false : /^Running\|Automatic/.test(truth.tailscale) && (truth.tailscaleUnattended || truth.autoLogon === '1'),
      conductor: false
    }
    const first = await readiness()
    const got = Object.fromEntries(Object.keys(expected).map(id => [id, checkOf(first, id)?.ok ?? 'missing']))
    const mismatches = Object.keys(expected).filter(id => got[id] !== expected[id])
    step('A1 the failsafe: phone on without a code, then with one')
    const offFailsafe = checkOf(first, 'failsafe')?.ok
    await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
    const noCode = checkOf(await readiness(), 'failsafe')
    await view.evaluate(code => window.conductor.phone.setLockCode(code), CODE)
    const withCode = checkOf(await readiness(), 'failsafe')
    await view.evaluate(() => window.conductor.phone.setSettings({ enabled: false }))
    record('A1', mismatches.length === 0 && offFailsafe === true && noCode?.ok === false && withCode?.ok === true && first?.ready === false && first?.missing?.length > 0 ? 'PASS' : 'FAIL',
      { truth, expected, got, mismatches, failsafe: { phoneOff: offFailsafe, onNoCode: noCode?.ok, onWithCode: withCode?.ok }, ready: first?.ready },
      `missing steps as Conductor words them: ${JSON.stringify(first?.missing ?? []).slice(0, 700)}; failsafe without a code: ${JSON.stringify(noCode?.detail ?? null)}`)
  }

  if (want('A3')) {
    step('A3 phone paired, code set; control: the right code unlocks at once')
    const enabled = await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
    let client = phoneClient(`https://127.0.0.1:${new URL(enabled.primaryEndpoint).port}`)
    const token = await pairPhone(view, client, 'VR2 owner phone')
    await view.evaluate(code => window.conductor.phone.setLockCode(code), CODE)
    const unlock = code => client.req('/api/lock/unlock', { method: 'POST', token, body: { code } })
    const lockState = async () => (await client.req('/api/lock/state', { token })).json
    const right = await unlock(CODE)
    await client.req('/api/lock/lock', { method: 'POST', token, unlock: right.json?.unlockToken })
    const control = { status: right.status, failuresAfter: (await lockState())?.failures }

    step('A3 two wrong codes, then an unattended start')
    const wrong1 = (await unlock(WRONG[0])).status, wrong2 = (await unlock(WRONG[1])).status
    ;({ view, client } = await loginStart(inst))
    const afterStart = await lockState()
    await sleep(Math.max(0, Date.parse(afterStart?.retryAt ?? 0) - Date.now()) + 500)
    const wrong3 = (await unlock(WRONG[2])).status
    const tooSoon = await unlock(WRONG[3])
    const afterThird = await lockState()
    step('A3 wait out the 30 s and 2 min backoffs to the fifth wrong code')
    await sleep(Math.max(0, Date.parse(afterThird?.retryAt ?? 0) - Date.now()) + 500)
    const wrong4 = (await unlock(WRONG[3])).status
    const afterFourth = await lockState()
    await sleep(Math.max(0, Date.parse(afterFourth?.retryAt ?? 0) - Date.now()) + 500)
    const wrong5 = await unlock(WRONG[4])
    const rightWhileLockedOut = (await unlock(CODE)).status

    step('A3 the lockout survives another unattended start; the desktop reset clears it')
    ;({ view, client } = await loginStart(inst))
    const afterSecondStart = await lockState()
    const rightAfterStart = (await unlock(CODE)).status
    await view.evaluate(() => window.conductor.phone.resetLock())
    const rightAfterReset = await unlock(CODE)
    const data = (await client.req('/api/state', { token, unlock: rightAfterReset.json?.unlockToken })).status
    record('A3', control.status === 200 && control.failuresAfter === 0 && wrong1 !== 200 && wrong2 !== 200 && afterStart?.failures === 2 && afterStart?.unlocked === false && wrong3 !== 200 && tooSoon.status === 429 && wrong4 !== 200 && wrong5.status === 423 && wrong5.json?.lockedOut === true && rightWhileLockedOut === 423 && afterSecondStart?.lockedOut === true && rightAfterStart === 423 && rightAfterReset.status === 200 && data === 200 ? 'PASS' : 'FAIL',
      { control, wrong: [wrong1, wrong2, wrong3, wrong4, wrong5.status], afterFirstStart: { failures: afterStart?.failures, remaining: afterStart?.remaining, unlocked: afterStart?.unlocked }, tooSoon: tooSoon.status, rightWhileLockedOut, afterSecondStart: { lockedOut: afterSecondStart?.lockedOut, failures: afterSecondStart?.failures }, rightAfterStart, rightAfterReset: rightAfterReset.status, dataAfterReset: data },
      `pass: no fresh attempts after an unattended start, a lockout holds through one and only the desktop reset clears it; ${await shot('A3-end')}`)
  }
} catch (error) {
  await failed(error, 'vr2-machine')
}
await finish()
