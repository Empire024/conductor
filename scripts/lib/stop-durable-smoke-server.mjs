import assert from 'node:assert/strict'
import { identityOf, sameIdentity } from '../verify-kit.mjs'

/**
 * Stop only the model server spawned by this smoke's parked Electron main process. `app` is the
 * main's OS identity as verify-kit registered it at launch ({pid, creationTime, executable});
 * `snapshot()` returns a fresh process list with identities (verify-kit listProcesses().list) and
 * throws when it cannot. Ownership is re-proved in a fresh snapshot at selection and again right
 * before the stop: the main is still the registered process, the server is its direct child, was
 * created after it, and keeps one identity throughout. After local.stop confirms, the server's
 * exit is proved from the OS (its identity gone), not only from the app's registry. A failed
 * snapshot is never read as "gone".
 */
export async function stopDurableSmokeServer({ call, model, app, snapshot, exitTimeoutMs = 30_000, pollMs = 500, sleep = ms => new Promise(done => setTimeout(done, ms)), now = () => Date.now() }) {
  assert.ok(identityOf(app), 'parked app has no registered OS identity')
  const servers = await call('local.servers')
  assert.ok(Array.isArray(servers), 'local.servers did not return a server list')
  const matches = servers.filter(server => server.model === model)
  assert.equal(matches.length, 1, `expected one ${model} server; found ${matches.length}`)
  const server = matches[0]
  assert.equal(server.startedByConductor, true, `refusing unowned ${model} server`)
  assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0, `refusing ${model} server without a positive PID`)

  const verify = async label => {
    const list = await snapshot()
    const main = list.find(entry => entry.pid === app.pid)
    assert.ok(main && sameIdentity(identityOf(main), app), `${label}: parked main pid ${app.pid} is no longer the registered process`)
    const entry = list.find(entry => entry.pid === server.pid)
    assert.ok(entry, `${label}: ${model} pid ${server.pid} is not running`)
    const identity = identityOf(entry)
    assert.ok(identity, `${label}: ${model} pid ${server.pid} has no readable OS identity`)
    assert.equal(entry.ppid, app.pid, `refusing ${model} pid ${server.pid}: not started by the parked app`)
    assert.ok(BigInt(identity.creationTime) >= BigInt(app.creationTime), `refusing ${model} pid ${server.pid}: created before the parked app, so its parent pid was reused`)
    return identity
  }
  const identity = await verify('selection')
  const recheck = await verify('before stop')
  assert.ok(sameIdentity(identity, recheck), `refusing ${model} pid ${server.pid}: its identity changed between selection and stop`)

  const stopped = await call('local.stop', { pid: server.pid, force: true })
  assert.equal(stopped?.stopped, true, `local.stop did not confirm stop for pid ${server.pid}`)
  assert.equal(stopped.pid, server.pid, 'local.stop confirmed a different PID')
  assert.equal(stopped.model, model, 'local.stop confirmed a different model')
  assert.match(stopped.message ?? '', /^stopped \(pid \d+\)$/, 'local.stop did not confirm process termination')

  // Exit is proven only by the pid being absent, or held by a valid, different identity. The same
  // pid with an unreadable identity is unknown - as is a failed inventory - and never counts as gone.
  const deadline = now() + exitTimeoutMs
  let lastProblem = null
  for (;;) {
    try {
      const row = (await snapshot()).find(entry => entry.pid === server.pid)
      const seen = identityOf(row)
      if (!row || (seen && !sameIdentity(seen, identity))) break
      lastProblem = seen ? null : 'the pid is still listed with an unreadable identity'
    } catch (error) { lastProblem = `process inventory failed: ${error.message ?? error}` }
    assert.ok(now() < deadline, `pid ${server.pid} exit not observed by the OS within ${exitTimeoutMs / 1000} s${lastProblem ? ` (${lastProblem})` : ''}`)
    await sleep(pollMs)
  }
  const after = await call('local.servers')
  assert.ok(Array.isArray(after) && !after.some(entry => entry.pid === server.pid), `pid ${server.pid} remains in local.servers`)
  return { pid: server.pid, model, identity }
}
