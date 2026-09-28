import test from 'node:test'
import assert from 'node:assert/strict'
import { stopDurableSmokeServer } from './stop-durable-smoke-server.mjs'

const model = 'local/qwen3.6-35b-a3b'
const owned = { model, pid: 220, startedByConductor: true }
const foreign = { model: 'other', pid: 330, startedByConductor: false }
const APP = { pid: 100, creationTime: '1000', executable: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe' }
const LLAMA = 'D:\\llama\\llama-server.exe'
const row = (pid, ppid, creationTime, executable = LLAMA) => ({ pid, ppid, name: 'x.exe', commandLine: '', creationTime, executable })
const main = row(100, 90, '1000', APP.executable)
const server = row(220, 100, '2000')
const neighbour = row(330, 4, '10')

/** Scripted world: `lists` answers local.servers in turn; `snapshots` answers the OS inventory in
 *  turn (the last repeating; an Error throws). */
function fixture({ before = [owned, foreign], stopResult = { stopped: true, pid: 220, model, message: 'stopped (pid 220)' }, snapshots = [[main, server, neighbour], [main, server, neighbour], [main, neighbour]] } = {}) {
  const calls = []
  let lists = 0, snaps = 0, clock = 0
  const call = async (method, args) => {
    calls.push({ method, args })
    if (method === 'local.servers') return lists++ ? [foreign] : before
    if (method === 'local.stop') return stopResult
    throw new Error(method)
  }
  const snapshot = async () => { const answer = snapshots[Math.min(snaps++, snapshots.length - 1)]; if (answer instanceof Error) throw answer; return answer }
  return { calls, call, model, app: APP, snapshot, exitTimeoutMs: 2000, pollMs: 500, sleep: async ms => { clock += ms }, now: () => clock, stops: () => calls.filter(entry => entry.method === 'local.stop') }
}

test('stops the exact owned PID, proves its OS exit and leaves an unrelated PID alone', async () => {
  const args = fixture()
  const result = await stopDurableSmokeServer(args)
  assert.deepEqual(result, { pid: 220, model, identity: { pid: 220, creationTime: '2000', executable: LLAMA } })
  assert.deepEqual(args.stops(), [{ method: 'local.stop', args: { pid: 220, force: true } }])
})

test('a launcher shim identity is refused; the registered Electron main accepts its direct server child', async () => {
  const shim = fixture({ snapshots: [[row(90, 1, '900', 'C:\\Windows\\System32\\cmd.exe'), main, server]] })
  shim.app = { pid: 90, creationTime: '900', executable: 'C:\\Windows\\System32\\cmd.exe' }
  await assert.rejects(stopDurableSmokeServer(shim), /not started by the parked app/)
  assert.deepEqual(shim.stops(), [])
  assert.equal((await stopDurableSmokeServer(fixture())).pid, 220)
})

for (const [name, before, snapshots, message] of [
  ['missing', [foreign], undefined, /expected one/],
  ['ambiguous', [owned, { ...owned, pid: 221 }], undefined, /expected one/],
  ['unowned', [{ ...owned, startedByConductor: false }], undefined, /unowned/],
  ['invalid PID', [{ ...owned, pid: 0 }], undefined, /positive PID/],
  ['installed app parent', [owned], [[main, row(220, 999, '2000')]], /not started by the parked app/],
  ['a parked main whose pid was reused (same image, other creation time)', [owned], [[{ ...main, creationTime: '1500' }, server]], /no longer the registered process/],
  ['a parked main that has exited', [owned], [[server]], /no longer the registered process/],
  ['a server with no readable creation time', [owned], [[main, row(220, 100, null)]], /no readable OS identity/],
  ['a server older than the app (reused parent pid)', [owned], [[main, row(220, 100, '999')]], /created before the parked app/],
  ['a server pid not running at all', [owned], [[main]], /not running/],
  ['failed inventory at selection', [owned], [new Error('Access denied')], /Access denied/],
  ['failed inventory at the recheck', [owned], [[main, server], new Error('query timed out')], /query timed out/],
  ['a different process on the pid at the recheck', [owned], [[main, server], [main, row(220, 100, '2500')]], /identity changed between selection and stop/],
  ['a different image on the pid at the recheck', [owned], [[main, server], [main, row(220, 100, '2000', 'C:\\x\\node.exe')]], /identity changed/]
]) {
  test(`refuses ${name} before local.stop`, async () => {
    const args = fixture({ before, ...(snapshots ? { snapshots } : {}) })
    await assert.rejects(stopDurableSmokeServer(args), message)
    assert.deepEqual(args.stops(), [])
  })
}

test('refuses without a registered app identity (a bare numeric PID is not ownership)', async () => {
  const args = fixture()
  args.app = { pid: 100 }
  await assert.rejects(stopDurableSmokeServer(args), /no registered OS identity/)
  assert.deepEqual(args.calls, [])
})

test('failed local.stop never returns success', async () => {
  const args = fixture()
  args.call = async (method, payload) => {
    args.calls.push({ method, args: payload })
    if (method === 'local.servers') return [owned]
    throw new Error('stop refused')
  }
  await assert.rejects(stopDurableSmokeServer(args), /stop refused/)
})

test('unconfirmed stop never returns success', async () => {
  await assert.rejects(stopDurableSmokeServer(fixture({ before: [owned], stopResult: { stopped: true, pid: 220, model, message: 'not running (pid 220 had already exited)' } })), /did not confirm process termination/)
})

test('registry removal without an OS-observed exit never returns success', async () => {
  const survives = fixture({ snapshots: [[main, server]] })
  await assert.rejects(stopDurableSmokeServer(survives), /exit not observed by the OS/)
  const blind = fixture({ snapshots: [[main, server], [main, server], new Error('inventory unavailable')] })
  await assert.rejects(stopDurableSmokeServer(blind), /exit not observed[\s\S]*inventory unavailable/)
})

test('a same-pid row with an unreadable identity after the stop is not an exit', async () => {
  const unreadable = row(220, 100, null)
  const args = fixture({ snapshots: [[main, server], [main, server], [main, unreadable]] })
  await assert.rejects(stopDurableSmokeServer(args), /exit not observed[\s\S]*unreadable identity/)
  const noImage = fixture({ snapshots: [[main, server], [main, server], [main, { ...server, executable: null }]] })
  await assert.rejects(stopDurableSmokeServer(noImage), /exit not observed/)
})

test('the pid held by a valid different identity after the stop is an exit (control)', async () => {
  const args = fixture({ snapshots: [[main, server], [main, server], [main, row(220, 4, '9000', 'C:\\Windows\\notepad.exe')]] })
  assert.equal((await stopDurableSmokeServer(args)).pid, 220)
})

test('a delayed OS exit is waited for within the bound', async () => {
  const args = fixture({ snapshots: [[main, server], [main, server], [main, server], [main, server], [main]] })
  assert.equal((await stopDurableSmokeServer(args)).pid, 220)
})

test('a surviving PID in local.servers never returns success', async () => {
  const args = fixture({ before: [owned] })
  args.call = async (method, payload) => {
    args.calls.push({ method, args: payload })
    if (method === 'local.servers') return [owned]
    if (method === 'local.stop') return { stopped: true, pid: 220, model, message: 'stopped (pid 220)' }
  }
  await assert.rejects(stopDurableSmokeServer(args), /remains in local.servers/)
})
