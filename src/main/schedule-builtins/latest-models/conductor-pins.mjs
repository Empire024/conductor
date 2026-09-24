// Latest models, step 2: what the Conductor checkout (cwd) hard-codes about the CLIs and their
// models, read from source text the way scripts/probe-capability-sweep.mjs reads its static
// side. Nothing is imported or executed from the checkout.
//
// Prints the static catalogs (CLAUDE_MODELS, CODEX_MODELS, GROK_MODELS), the version pins
// (CLAUDE_COMPATIBILITY, CODEX_PROTOCOL_BASELINE, the Codex version gate, the protocol generator's
// expected version), effort ladders, fallback models, what the capability fixtures captured, and
// every other quoted model id in src/ and scripts/ with its file. Sorted, no timestamps.
// A folder that is not a Conductor checkout prints {"checkout":false}.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.cwd()
const done = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n', () => process.exit(0))
const read = path => { try { return readFileSync(join(root, path), 'utf8') } catch { return null } }


/** The text of the bracketed literal that starts at the first `open` after `from`, skipping
 *  string contents so ids such as 'opus[1m]' do not end the block early. */
function balanced(text, from, open = '[', closeChar = open === '[' ? ']' : '}') {
  const start = text.indexOf(open, from)
  if (start < 0) return ''
  let depth = 0, quoteChar = null
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoteChar) { if (char === '\\') index++; else if (char === quoteChar) quoteChar = null; continue }
    // Comments may hold apostrophes ("the CLI's") that must not open a string.
    if (char === '/' && text[index + 1] === '/') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end; continue }
    if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 1; continue }
    if (char === "'" || char === '"' || char === '`') quoteChar = char
    else if (char === open) depth++
    else if (char === closeChar && --depth === 0) return text.slice(start, index + 1)
  }
  return ''
}
const declaration = (text, constant) => {
  const at = text?.search(new RegExp(`(?:export\\s+)?const\\s+${constant}\\b[^=]*=`)) ?? -1
  return at < 0 ? '' : balanced(text, text.indexOf('=', at))
}
const objects = block => {
  const found = []
  for (let from = 1; ;) {
    const object = balanced(block, from, '{')
    if (!object) return found
    found.push(object)
    from = block.indexOf(object, from) + object.length
  }
}
const field = (object, key) => new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(object)?.[1] ?? null
const flag = (object, key) => { const value = new RegExp(`\\b${key}:\\s*(true|false)`).exec(object)?.[1]; return value === undefined ? null : value === 'true' }
const strings = text => [...(text ?? '').matchAll(/'([^'\n]*)'/g)].map(match => match[1])
const plainVersion = value => /\d+\.\d+\.\d+/.exec(value ?? '')?.[0] ?? null
const unique = values => [...new Set(values)].sort()

/** The comment lines directly above `index` (doc block or // lines). */
function commentAbove(text, index) {
  const lines = text.slice(0, index).split('\n')
  lines.pop()
  const kept = []
  while (lines.length && /^\s*(\/\/|\/\*|\*)/.test(lines.at(-1))) kept.unshift(lines.pop())
  return kept.join('\n')
}
/** Which CLI release and date a catalog says it mirrors, from its own comment. */
function provenance(text, constant) {
  const places = [text.search(new RegExp(`export const ${constant}\\b`)), text.search(new RegExp(`models:\\s*${constant}\\b`))].filter(index => index >= 0)
  for (const index of places) {
    const comment = commentAbove(text, index)
    const version = plainVersion(comment), date = /\b20\d\d-\d\d-\d\d\b/.exec(comment)?.[0] ?? null
    if (version || date) return { version, date }
  }
  return null
}
const catalog = (text, constant) => objects(declaration(text, constant)).map(object => ({ id: field(object, 'id'), label: field(object, 'label') })).filter(entry => entry.id)

