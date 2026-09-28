import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REPO, VERDICT, ancestorsOf, cpuPercent, descendantsOf, formatRecordLine, identityOf, ignoredTabs, judgeLoad, leavesFirst, listProcesses, loadInfo, matchProcesses, midTurnTabs, newInstance, suppliedControl,
  ownedTree, parseLlamaCommandLine, parseNvidiaSmi, parseProcessList, poll, readGateThresholds, registerRelaunch, registerRoot, retryAck, safeClose,
  sameProcesses, terminateIdentity, trackDescendants, withDeadline, commandHasArg, creationMs, startTracking, stopTracking, assertBuildHash, registerOwnChild,
  possibleDescendants, packagedAcceptanceExecutable, assertPackagedEnvironment, assertPackagedReceipt, relaunchParked
} from './verify-kit.mjs'

test('packaged acceptance requires an explicit absolute executable and matching bytes before launch', () => {
  assert.equal(packagedAcceptanceExecutable({}), null)
  const executable = join(REPO, 'package.json')
  const hash = createHash('sha256').update(readFileSync(executable)).digest('hex')
  const version = '1.2.3-local.42'
  assert.throws(() => packagedAcceptanceExecutable({ CONDUCTOR_PACKAGED_ACCEPTANCE_EXE: 'relative.exe', CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256: hash, CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION: version }), /absolute/)
  assert.throws(() => packagedAcceptanceExecutable({ CONDUCTOR_PACKAGED_ACCEPTANCE_EXE: executable }), /SHA256/)
  assert.throws(() => packagedAcceptanceExecutable({ CONDUCTOR_PACKAGED_ACCEPTANCE_EXE: executable, CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256: '0'.repeat(64), CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION: version }), /not the granted/)
  assert.deepEqual(packagedAcceptanceExecutable({ CONDUCTOR_PACKAGED_ACCEPTANCE_EXE: executable, CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256: hash, CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION: version }), { executable, executableSha256: hash, expectedPackagedVersion: version })
})

test('packaged relaunch refuses missing opt-in, changed profile or project root before any spawn', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'conductor-packaged-acceptance-'))
  const profile = join(root, 'profile'); mkdirSync(profile)
  const executable = join(REPO, 'package.json'), hash = createHash('sha256').update(readFileSync(executable)).digest('hex')
  const version = '1.2.3-local.42'
  const base = { CONDUCTOR_PACKAGED_ACCEPTANCE: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_PACKAGED_ACCEPTANCE_EXE: executable, CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256: hash, CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION: version }
  try {
    for (const env of [{ CONDUCTOR_PACKAGED_ACCEPTANCE: undefined }, { CONDUCTOR_TEST_USER_DATA: REPO }, { CONDUCTOR_PROJECTS_ROOT: REPO }, { CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256: '0'.repeat(64) }]) {
      const inst = newInstance({ mode: 'spawn', root, profile, executable, executableSha256: hash, expectedPackagedVersion: version, env: { ...base } })
      assert.doesNotThrow(() => assertPackagedEnvironment(inst))
      await assert.rejects(relaunchParked(inst, { env }), /pinned/)
      assert.equal(inst.child, null)
    }
    const inst = { executable, expectedPackagedVersion: version }
    assert.doesNotThrow(() => assertPackagedReceipt(inst, { packaged: true, appVersion: version }))
    assert.throws(() => assertPackagedReceipt(inst, { packaged: false, appVersion: version }), /version/)
    assert.throws(() => assertPackagedReceipt(inst, { packaged: true, appVersion: '1.2.4' }), /version/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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
  assert.deepEqual(parseProcessList('{"ProcessId":4,"ParentProcessId":0,"Name":"System","CommandLine":null}'), [{ pid: 4, ppid: 0, name: 'System', commandLine: '', creationTime: null, executable: null }])
  assert.equal(parseProcessList('[{"ProcessId":1,"ParentProcessId":0,"Name":"a","CommandLine":"x"},{"ProcessId":2,"ParentProcessId":1,"Name":"b","CommandLine":"y"}]').length, 2)
  assert.deepEqual(parseProcessList(''), [])
})

test('parseProcessList keeps OS identity only when it is usable and refuses a broken inventory', () => {
  const [row] = parseProcessList('{"ProcessId":500,"ParentProcessId":400,"Name":"electron.exe","CommandLine":"e","ExecutablePath":"C:\\\\app\\\\electron.exe","CreationTime":"13403612345678901"}')
  assert.deepEqual(identityOf(row), { pid: 500, creationTime: '13403612345678901', executable: 'C:\\app\\electron.exe' })
  for (const created of [null, '', '0', 'yesterday']) assert.equal(identityOf(parseProcessList(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: 'x', ExecutablePath: 'C:\\x.exe', CreationTime: created }))[0]), null)
  assert.equal(identityOf(parseProcessList('{"ProcessId":5,"ParentProcessId":1,"Name":"x","CreationTime":"123"}')[0]), null)
  assert.throws(() => parseProcessList('[{"Name":"no id"}]'), /without a process id \(fields: Name:string\)/)
})

// ---- ownership: identity-verified trees, fail-closed cleanup (docs/verification/2026-09-28-local-safety-review.md)

const EXE = 'C:\\app\\electron.exe'
const proc = (pid, ppid, created, extra = {}) => ({ pid, ppid, name: 'electron.exe', commandLine: 'electron out/main/index.js', creationTime: created == null ? null : String(created), executable: EXE, ...extra })
const idOf = entry => ({ pid: entry.pid, creationTime: entry.creationTime, executable: entry.executable })
// Registered root 500 (created 1000) -> renderer 501, gpu 502 -> helper 503. Foreign neighbour 700.
const owned = [proc(500, 400, 1000), proc(501, 500, 1001), proc(502, 500, 1002), proc(503, 502, 1003), proc(700, 1, 5, { name: 'node.exe', executable: 'C:\\node\\node.exe' })]
const root = idOf(owned[0])
const pids = tree => tree.members.map(member => member.pid).sort()

