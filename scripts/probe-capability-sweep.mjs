// Capability sweep, discovery only: what the installed Codex CLI and Claude Code expose to this
// account, next to what Conductor's own catalogs and adapters assume. Sends no prompt to any
// model. Codex is asked over its app-server protocol (initialize, model/list, config/read,
// account reads); Claude Code is asked through its stream-json control protocol (initialize).
// Conductor's static side is read from the source tree; its live side from a saved
// `models.list` answer of the running app when one is given.
//
//   node scripts/probe-capability-sweep.mjs [--out=artifacts/swarm-2026-09-21/capabilities]
//       [--conductor-models=<models.list json>] [--skip-codex] [--skip-claude]
//
// Writes raw answers as JSON (secret-looking keys redacted), a computed `matrix.json` and a
// readable `matrix.md`. Nothing here is proof that a model answers: it is proof of what is
// advertised and what Conductor would offer.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const m = /^--([^=]+)(?:=(.*))?$/.exec(arg); return m ? [m[1], m[2] ?? true] : [arg, true] }))
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(String(args.out ?? 'artifacts/swarm-2026-09-21/capabilities'))
mkdirSync(out, { recursive: true })
const startedAt = new Date().toISOString()
const notes = []
const note = text => { notes.push(text); console.log(text) }

const SECRET_KEY = /key|token|secret|password|authorization|cookie|email|organization|account_id|accountId/i
function redact(value, key = '') {
  if (SECRET_KEY.test(key) && typeof value !== 'boolean' && value !== null) return '<redacted>'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  return value
}
const save = (name, value) => { writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n'); return value }
const saveText = (name, text) => writeFileSync(join(out, name), text)
const which = command => {
  try { return execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? null } catch { return null }
}
const run = (file, argv, options = {}) => new Promise(done => execFile(file, argv, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => done({ error: error ? error.message : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })))

/** Newline-framed JSON child with request/response bookkeeping. */
function jsonProcess(executable, argv, { cwd, env, onMessage }) {
  const child = spawn(executable, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
  const stderr = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  let pending = ''
  child.stdout.on('data', chunk => {
    pending += String(chunk)
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1)
      if (!line.trim()) continue
      try { onMessage(JSON.parse(line)) } catch (error) { stderr.push(`unparsed frame: ${String(error)}`) }
    }
  })
  const exited = new Promise(resolveExit => child.on('close', code => resolveExit(code)))
  return {
    send: message => child.stdin.write(JSON.stringify(message) + '\n'),
    stderr: () => stderr.join('').slice(-8000),
    close: async () => { try { child.stdin.end() } catch { /* already closed */ } const timer = setTimeout(() => child.kill(), 4000); await exited; clearTimeout(timer) }
  }
}

