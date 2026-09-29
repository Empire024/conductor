// A stand-in for the Codex and Claude Code CLIs in the auto model upgrade tests
// (docs/model-upgrades.md). It answers --version, --help, Codex's app-server initialize and
// model/list, and Claude Code's stream-json initialize, with the catalog CONDUCTOR_FAKE_CLI_CATALOGS
// (a JSON file: {"codex": {"<version>": [models]}, "claude": {...}}) names for its version.
// Never a model turn, never the network.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const take = name => { const index = argv.indexOf(name); if (index < 0) return null; const [value] = argv.splice(index, 2).slice(1); return value }
const provider = take('--fake-provider') ?? 'codex'
const version = take('--fake-version') ?? '0.0.0'
const catalogs = (() => { try { return JSON.parse(readFileSync(process.env.CONDUCTOR_FAKE_CLI_CATALOGS ?? '', 'utf8')) } catch { return {} } })()
const models = catalogs?.[provider]?.[version] ?? []
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`)

if (argv.includes('--version')) {
  process.stdout.write(provider === 'codex' ? `codex-cli ${version}\n` : `${version} (Claude Code)\n`)
  process.exit(0)
}
if (argv.includes('--help')) {
  process.stdout.write('--print --input-format --output-format --verbose --include-partial-messages --permission-prompt-tool --permission-prompts --forward-subagent-text --permission-mode --no-session-persistence --strict-mcp-config --mcp-config\n')
  process.exit(0)
}
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (provider === 'codex') {
    if (message.id === undefined || !message.method) return
    if (message.method === 'initialize') write({ id: message.id, result: { userAgent: `fake-codex/${version}` } })
    else if (message.method === 'model/list') write({ id: message.id, result: { data: models.map(model => ({ id: model.id, model: model.id, displayName: model.displayName ?? model.id, description: model.description ?? '', hidden: Boolean(model.hidden), isDefault: Boolean(model.isDefault), upgrade: model.upgrade ?? null, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' })), nextCursor: null } })
    else write({ id: message.id, error: { code: -32601, message: `fake codex does not implement ${message.method}` } })
    return
  }
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: models.map(model => ({ value: model.id, displayName: model.displayName ?? model.id, description: model.description ?? '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], isDefault: Boolean(model.isDefault) })) } } })
  }
})
lines.on('close', () => process.exit(0))