test('ownedTree admits the exact registered tree and nothing beside it', () => {
  const tree = ownedTree(owned, [root])
  assert.deepEqual(pids(tree), [500, 501, 502, 503])
  assert.deepEqual(tree.unresolved, [])
  assert.deepEqual(leavesFirst(tree.members).map(member => member.pid), [503, 501, 502, 500])
})

test('ownedTree: a reused root pid is not the root, even with the same name and command line', () => {
  const reused = [proc(500, 400, 9999), proc(501, 500, 10000)]
  const tree = ownedTree(reused, [root])
  assert.deepEqual(pids(tree), [])
  assert.match(tree.unresolved[0].reason, /belongs to another process/)
})

test('ownedTree: same pid and creation time with a different image is not the root', () => {
  assert.deepEqual(pids(ownedTree([proc(500, 400, 1000, { executable: 'C:\\Windows\\notepad.exe' }), proc(501, 500, 1001)], [root])), [])
})

test('ownedTree: missing creation identity stops admission there, for roots and children alike', () => {
  assert.deepEqual(pids(ownedTree([proc(500, 400, null), proc(501, 500, 1001)], [root])), [])
  const tree = ownedTree([proc(500, 400, 1000), proc(502, 500, null), proc(503, 502, 1003)], [root])
  assert.deepEqual(pids(tree), [500])
  assert.match(tree.unresolved[0].reason, /no readable OS identity/)
  assert.deepEqual(pids(ownedTree([proc(500, 400, 1000, { executable: null })], [root])), [])
})

test('ownedTree: an exited root and a foreign process that inherited its pid as parent', () => {
  const tree = ownedTree([proc(501, 500, 1001), proc(900, 500, 50000)], [root])
  assert.deepEqual(pids(tree), [])
  assert.match(tree.unresolved[0].reason, /no longer running/)
})

test('ownedTree: a child created before its listed parent means the parent pid was reused', () => {
  const tree = ownedTree([proc(500, 400, 1000), proc(501, 500, 999)], [root])
  assert.deepEqual(pids(tree), [500])
  assert.match(tree.unresolved[0].reason, /created before its listed parent/)
})

test('ownedTree: cyclic ancestry terminates and admits nothing foreign', () => {
  const cycle = [proc(500, 501, 1000), proc(501, 500, 1001), proc(502, 501, 1002)]
  assert.deepEqual(pids(ownedTree(cycle, [root])), [500, 501, 502])
  const foreignCycle = [proc(600, 601, 1), proc(601, 600, 2)]
  assert.deepEqual(pids(ownedTree(foreignCycle, [root])), [])
})

test('ownedTree: a pid listed twice is never acted on', () => {
  const tree = ownedTree([proc(500, 400, 1000), proc(501, 500, 1001), proc(501, 500, 1001)], [root])
  assert.deepEqual(pids(tree), [500])
})

/** A scripted machine for safeClose: `snapshots` answers each inventory call in turn (an Error
 *  throws), the last one repeating; terminate answers are scripted per pid. */
function machine({ snapshots, terminate = () => ({ state: 'exited' }), roots = [root], observed = true }) {
  const calls = { list: 0, terminate: [] }
  const ledger = []
  const inst = newInstance({ name: 'kit-test' })
  // observed: the tracker saw each root alive with its subtree (see trackDescendants).
  inst.roots = roots.map(entry => ({ ...entry, generation: inst.generation, source: 'launch', observedTree: observed }))
  let clock = 0
  const deps = {
    listProcesses: async () => { const answer = snapshots[Math.min(calls.list++, snapshots.length - 1)]; if (answer instanceof Error) throw answer; return { list: answer } },
    terminate: async (identity, budgetMs) => { calls.terminate.push(identity.pid); return terminate(identity, budgetMs) },
    now: () => clock, sleep: async ms => { clock += ms }, ledger: entry => ledger.push(entry)
  }
  return { inst, deps, calls, ledger }
}
const quietClose = async (inst, options) => { const log = console.log; console.log = () => {}; try { return await safeClose(inst, options) } finally { console.log = log } }

