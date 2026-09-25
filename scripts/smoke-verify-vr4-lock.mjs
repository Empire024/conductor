// VR4 Q1 (docs/verification/2026-09-25-vr4.md), smoke-lock-fifo. The owner's case: VR2 waited 11+ min
// behind three VR3 smokes chained back to back. The real smoke-lock CLI with real processes, on an
// isolated lock (TEMP/TMP point at a temp folder, so os.tmpdir() and the lock and queue move there and
// the machine's real lock is never touched):
//   A chains three runs back to back; B arrives while A1 holds; D arrives and is killed while waiting;
//   C arrives after D. Expected order A1 B C A2 A3 - never A twice while someone waits - and the dead
//   D never stalls the line.
//   node scripts/smoke-verify-vr4-lock.mjs [--lock <smoke-lock.mjs>] [--runs 2]
// --lock runs the same scenario on another copy (the control: e4d4db1^ must fail). No app, no lock needed.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configure, failed, finish, record, sleep, step, watchdog } from './verify-kit.mjs'

const argv = process.argv.slice(2)
const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const lockScript = resolve(option('--lock') ?? 'scripts/smoke-lock.mjs')
const label = option('--label') ?? 'Q1'
configure({ name: `vr4-lock ${label}`, output: process.env.VR4_OUT ?? 'C:/Claude/conductor/artifacts/verification/2026-09-25-vr4' })
watchdog(5 * 60)

async function once(run) {
  const temp = mkdtempSync(join(tmpdir(), 'vr4-lock-'))
  const order = join(temp, 'order.log'), logs = join(temp, 'waiters.log')
  writeFileSync(order, '')
  const env = { ...process.env, TEMP: temp, TMP: temp }
  const hold = (name, ms) => ['node', '-e', `const f=require('fs');f.appendFileSync(${JSON.stringify(order)},'start ${name} '+Date.now()+'\\n');setTimeout(()=>f.appendFileSync(${JSON.stringify(order)},'end ${name} '+Date.now()+'\\n'),${ms})`]
  const children = []
  const lock = (name, ms) => {
    const child = spawn(process.execPath, [lockScript, '--timeout-min', '1', '--', ...hold(name, ms)], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    children.push(child)
    child.stderr.on('data', chunk => appendFileSync(logs, `${name}: ${chunk}`))
    return { child, done: new Promise(done => child.on('close', code => done(code))) }
  }
  const a = (async () => { await lock('A1', 6000).done; await lock('A2', 2000).done; await lock('A3', 2000).done })()
  await sleep(700); const b = lock('B', 3000)
  await sleep(700); const d = lock('D', 3000)
  await sleep(700); const c = lock('C', 3000)
  await sleep(1200)
  spawnSync('taskkill', ['/PID', String(d.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  const all = await Promise.race([Promise.all([a, b.done, c.done]).then(() => 'ok'), sleep(150_000).then(() => 'timeout')])
  if (all !== 'ok') for (const child of children) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  const lines = readFileSync(order, 'utf8').trim().split('\n').filter(Boolean).map(line => { const [kind, name, at] = line.split(' '); return { kind, name, at: Number(at) } })
  const starts = lines.filter(line => line.kind === 'start').map(line => line.name)
  const gaps = []
  for (const line of lines.filter(entry => entry.kind === 'end')) { const next = lines.find(entry => entry.kind === 'start' && entry.at >= line.at); if (next) gaps.push(next.at - line.at) }
  const waiterText = (() => { try { return readFileSync(logs, 'utf8') } catch { return '' } })()
  const positions = (waiterText.match(/position \d+ of \d+/g) ?? []).length
  const expected = ['A1', 'B', 'C', 'A2', 'A3']
  const pass = all === 'ok' && JSON.stringify(starts) === JSON.stringify(expected) && Math.max(...gaps) < 10_000 && positions > 0
  record(`${label} run ${run}`, pass ? 'PASS' : 'FAIL', { order: starts.join(' '), maxGapMs: Math.max(...gaps), gaps, positionLines: positions, lock: lockScript.replace(/\\/g, '/') }, `expected ${expected.join(' ')}; D killed while waiting; ${temp.replace(/\\/g, '/')}`)
}

try {
  for (let run = 1; run <= Number(option('--runs') ?? 2); run++) { step(`${label} run ${run}`); await once(run) }
} catch (error) { await failed(error, label) }
await finish()
