// VR10 scenario 2: admit the shared verifier's parked launch path without starting a model.
// Run only under a fresh exact Electron slot and smoke-lock:
// node scripts/smoke-lock.mjs --timeout-min 5 -- node scripts/smoke-verify-vr10-launch.mjs
import assert from 'node:assert/strict'
import {
  call, configure, failed, finish, launchParked, openProject, owner,
  record, safeClose, shot, step, watchdog
} from './verify-kit.mjs'

configure({ name: 'vr10-launch-admission', output: 'artifacts/verification/2026-09-27-vr10/launch' })
watchdog(4 * 60)

try {
  step('launch parked, offline unset')
  const inst = await launchParked({ mode: 'playwright', args: ['--disable-gpu'], env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  const mounted = await inst.page.evaluate(() => Boolean(window.conductor))
  assert.equal(mounted, true, 'renderer bridge must mount')
  const parked = await inst.app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const bounds = window.getBounds()
    return {
      focused: window.isFocused(),
      overlapping: screen.getAllDisplays().some(({ bounds: display }) =>
        bounds.x < display.x + display.width && bounds.x + bounds.width > display.x &&
        bounds.y < display.y + display.height && bounds.y + bounds.height > display.y)
    }
  })
  assert.deepEqual(parked, { focused: false, overlapping: false }, 'window must remain parked')

  step('owner control and isolated project')
  const credential = await owner(inst)
  assert.ok(credential.pid && credential.token, 'owner credential must be available')
  const before = await call('local.servers')
  assert.deepEqual(before, [], 'no model server before project open')
  const project = await openProject({ name: 'VR10 launch admission', files: { 'README.md': '# VR10 launch admission\n' } })
  assert.ok(project.id, 'isolated project must open')
  const after = await call('local.servers')
  assert.deepEqual(after, [], 'opening the project must not start a model server')
  const screenshot = await shot('parked-project')
  record('launch-admission', 'PASS', { mounted, parked, projectId: project.id, serversBefore: before.length, serversAfter: after.length }, screenshot)

  step('cleanup')
  const close = await safeClose(inst)
  assert.deepEqual(close.leftovers, [], 'the launched process tree must exit')
  record('cleanup', 'PASS', { graceful: close.graceful, leftovers: close.leftovers.length }, 'parked instance closed')
} catch (error) { await failed(error) }
await finish()
