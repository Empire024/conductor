import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The Production agent's fixture suite (docs/production-agent.md section 11, M8): every fixture
// site audited for real through createProductionService, with the real checks, the real audit
// browser and the loopback fakes (src/main/production/fixture-suite.test.ts). Prints one row per
// fixture site with the expected and the actual control status, the source-coverage check (the 26
// source items each map to a control), and exits non-zero on any mismatch or when vitest fails.
//
//   node scripts/production-fixture-suite.mjs
//   PRODUCTION_FIXTURE_SUITE_OUT=<path> keeps the JSON table (default: a temp file, removed after).
// It runs headless on loopback only and opens no window; it takes a few minutes.

const root = resolve(import.meta.dirname, '..')
const keepOut = process.env.PRODUCTION_FIXTURE_SUITE_OUT?.trim()
const scratch = keepOut ? null : mkdtempSync(join(tmpdir(), 'production-fixture-suite-'))
const out = keepOut ? resolve(keepOut) : join(scratch, 'table.json')
const started = Date.now()

// ---- source coverage: SOURCE_COVERAGE in the shared contract, read as text (no TS import) -----
const contract = readFileSync(join(root, 'src', 'shared', 'production.ts'), 'utf8')
const coverageBlock = /export const SOURCE_COVERAGE[^=]*=\s*\{([\s\S]*?)\n\}/.exec(contract)?.[1] ?? ''
const coverage = [...coverageBlock.matchAll(/'(V\d-\d{2})':\s*'(C\d{2})'/g)].map(match => ({ item: match[1], control: match[2] }))
const sourceItems = [...new Set([...(/export const SOURCE_ITEM_IDS\s*=\s*\[([\s\S]*?)\]/.exec(contract)?.[1] ?? '').matchAll(/'(V\d-\d{2})'/g)].map(match => match[1]))]
const controlIds = [...new Set([...(/export const CONTROL_IDS\s*=\s*\[([\s\S]*?)\]/.exec(contract)?.[1] ?? '').matchAll(/'(C\d{2})'/g)].map(match => match[1]))]

// ---- the vitest run -------------------------------------------------------------------------------
const vitest = await new Promise(done => {
  const child = spawn(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/main/production/fixture-suite.test.ts', '--reporter=verbose'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PRODUCTION_FIXTURE_SUITE: '1', PRODUCTION_FIXTURE_SUITE_OUT: out },
  })
  let tail = ''
  const keep = chunk => { tail = (tail + chunk.toString('utf8')).slice(-40_000) }
  child.stdout.on('data', chunk => { keep(chunk); process.stderr.write(chunk) })
  child.stderr.on('data', chunk => { keep(chunk); process.stderr.write(chunk) })
  child.on('error', error => done({ code: null, tail: `${tail}\n${error.message}` }))
  child.on('close', code => done({ code, tail }))
})

// ---- the table ------------------------------------------------------------------------------------
const table = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
const rows = table?.rows ?? []
const pad = (text, width) => String(text).padEnd(width)
const widths = {
  site: Math.max(4, ...rows.map(row => row.site.length)),
  controls: Math.max(8, ...rows.map(row => row.controls.join(',').length)),
  expected: Math.max(8, ...rows.map(row => row.expected.length)),
  actual: Math.max(6, ...rows.map(row => row.actual.length)),
}
const line = (site, controls, expected, actual, verdict, seconds) => `${pad(site, widths.site)}  ${pad(controls, widths.controls)}  ${pad(expected, widths.expected)}  ${pad(actual, widths.actual)}  ${pad(verdict, 8)}  ${seconds}`
console.log('')
console.log(`Production fixture suite${table ? ` (audit browser: ${table.engine ?? 'unknown'})` : ''}`)
console.log('')
console.log(line('site', 'controls', 'expected', 'actual', 'result', 'time'))
console.log(line('-'.repeat(widths.site), '-'.repeat(widths.controls), '-'.repeat(widths.expected), '-'.repeat(widths.actual), '--------', '----'))
for (const row of rows) console.log(line(row.site, row.controls.join(','), row.expected, row.actual, row.ok ? 'OK' : 'MISMATCH', `${(row.durationMs / 1000).toFixed(1)} s`))
const mismatches = rows.filter(row => !row.ok)
if (mismatches.length) {
  console.log('')
  for (const row of mismatches) {
    console.log(`MISMATCH ${row.site} (${row.role}):`)
    for (const problem of row.problems) console.log(`  - ${problem.split('\n')[0]}`)
  }
}

console.log('')
const byRole = rows.reduce((into, row) => ({ ...into, [row.role]: (into[row.role] ?? 0) + 1 }), {})
const auditedControls = [...new Set(rows.flatMap(row => row.controls))].sort()
console.log(`Rows: ${rows.length}, OK: ${rows.length - mismatches.length}, mismatches: ${mismatches.length} (${Object.entries(byRole).map(([role, count]) => `${count} ${role}`).join(', ')}).`)
console.log(`Controls audited: ${auditedControls.join(' ')}${controlIds.length ? ` (${auditedControls.length} of ${controlIds.length})` : ''}.`)

// ---- source coverage --------------------------------------------------------------------------------
const unmapped = sourceItems.filter(item => !coverage.some(entry => entry.item === item))
const unknownControl = coverage.filter(entry => controlIds.length && !controlIds.includes(entry.control))
const unaudited = [...new Set(coverage.map(entry => entry.control))].filter(control => !auditedControls.includes(control))
const coverageOk = coverage.length === 26 && (!sourceItems.length || sourceItems.length === 26) && !unmapped.length && !unknownControl.length
console.log(`Source coverage: ${coverage.length} source items map to ${new Set(coverage.map(entry => entry.control)).size} controls${coverageOk ? ' (all 26 items map to a control)' : ''}; every mapped control ${unaudited.length ? `except ${unaudited.join(', ')} ` : ''}has a fixture row. registry.test.ts asserts the same mapping against the registry.`)
if (!coverageOk) console.log(`SOURCE COVERAGE PROBLEM: ${coverage.length} mapped, unmapped ${unmapped.join(', ') || 'none'}, unknown control ${unknownControl.map(entry => `${entry.item}->${entry.control}`).join(', ') || 'none'}`)

const seconds = ((Date.now() - started) / 1000).toFixed(0)
const vitestFailed = vitest.code !== 0
if (!table) console.log(`No table was written (${out}); vitest exited ${vitest.code}. Is an audit browser installed (Edge, Chrome or Playwright Chromium)?`)
else if (vitestFailed && !mismatches.length) console.log(`vitest exited ${vitest.code} although every row matched; see its output above.`)
console.log(`Duration: ${seconds} s.`)
if (scratch) rmSync(scratch, { recursive: true, force: true })

const failed = !table || !rows.length || mismatches.length > 0 || vitestFailed || !coverageOk || unaudited.length > 0
console.log(failed ? 'FIXTURE SUITE FAILED' : 'FIXTURE SUITE PASSED')
process.exit(failed ? 1 : 0)
