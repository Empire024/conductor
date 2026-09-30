// Replay recent real change sets against one fixed snapshot. This is verification timing,
// not historical checkout timing or commit/preflight/network timing.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fullTestReason, relatedTestFiles } from '../src/main/delivery-test-policy.ts'

const commits = process.argv.slice(2)
if (!commits.length) throw new Error('Pass recent commit shas to replay')
const output = resolve('.conductor-scratch/policy-measurements')
mkdirSync(output, { recursive: true })
const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...(process.env.PATH ?? '').split(delimiter).map(path => join(path, 'node_modules/npm/bin/npm-cli.js'))].find(path => path && existsSync(path))
if (!npm) throw new Error('Host npm CLI not found')
const results = []
async function command(name, args) {
  const start = performance.now(), chunks = []
  const child = spawn(process.execPath, args, { env: { ...process.env, CI: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => chunks.push(data)); child.stderr.on('data', data => chunks.push(data))
  const code = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', done) })
  const text = Buffer.concat(chunks).toString()
  writeFileSync(join(output, name + '.log'), text)
  return { code, seconds: (performance.now() - start) / 1000, text }
}
for (const commit of commits) {
  const paths = execFileSync('git', ['show', '--format=', '--name-only', commit], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(Boolean)
  const reason = fullTestReason(paths, false)
  if (reason) throw new Error(`${commit} requires full verification: ${reason}; choose a narrow recent commit for the replay`)
  const start = performance.now()
  let files = [], graphSeconds = 0
  const tests = async () => {
    const graph = await command(commit + '-graph', ['scripts/delivery-related-tests.mjs', ...paths])
    graphSeconds = graph.seconds
    if (graph.code !== 0) throw new Error(`${commit}: graph failed`)
    files = relatedTestFiles(graph.text, paths)
    const vitest = files.length ? await command(commit + '-tests', ['node_modules/vitest/vitest.mjs', 'run', ...files]) : { code: 0, seconds: 0 }
    if (vitest.code !== 0) throw new Error(`${commit}: related tests failed (see logs)`)
    const scripts = paths.some(path => path.startsWith('scripts/')) ? await command(commit + '-scripts', [npm, 'run', 'test:scripts']) : { code: 0, seconds: 0 }
    if (scripts.code !== 0) throw new Error(`${commit}: script tests failed`)
    return graphSeconds + vitest.seconds + scripts.seconds
  }
  const [testSeconds, typecheck, build] = await Promise.all([
    tests(),
    command(commit + '-typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', `.conductor-scratch/policy-measurements/${commit}.tsbuildinfo`]),
    command(commit + '-build', ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
  ])
  if (typecheck.code !== 0 || build.code !== 0) throw new Error(`${commit}: typecheck/build failed`)
  const row = { commit, paths, files, graphSeconds, testSeconds, typecheckSeconds: typecheck.seconds, buildSeconds: build.seconds, verificationWallSeconds: (performance.now() - start) / 1000 }
  results.push(row)
  writeFileSync(join(output, 'results.json'), JSON.stringify({ observedAt: new Date().toISOString(), snapshotHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), note: 'Recent commit change sets replayed on this fixed isolated snapshot, not historical revisions. tsc/build/tests overlap as in git.ship; baseline comes from the real full git.ship run reported separately.', results }, null, 2))
  console.log(JSON.stringify({ commit, files: files.length, testSeconds, verificationWallSeconds: row.verificationWallSeconds }))
}
