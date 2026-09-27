import test from 'node:test'
import assert from 'node:assert/strict'
import { stopDurableSmokeServer } from './stop-durable-smoke-server.mjs'

const model = 'local/qwen3.6-35b-a3b'
const owned = { model, pid: 220, startedByConductor: true }
const foreign = { model: 'other', pid: 330, startedByConductor: false }

function fixture(before = [owned, foreign], stopResult = { stopped: true, pid: 220, model, message: 'stopped (pid 220)' }) {
  const calls = []
  let lists = 0
  const call = async (method, args) => {
    calls.push({ method, args })
    if (method === 'local.servers') return lists++ ? [foreign] : before
    if (method === 'local.stop') return stopResult
    throw new Error(method)
  }
  return { calls, call, model, appPid: 100, parentPidOf: async () => 100 }
}

test('stops the exact owned PID and leaves an unrelated PID alone', async () => {
  const args = fixture()
  assert.deepEqual(await stopDurableSmokeServer(args), { pid: 220, model })
  assert.deepEqual(args.calls.filter(entry => entry.method === 'local.stop'), [{ method: 'local.stop', args: { pid: 220, force: true } }])
})

for (const [name, before, parent] of [
  ['missing', [foreign], 100],
  ['ambiguous', [owned, { ...owned, pid: 221 }], 100],
  ['unowned', [{ ...owned, startedByConductor: false }], 100],
  ['invalid PID', [{ ...owned, pid: 0 }], 100],
  ['installed app parent', [owned], 999]
]) {
  test(`refuses ${name} selection before local.stop`, async () => {
    const args = fixture(before)
    args.parentPidOf = async () => parent
    await assert.rejects(stopDurableSmokeServer(args))
    assert.equal(args.calls.some(entry => entry.method === 'local.stop'), false)
  })
}

test('failed local.stop never returns success', async () => {
  const args = fixture()
  args.call = async (method, payload) => {
    args.calls.push({ method, args: payload })
    if (method === 'local.servers') return [owned]
    throw new Error('stop refused')
  }
  await assert.rejects(stopDurableSmokeServer(args), /stop refused/)
})

test('unconfirmed stop and surviving PID never return success', async () => {
  await assert.rejects(stopDurableSmokeServer(fixture([owned], { stopped: true, pid: 220, model, message: 'not running' })), /did not confirm process termination/)
  const args = fixture([owned])
  let lists = 0
  args.call = async (method, payload) => {
    if (method === 'local.servers') return lists++ ? [owned] : [owned]
    if (method === 'local.stop') return { stopped: true, pid: 220, model, message: 'stopped (pid 220)' }
  }
  await assert.rejects(stopDurableSmokeServer(args), /remains in local.servers/)
})