function fixtures() {
  const found = []
  const header = text => { const lines = []; for (const line of text.split('\n')) { if (!/^\s*(\/\/|\/\*|\*)/.test(line)) break; lines.push(line) } return lines.join('\n') }
  const describe = (file, provider, parseModels) => {
    const text = read(file)
    if (text === null) return
    const head = header(text)
    const reports = plainVersion(/argv\.includes\('--version'\)\)\s*\{\s*console\.log\('([^']+)'\)/.exec(text)?.[1])
    found.push({
      file, provider, reportsVersion: reports,
      headerVersions: unique([...head.matchAll(/\b\d+\.\d+\.\d+\b/g)].map(match => match[0])),
      headerDates: unique([...head.matchAll(/\b20\d\d-\d\d-\d\d\b/g)].map(match => match[0])),
      ...(parseModels ? { models: parseModels(text) } : {})
    })
  }
  describe('scripts/fixtures/swarm-capabilities-claude.mjs', 'claude', text => objects(declaration(text, 'CLAUDE_MODELS')).map(object => ({
    value: field(object, 'value'), resolvedModel: field(object, 'resolvedModel'), displayName: field(object, 'displayName'),
    supportsEffort: flag(object, 'supportsEffort'), efforts: /supportedEffortLevels:\s*EFFORTS/.test(object) ? strings(declaration(text, 'EFFORTS')) : [],
    // Entries the fixture invents to exercise unknown metadata are named swarm-*.
    synthetic: /^swarm-/.test(field(object, 'value') ?? '')
  })).filter(model => model.value).sort((a, b) => a.value.localeCompare(b.value)))
  describe('scripts/fixtures/swarm-capabilities-codex.mjs', 'codex', text => objects(declaration(text, 'CODEX_MODELS')).map(object => ({
    id: field(object, 'model') ?? field(object, 'id'), displayName: field(object, 'displayName'), hidden: flag(object, 'hidden') ?? false,
    isDefault: flag(object, 'isDefault') ?? false, efforts: strings(/supportedReasoningEfforts:\s*efforts\(([^)]*)\)/.exec(object)?.[1]),
    defaultEffort: field(object, 'defaultReasoningEffort'), upgrade: field(object, 'upgrade'),
    synthetic: /^swarm-/.test(field(object, 'model') ?? field(object, 'id') ?? '')
  })).filter(model => model.id).sort((a, b) => a.id.localeCompare(b.id)))
  describe('scripts/fixtures/codex-app-server.mjs', 'codex', null)
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

// Model-id shaped string literals. Bare Claude aliases are included because a CLI can stop
// accepting a family; `codex-*` is not, it names items and files far more often than models.
const MODEL_ID = [
  /^(?:opus|sonnet|haiku|fable)(?:\[1m\])?$/,
  /^claude-(?:[a-z]{3,}-\d+(?:-\d+)*|\d+(?:-\d+)*-[a-z]+(?:-\d{8})?)(?:\[1m\])?$/,
  /^gpt-\d[\w.-]*$/,
  /^grok-\d[\w.-]*$/
]
const providerOf = id => /^gpt-/.test(id) ? 'codex' : /^grok-/.test(id) ? 'grok' : 'claude'
const SKIP_DIRS = new Set(['node_modules', 'generated', '.git', 'out', 'dist', 'release'])
const OWN_DIR = join('src', 'main', 'schedule-builtins', 'latest-models')
function walk(dir, files) {
  let entries = []
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { return files }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && path !== OWN_DIR) walk(path, files) }
    else if (/\.(?:ts|tsx|mjs|js|cjs)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(path)
  }
  return files
}
function references() {
  const found = new Map()
  for (const path of [...walk('src', []), ...walk('scripts', [])]) {
    const text = read(path)
    if (!text || text.length > 2_000_000) continue
    const file = relative(root, join(root, path)).split(sep).join('/')
    const kind = /\.test\.[cm]?[jt]sx?$/.test(file) ? 'test' : file.startsWith('scripts/fixtures/') || /fixture/i.test(file.split('/').pop()) ? 'fixture' : file.startsWith('scripts/') ? 'script' : 'source'
    for (const match of text.matchAll(/['"`]([a-z][a-z0-9.\-[\]]{1,60})['"`]/g)) {
      const id = match[1]
      if (!MODEL_ID.some(pattern => pattern.test(id))) continue
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      const lineEnd = text.indexOf('\n', match.index)
      const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
      const before = text.slice(lineStart, match.index)
      const comment = /^\s*(\/\/|\/\*|\*)/.test(line) || before.includes('//')
      const retired = /retired|legacy|deprecated/i.test(line)
      const key = `${id}\u0000${file}\u0000${comment}\u0000${retired}`
      if (!found.has(key)) found.set(key, { id, provider: providerOf(id), file, kind, comment, retired })
    }
  }
  // No line numbers: an unrelated edit above a reference must not change the evidence.
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file) || Number(a.comment) - Number(b.comment) || Number(a.retired) - Number(b.retired))
}

