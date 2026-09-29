// What model catalog a given codex-cli version is served, without touching the global install or
// the owner's ~/.codex. OpenAI filters the catalog by client version (codex-cli 0.155.1 was never
// offered gpt-6.1-sol; 0.159.1 got it as the default on the same account, 2026-09-30), so a newer
// model only shows up through a newer CLI.
//
//   node scripts/probe-codex-catalog.mjs --version 0.159.1
//   node scripts/probe-codex-catalog.mjs --executable C:/path/codex.exe
//
// Installs @openai/codex@<version> into .conductor-scratch/codex-<version>/, runs its App Server
// with CODEX_HOME=.conductor-scratch/codex-<version>/home (a copy of auth.json only), and asks
// initialize + model/list (hidden included). Zero threads, zero turns. Prints JSON: the version,
// the native executable (CONDUCTOR_CODEX_PATH for scripts/generate-codex-protocol.mjs), and each
// model with efforts and the context window from the CLI's own models_cache.json. The catalog
// carries no prices.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const arg = name => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined }
const wanted = arg('version')
let executable = arg('executable')
if (!wanted && !executable) throw new Error('Pass --version <x.y.z> or --executable <path>')
const root = resolve('.conductor-scratch', `codex-${wanted ?? 'probe'}`)
mkdirSync(root, { recursive: true })
if (!executable) {
  const find = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) { const hit = find(path); if (hit) return hit } else if (/^codex(?:\.exe)?$/.test(name) && /[\\/]bin$/.test(dir) && /vendor/.test(dir)) return path } }
  const packages = join(root, 'node_modules', '@openai')
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error(`Not a version: ${wanted}`)
  if (!existsSync(packages) || !find(packages)) execFileSync(`npm i --prefix "${root}" @openai/codex@${wanted} --no-audit --no-fund`, { stdio: 'inherit', shell: true })
  executable = find(packages)
  if (!executable) throw new Error(`No native codex executable under ${packages}`)
}
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
copyFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(home, 'auth.json'))

const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: root, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
const pending = new Map(); let sequence = 0, buffer = ''
const timer = setTimeout(() => { child.kill(); console.error('model/list timed out'); process.exit(1) }, 60_000)
child.stdout.on('data', bytes => {
  buffer += bytes.toString('utf8'); let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line), entry = pending.get(message.id)
    if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result) }
  }
})
const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n') })
try {
  await request('initialize', { clientInfo: { name: 'conductor-catalog-probe', version: '1' }, capabilities: { experimentalApi: false } })
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  const { data } = await request('model/list', { limit: 100, includeHidden: true })
  let cache = {}
  try { cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')) } catch {}
  const windows = new Map((cache.models ?? []).map(model => [model.slug, model]))
  console.log(JSON.stringify({
    version: version.replace(/^codex-cli\s+/, ''), executable, catalogFetchedAt: cache.fetched_at ?? null, catalogClientVersion: cache.client_version ?? null,
    models: data.map(model => ({
      id: model.model, label: model.displayName, isDefault: model.isDefault, hidden: model.hidden, description: model.description,
      efforts: model.supportedReasoningEfforts?.map(item => item.reasoningEffort), defaultEffort: model.defaultReasoningEffort,
      contextWindow: windows.get(model.model)?.context_window ?? null, maxContextWindow: windows.get(model.model)?.max_context_window ?? null,
      note: model.availabilityNux?.message ?? null
    }))
  }, null, 2))
} finally { clearTimeout(timer); child.stdin.end(); child.kill() }
