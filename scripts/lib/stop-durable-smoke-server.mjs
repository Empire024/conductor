import assert from 'node:assert/strict'

/** Stop only the model process spawned by this smoke's parked Electron main process. */
export async function stopDurableSmokeServer({ call, model, appPid, parentPidOf }) {
  assert.ok(Number.isSafeInteger(appPid) && appPid > 0, 'parked app has no positive PID')
  const servers = await call('local.servers')
  assert.ok(Array.isArray(servers), 'local.servers did not return a server list')
  const matches = servers.filter(server => server.model === model)
  assert.equal(matches.length, 1, `expected one ${model} server; found ${matches.length}`)
  const server = matches[0]
  assert.equal(server.startedByConductor, true, `refusing unowned ${model} server`)
  assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0, `refusing ${model} server without a positive PID`)
  assert.equal(await parentPidOf(server.pid), appPid, `refusing ${model} pid ${server.pid}: not started by the parked app`)

  const stopped = await call('local.stop', { pid: server.pid, force: true })
  assert.equal(stopped?.stopped, true, `local.stop did not confirm stop for pid ${server.pid}`)
  assert.equal(stopped.pid, server.pid, 'local.stop confirmed a different PID')
  assert.equal(stopped.model, model, 'local.stop confirmed a different model')
  assert.match(stopped.message ?? '', /^stopped \(pid \d+\)$/, 'local.stop did not confirm process termination')
  const after = await call('local.servers')
  assert.ok(Array.isArray(after) && !after.some(entry => entry.pid === server.pid), `pid ${server.pid} remains in local.servers`)
  return { pid: server.pid, model }
}
