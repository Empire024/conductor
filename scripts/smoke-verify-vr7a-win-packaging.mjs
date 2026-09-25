// VR7a S3 (macos-node-green, FX30 mac-packaging): Windows packaging and the Windows release job are
// unchanged by the Mac work. `electron-builder --win dir --x64` from the same out/ with the pre-FX30
// build config (--base, default HEAD~2) and HEAD's, compared file for file; a third build with
// extraMetadata.version changed is the control that must differ. Then release.yml: the Windows job
// equal to the base apart from the new `outputs:`, the Mac job gated on the `mac` input (default
// false), and the delivery's workflow dispatch sending no inputs.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr7a-win-packaging.mjs [--base <commit>]
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO, configure, finish, record, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr7a-win-packaging', output: 'artifacts/verification/2026-09-25-vr7a' })
watchdog(15 * 60)
const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'HEAD~2'
const scratch = join(REPO, '.conductor-scratch', 'vr7a', 'win')
mkdirSync(scratch, { recursive: true })
const show = path => execFileSync('git', ['show', path], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
const builder = join(REPO, 'node_modules', 'electron-builder', 'cli.js')

function build(name, config, extra = []) {
  step(`electron-builder --win dir (${name})`)
  const file = join(scratch, `${name}-build.json`), output = join(scratch, name)
  writeFileSync(file, JSON.stringify(config, null, 2))
  rmSync(output, { recursive: true, force: true })
  const started = Date.now()
  const result = spawnSync(process.execPath, [builder, '--win', 'dir', '--x64', '--publish', 'never', '--config', file, `-c.directories.output=${output}`, ...extra], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
  writeFileSync(join(scratch, `${name}.log`), `${result.stdout}\n${result.stderr}`)
  if (result.status !== 0) throw new Error(`${name} build exited ${result.status}; log ${join(scratch, `${name}.log`)}`)
  console.log(`${name}: ${Math.round((Date.now() - started) / 1000)} s`)
  return join(output, 'win-unpacked')
}
function hashes(dir) {
  const out = new Map()
  const walk = d => { for (const entry of readdirSync(d)) { const p = join(d, entry); if (statSync(p).isDirectory()) walk(p); else out.set(relative(dir, p), createHash('sha256').update(readFileSync(p)).digest('hex')) } }
  walk(dir)
  return out
}
const differing = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(key => a.get(key) !== b.get(key))

try {
  const baseCommit = execFileSync('git', ['rev-parse', '--short', base], { cwd: REPO, encoding: 'utf8' }).trim()
  const baseBuild = JSON.parse(show(`${base}:package.json`)).build
  const headBuild = JSON.parse(show('HEAD:package.json')).build
  const baseDir = build('base', baseBuild)
  const headDir = build('head', headBuild)
  const controlDir = build('control', headBuild, ['-c.extraMetadata.version=9.9.9'])
  const a = hashes(baseDir), b = hashes(headDir), c = hashes(controlDir)
  const diff = differing(a, b), controlDiff = differing(b, c)
  record('S3a-win-dir-file-for-file', diff.length === 0 && a.size > 0 ? 'PASS' : 'FAIL', { base: baseCommit, baseFiles: a.size, headFiles: b.size, differing: diff.length }, diff.length ? diff.slice(0, 20).join(', ') : `${scratch}`)
  record('S3a-control-version-change-detected', controlDiff.length > 0 ? 'PASS' : 'FAIL', { differing: controlDiff.length }, controlDiff.slice(0, 5).join(', '))

  step('release.yml')
  const job = (text, name) => { const start = text.indexOf(`\n  ${name}:`); if (start < 0) return null; const rest = text.slice(start + 1); const next = rest.slice(1).search(/\n  [\w-]+:\n/); return (next < 0 ? rest : rest.slice(0, next + 1)).replace(/(\n(\s*|  #.*))+$/, '') } // without the next job's leading comments
  const baseYml = show(`${base}:.github/workflows/release.yml`).replace(/\r\n/g, '\n'), headYml = show('HEAD:.github/workflows/release.yml').replace(/\r\n/g, '\n')
  const baseWin = job(baseYml, 'windows-release'), headWin = job(headYml, 'windows-release')
  const headWinWithoutOutputs = headWin?.replace(/\n    outputs:\n      version: \$\{\{ steps\.version\.outputs\.version \}\}/, '')
  const macJob = job(headYml, 'macos-release') ?? ''
  const gated = /\n    if: \$\{\{ inputs\.mac \}\}\n/.test(macJob) && /\n    needs: windows-release\n/.test(macJob)
  const input = /\n      mac:\n[\s\S]*?type: boolean\n\s*default: false\n/.test(headYml)
  const triggers = yml => yml.slice(yml.indexOf('\non:'), yml.indexOf('\nconcurrency:'))
  const noPush = !/\n\s+push:/.test(triggers(headYml))
  const jobNames = [...headYml.matchAll(/\n  ([\w-]+):\n    (?:runs-on|needs|if|outputs)/g)].map(m => m[1])
  record('S3b-release-windows-job-unchanged', baseWin && headWinWithoutOutputs === baseWin ? 'PASS' : 'FAIL', { baseLines: baseWin?.split('\n').length, headLines: headWin?.split('\n').length }, 'windows-release job equal to the base once the added outputs: block is removed')
  record('S3b-release-mac-job-gated', gated && input && noPush && jobNames.join(',') === 'windows-release,macos-release' ? 'PASS' : 'FAIL', { gated, inputDefaultFalse: input, noPushTrigger: noPush, jobs: jobNames.join(',') })

  step('delivery dispatch body')
  const delivery = readFileSync(join(REPO, 'src', 'main', 'delivery.ts'), 'utf8')
  const bodies = [...delivery.matchAll(/\/dispatches`[\s\S]{0,400}?body: (JSON\.stringify\([^)]*\))/g)].map(m => m[1])
  const clean = bodies.length === 1 && bodies[0] === 'JSON.stringify({ ref: plan.config.branch })'
  record('S3c-publish-dispatch-sends-no-mac-input', clean ? 'PASS' : 'FAIL', { dispatchCalls: bodies.length }, bodies.join(' | '))
} catch (error) {
  record('S3-error', 'FAIL', {}, String(error?.stack ?? error).slice(0, 1500))
}
await finish()
