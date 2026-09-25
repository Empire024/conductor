import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO, VERDICT, ancestorsOf, cpuPercent, descendantsOf, formatRecordLine, judgeLoad, matchProcesses, parseLlamaCommandLine,
  parseNvidiaSmi, parseProcessList, poll, readGateThresholds, retryAck, sameProcesses, withDeadline
} from './verify-kit.mjs'

// shell(100) -> agent node(200) -> smoke-lock(300) -> smoke(400) -> electron(500) -> renderer(501), fixture(502)
//                                                    smoke(400) -> powershell query(600) -> conhost(601)
const marker = 'rv1-a2b-1758790000000'
const list = [
  { pid: 100, ppid: 1, name: 'pwsh.exe', commandLine: `pwsh -c "node smoke.mjs ${marker}"` },
  { pid: 200, ppid: 100, name: 'node.exe', commandLine: `node agent.mjs --marker ${marker}` },
  { pid: 300, ppid: 200, name: 'node.exe', commandLine: `node scripts/smoke-lock.mjs -- node smoke.mjs ${marker}` },
  { pid: 400, ppid: 300, name: 'node.exe', commandLine: `node smoke.mjs ${marker}` },
  { pid: 500, ppid: 400, name: 'electron.exe', commandLine: 'electron out/main/index.js' },
  { pid: 501, ppid: 500, name: 'electron.exe', commandLine: 'electron --type=renderer' },
  { pid: 502, ppid: 500, name: 'node.exe', commandLine: `node -e "console.log('${marker}')"` },
  { pid: 600, ppid: 400, name: 'powershell.exe', commandLine: `powershell -Command Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' }` },
  { pid: 601, ppid: 600, name: 'conhost.exe', commandLine: `conhost.exe 0x4 ${marker}` },
  { pid: 700, ppid: 1, name: 'node.exe', commandLine: 'node unrelated.mjs' }
]

test('parseProcessList reads one row or many and keeps a null command line empty', () => {
  assert.deepEqual(parseProcessList('{"ProcessId":4,"ParentProcessId":0,"Name":"System","CommandLine":null}'), [{ pid: 4, ppid: 0, name: 'System', commandLine: '' }])
  assert.equal(parseProcessList('[{"ProcessId":1,"ParentProcessId":0,"Name":"a","CommandLine":"x"},{"ProcessId":2,"ParentProcessId":1,"Name":"b","CommandLine":"y"}]').length, 2)
  assert.deepEqual(parseProcessList(''), [])
})

test('ancestorsOf walks the parent chain and survives a reused-pid cycle', () => {
  assert.deepEqual([...ancestorsOf(list, 400)].sort(), [1, 100, 200, 300])
  const cycle = [{ pid: 10, ppid: 11, name: 'a', commandLine: '' }, { pid: 11, ppid: 10, name: 'b', commandLine: '' }]
  assert.deepEqual([...ancestorsOf(cycle, 10)], [11])
})

test('descendantsOf finds the whole tree, roots included only when still listed', () => {
  assert.deepEqual([...descendantsOf(list, [500])].sort(), [500, 501, 502])
  assert.deepEqual([...descendantsOf(list, [999, 600])].sort(), [600, 601])
})

test('matchProcesses excludes itself, its shell ancestry and its query (RV1 A2 false positive)', () => {
  const found = matchProcesses(list, marker, { selfPid: 400, queryPid: 600 })
  assert.deepEqual(found.map(entry => entry.pid), [502])
  // With the target gone, nothing matches although six other command lines still quote the marker.
  assert.deepEqual(matchProcesses(list.filter(entry => entry.pid !== 502), marker, { selfPid: 400, queryPid: 600 }), [])
})

test('matchProcesses refuses a marker short enough to match unrelated processes', () => {
  assert.throws(() => matchProcesses(list, 'node', { selfPid: 400 }), /distinctive marker/)
  assert.throws(() => matchProcesses(list, undefined, { selfPid: 400 }), /distinctive marker/)
})

test('sameProcesses never matches a reused pid running something else', () => {
  const snapshot = [list[4], list[5]]
  const later = [{ ...list[4] }, { pid: 501, ppid: 9, name: 'notepad.exe', commandLine: 'notepad' }]
  assert.deepEqual(sameProcesses(snapshot, later).map(entry => entry.pid), [500])
})

test('parseLlamaCommandLine reads the port and API key llamaServerArgs writes', () => {
  assert.deepEqual(parseLlamaCommandLine('"D:\\llama\\llama-server.exe" --host 127.0.0.1 --port 8081 --api-key abcdef0123456789abcdef0123456789 --no-webui'), { port: 8081, apiKey: 'abcdef0123456789abcdef0123456789' })
  assert.deepEqual(parseLlamaCommandLine('llama-server --port=9000'), { port: 9000, apiKey: null })
  assert.equal(parseLlamaCommandLine('llama-server --help'), null)
})

test('parseNvidiaSmi reads one utilization per GPU and ignores noise', () => {
  assert.deepEqual(parseNvidiaSmi('7\r\n'), [7])
  assert.deepEqual(parseNvidiaSmi('12\n85\n'), [12, 85])
  assert.deepEqual(parseNvidiaSmi('NVIDIA-SMI has failed'), [])
})