function main() {
  const manager = read('src/main/agent-manager.ts') ?? ''
  const claudeAdapter = read('src/main/providers/claude.ts') ?? ''
  const codexAdapter = read('src/main/providers/codex.ts') ?? ''
  const selection = read('src/shared/agent-model-selection.ts') ?? ''
  const agent = read('src/shared/structured-agent.ts') ?? ''
  const routing = read('src/shared/model-routing.ts') ?? ''
  const generator = read('scripts/generate-codex-protocol.mjs') ?? ''
  const gate = /\/\^(\d+)\\\.(\d+)\\\.\/\.test\([^)]*runtimeVersion\)/.exec(codexAdapter)
  const constant = (text, name) => new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`).exec(text)?.[1] ?? null
  const frontier = provider => new RegExp(`provider === '${provider}'\\) return /(.+?)/([a-z]*)\\.test\\(model\\)`).exec(agent)
  const rank = [...routing.matchAll(/if \(\/(.+?)\/([a-z]*)\.test\(id\)\) return (\d)/g)].map(match => ({ pattern: match[1], flags: match[2], rank: Number(match[3]) }))
  done({
    checkout: true,
    catalogs: {
      claude: catalog(manager, 'CLAUDE_MODELS'),
      codex: catalog(manager, 'CODEX_MODELS'),
      grok: catalog(manager, 'GROK_MODELS')
    },
    catalogProvenance: {
      claude: provenance(manager, 'CLAUDE_MODELS'),
      codex: provenance(manager, 'CODEX_MODELS'),
      grok: provenance(manager, 'GROK_MODELS')
    },
    claudeCompatibility: constant(claudeAdapter, 'CLAUDE_COMPATIBILITY'),
    codexProtocolBaseline: constant(codexAdapter, 'CODEX_PROTOCOL_BASELINE'),
    codexVersionGate: gate ? `${gate[1]}.${gate[2]}.x` : null,
    codexGeneratorExpected: /const expected = '([^']+)'/.exec(generator)?.[1] ?? null,
    efforts: {
      catalog: objects(declaration(manager, 'CODEX_EFFORTS')).map(object => field(object, 'id')).filter(Boolean),
      claudeAdapter: strings(/\beffort:\s*(\[[^\]]*\])/.exec(claudeAdapter)?.[1]),
      codexAdapter: strings(/\beffort:\s*(\[[^\]]*\])/.exec(codexAdapter)?.[1]),
      codexAccepted: strings(/!(\['none'[^\]]*\])\.includes\(settings\.effort\)/.exec(codexAdapter)?.[1])
    },
    fallbacks: {
      claude: constant(selection, 'CLAUDE_FALLBACK_MODEL'),
      codex: constant(selection, 'CODEX_FALLBACK_MODEL'),
      grok: constant(selection, 'GROK_FALLBACK_MODEL')
    },
    classifiers: {
      frontier: Object.fromEntries(['claude', 'codex', 'grok'].map(provider => { const match = frontier(provider); return [provider, match ? { pattern: match[1], flags: match[2] } : null] })),
      capabilityRank: rank
    },
    fixtures: fixtures(),
    references: references()
  })
}

let packageName = null
try { packageName = JSON.parse(read('package.json') ?? '{}').name } catch { /* not JSON */ }
if (packageName === 'conductor-desktop') main()
else done({ checkout: false })