test('safeClose kills the exact owned tree leaves first, re-proved after the close, and leaves the neighbour', async () => {
  const m = machine({ snapshots: [owned, owned, [owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [503, 501, 502, 500])
  assert.deepEqual(report.leftovers, [])
  assert.deepEqual(report.unresolved, [])
  assert.equal(report.tree, 4)
  assert.deepEqual(m.ledger.filter(entry => entry.event === 'terminate').map(entry => entry.pid), [503, 501, 502, 500])
})

test('safeClose: children orphaned by the close stay attributable by their own identity', async () => {
  const orphaned = [proc(501, 500, 1001), proc(503, 502, 1003), owned[4]]
  const m = machine({ snapshots: [owned, orphaned, [owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate.sort(), [501, 503])
  assert.deepEqual(report.unresolved, [])
})

for (const [name, snapshots] of [
  ['inventory failing before the close', [new Error('Access denied')]],
  ['inventory failing after the close', [owned, new Error('query timed out')]]
]) {
  test(`safeClose: ${name} means zero kills and an unresolved report, never a pid fallback`, async () => {
    const m = machine({ snapshots })
    m.inst.pids.add(500); m.inst.pids.add(501)
    const report = await quietClose(m.inst, { deps: m.deps })
    assert.deepEqual(m.calls.terminate, [])
    assert.ok(report.unresolved.some(entry => /process inventory failed/.test(entry.reason)))
  })
}

test('safeClose: an instance with only numeric pids (no registered identity) kills nothing', async () => {
  const m = machine({ snapshots: [owned], roots: [] })
  for (const pid of [500, 501, 502, 503]) m.inst.pids.add(pid)
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.equal(m.calls.list, 0)
  assert.match(report.unresolved[0].reason, /no registered root identity/)
})

test('safeClose: a root from a stale generation is not authority', async () => {
  const m = machine({ snapshots: [owned] })
  m.inst.roots[0].generation = 'an-earlier-run'
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.ok(report.unresolved.some(entry => /another generation/.test(entry.reason)))
})

test('safeClose: a member pid reused by the same program after the close is left alone', async () => {
  const reusedAfter = [proc(500, 400, 7000), proc(501, 500, 7001), owned[4]]
  const m = machine({ snapshots: [owned, reusedAfter] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.deepEqual(report.leftovers, [])
})

test('safeClose: a member whose identity is unreadable after the close is reported, not killed', async () => {
  const partial = [proc(500, 400, 1000), proc(501, 500, null), owned[4]]
  // 501 stays listed and unreadable through the re-probe: nothing proves it exited.
  const m = machine({ snapshots: [[owned[0], owned[1], owned[4]], partial, [proc(501, 500, null), owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [500])
  assert.ok(report.unresolved.some(entry => entry.pid === 501 && /no readable OS identity/.test(entry.reason)))
})

// ---- an unreadable child is re-probed (fault 1790593849520: nvidia-smi caught mid-exit)
const smi = (pid, extra = {}) => proc(pid, 500, null, { name: 'nvidia-smi.exe', executable: null, ...extra })

test('safeClose: a transient unreadable child that is gone on re-probe is a note, never killed, and the close is clean', async () => {
  // Before the close: the app, its renderer, and nvidia-smi 900 mid-exit (no identity). After: all gone.
  const m = machine({ snapshots: [[owned[0], owned[1], smi(900), owned[4]], [owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.deepEqual(report.unresolved, [])
  assert.deepEqual(report.leftovers, [])
  assert.ok(report.notes.some(entry => entry.pid === 900 && /exited, never killed/.test(entry.reason)), JSON.stringify(report.notes))
  const probe = m.ledger.find(entry => entry.event === 'reprobe')
  assert.deepEqual([probe.exited, probe.still, probe.failure], [[900], [], null])
})

test('safeClose: an unreadable child still listed after the bounded re-probe stays unresolved and is never killed', async () => {
  const m = machine({ snapshots: [[owned[0], smi(900), owned[4]], [smi(900, { ppid: 1 }), owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.ok(report.unresolved.some(entry => entry.pid === 900 && /child of 500 has no readable OS identity/.test(entry.reason)))
  assert.ok(!report.notes.some(entry => entry.pid === 900))
  const probe = m.ledger.find(entry => entry.event === 'reprobe')
  assert.deepEqual([probe.exited, probe.still], [[], [900]])
  assert.ok(m.calls.list >= 11, `re-probed for the whole window (${m.calls.list} inventories)`)
})

test('safeClose: an unreadable child that turns readable, or leaves a listed child behind, stays unresolved', async () => {
  const readable = machine({ snapshots: [[owned[0], smi(900), owned[4]], [smi(900, { creationTime: '5000', executable: 'C:\\nv\\nvidia-smi.exe', ppid: 1 }), owned[4]]] })
  const orphan = machine({ snapshots: [[owned[0], smi(900), owned[4]], [proc(901, 900, 5001, { name: 'conhost.exe' }), owned[4]]] })
  for (const m of [readable, orphan]) {
    const report = await quietClose(m.inst, { deps: m.deps })
    assert.deepEqual(m.calls.terminate, [])
    assert.ok(report.unresolved.some(entry => entry.pid === 900), JSON.stringify(report.unresolved))
  }
})

test('safeClose: a failed inventory during the re-probe keeps the unreadable child unresolved', async () => {
  const m = machine({ snapshots: [[owned[0], smi(900), owned[4]], [owned[4]], new Error('query timed out')] })
  // Close: before, after (member 500 gone, graceful false -> exit confirmation reads the third), then re-probe.
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.ok(report.unresolved.some(entry => entry.pid === 900))
  assert.ok(report.unresolved.some(entry => /inventory failed/.test(entry.reason)))
})

test('safeClose: R-1 - U -> C -> G seen before the close, only G left on re-probe: U stays unresolved, nothing killed', async () => {
  // U 900 (unreadable) -> C 901 -> G 902, all under the app 500 before the close. Afterwards U and C
  // are gone and G survives with ppid 901: neither 900 nor ppid 900 is listed, but G is its descendant.
  const g = proc(902, 901, 5002, { name: 'conhost.exe' })
  const m = machine({ snapshots: [[owned[0], smi(900), proc(901, 900, 5001, { name: 'cmd.exe' }), g, owned[4]], [g, owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.ok(report.unresolved.some(entry => entry.pid === 900 && /no readable OS identity/.test(entry.reason)), JSON.stringify(report.unresolved))
  assert.ok(!report.notes.some(entry => entry.pid === 900))
  assert.deepEqual(m.ledger.find(entry => entry.event === 'reprobe').still, [900])
})

test('possibleDescendants follows every ppid link across snapshots, even to a child older than its parent', () => {
  // 903 predates its listed parent 902 (a possibly reused pid): followed anyway, since over-inclusion
  // only makes the close stricter.
  const snapshots = [[smi(900), proc(901, 900, 5001)], [proc(902, 901, 5002), proc(903, 902, 4000)]]
  assert.deepEqual([...possibleDescendants(900, snapshots)].sort(), [900, 901, 902, 903])
  assert.deepEqual([...possibleDescendants(900, [[proc(700, 1, 5)]])], [900])
})

test('safeClose: readable foreign processes are unaffected by the re-probe', async () => {
  // 700 (foreign, readable) is listed throughout; 900 is gone: only 900 is resolved, 700 is never touched.
  const m = machine({ snapshots: [[owned[0], smi(900), owned[4]], [owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.ok(!report.notes.some(entry => entry.pid === 700) && !report.unresolved.some(entry => entry.pid === 700))
})

test('safeClose: a pid that changed between selection and kill is refused by the kill helper and not counted', async () => {
  const m = machine({ snapshots: [[owned[0], owned[4]], [owned[0], owned[4]], [owned[4]]], terminate: () => ({ state: 'mismatch', creationTime: '42', executable: EXE }) })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(report.killed, [])
  assert.equal(report.attempts[0].result.state, 'mismatch')
})

test('safeClose: kill-helper failure or hang is bounded and the survivor is a leftover', async () => {
  for (const terminate of [() => ({ state: 'unknown', detail: 'kill helper exited 1' }), () => new Promise(() => {})]) {
    const m = machine({ snapshots: [[owned[0], owned[4]]], terminate })
    const started = Date.now()
    const report = await quietClose(m.inst, { deps: m.deps, killWindowMs: 50 })
    assert.ok(Date.now() - started < 5000)
    assert.deepEqual(report.leftovers, [{ pid: 500, name: 'electron.exe' }])
    assert.equal(report.attempts[0].result.state, 'unknown')
  }
})

test('safeClose: an explicitly registered relaunch is owned; its exited predecessor is only noted', async () => {
  const relaunch = proc(800, 1, 3000)
  const m = machine({ snapshots: [[relaunch, proc(801, 800, 3001), owned[4]], [relaunch, owned[4]], [owned[4]]], roots: [root, idOf(relaunch)] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [800])
  assert.deepEqual(report.unresolved, [])
  assert.match(report.notes[0].reason, /no longer running/)
})

// ---- S-B3: relaunch needs this profile's credential, written while the process already held the pid.
const BUILD_PATH = 'C:\\repo\\out\\main\\index.js'
const PROFILE = 'C:\\Temp\\conductor-kit-abc\\profile'
// Creation 3000 s after the Unix epoch, as listProcesses' microseconds since 1601.
const US_1601 = ms => String((BigInt(ms) + 11_644_473_600_000n) * 1000n)
const relaunchInst = () => {
  const inst = newInstance({ name: 'kit-test', build: BUILD_PATH, profile: PROFILE })
  inst.roots.push({ ...root, creationTime: US_1601(1_000_000), generation: inst.generation, source: 'launch' })
  return inst
}
const relaunchedApp = (over = {}) => proc(800, 1, US_1601(3_000_000), { commandLine: `"C:\\e\\electron.exe" --remote-debugging-port=1 "${BUILD_PATH}"`, ...over })
const proofFor = (over = {}) => ({ path: `${PROFILE}\\control-owner.json`, pid: 800, mtimeMs: 3_000_500, ...over })

test('registerRelaunch accepts the app this profile\'s credential names, proven alive when it was written', async () => {
  const inst = relaunchInst()
  const registered = await registerRelaunch(inst, 800, { list: [relaunchedApp()], credential: proofFor() })
  assert.equal(registered.source, 'relaunch')
  assert.ok(inst.roots.some(entry => entry.pid === 800))
})

test('packaged app-initiated relaunch uses exact executable, profile receipt and version without a build argument', async () => {
  const executable = join(REPO, 'package.json'), hash = createHash('sha256').update(readFileSync(executable)).digest('hex')
  const rootDir = mkdtempSync(join(realpathSync(tmpdir()), 'conductor-packaged-acceptance-'))
  const profile = join(rootDir, 'profile'); mkdirSync(profile)
  const inst = relaunchInst()
  const version = '1.2.3'
  Object.assign(inst, { root: rootDir, profile, executable, executableSha256: hash, expectedPackagedVersion: version,
    env: { CONDUCTOR_PACKAGED_ACCEPTANCE: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(rootDir, 'projects'), CONDUCTOR_PACKAGED_ACCEPTANCE_EXE: executable, CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256: hash, CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION: version } })
  inst.roots[0].executable = executable
  const entry = relaunchedApp({ executable, commandLine: `"${executable}" --remote-debugging-port=1` })
  const proof = proofFor({ path: join(profile, 'control-owner.json'), packaged: true, appVersion: version })
  try {
    await assert.rejects(registerRelaunch(inst, 800, { list: [entry], credential: { ...proof, appVersion: '1.2.2' } }), /version/)
    delete inst.env.CONDUCTOR_PACKAGED_ACCEPTANCE
    await assert.rejects(registerRelaunch(inst, 800, { list: [entry], credential: proof }), /pinned/)
    assert.equal(inst.roots.length, 1)
    inst.env.CONDUCTOR_PACKAGED_ACCEPTANCE = '1'
    await registerRelaunch(inst, 800, { list: [entry], credential: proof })
    assert.ok(inst.roots.some(item => item.pid === 800))
  } finally { rmSync(rootDir, { recursive: true, force: true }) }
})

for (const [name, entry, credential, message] of [
  ['stale credential pid reused by a foreign same-image, same-build app', relaunchedApp({ creationTime: US_1601(3_600_000) }), proofFor(), /created after the profile credential was written/],
  ['a credential from another profile', relaunchedApp(), proofFor({ path: 'C:\\Temp\\conductor-other\\profile\\control-owner.json' }), /own profile/],
  ['no credential at all', relaunchedApp(), null, /own profile/],
  ['a credential naming another pid', relaunchedApp(), proofFor({ pid: 801 }), /names pid 801/],
  ['a build-prefix lookalike argument', relaunchedApp({ commandLine: `electron "${BUILD_PATH}.bak"` }), proofFor(), /build is not one of its arguments/],
  ['a build path only inside another argument', relaunchedApp({ commandLine: `electron --x=${BUILD_PATH}` }), proofFor(), /build is not one of its arguments/],
  ['a different Electron image', relaunchedApp({ executable: 'C:\\other\\electron.exe' }), proofFor(), /no earlier root of this generation/],
  ['an unreadable identity', relaunchedApp({ creationTime: null }), proofFor(), /unreadable/]
]) {
  test(`registerRelaunch refuses ${name}: nothing registered, nothing killed`, async () => {
    const inst = relaunchInst()
    await assert.rejects(registerRelaunch(inst, 800, { list: [entry], credential }), message)
    assert.equal(inst.roots.length, 1)
  })
}

test('registerRelaunch refuses when only another generation\'s root runs the image', async () => {
  const inst = relaunchInst()
  inst.roots[0].generation = 'an-earlier-run'
  await assert.rejects(registerRelaunch(inst, 800, { list: [relaunchedApp()], credential: proofFor() }), /no earlier root of this generation/)
})

// ---- Correction review S-C1: register only a child still running after its snapshot.
test('registerOwnChild: a child that exited (or was signalled) before the snapshot check is never registered', async () => {
  for (const child of [{ pid: 800, exitCode: 0, signalCode: null }, { pid: 800, exitCode: null, signalCode: 'SIGKILL' }, null]) {
    const inst = newInstance({ name: 'kit-test' })
    await assert.rejects(registerOwnChild(inst, child, { source: 'launch', list: [relaunchedApp()], spawnedAtMs: 2_999_000, now: () => 3_001_000 }), /exited before its identity was read/)
    assert.deepEqual(inst.roots, [])
  }
})

test('registerOwnChild: a live child inside the spawn window registers (control); outside it does not', async () => {
  const live = { pid: 800, exitCode: null, signalCode: null }
  const inst = newInstance({ name: 'kit-test' })
  assert.equal((await registerOwnChild(inst, live, { source: 'launch', list: [relaunchedApp()], spawnedAtMs: 2_999_000, now: () => 3_001_000 })).pid, 800)
  for (const [spawnedAtMs, now] of [[3_100_000, () => 3_101_000], [2_000_000, () => 2_900_000]]) {
    const fresh = newInstance({ name: 'kit-test' })
    await assert.rejects(registerOwnChild(fresh, live, { source: 'launch', list: [relaunchedApp()], spawnedAtMs, now }), /outside the spawn window/)
    assert.deepEqual(fresh.roots, [])
  }
})

test('commandHasArg matches whole arguments only', () => {
  assert.equal(commandHasArg(`electron "${BUILD_PATH}" --x`, BUILD_PATH), true)
  assert.equal(commandHasArg(`electron C:/repo/out/main/index.js`, BUILD_PATH), true)
  assert.equal(commandHasArg(`electron ${BUILD_PATH}x`, BUILD_PATH), false)
  assert.equal(commandHasArg('', BUILD_PATH), false)
  assert.equal(creationMs(US_1601(3_000_000)), 3_000_000)
})

// ---- S-B2: unknown identity is never exit, and an exited root proves nothing about its orphans.

test('safeClose: a kill that returns unknown, then a same-pid row with unreadable identity, is unresolved - not exit', async () => {
  const unreadable = { ...owned[0], creationTime: null }
  const m = machine({ snapshots: [[owned[0], owned[4]], [owned[0], owned[4]], [unreadable, owned[4]]], terminate: () => ({ state: 'unknown', detail: 'kill helper exited 1' }) })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(report.leftovers, [])
  assert.ok(report.unresolved.some(entry => entry.pid === 500 && /unreadable OS identity: exit not proven/.test(entry.reason)), JSON.stringify(report.unresolved))
})

test('safeClose: a member pid now held by a valid different identity has exited (control)', async () => {
  const m = machine({ snapshots: [[owned[0], owned[4]], [owned[0], owned[4]], [{ ...owned[0], creationTime: '999999' }, owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(report.leftovers, [])
  assert.deepEqual(report.unresolved, [])
})

test('safeClose: a root that exited before its descendants were ever observed cannot close clean', async () => {
  const m = machine({ snapshots: [[owned[4]]], observed: false })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.match(report.unresolved[0].reason, /never observed/)
})

test('safeClose: an observed exited root with a possible untracked orphan is unresolved and the orphan is untouched', async () => {
  const orphan = proc(950, 500, 1500, { name: 'node.exe', executable: EXE })
  const m = machine({ snapshots: [[orphan, owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate, [])
  assert.deepEqual(report.unresolved.map(entry => entry.pid), [950])
})

test('safeClose: an observed exited root with no possible orphans is only a note (clean control)', async () => {
  const older = proc(960, 500, 900) // lists 500 as parent but predates the root: not its child
  const m = machine({ snapshots: [[older, owned[4]]] })
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(report.unresolved, [])
  assert.match(report.notes[0].reason, /no longer running/)
})

test('registerRoot tracks the subtree its own snapshot shows, marking it observed', async () => {
  const inst = newInstance({ name: 'kit-test' })
  await registerRoot(inst, 500, { source: 'launch', list: owned })
  assert.deepEqual(inst.roots.map(entry => entry.pid).sort(), [500, 501, 502, 503])
  assert.ok(inst.roots.every(entry => entry.observedTree))
})

test('startTracking: a failed inventory is counted, never read as no descendants; stopTracking stops it', async () => {
  const inst = newInstance({ name: 'kit-test' })
  await registerRoot(inst, 500, { source: 'launch', list: [owned[0]] })
  let calls = 0
  const tick = startTracking(inst, { intervalMs: 60_000, list: async () => { calls++; if (calls === 1) throw new Error('denied'); return { list: owned } } })
  // The first (immediate) tick fails; later ones run one at a time once it has settled.
  for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); await tick() }
  assert.ok(inst.trackFailures >= 1)
  assert.deepEqual(inst.roots.map(entry => entry.pid).sort(), [500, 501, 502, 503])
  stopTracking(inst)
  assert.equal(inst.tracker, null)
})

// ---- S-B5 / S-B6 helpers

test('assertBuildHash: the build about to launch must be the granted bytes', () => {
  const good = 'a'.repeat(64)
  assert.equal(assertBuildHash('C:\\b\\index.js', good, { digest: () => good }), good)
  assert.throws(() => assertBuildHash('C:\\b\\index.js', good, { digest: () => 'b'.repeat(64) }), /not the granted/)
  assert.throws(() => assertBuildHash('C:\\b\\index.js', 'short', { digest: () => good }), /full sha256/)
  assert.throws(() => assertBuildHash('C:\\b\\index.js', good, { digest: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } }), /cannot be read: ENOENT/)
})

test('parseProcessList reports a malformed row by field names only, never its command line', () => {
  const secret = 'SYNTHETIC-KEY-0123456789abcdef0123456789abcdef'
  let message = ''
  try { parseProcessList(JSON.stringify([{ Name: 'llama-server.exe', CommandLine: `llama-server --api-key ${secret}` }])) } catch (error) { message = error.message }
  assert.match(message, /without a process id \(fields: Name:string, CommandLine:string\)/)
  assert.ok(!message.includes(secret))
})

test('trackDescendants keeps verified identities attributable after their parent exits, and nothing else', async () => {
  const m = machine({ snapshots: [[proc(501, 500, 1001), proc(503, 502, 1003), proc(900, 500, 50000), owned[4]], [proc(501, 500, 1001), proc(503, 502, 1003), owned[4]], [owned[4]]] })
  assert.deepEqual(trackDescendants(m.inst, owned).map(entry => entry.pid).sort(), [501, 502, 503])
  assert.equal(trackDescendants(m.inst, owned).length, 0, 'idempotent')
  assert.deepEqual(leavesFirst(ownedTree(owned, m.inst.roots).members).map(member => member.pid), [503, 501, 502, 500], 'tracked roots keep their depth')
  // Root and 502 exit; 900 lists the dead root's pid as its parent. Only proven identities are
  // killed, and 900 - which may be an untracked orphan - keeps the close from counting as clean.
  const report = await quietClose(m.inst, { deps: m.deps })
  assert.deepEqual(m.calls.terminate.sort(), [501, 503])
  assert.deepEqual(report.unresolved.map(entry => entry.pid), [900])
  assert.match(report.unresolved[0].reason, /possible untracked orphan of exited root 500/)
  m.inst.roots.forEach(root => assert.equal(root.generation, m.inst.generation))
})

test('registerRoot with `under` needs a verified descendant in the same snapshot', async () => {
  const inst = newInstance({ name: 'kit-test' })
  assert.equal((await registerRoot(inst, 501, { source: 'electron main', list: owned, under: [root] })).pid, 501)
  await assert.rejects(registerRoot(inst, 700, { source: 'electron main', list: owned, under: [root] }), /not a verified descendant/)
  await assert.rejects(registerRoot(inst, 999, { source: 'x', list: owned }), /not running/)
})

// Read-only on this machine: the inventory's identity for a child of this test equals what the
// kill helper reads through its own handle (same precision), and a wrong image is refused unkilled.
test('listProcesses and terminateIdentity agree on a live identity and refuse a mismatch', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  try {
    const { list } = await listProcesses()
    const identity = identityOf(list.find(entry => entry.pid === child.pid))
    assert.ok(identity, 'no identity for our own child')
    assert.equal(identity.executable.toLowerCase(), process.execPath.toLowerCase())
    const refused = await terminateIdentity({ ...identity, executable: 'C:\\Windows\\notepad.exe' }, { budgetMs: 15_000 })
    assert.equal(refused.state, 'mismatch')
    assert.equal(refused.creationTime, identity.creationTime, 'inventory and handle disagree on creation time precision')
    assert.equal(child.exitCode, null)
  } finally { child.kill() }
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
  const quiet = { inventory: { ok: true }, lock: { held: true, self: true, holder: { pid: 300 } }, cpuPercent: 12, gpuPercent: 3, llama: [{ pid: 9, port: 8081, busy: false }], midTurn: { count: 1 } }
  assert.deepEqual(judgeLoad(quiet, thresholds), { quiet: true, reasons: [] })
  const loaded = { inventory: { ok: true }, lock: { held: true, self: false, holder: { pid: 77, command: 'node smoke-other.mjs' } }, cpuPercent: 30, gpuPercent: 64, llama: [{ pid: 9, port: 8081, busy: true }, { pid: 10, port: 8082, busy: null }], midTurn: { count: 3 } }
  const { quiet: isQuiet, reasons } = judgeLoad(loaded, thresholds)
  assert.equal(isQuiet, false)
  assert.equal(reasons.length, 6)
  assert.match(reasons.join('\n'), /pid 77[\s\S]*CPU 30% >= 30%[\s\S]*GPU 64% >= 40%[\s\S]*port 8081 is generating[\s\S]*pid 10 state unknown[\s\S]*2 mid-turn tab/)
  assert.equal(judgeLoad({ ...quiet, midTurn: { count: 0 } }, thresholds, { selfTabs: 0 }).quiet, true)
  assert.equal(judgeLoad({ ...quiet, midTurn: { count: 1 } }, thresholds, { selfTabs: 0 }).quiet, false)
  assert.deepEqual(judgeLoad({ ...quiet, cpuPercent: null, gpuPercent: null, midTurn: { count: null, note: 'refused' } }, thresholds).reasons, ['CPU load unknown', 'GPU load unknown', 'mid-turn tabs unknown (refused)'])
})

test('judgeLoad: a missing or failed process inventory and an unreadable lock are never quiet', () => {
  const thresholds = { machineCpuPercent: 30, gpuPercent: 40 }
  const quiet = { inventory: { ok: true }, lock: { held: false }, cpuPercent: 5, gpuPercent: 1, llama: [], midTurn: { count: 1 } }
  assert.equal(judgeLoad(quiet, thresholds).quiet, true)
  assert.deepEqual(judgeLoad({ ...quiet, inventory: { ok: false, error: 'process query took over 30 s' } }, thresholds).reasons, ['process inventory unavailable (process query took over 30 s)'])
  assert.deepEqual(judgeLoad({ ...quiet, inventory: undefined }, thresholds).reasons, ['process inventory unavailable'])
  assert.deepEqual(judgeLoad({ ...quiet, lock: { held: false, unknown: true } }, thresholds).reasons, ['smoke lock state unknown (holder file unreadable)'])
})

const TOKEN = 't'.repeat(64)
const ENDPOINT = 'http://127.0.0.1:55908/control'

test('suppliedControl takes only the caller\'s own loopback endpoint and token from its environment', () => {
  assert.deepEqual(suppliedControl({ CONDUCTOR_CONTROL_ENDPOINT: ENDPOINT, CONDUCTOR_CONTROL_TOKEN: TOKEN }), { endpoint: ENDPOINT, token: TOKEN })
  assert.deepEqual(suppliedControl({ CONDUCTOR_CONTROL_ENDPOINT: ENDPOINT, CONDUCTOR_CONTROL_TOKEN: TOKEN, CONDUCTOR_CONTROL_PROJECT_ID: 'p1', CONDUCTOR_CONTROL_WORKSPACE_ID: 'w1' }), { endpoint: ENDPOINT, token: TOKEN, projectId: 'p1', workspaceId: 'w1' })
  for (const env of [{}, { CONDUCTOR_CONTROL_ENDPOINT: ENDPOINT }, { CONDUCTOR_CONTROL_TOKEN: TOKEN }, { CONDUCTOR_CONTROL_ENDPOINT: 'http://example.com:55908/control', CONDUCTOR_CONTROL_TOKEN: TOKEN },
    { CONDUCTOR_CONTROL_ENDPOINT: 'https://127.0.0.1:1/x', CONDUCTOR_CONTROL_TOKEN: TOKEN }, { CONDUCTOR_CONTROL_ENDPOINT: ENDPOINT, CONDUCTOR_CONTROL_TOKEN: 'short' },
    { CONDUCTOR_CONTROL_ENDPOINT: ENDPOINT, CONDUCTOR_CONTROL_TOKEN: TOKEN, CONDUCTOR_CONTROL_WORKSPACE_ID: 'w1' }, { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }])
    assert.equal(suppliedControl(env), null, JSON.stringify(env))
})

/** A scripted control endpoint: `routes[method]` answers ({status, body}) given the request scope. */
function controlServer(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body)
    calls.push({ url, method: request.method, args: request.args, scope: request.scope ?? null, auth: init.headers.Authorization })
    const answer = routes[request.method]?.(request.scope) ?? { status: 404, body: { error: 'unknown' } }
    return { status: answer.status ?? 200, json: async () => { if (answer.raw) throw new Error('bad json'); return answer.body } }
  }
  return { calls, fetchImpl }
}
const ok = result => ({ status: 200, body: { result } })

// What a conversation credential's agents.list answers: its own workspace, plus the tabs it may reach
// elsewhere, all marked crossProject (a same-project tab in another workspace included).
const listing = [
  { agentSessionId: 'agent_me', title: 'Caller', phase: 'running', projectId: 'p1', workspaceId: 'w1' },
  { agentSessionId: 'agent_a', title: 'Worker A', phase: 'running', projectId: 'p1', workspaceId: 'w1' },
  { agentSessionId: 'agent_idle', title: 'Idle', phase: 'idle', projectId: 'p1', workspaceId: 'w1' },
  { agentSessionId: 'agent_ask', title: 'Asking', phase: 'waiting_approval', projectId: 'p1', workspaceId: 'w1' },
  { agentSessionId: 'agent_b', title: 'Worker B', phase: 'starting', projectId: 'p1', workspaceId: 'w2', crossProject: true, controlled: true },
  { agentSessionId: 'agent_haft', title: 'Haftheme wizard', phase: 'running', projectId: 'p2', workspaceId: 'w3', crossProject: true, controlled: false }
]

test('midTurnTabs makes one agents.list call and splits this project, approval waits and other projects', async () => {
  const server = controlServer({ 'agents.list': () => ok(listing) })
  const result = await midTurnTabs({ control: { endpoint: ENDPOINT, token: TOKEN }, fetchImpl: server.fetchImpl })
  assert.deepEqual(server.calls.map(call => [call.method, call.args]), [['agents.list', { load: true }]])
  assert.ok(server.calls.every(call => call.url === ENDPOINT && call.auth === `Bearer ${TOKEN}`))
  assert.equal(result.projectId, 'p1')
  assert.equal(result.count, 3)
  assert.deepEqual(result.tabs.map(tab => tab.agentSessionId), ['agent_me', 'agent_a', 'agent_b'])
  assert.deepEqual(result.waiting.map(tab => tab.agentSessionId), ['agent_ask'])
  assert.deepEqual(result.elsewhere.map(tab => [tab.agentSessionId, tab.projectId]), [['agent_haft', 'p2']])
  const scoped = controlServer({ 'agents.list': () => ok(listing) })
  assert.equal((await midTurnTabs({ control: { endpoint: ENDPOINT, token: TOKEN, projectId: 'p2', workspaceId: 'w3' }, fetchImpl: scoped.fetchImpl })).count, 1)
  assert.deepEqual(scoped.calls[0].scope, { projectId: 'p2', workspaceId: 'w3' })
})

test('midTurnTabs reads the load list: this project\'s other workspaces count, other projects stay INFO', async () => {
  // agents.list({load:true}): every tab of every co-open project, crossProject only for another project.
  const load = [
    { tabId: 't1', agentSessionId: 'agent_me', title: 'Caller', provider: 'claude', phase: 'running', projectId: 'p1', workspaceId: 'w1', crossProject: false, backgroundTasks: 0 },
    { tabId: 't2', agentSessionId: 'agent_other_ws', title: 'Other workspace', provider: 'codex', phase: 'running', projectId: 'p1', workspaceId: 'w2', crossProject: false, backgroundTasks: 0 },
    { tabId: 't3', agentSessionId: 'agent_coworker_elsewhere', title: 'Haftheme coworker', provider: 'claude', phase: 'running', projectId: 'p2', workspaceId: 'w3', crossProject: true, backgroundTasks: 0 }
  ]
  const server = controlServer({ 'agents.list': () => ok(load) })
  const result = await midTurnTabs({ control: { endpoint: ENDPOINT, token: TOKEN }, fetchImpl: server.fetchImpl })
  assert.equal(server.calls.length, 1)
  assert.equal(result.projectId, 'p1')
  assert.deepEqual(result.tabs.map(tab => [tab.agentSessionId, tab.workspaceId]), [['agent_me', 'w1'], ['agent_other_ws', 'w2']])
  assert.deepEqual(result.elsewhere.map(tab => tab.agentSessionId), ['agent_coworker_elsewhere'])
  const verdict = judgeLoad({ inventory: { ok: true }, lock: { held: false }, cpuPercent: 5, gpuPercent: 1, llama: [], midTurn: result }, { machineCpuPercent: 30, gpuPercent: 40 }, { callerId: 'agent_me' })
  assert.equal(verdict.quiet, false)
  assert.match(verdict.reasons.join(' '), /"Other workspace" \(agent_other_ws, running, project p1\)/)
  assert.doesNotMatch(verdict.reasons.join(' '), /agent_coworker_elsewhere/)
})

test('judgeLoad counts only this project\'s working tabs and names the blocking ones with the way out', async () => {
  const thresholds = { machineCpuPercent: 30, gpuPercent: 40 }
  const machine = { inventory: { ok: true }, lock: { held: false }, cpuPercent: 5, gpuPercent: 1, llama: [] }
  const judge = async (entries, options) => judgeLoad({ ...machine, midTurn: await midTurnTabs({ control: { endpoint: ENDPOINT, token: TOKEN }, fetchImpl: controlServer({ 'agents.list': () => ok(entries) }).fetchImpl }) }, thresholds, options)
  const [me, a, idle, ask, b, haft] = listing
  // Another project's running wizard and a tab waiting on the owner are not load.
  assert.deepEqual(await judge([me, idle, ask, haft]), { quiet: true, reasons: [] })
  assert.equal((await judge([me, haft], { otherProjects: 'count' })).quiet, false)
  // A same-project running tab blocks and is named with its id, phase, project and the overrides.
  const blocked = await judge([me, a, b])
  assert.equal(blocked.quiet, false)
  assert.equal(blocked.reasons.length, 1)
  assert.match(blocked.reasons[0], /^2 mid-turn tab\(s\) besides the caller: "Caller" \(agent_me, running, project p1\), "Worker A" \(agent_a, running, project p1\), "Worker B" \(agent_b, starting, project p1\) \(the caller is one of these; leave it out\)\./)
  assert.match(blocked.reasons[0], /loadCheck\(\{selfTabs:\['agent_me','agent_a','agent_b'\]\}\) or set CONDUCTOR_LOAD_IGNORE_TABS=agent_me,agent_a,agent_b\.$/)
  // A known caller is left out of the names; listed own tabs and the ignore list remove the rest.
  const known = await judge([me, a, b], { callerId: 'agent_me' })
  assert.match(known.reasons[0], /^2 mid-turn tab\(s\) besides the caller: "Worker A" [^;]*"Worker B" \(agent_b, starting, project p1\)\. Wait/)
  assert.equal((await judge([me, a, b], { selfTabs: ['agent_a', 'agent_b'] })).quiet, true)
  assert.equal((await judge([me, a, b], { selfTabs: ['agent_a'] })).quiet, false)
  assert.equal((await judge([me, a, b], { ignoreTabs: ignoredTabs({ CONDUCTOR_LOAD_IGNORE_TABS: 'agent_a, agent_b' }) })).quiet, true)
  assert.equal((await judge([me, a, b], { callerId: 'agent_me', selfTabs: ['agent_a', 'agent_b'] })).quiet, true)
  assert.equal((await judge([me, a], { callerId: 'agent_me', selfTabs: 2 })).quiet, true)
  assert.deepEqual(ignoredTabs({}), [])
})

test('loadInfo lists approval waits and other projects\' turns without counting them', async () => {
  const midTurn = await midTurnTabs({ control: { endpoint: ENDPOINT, token: TOKEN }, fetchImpl: controlServer({ 'agents.list': () => ok(listing) }).fetchImpl })
  const info = loadInfo(midTurn)
  assert.equal(info.length, 2)
  assert.match(info[0], /waiting on an approval \(not load\): "Asking" \(agent_ask, waiting_approval, project p1\)/)
  assert.match(info[1], /other projects \(not load; .*"Haftheme wizard" \(agent_haft, running, project p2\)/)
  assert.equal(loadInfo(midTurn, { otherProjects: 'count' }).length, 1)
  assert.deepEqual(loadInfo({ count: 0, tabs: [] }), [])
})

test('midTurnTabs is unknown, never zero, without a credential or with any incomplete listing', async () => {
  const none = await midTurnTabs({ control: null, fetchImpl: async () => { throw new Error('must not be called') } })
  assert.equal(none.count, null)
  assert.match(none.note, /owner credential is never used/)
  const control = { endpoint: ENDPOINT, token: TOKEN }
  for (const [name, routes] of [
    ['agents.list refused', { 'agents.list': () => ({ status: 403, body: { error: `denied for ${TOKEN}` } }) }],
    ['agents.list error body', { 'agents.list': () => ({ status: 200, body: { error: 'nope' } }) }],
    ['agents.list not a list', { 'agents.list': () => ok({ agents: [] }) }],
    ['agent without phase', { 'agents.list': () => ok([{ agentSessionId: 'a1' }]) }],
    ['unreadable body', { 'agents.list': () => ({ status: 200, raw: true }) }]
  ]) {
    const result = await midTurnTabs({ control, fetchImpl: controlServer(routes).fetchImpl })
    assert.equal(result.count, null, name)
    assert.ok(!String(result.note).includes(TOKEN), `${name}: note leaks the token`)
  }
})

test('verify-kit never reads the installed owner credential for load admission', () => {
  const source = readFileSync(join(REPO, 'scripts', 'verify-kit.mjs'), 'utf8')
  assert.doesNotMatch(source, /APPDATA/)
  assert.doesNotMatch(source, /'Conductor', 'control-owner\.json'/)
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