// ---------------------------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------------------------
async function probeCodex() {
  const executable = process.env.CONDUCTOR_CODEX_PATH || which('codex')
  const result = { executable, version: null, features: null, initialize: null, models: null, modelsHidden: null, config: null, requirements: null, account: null, rateLimits: null, errors: [] }
  if (!executable) { result.errors.push('codex is not on PATH'); return result }
  result.version = (await run(executable, ['--version'])).stdout.trim()
  const features = await run(executable, ['features', 'list'])
  result.features = features.stdout.split(/\r?\n/).filter(Boolean).map(line => { const [name, ...rest] = line.trim().split(/\s{2,}/); const state = rest.pop(); return { name, stage: rest.join(' '), enabled: state === 'true' } })
  saveText('codex-features.txt', features.stdout)
  const responses = new Map()
  const notifications = []
  let id = 0
  const child = jsonProcess(executable, ['app-server', '--listen', 'stdio://'], { cwd: repo, env: process.env, onMessage: message => {
    if (message.id !== undefined && !message.method) responses.get(message.id)?.(message)
    else notifications.push(message)
  } })
  const request = (method, params) => new Promise((resolveResponse, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { responses.delete(requestId); reject(new Error(`${method} timed out`)) }, 60_000)
    responses.set(requestId, message => { clearTimeout(timer); responses.delete(requestId); message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolveResponse(message.result) })
    child.send({ id: requestId, method, ...(params === undefined ? {} : { params }) })
  })
  try {
    result.initialize = await request('initialize', { clientInfo: { name: 'conductor-capability-probe', title: 'Conductor capability probe', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } })
    child.send({ method: 'initialized' })
    for (const [key, params] of [['models', { limit: 100, includeHidden: false }], ['modelsHidden', { limit: 100, includeHidden: true }]]) {
      try { result[key] = await request('model/list', params) } catch (error) { result.errors.push(String(error.message)) }
    }
    try { result.config = await request('config/read', { cwd: repo, includeLayers: true }) } catch (error) { result.errors.push(String(error.message)) }
    try { result.requirements = await request('configRequirements/read') } catch (error) { result.errors.push(String(error.message)) }
    try { result.account = await request('account/read', { refreshToken: false }) } catch (error) { result.errors.push(String(error.message)) }
    try { result.rateLimits = await request('account/rateLimits/read') } catch (error) { result.errors.push(String(error.message)) }
  } catch (error) { result.errors.push(String(error.message)) }
  finally { await child.close() }
  result.notifications = notifications.slice(0, 50)
  result.stderr = child.stderr()
  save('codex-app-server.json', redact(result))
  return result
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------
async function probeClaude() {
  const executable = process.env.CONDUCTOR_CLAUDE_PATH || which('claude')
  const result = { executable, version: null, help: null, initialize: null, messages: [], settings: null, errors: [] }
  if (!executable) { result.errors.push('claude is not on PATH'); return result }
  result.version = (await run(executable, ['--version'])).stdout.trim()
  const help = (await run(executable, ['--help'])).stdout
  saveText('claude-help.txt', help)
  const flag = name => help.includes(name)
  const effortChoices = /--effort <level>\s+Effort level[^()]*\(([^)]*)\)/s.exec(help)?.[1]?.replace(/\s+/g, ' ').trim() ?? null
  result.help = {
    effortChoices, autocompact: flag('--autocompact'), modelAliasesInHelp: /--model <model>[\s\S]*?\(e\.g\.\s*([^)]*)\)/.exec(help)?.[1]?.replace(/\s+/g, ' ') ?? null,
    fastModeFlag: /--fast\b/.test(help), background: flag('--bg, --background'), forkSession: flag('--fork-session'), fallbackModel: flag('--fallback-model'),
    includeHookEvents: flag('--include-hook-events'), forwardSubagentText: flag('--forward-subagent-text'), replayUserMessages: flag('--replay-user-messages'),
    jsonSchema: flag('--json-schema'), maxBudgetUsd: flag('--max-budget-usd'), chrome: flag('--chrome'), systemPromptSnapshot: flag('--system-prompt-snapshot'),
    excludeDynamicSystemPromptSections: flag('--exclude-dynamic-system-prompt-sections'), permissionPrompts: flag('--permission-prompts'), permissionModes: /--permission-mode <mode>[\s\S]*?\(choices: ([^)]*)\)/.exec(help)?.[1]?.replace(/\s+/g, ' ') ?? null,
    cloud: flag('--cloud'), worktree: flag('--worktree'), restricted: flag('--restricted'), bare: flag('--bare')
  }
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    result.settings = { settingNames: Object.keys(settings), model: settings.model ?? null, effortLevel: settings.effortLevel ?? null, fastMode: settings.fastMode ?? null, fastModePerSessionOptIn: settings.fastModePerSessionOptIn ?? null, modelSettings: settings.modelSettings ?? null, autocompact: settings.autoCompactWindow ?? null }
  } catch { result.settings = null }
  // An empty directory as cwd: no project CLAUDE.md, hooks or .mcp.json; the owner's user-level
  // configuration still applies, exactly as it does for a Conductor tab.
  const cwd = await mkdtemp(join(tmpdir(), 'conductor-capability-probe-'))
  const argv = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', '--forward-subagent-text', '--permission-mode', 'default']
  let settle
  const settled = new Promise(resolveSettle => { settle = resolveSettle })
  const child = jsonProcess(executable, argv, { cwd, env: process.env, onMessage: message => {
    result.messages.push(message)
    if (message.type === 'control_response' && message.response?.request_id === 'probe-initialize') { result.initialize = message.response.response ?? message.response; settle() }
  } })
  const timer = setTimeout(() => { result.errors.push('initialize timed out after 90 s'); settle() }, 90_000)
  child.send({ type: 'control_request', request_id: 'probe-initialize', request: { subtype: 'initialize', hooks: {}, forwardSubagentText: true, promptSuggestions: false, agentProgressSummaries: false } })
  await settled
  clearTimeout(timer)
  await child.close()
  await rm(cwd, { recursive: true, force: true }).catch(() => {})
  result.stderr = child.stderr()
  save('claude-initialize.json', redact(result))
  return result
}

