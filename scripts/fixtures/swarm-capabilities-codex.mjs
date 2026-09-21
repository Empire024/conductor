// SYNTHETIC Codex App Server fixture for the capability sweep. No provider, network, credentials
// or inference. `model/list` answers with the catalog codex-cli 0.153.4 advertised to this
// account on 2026-09-21 (captured by scripts/probe-capability-sweep.mjs: ids, display names,
// effort ladders, defaults, service tiers, hidden entries verbatim) plus one effort-less model,
// and explicitly synthetic turns answer with the token-usage and compaction frames the
// production adapter reads. Context-window figures here are fixture values.
import readline from 'node:readline'

if (process.env.CONDUCTOR_TEST_PROVIDER_START_CAPTURE) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.CONDUCTOR_TEST_PROVIDER_START_CAPTURE, `${process.pid}\n`) }
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0) }

const efforts = (...levels) => levels.map(reasoningEffort => ({ reasoningEffort, description: `${reasoningEffort} reasoning (synthetic copy of the CLI description)` }))
const tier = [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }]
const base = { upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, inputModalities: ['text', 'image'], supportsPersonality: false, multiAgentVersion: 'v2', additionalSpeedTiers: ['fast'], serviceTiers: tier, defaultServiceTier: null }
export const CODEX_MODELS = [
  { ...base, id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Our most capable model for complex, demanding work.', hidden: false, supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), defaultReasoningEffort: 'medium', isDefault: true },
  { ...base, id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'The most capable GPT-5.6 model.', hidden: false, supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), defaultReasoningEffort: 'low', isDefault: false },
  { ...base, id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'Balanced GPT-5.6 model for everyday work.', hidden: false, supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), defaultReasoningEffort: 'medium', isDefault: false },
  { ...base, id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', description: 'Fast and affordable GPT-5.6 model.', hidden: false, multiAgentVersion: null, supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max'), defaultReasoningEffort: 'medium', isDefault: false },
  { ...base, id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Legacy model; retires from ChatGPT products on 2026-10-14.', hidden: false, multiAgentVersion: null, upgrade: 'gpt-5.6-sol', supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh'), defaultReasoningEffort: 'medium', isDefault: false },
  { ...base, id: 'gpt-reserve', model: 'gpt-reserve', displayName: 'GPT-Reserve', description: 'Hidden in the CLI picker.', hidden: true, supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max'), defaultReasoningEffort: 'medium', isDefault: false },
  { ...base, id: 'codex-auto-review', model: 'codex-auto-review', displayName: 'Codex Auto Review', description: 'Hidden in the CLI picker.', hidden: true, supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max'), defaultReasoningEffort: 'medium', isDefault: false },
  // Not advertised by the real CLI: a model without an effort ladder, so the sweep can show the
  // composer with no effort control and a default effort the catalog calls 'none'.
  { ...base, id: 'swarm-plain', model: 'swarm-plain', displayName: 'Synthetic effort-less model', description: 'No reasoning efforts.', hidden: false, serviceTiers: [], additionalSpeedTiers: [], supportedReasoningEfforts: [], defaultReasoningEffort: 'none', isDefault: false }
]
/** Fixture context windows per model; the live sweep records the real `modelContextWindow`. */
const WINDOWS = { 'gpt-6-astra': 400_000, 'gpt-5.6-sol': 400_000, 'gpt-5.6-terra': 400_000, 'gpt-5.6-luna': 400_000, 'gpt-5.5': 272_000, 'swarm-plain': 128_000 }

const threadId = 'swarm-codex-thread-1'
let initialized = false
let acknowledged = false
let currentTurn
let turnNumber = 0
let contextUsed = 0
let cumulative = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params })
const itemEvent = (method, item) => notify(method, { threadId, turnId: currentTurn, item })
const finish = (status = 'completed') => notify('turn/completed', { threadId, turn: { id: currentTurn, items: [], status, error: null } })
const defaults = () => ({ thread: { id: threadId, status: { type: 'idle' }, turns: [], cwd: process.cwd() }, model: 'gpt-6-astra', modelProvider: 'openai', serviceTier: 'default', reasoningEffort: 'xhigh', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, instructionSources: [] })
const usage = (model, lastInput, lastOutput) => {
  const last = { inputTokens: lastInput, cachedInputTokens: Math.max(0, lastInput - 4), cacheWriteInputTokens: 0, outputTokens: lastOutput, reasoningOutputTokens: 0, totalTokens: lastInput + lastOutput }
  cumulative = { inputTokens: cumulative.inputTokens + last.inputTokens, cachedInputTokens: cumulative.cachedInputTokens + last.cachedInputTokens, cacheWriteInputTokens: 0, outputTokens: cumulative.outputTokens + last.outputTokens, reasoningOutputTokens: 0, totalTokens: cumulative.totalTokens + last.totalTokens }
  notify('thread/tokenUsage/updated', { threadId, turnId: currentTurn, tokenUsage: { total: cumulative, last, modelContextWindow: WINDOWS[model] ?? null } })
}
const rateLimits = () => ({ limitId: 'codex', limitName: null, primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 6 * 86_400 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, individualLimit: null, spendControlReached: false, planType: 'prolite', rateLimitReachedType: null })

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (!message.method) return
  if (message.method === 'initialize') {
    if (initialized) throw new Error('duplicate initialization')
    initialized = true
    send({ id: message.id, result: { userAgent: 'codex/0.153.4 synthetic capability fixture', codexHome: '/synthetic/not-read', platformFamily: 'windows', platformOs: 'windows' } })
    return
  }
  if (message.method === 'initialized') { if (!initialized) throw new Error('initialized before initialize response'); acknowledged = true; return }
  if (!initialized || !acknowledged) throw new Error('request before initialization handshake completed')
  if (message.method === 'thread/start' || message.method === 'thread/resume') { send({ id: message.id, result: defaults() }); return }
  if (message.method === 'thread/read') { send({ id: message.id, result: { thread: defaults().thread } }); return }
  if (message.method === 'model/list') {
    const data = CODEX_MODELS.filter(model => message.params?.includeHidden || !model.hidden)
    send({ id: message.id, result: { data, nextCursor: null } })
    return
  }
  if (message.method === 'account/rateLimits/read') { send({ id: message.id, result: { rateLimits: rateLimits(), rateLimitsByLimitId: { codex: rateLimits() }, rateLimitResetCredits: null, accountId: 'synthetic-account', rateLimitUpsell: null } }); return }
  if (message.method === 'thread/goal/get') { send({ id: message.id, result: { goal: null } }); return }
  if (message.method === 'skills/list') { send({ id: message.id, result: { data: [{ cwd: process.cwd(), skills: [], errors: [] }] } }); return }
  if (message.method === 'mcpServerStatus/list') { send({ id: message.id, result: { data: [], nextCursor: null } }); return }
  if (message.method === 'plugin/list') { send({ id: message.id, result: { marketplaces: [] } }); return }
  if (['thread/unsubscribe', 'thread/name/set', 'thread/archive', 'thread/unarchive'].includes(message.method)) { send({ id: message.id, result: {} }); return }
  if (message.method === 'turn/interrupt') { send({ id: message.id, result: {} }); setTimeout(() => finish('interrupted'), 15); return }
  if (message.method !== 'turn/start') { send({ id: message.id, error: { code: -32601, message: 'unsupported synthetic request' } }); return }
  currentTurn = `swarm-turn-${++turnNumber}`
  const model = message.params.model ?? 'gpt-6-astra'
  const promptText = message.params.input[0].text
  const scenario = promptText.split(/\r?\n/, 1)[0]
  notify('turn/started', { threadId, turn: { id: currentTurn, status: 'inProgress', items: [], error: null } })
  send({ id: message.id, result: { turn: { id: currentTurn, status: 'inProgress', items: [], error: null } } })
  if (scenario === 'synthetic:compact') {
    itemEvent('item/started', { type: 'contextCompaction', id: `compact-${turnNumber}` })
    itemEvent('item/completed', { type: 'contextCompaction', id: `compact-${turnNumber}` })
    contextUsed = 12_000
    itemEvent('item/completed', { type: 'agentMessage', id: `message-${turnNumber}`, text: 'Compacted.', phase: null, memoryCitation: null, delivery: null, questions: null })
    usage(model, contextUsed, 3)
    finish(); return
  }
  const explicit = /^synthetic:context (\d+)/.exec(scenario)
  if (!explicit && !scenario.startsWith('synthetic:ok')) throw new Error('Fixture accepts explicitly synthetic prompts only')
  contextUsed = explicit ? Number(explicit[1]) : contextUsed + 20_300
  itemEvent('item/completed', { type: 'agentMessage', id: `message-${turnNumber}`, text: 'OK', phase: null, memoryCitation: null, delivery: null, questions: null })
  usage(model, contextUsed, 1)
  if (turnNumber === 1) notify('account/rateLimits/updated', { rateLimits: rateLimits() })
  finish()
})
