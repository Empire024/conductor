// VR7 P1/P2 (publish-includes-mac, FX31 eeaba87): a publish dispatches release.yml with mac true unless
// mac:false, and verifies the dmg, zip, blockmap and latest-mac.yml beside the Windows files; a failed Mac
// job is reported as such and the Windows release stands. Owner decision: never publish, so this is a dry
// run of the REAL DeliveryService (src/main/delivery.ts): real git in a temp repository whose network git
// calls (fetch, push, pull) go to a local bare repository, the REAL .github/workflows/release.yml, the
// asset names electron-builder and the workflow's upload step really produce, and a stubbed GitHub API.
// Any request that is not to the stubbed api.github.com routes fails the run: nothing leaves the machine.
//   npx vite-node scripts/smoke-verify-vr7-publish.mts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeliveryService } from '../src/main/delivery'
import { configure, failed, finish, record, REPO, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr7-publish', output: process.env.VR7_OUT ?? 'artifacts/verification/2026-09-26-vr7' })
watchdog(300)

const workflowText = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
const builder = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).build
// Job ids as GitHub names them (release.yml gives no `name:`), read from the real workflow.
const jobIds = [...workflowText.replace(/\r\n/g, '\n').split(/\njobs:\n/)[1].matchAll(/^ {2}([\w-]+):\s*$/gm)].map(match => match[1])
const windowsJob = jobIds.find(id => /windows/.test(id))!, macJob = jobIds.find(id => /mac/.test(id))!
const version = '9.9.9'
const expand = (pattern: string, ext: string) => pattern.replace('${version}', version).replace('${arch}', 'arm64').replace('${ext}', ext)
// What the Windows job and the Mac job's `gh release upload` lines put on the release.
const windowsAssets = [expand(builder.nsis?.artifactName ?? builder.win?.artifactName, 'exe'), `${expand(builder.nsis?.artifactName ?? builder.win?.artifactName, 'exe')}.blockmap`, 'latest.yml']
const macUploads = [...workflowText.slice(workflowText.indexOf(`
  ${macJob}:`)).matchAll(/"release\/([^"]+)"/g)].map(match => match[1].replace('$version', version))

const root = mkdtempSync(join(tmpdir(), 'conductor-vr7-publish-'))
const bare = join(root, 'remote.git'), work = join(root, 'app')
const git = (cwd: string, ...args: string[]) => { const run = spawnSync('git', ['-c', 'user.email=vr7@example.invalid', '-c', 'user.name=VR7', ...args], { cwd, encoding: 'utf8' }); if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`); return run.stdout.trim() }
mkdirSync(work, { recursive: true })
git(root, 'init', '-q', '--bare', bare)
git(work, 'init', '-q', '-b', 'main')
mkdirSync(join(work, '.github', 'workflows'), { recursive: true })
mkdirSync(join(work, '.conductor'), { recursive: true })
writeFileSync(join(work, '.github', 'workflows', 'release.yml'), workflowText)
writeFileSync(join(work, '.conductor', 'delivery.json'), JSON.stringify({ test: ['node', '-e', '0'], build: ['node', '-e', '0'] }))
writeFileSync(join(work, 'notes.md'), 'start\n')
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'Initial')
git(work, 'remote', 'add', 'origin', 'https://github.com/vr7-dryrun/app.git')
git(work, 'push', '-q', bare, 'main:main')
git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

type Scenario = { conclusion: string; jobs: Record<string, string>; assets: string[] }
let scenario: Scenario
const requests: { method: string; url: string; body: string | null }[] = []
const foreign: string[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
let dispatchedAt = ''
const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input), method = init?.method ?? 'GET'
  requests.push({ method, url, body: typeof init?.body === 'string' ? init.body : null })
  const api = 'https://api.github.com/repos/vr7-dryrun/app'
  if (!url.startsWith(api)) { foreign.push(url); throw new Error(`VR7 dry run: refused a request outside the stub: ${url}`) }
  const path = url.slice(api.length)
  const sha = git(work, 'rev-parse', 'HEAD')
  if (path === '/actions/workflows/release.yml/dispatches' && method === 'POST') { dispatchedAt = new Date().toISOString(); return new Response(null, { status: 204 }) }
  if (path.startsWith('/actions/runs?')) return json({ workflow_runs: dispatchedAt ? [{ id: 7, path: '.github/workflows/release.yml', name: 'Release Conductor', head_sha: sha, status: 'completed', conclusion: scenario.conclusion, html_url: 'https://github.com/vr7-dryrun/app/actions/runs/7', created_at: dispatchedAt, run_started_at: dispatchedAt }] : [] })
  if (path.startsWith('/actions/runs/7/jobs')) return json({ jobs: Object.entries(scenario.jobs).map(([name, conclusion], index) => ({ id: 90 + index, name, conclusion, steps: conclusion === 'failure' ? [{ name: name === macJob ? 'Build macOS release' : 'Test', conclusion: 'failure' }] : [] })) })
  if (/\/check-runs\/\d+\/annotations/.test(path)) return json([{ title: 'dry run', message: 'VR7 stubbed failure annotation' }])
  if (path.startsWith('/releases')) return json([{ tag_name: `v${version}`, html_url: `https://github.com/vr7-dryrun/app/releases/tag/v${version}`, target_commitish: sha, published_at: new Date(Date.now() + 1000).toISOString(), created_at: new Date().toISOString(), assets: scenario.assets.map(name => ({ name })) }])
  return new Response('not found', { status: 404 })
}
// Real commands; git's network verbs go to the bare repository instead of github.com.
const service = new DeliveryService({
  fetch: fetchStub as typeof fetch, githubToken: async () => 'vr7-dry-run-token', sleep: async () => {},
  run: async (command, args, options) => {
    const rewritten = command === 'git' && ['fetch', 'push', 'pull'].includes(args[0]!) ? args.map(arg => arg === 'origin' ? bare : arg) : args
    const run = spawnSync(command, rewritten, { cwd: options.cwd, encoding: 'utf8', env: { ...process.env, ...options.env }, shell: false, maxBuffer: 64 * 1024 * 1024 })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    for (const line of out.split(/\r?\n/)) if (line) options.onLine(line)
    return { code: run.status ?? 1, stdout: run.stdout ?? '' }
  }
})