test('cpuPercent is busy time over total time across cores', () => {
  const at = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } })
  assert.equal(cpuPercent([at(0, 0), at(0, 0)], [at(25, 75), at(75, 25)]), 50)
  assert.equal(cpuPercent([at(10, 10)], [at(10, 10)]), 0)
})

test('readGateThresholds reads the live schedule-gate.ts (CPU 30 %, GPU 40 % per verify.md)', () => {
  const thresholds = readGateThresholds(readFileSync(join(REPO, 'src', 'main', 'schedule-gate.ts'), 'utf8'))
  assert.deepEqual(thresholds, { machineCpuPercent: 30, gpuPercent: 40 })
  assert.throws(() => readGateThresholds('export const nothing = 1'), /no longer defines machineCpuPercent/)
})

test('judgeLoad is quiet only with no foreign lock, low CPU and GPU, idle llama and no extra mid-turn tab', () => {
  const thresholds = { machineCpuPercent: 30, gpuPercent: 40 }
  const quiet = { lock: { held: true, self: true, holder: { pid: 300 } }, cpuPercent: 12, gpuPercent: 3, llama: [{ pid: 9, port: 8081, busy: false }], midTurn: { count: 1 } }
  assert.deepEqual(judgeLoad(quiet, thresholds), { quiet: true, reasons: [] })
  const loaded = { lock: { held: true, self: false, holder: { pid: 77, command: 'node smoke-other.mjs' } }, cpuPercent: 30, gpuPercent: 64, llama: [{ pid: 9, port: 8081, busy: true }, { pid: 10, port: 8082, busy: null }], midTurn: { count: 3 } }
  const { quiet: isQuiet, reasons } = judgeLoad(loaded, thresholds)
  assert.equal(isQuiet, false)
  assert.equal(reasons.length, 6)
  assert.match(reasons.join('\n'), /pid 77[\s\S]*CPU 30% >= 30%[\s\S]*GPU 64% >= 40%[\s\S]*port 8081 is generating[\s\S]*pid 10 state unknown[\s\S]*2 mid-turn tab/)
  assert.equal(judgeLoad({ ...quiet, midTurn: { count: 0 } }, thresholds, { selfTabs: 0 }).quiet, true)
  assert.equal(judgeLoad({ ...quiet, midTurn: { count: 1 } }, thresholds, { selfTabs: 0 }).quiet, false)
  assert.deepEqual(judgeLoad({ ...quiet, cpuPercent: null, gpuPercent: null, midTurn: { count: null, note: 'refused' } }, thresholds).reasons, ['CPU load unknown', 'GPU load unknown', 'mid-turn tabs unknown (refused)'])
})

test('VERDICT holds the v3 vocabulary and NOT RUN must name its reason', () => {
  for (const ok of ['PASS', 'FAIL', 'HUNG', 'INFO', 'LOAD', 'NOT RUN (owner)', 'NOT RUN (harness)', 'NOT RUN (time-box)']) assert.match(ok, VERDICT)
  for (const bad of ['BLOCKED', 'NOT RUN', 'pass', 'PASS ']) assert.doesNotMatch(bad, VERDICT)
})

test('formatRecordLine writes one line with numbers as JSON and evidence flattened', () => {
  assert.equal(formatRecordLine({ at: 'T', id: 'A8', verdict: 'PASS', numbers: { ms: 12 }, evidence: 'a.png\nb.png' }), '- T **A8** PASS {"ms":12} - a.png b.png\n')
  assert.equal(formatRecordLine({ at: 'T', id: 'x', verdict: 'FAIL', numbers: {}, evidence: '' }), '- T **x** FAIL\n')
})

test('withDeadline never hangs and never throws', async () => {
  assert.deepEqual(await withDeadline(Promise.resolve(3), 50), { ok: true, value: 3 })
  assert.deepEqual(await withDeadline(new Promise(() => {}), 20), { ok: false, timedOut: true })
  const failed = await withDeadline(Promise.reject(new Error('boom')), 50)
  assert.equal(failed.ok, false)
  assert.equal(failed.error.message, 'boom')
})

test('retryAck retries only "did not acknowledge" and gives up after the last attempt', async () => {
  let calls = 0
  const value = await retryAck(async () => { if (++calls < 3) throw new Error('Workspace did not acknowledge the action. Inspect the UI before retrying.'); return 'tab' }, { wait: async () => {}, log: () => {} })
  assert.equal(value, 'tab')
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(retryAck(async () => { calls++; throw new Error('tabs.open -> HTTP 400: bad provider') }, { wait: async () => {}, log: () => {} }), /bad provider/)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(retryAck(async () => { calls++; throw new Error('did not acknowledge') }, { attempts: 2, wait: async () => {}, log: () => {} }), /did not acknowledge/)
  assert.equal(calls, 2)
})

test('poll needs a deadline and reports the last value when it runs out', async () => {
  await assert.rejects(poll(() => false, {}), /needs a timeoutMs/)
  let clock = 0
  await assert.rejects(poll(() => ({ phase: 'running' }) && null, { timeoutMs: 1000, intervalMs: 400, label: 'phase completed', wait: async ms => { clock += ms }, now: () => clock }), /timed out after 1 s waiting for phase completed; last: null/)
  clock = 0
  let n = 0
  assert.equal(await poll(() => (++n === 3 ? 'done' : null), { timeoutMs: 5000, wait: async ms => { clock += ms }, now: () => clock }), 'done')
})