// ---------------------------------------------------------------------------------------------
// Conductor: static catalogs from source, live catalog from a saved models.list answer
// ---------------------------------------------------------------------------------------------
const source = path => readFileSync(join(repo, path), 'utf8')
const entries = block => [...block.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/g)].map(m => ({ id: m[1], label: m[2] }))
const block = (text, start) => { const from = text.indexOf(start); if (from < 0) return ''; const to = text.indexOf(']', from); return text.slice(from, to) }
const stringList = text => [...text.matchAll(/'([^']+)'/g)].map(m => m[1])
async function conductorStatic() {
  const manager = source('src/main/agent-manager.ts')
  const codexAdapter = source('src/main/providers/codex.ts')
  const claudeAdapter = source('src/main/providers/claude.ts')
  const localAdapter = source('src/main/providers/local.ts')
  const claudeBlock = manager.slice(manager.indexOf("id: 'claude',"), manager.indexOf("id: 'gemini',"))
  const local = await import(pathToFileURL(join(repo, 'src/shared/local-models.ts')).href)
  let localConfig = null
  try {
    const config = await import(pathToFileURL(join(repo, 'src/main/local-models/config.ts')).href)
    const stack = config.loadConfig()
    localConfig = { llamaVersion: stack.llamaVersion, models: Object.values(stack.models).map(model => ({ id: model.id, label: model.label, contextTokens: model.contextTokens, quant: model.quant, recordedPort: config.recordedPort(model), configuredPort: model.port })) }
  } catch (error) { localConfig = { error: String(error.message) } }
  return {
    codexCatalog: entries(block(manager, 'export const CODEX_MODELS')),
    codexEfforts: stringList(block(manager, 'export const CODEX_EFFORTS')).filter(value => !/^(Automatic|Low|Medium|High|Extra high)$/.test(value)),
    claudeCatalog: entries(claudeBlock),
    claudeEffortsCatalog: [...stringList(block(manager, 'export const CODEX_EFFORTS')), 'max'].filter(value => /^[a-z]+$/.test(value)),
    codexAdapterEffort: stringList(block(codexAdapter, "effort: ['")),
    codexAdapterPermissions: stringList(block(codexAdapter, "permissions: ['")),
    claudeAdapterEffort: stringList(block(claudeAdapter, "effort: ['")),
    claudeAdapterPermissions: stringList(block(claudeAdapter, "permissions: ['")),
    claudeCompatibility: /CLAUDE_COMPATIBILITY = '([^']+)'/.exec(claudeAdapter)?.[1] ?? null,
    codexProtocolBaseline: /CODEX_PROTOCOL_BASELINE = '([^']+)'/.exec(codexAdapter)?.[1] ?? null,
    codexVersionGate: /\/\^0\\\.(\d+)\\\.\//.exec(codexAdapter)?.[1] ? `0.${/\/\^0\\\.(\d+)\\\.\//.exec(codexAdapter)[1]}.x` : null,
    codexAcceptedTurnEfforts: stringList(block(codexAdapter, "!['none'")),
    claudeContextReserve: /this\.contextWindow - this\.maxOutputTokens - ([\d_]+)/.exec(claudeAdapter)?.[1]?.replace(/_/g, '') ?? null,
    localModels: local.LOCAL_MODELS.map(model => ({ ...model })),
    localDefault: local.DEFAULT_LOCAL_MODEL,
    localUsageReportsLimits: /usage: usage => this\.emit\([^\n]*limits/.test(localAdapter),
    localConfig
  }
}
function conductorLive() {
  const path = args['conductor-models'] ? resolve(String(args['conductor-models'])) : join(out, 'conductor-models-list.json')
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  return { path, capturedAt: parsed.capturedAt ?? null, providers: parsed.result ?? parsed }
}

