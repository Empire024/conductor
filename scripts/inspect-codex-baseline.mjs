// Metadata only. Never starts a thread or submits a turn; never reads credential stores.
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { resolve } from 'node:path'
const executable = process.env.CONDUCTOR_CODEX_PATH || 'codex.exe'
const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: process.env.CONDUCTOR_BASELINE_CWD || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const pending = new Map(); let sequence = 0, buffer = ''
const decoder = new StringDecoder('utf8')
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1 }, 20000)
child.stderr.on('data', () => {})
child.stdout.on('data', bytes => {
  buffer += decoder.write(bytes)
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line), entry = pending.get(message.id)
    if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result) }
  }
})
const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n') })
try {
  await request('initialize', { clientInfo: { name: 'conductor-baseline-inspection', version: '1' }, capabilities: { experimentalApi: false } })
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  if (process.argv.includes('--usage-only')) {
    const response = await request('account/rateLimits/read', {})
    const buckets = response.rateLimitsByLimitId ?? { default: response.rateLimits }
    console.log(JSON.stringify({ source: 'native account/rateLimits/read; zero threads/turns', buckets: Object.entries(buckets).map(([id, limit]) => ({ id, limitId: limit.limitId, primary: limit.primary, secondary: limit.secondary, spendControlReached: limit.spendControlReached, rateLimitReachedType: limit.rateLimitReachedType, additionalCreditsAvailable: limit.credits?.hasCredits })) }, null, 2))
  } else {
  const [config, models, requirements] = await Promise.all([
    request('config/read', { includeLayers: true }),
    request('model/list', { limit: 100, includeHidden: false }),
    request('configRequirements/read', {})
  ])
  const effective = config.config
  console.log(JSON.stringify({
    source: 'native App Server metadata only; zero threads/turns',
    model: effective.model, modelProvider: effective.model_provider, effort: effective.model_reasoning_effort,
    permissions: { approval: effective.approval_policy, sandbox: effective.sandbox_mode },
    features: effective.features,
    optionalMcpServers: Object.entries(effective.mcp_servers ?? {}).map(([name, server]) => ({ name, enabled: server.enabled !== false })),
    hookKeys: Object.keys(effective.hooks ?? {}),
    pluginKeys: Object.keys(effective.plugins ?? {}),
    memoryKeys: Object.keys(effective.memories ?? {}),
    configurationLayers: config.layers?.map(layer => ({ name: layer.name ?? layer.source?.type, disabled: layer.disabledReason ?? null, keys: Object.keys(layer.config ?? {}) })),
    requirements: requirements.requirements ? Object.keys(requirements.requirements).filter(key => requirements.requirements[key] != null) : [],
    models: models.data.map(model => ({ id: model.model, label: model.displayName, default: model.isDefault, efforts: model.supportedReasoningEfforts?.map(item => item.reasoningEffort) }))
  }, null, 2))
  }
} finally { clearTimeout(timeout); child.stdin.end(); child.kill() }
