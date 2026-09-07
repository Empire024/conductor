// Explicit native metadata preflight only. No thread/start, turn/start, auth write, or user config write.
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { resolve } from 'node:path'

if (process.env.CONDUCTOR_LIVE_TESTS !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'CONDUCTOR_LIVE_TESTS is off; no provider process started.' }))
  process.exit(0)
}
// Compile the production pure preflight functions in memory so launcher checks cannot drift.
const bundle = await build({ entryPoints: [resolve('src/main/providers/codex.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { codexLaunchArguments, validateCodexLiveConfiguration, codexLiveSkillOverrides } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const executable = process.env.CONDUCTOR_CODEX_PATH || 'codex.exe'
const runtimeVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
const args = codexLaunchArguments(process.env)
const cwd = process.env.CONDUCTOR_BASELINE_CWD || process.cwd()
const child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
const pending = new Map()
const methods = []
const decoder = new StringDecoder('utf8')
let sequence = 0, buffer = '', stderr = ''
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-4096) })
child.stdout.on('data', bytes => {
  buffer += decoder.write(bytes)
  if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { child.kill(); return }
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const entry = pending.get(message.id)
    if (entry) {
      pending.delete(message.id)
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
    }
  }
})
child.on('error', error => { for (const entry of pending.values()) entry.reject(error); pending.clear() })
child.on('close', code => { for (const entry of pending.values()) entry.reject(new Error(`Metadata process exited (${code}): ${stderr}`)); pending.clear() })
const timer = setTimeout(() => { for (const entry of pending.values()) entry.reject(new Error('Metadata preflight timed out')); pending.clear(); child.kill() }, 20000)
const request = (method, params) => new Promise((resolve, reject) => {
  if (!['initialize', 'config/read', 'configRequirements/read', 'skills/list'].includes(method)) throw new Error('Metadata preflight cannot invoke model or mutation methods')
  methods.push(method)
  const id = ++sequence
  pending.set(id, { resolve, reject })
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
})
try {
  await request('initialize', { clientInfo: { name: 'conductor-isolation-verification', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } })
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  const requirements = await request('configRequirements/read', {})
  const config = await request('config/read', { includeLayers: true, cwd })
  validateCodexLiveConfiguration(config, requirements)
  const discovered = await request('skills/list', { cwds: [cwd], forceReload: true })
  const skillOverrides = codexLiveSkillOverrides(discovered, config)
  console.log(JSON.stringify({ status: 'metadata-verified', runtimeVersion, methods, threadsStarted: 0, userTurnSubmissions: 0, mcpServers: Object.entries(config.config.mcp_servers ?? {}).map(([name, server]) => ({ name, enabled: server.enabled })), optionalSkillDisableOverridesPrepared: skillOverrides['skills.config'].length, preservedAdministratorSkills: discovered.data.flatMap(entry => entry.skills).filter(skill => skill.scope === 'admin' && skill.enabled).length }, null, 2))
} finally {
  clearTimeout(timer)
  child.stdin.end()
  child.kill()
}