// ---------------------------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------------------------
function codexMatrix(codex, stat, live) {
  const visible = codex?.models?.data ?? []
  const hidden = (codex?.modelsHidden?.data ?? []).filter(model => !visible.some(v => v.model === model.model))
  const runtime = live?.providers?.find(p => p.provider === 'codex')?.models ?? []
  const ids = [...new Set([...visible.map(m => m.model), ...hidden.map(m => m.model), ...stat.codexCatalog.map(m => m.id).filter(id => id !== 'default'), ...runtime.map(m => m.id)])]
  const rows = ids.map(id => {
    const cli = visible.find(m => m.model === id) ?? hidden.find(m => m.model === id)
    const catalog = stat.codexCatalog.find(m => m.id === id)
    const advertised = runtime.find(m => m.id === id)
    const flags = []
    if (cli && !cli.hidden && !catalog) flags.push('advertised by the CLI but missing from the static fallback catalog')
    if (!cli && catalog) flags.push('in the static catalog but not advertised by the CLI to this account')
    if (cli?.hidden) flags.push('hidden in the CLI picker')
    if (cli?.upgrade) flags.push(`CLI suggests upgrade to ${cli.upgrade}`)
    if (cli && advertised && JSON.stringify(cli.supportedReasoningEfforts.map(o => o.reasoningEffort)) !== JSON.stringify(advertised.effort ?? [])) flags.push('effort ladder differs between the CLI and what Conductor advertises')
    if (cli && cli.serviceTiers?.length) flags.push(`service tiers ${cli.serviceTiers.map(t => t.id).join('/')} not surfaced by Conductor`)
    return { id, cliDisplayName: cli?.displayName ?? null, cliDescription: cli?.description ?? null, cliHidden: cli?.hidden ?? null, cliIsDefault: cli?.isDefault ?? null, cliEfforts: cli?.supportedReasoningEfforts.map(o => o.reasoningEffort) ?? null, cliDefaultEffort: cli?.defaultReasoningEffort ?? null, cliServiceTiers: cli?.serviceTiers?.map(t => t.id) ?? null, cliDefaultServiceTier: cli?.defaultServiceTier ?? null, cliInputModalities: cli?.inputModalities ?? null, cliMultiAgentVersion: cli?.multiAgentVersion ?? null, cliUpgrade: cli?.upgrade ?? null, cliRetirementAt: cli?.upgradeInfo?.retirementAt ?? null, staticCatalogLabel: catalog?.label ?? null, conductorAdvertised: Boolean(advertised), conductorEfforts: advertised?.effort ?? null, conductorDefaultEffort: advertised?.defaultEffort ?? null, flags }
  })
  const cliEffortUnion = [...new Set(visible.flatMap(m => m.supportedReasoningEfforts.map(o => o.reasoningEffort)))]
  const effortFlags = []
  for (const effort of stat.codexAdapterEffort) if (!cliEffortUnion.includes(effort)) effortFlags.push(`adapter fallback ladder offers '${effort}', which no advertised model supports`)
  for (const effort of cliEffortUnion) if (!stat.codexAdapterEffort.includes(effort)) effortFlags.push(`adapter fallback ladder lacks '${effort}', which the CLI advertises`)
  for (const effort of cliEffortUnion) if (!stat.codexEfforts.includes(effort)) effortFlags.push(`agent-manager CODEX_EFFORTS (router/task assignment, legacy launch) lacks '${effort}'`)
  return { rows, cliEffortUnion, adapterFallbackEfforts: stat.codexAdapterEffort, catalogEfforts: stat.codexEfforts, acceptedTurnEfforts: stat.codexAcceptedTurnEfforts, effortFlags, config: codex?.config ? { model: codex.config.config?.model ?? null, model_reasoning_effort: codex.config.config?.model_reasoning_effort ?? null, service_tier: codex.config.config?.service_tier ?? null, web_search: codex.config.config?.web_search ?? null, model_context_window: codex.config.config?.model_context_window ?? null, model_auto_compact_token_limit: codex.config.config?.model_auto_compact_token_limit ?? null, approvals_reviewer: codex.config.config?.approvals_reviewer ?? null, personality: codex.config.config?.personality ?? null, features: codex.config.config?.features ?? null, mcpServers: Object.keys(codex.config.config?.mcp_servers ?? {}) } : null, features: Object.fromEntries((codex?.features ?? []).filter(f => ['fast_mode', 'multi_agent', 'multi_agent_v2', 'hooks', 'remote_compaction_v2', 'context_management', 'memories', 'standalone_web_search', 'web_search_cached', 'web_search_request', 'browser_use', 'computer_use', 'steer', 'guardian_approval', 'plugins', 'skill_search', 'tool_search', 'token_budget', 'personality', 'goals', 'collaboration_modes'].includes(f.name)).map(f => [f.name, { stage: f.stage, enabled: f.enabled }])), account: codex?.account ? { type: codex.account.account?.type ?? null, planType: codex.account.account?.planType ?? null } : null, rateLimits: codex?.rateLimits ? { planType: codex.rateLimits.rateLimits?.planType ?? null, primaryUsedPercent: codex.rateLimits.rateLimits?.primary?.usedPercent ?? null, primaryWindowMins: codex.rateLimits.rateLimits?.primary?.windowDurationMins ?? null, secondaryUsedPercent: codex.rateLimits.rateLimits?.secondary?.usedPercent ?? null, secondaryWindowMins: codex.rateLimits.rateLimits?.secondary?.windowDurationMins ?? null, perModel: Object.keys(codex.rateLimits.rateLimitsByLimitId ?? {}) } : null }
}
function claudeMatrix(claude, stat, live) {
  const models = Array.isArray(claude?.initialize?.models) ? claude.initialize.models : []
  const runtime = live?.providers?.find(p => p.provider === 'claude')?.models ?? []
  const ids = [...new Set([...models.map(m => m.value ?? m.id), ...stat.claudeCatalog.map(m => m.id), ...runtime.map(m => m.id)])]
  const rows = ids.map(id => {
    const cli = models.find(m => (m.value ?? m.id) === id)
    const catalog = stat.claudeCatalog.find(m => m.id === id)
    const advertised = runtime.find(m => m.id === id)
    const cliEfforts = cli ? (cli.supportsEffort === false ? [] : Array.isArray(cli.supportedEffortLevels) ? cli.supportedEffortLevels : cli.supportsEffort === true ? stat.claudeAdapterEffort : null) : null
    const flags = []
    if (cli && !catalog) flags.push('offered by Claude Code initialize but not in the static fallback catalog')
    if (!cli && catalog && id !== 'default') flags.push('in the static catalog but not in the initialize model list (an alias the CLI still accepts on --model)')
    if (cli && cliEfforts && cliEfforts.some(e => !stat.claudeAdapterEffort.includes(e))) flags.push('CLI effort level outside the adapter fallback ladder would be dropped')
    if (cli && cli.supportsEffort === false) flags.push('no effort control for this model')
    if (cli && cli.contextWindow === undefined) flags.push('initialize does not state a context window; Conductor learns it from the first result')
    return { id, cliDisplayName: cli?.displayName ?? cli?.name ?? null, cliDescription: cli?.description ?? null, cliSupportsEffort: cli?.supportsEffort ?? null, cliEfforts, cliDefaultEffort: cli?.defaultEffort ?? null, cliIsDefault: cli?.isDefault ?? null, cliExtra: cli ? Object.fromEntries(Object.entries(cli).filter(([k]) => !['value', 'id', 'displayName', 'name', 'description', 'supportsEffort', 'supportedEffortLevels', 'defaultEffort', 'isDefault'].includes(k))) : null, staticCatalogLabel: catalog?.label ?? null, conductorAdvertised: Boolean(advertised), conductorEfforts: advertised?.effort ?? null, flags }
  })
  const init = claude?.initialize ?? {}
  return { rows, adapterFallbackEfforts: stat.claudeAdapterEffort, catalogEfforts: stat.claudeEffortsCatalog, helpEffortChoices: claude?.help?.effortChoices ?? null, initializeKeys: Object.keys(init), commands: Array.isArray(init.commands) ? init.commands.length : null, agents: Array.isArray(init.agents) ? init.agents.length : null, capabilities: init.capabilities ?? null, settings: claude?.settings ?? null, help: claude?.help ?? null }
}
function localMatrix(stat, live) {
  const runtime = live?.providers?.find(p => p.provider === 'local')?.models ?? []
  const rows = stat.localModels.map(model => {
    const config = stat.localConfig?.models?.find(m => m.id === model.id)
    const advertised = runtime.find(m => m.id === model.id)
    const flags = []
    if (config && config.label !== model.label) flags.push(`launcher/composer label '${model.label}' differs from the local config label '${config.label}' used by the provider list`)
    if (!stat.localUsageReportsLimits) flags.push('turn usage carries no context window figures, so the context ring never shows for a local model')
    return { id: model.id, sharedLabel: model.label, configLabel: config?.label ?? null, contextTokens: config?.contextTokens ?? null, quant: config?.quant ?? null, isDefault: model.id === stat.localDefault, conductorAdvertised: Boolean(advertised), conductorLabel: advertised?.label ?? null, flags }
  })
  return { rows, llamaVersion: stat.localConfig?.llamaVersion ?? null }
}