let count = 0
async function ship(label: string, next: Scenario, mac?: boolean) {
  scenario = next
  writeFileSync(join(work, 'notes.md'), `${label} ${++count}\n`)
  requests.length = 0; dispatchedAt = ''
  step(`${label}: publish${mac === false ? ' mac:false' : ''}`)
  const started = service.ship('p1', work, { message: `VR7 ${label}`, publish: true, ...(mac === undefined ? {} : { mac }) }, { kind: 'owner' })
  const run = await service.wait('p1', started.id, 120_000)
  const dispatch = requests.find(request => request.url.endsWith('/dispatches'))
  const release = run.stages.find(stage => stage.id === 'release')
  return { run, dispatchBody: dispatch?.body ? JSON.parse(dispatch.body) : null, releaseDetail: release?.detail ?? '', pushedToBare: git(bare, 'rev-parse', 'main') === git(work, 'rev-parse', 'HEAD') }
}

try {
  const allMac = macUploads
  const numbersOf = (result: Awaited<ReturnType<typeof ship>>) => ({ state: result.run.state, mac: result.run.mac, dispatch: result.dispatchBody, releaseTag: result.run.releaseTag, pushedToBare: result.pushedToBare })
  // P1: the default publish carries the Mac build and verifies its four files.
  const full = await ship('P1-default-mac', { conclusion: 'success', jobs: { [windowsJob]: 'success', [macJob]: 'success' }, assets: [...windowsAssets, ...allMac] })
  const p1 = full.run.state === 'delivered' && full.run.mac === true && full.dispatchBody?.inputs?.mac === 'true' && /latest-mac\.yml/.test(full.releaseDetail) && /\.dmg/.test(full.releaseDetail) && full.pushedToBare
  record('P1-publish-default-mac', p1 ? 'PASS' : 'FAIL', { ...numbersOf(full), assets: [...windowsAssets, ...allMac] }, `release stage: ${full.releaseDetail.slice(0, 300)}; error: ${full.run.error ?? 'none'}`)
  const winOnly = await ship('P1-mac-files-missing', { conclusion: 'success', jobs: { [windowsJob]: 'success', [macJob]: 'success' }, assets: windowsAssets })
  const p1b = winOnly.run.state === 'failed' && winOnly.run.releaseTag === `v${version}` && /Windows release v9\.9\.9 stands/.test(winOnly.run.error ?? '') && /\.dmg, -mac\.zip, -mac\.zip\.blockmap, latest-mac\.yml/.test(winOnly.run.error ?? '')
  record('P1-mac-files-missing', p1b ? 'PASS' : 'FAIL', numbersOf(winOnly), `error: ${winOnly.run.error}`)
  const off = await ship('P1-control-mac-false', { conclusion: 'success', jobs: { [windowsJob]: 'success', [macJob]: 'skipped' }, assets: windowsAssets }, false)
  const p1c = off.run.state === 'delivered' && off.run.mac === false && off.dispatchBody?.inputs?.mac === 'false' && !/mac/i.test(off.releaseDetail)
  record('P1-control-mac-false', p1c ? 'PASS' : 'FAIL', numbersOf(off), `release stage: ${off.releaseDetail.slice(0, 300)}; error: ${off.run.error ?? 'none'}`)
  // P2: only the Mac job failed: reported as that, the Windows release stands.
  const macFail = await ship('P2-mac-job-failed', { conclusion: 'failure', jobs: { [windowsJob]: 'success', [macJob]: 'failure' }, assets: windowsAssets })
  const p2 = macFail.run.state === 'failed' && macFail.run.releaseTag === `v${version}` && /^The Mac build failed/.test(macFail.run.error ?? '') && /Windows release v9\.9\.9 stands with/.test(macFail.run.error ?? '') && /Build macOS release/.test(macFail.run.error ?? '')
  record('P2-mac-job-failed', p2 ? 'PASS' : 'FAIL', numbersOf(macFail), `jobs ${windowsJob}=success ${macJob}=failure; error: ${macFail.run.error}`)
  const winFail = await ship('P2-control-windows-failed', { conclusion: 'failure', jobs: { [windowsJob]: 'failure', [macJob]: 'skipped' }, assets: [] })
  const p2c = winFail.run.state === 'failed' && /ended failure/.test(winFail.run.error ?? '') && !/stands/.test(winFail.run.error ?? '')
  record('P2-control-windows-failed', p2c ? 'PASS' : 'FAIL', numbersOf(winFail), `error: ${winFail.run.error}`)
  record('P-no-foreign-requests', foreign.length ? 'FAIL' : 'PASS', { foreign: foreign.length }, foreign.join(', ') || 'every request went to the stubbed api.github.com routes')
} catch (error) { await failed(error, 'publish') }
await finish()