function markdown(matrix) {
  const lines = [`# Capability sweep matrix (${matrix.startedAt})`, '', `Installed: Codex ${matrix.installed.codex ?? 'n/a'}; Claude Code ${matrix.installed.claude ?? 'n/a'}; Conductor baselines Codex ${matrix.installed.codexBaseline}, Claude ${matrix.installed.claudeBaseline}.`, '']
  lines.push('## Codex models', '', '| Model | CLI display name | CLI efforts (default) | Service tiers | Static catalog | Conductor advertises | Flags |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of matrix.codex.rows) lines.push(`| ${row.id} | ${row.cliDisplayName ?? '—'} | ${row.cliEfforts ? row.cliEfforts.join(', ') + ` (${row.cliDefaultEffort})` : '—'} | ${row.cliServiceTiers?.join(', ') || '—'} | ${row.staticCatalogLabel ?? 'no'} | ${row.conductorAdvertised ? (row.conductorEfforts ?? []).join(', ') || 'yes' : 'no'} | ${row.flags.join('; ') || '—'} |`)
  lines.push('', `Adapter fallback effort ladder: ${matrix.codex.adapterFallbackEfforts.join(', ')}. CLI union: ${matrix.codex.cliEffortUnion.join(', ')}. agent-manager CODEX_EFFORTS: ${matrix.codex.catalogEfforts.join(', ')}.`)
  for (const flag of matrix.codex.effortFlags) lines.push(`- ${flag}`)
  lines.push('', '## Claude models', '', '| Model | CLI display name | supportsEffort | CLI efforts | Static catalog | Conductor advertises | Flags |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of matrix.claude.rows) lines.push(`| ${row.id} | ${row.cliDisplayName ?? '—'} | ${row.cliSupportsEffort ?? '—'} | ${row.cliEfforts ? row.cliEfforts.join(', ') || 'none' : '—'} | ${row.staticCatalogLabel ?? 'no'} | ${row.conductorAdvertised ? (row.conductorEfforts ?? []).join(', ') || 'yes (no efforts)' : 'no'} | ${row.flags.join('; ') || '—'} |`)
  lines.push('', `Adapter fallback effort ladder: ${matrix.claude.adapterFallbackEfforts.join(', ')}. --help choices: ${matrix.claude.helpEffortChoices ?? 'n/a'}. Initialize keys: ${matrix.claude.initializeKeys.join(', ') || 'n/a'}.`)
  lines.push('', '## Local models', '', '| Model | Shared label | Config label | Context tokens | Default | Flags |', '| --- | --- | --- | --- | --- | --- |')
  for (const row of matrix.local.rows) lines.push(`| ${row.id} | ${row.sharedLabel} | ${row.configLabel ?? '—'} | ${row.contextTokens ?? '—'} | ${row.isDefault ? 'yes' : ''} | ${row.flags.join('; ') || '—'} |`)
  if (matrix.notes.length) lines.push('', '## Notes', '', ...matrix.notes.map(text => `- ${text}`))
  return lines.join('\n') + '\n'
}

const stat = await conductorStatic()
save('conductor-static.json', stat)
const live = conductorLive()
if (!live) note('No saved Conductor models.list answer found; the "Conductor advertises" column is empty. Save one with the app protocol (models.list) as conductor-models-list.json in the output folder.')
const codex = args['skip-codex'] ? null : await probeCodex()
const claude = args['skip-claude'] ? null : await probeClaude()
for (const error of [...(codex?.errors ?? []), ...(claude?.errors ?? [])]) note(error)
const matrix = {
  startedAt, finishedAt: new Date().toISOString(), inferenceTurns: 0,
  installed: { codex: codex?.version ?? null, claude: claude?.version ?? null, codexBaseline: stat.codexProtocolBaseline, claudeBaseline: stat.claudeCompatibility, codexVersionGate: stat.codexVersionGate },
  conductorLive: live ? { path: live.path, capturedAt: live.capturedAt } : null,
  codex: codexMatrix(codex, stat, live), claude: claudeMatrix(claude, stat, live), local: localMatrix(stat, live), notes
}
save('matrix.json', matrix)
saveText('matrix.md', markdown(matrix))
console.log(markdown(matrix))
console.log(`Written to ${out}. Inference turns: 0.`)
