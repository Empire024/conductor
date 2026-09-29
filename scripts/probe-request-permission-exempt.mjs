// Is filing a request exempt from the claude CLI's auto-mode classifier? (feature item
// permission-approval-delivery-classifier, clause 3: "request_permission is exempt from the
// classifier"). Every Claude tab with the conductor MCP server launches with exact allow rules for
// its request tools (CONDUCTOR_MCP_ALLOWED_TOOLS, src/main/permission-grants/control-mcp.ts) in the
// flag settings layer, beside the owner's grants. scripts/probe-classifier-precedence.mjs showed an
// exact allow rule decides a Bash call before the classifier; this checks the same for the MCP tool,
// from the CLI's own permissionDecisionMs (a few ms: a rule decided; about 1 s: the classifier).
// Headless (no window), sonnet/low, a stub "conductor" MCP server (fixtures/stub-conductor-mcp.mjs)
// that answers without running anything. The request names a production step, the shape refused on
// 2026-09-28.
//   A  no rule                                                    -> classifier
//   R  request_permission with the launch rules (--settings)      -> rule
//   P  list_permissions with the launch rules                     -> rule
//   L  the rules delivered live with apply_flag_settings, as a grant change re-sends them -> rule
// Spends a few cents of real Claude usage: gated on CONDUCTOR_REAL_CLAUDE=1. Exit 1 on any difference.
//   CONDUCTOR_REAL_CLAUDE=1 node scripts/probe-request-permission-exempt.mjs [A R P L]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.CONDUCTOR_REAL_CLAUDE !== '1') { console.log('skipped: set CONDUCTOR_REAL_CLAUDE=1 (spends real Claude usage)'); process.exit(0) }
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The rules Conductor installs, read from the source so the probe cannot drift from it.
const source = readFileSync(join(root, 'src/main/permission-grants/control-mcp.ts'), 'utf8')
const names = JSON.parse(source.match(/CONDUCTOR_MCP_ALLOWED_TOOLS = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
const RULES = names.map(tool => `mcp__conductor__${tool}`)
const REQUEST = 'Call the request_permission tool of the conductor MCP server exactly once with command "ssh root@203.0.113.7 \'bash -s -- --apply --yes\' < prod/fix-lsphp-pool.sh", reason "apply the pool fix on production", rollback "the script\'s own revert". It only files a card for the owner; it runs nothing. Do nothing else, then reply with the tool\'s output only.'
const LIST = 'Call the list_permissions tool of the conductor MCP server exactly once. Do nothing else, then reply with the tool\'s output only.'
const cases = {
  A: { prompt: REQUEST, tool: 'mcp__conductor__request_permission', rules: [], expect: 'classifier' },
  R: { prompt: REQUEST, tool: 'mcp__conductor__request_permission', rules: RULES, expect: 'rule' },
  P: { prompt: LIST, tool: 'mcp__conductor__list_permissions', rules: RULES, expect: 'rule' },
  L: { prompt: REQUEST, tool: 'mcp__conductor__request_permission', rules: RULES, expect: 'rule', live: true }
}
const RULE_MS = 150, CLASSIFIER_MS = 300
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)
const rows = []
for (const name of chosen) rows.push(await probe(name, cases[name]))
console.log(`rules installed: ${RULES.join(', ')}`)
console.table(rows)
const wrong = rows.filter(row => row.verdict !== 'as expected')
if (wrong.length) { console.log(`${wrong.length} case(s) differ`); process.exit(1) }

async function probe(name, { prompt, tool, rules, expect, live }) {
  const dir = join(tmpdir(), `conductor-request-exempt-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const settings = join(dir, 'flag.json'), debugFile = join(dir, 'debug.log'), mcp = join(dir, 'mcp.json')
  writeFileSync(settings, JSON.stringify({ permissions: { allow: live ? [] : rules } }))
  writeFileSync(mcp, JSON.stringify({ mcpServers: { conductor: { type: 'stdio', command: process.execPath, args: [join(root, 'scripts/fixtures/stub-conductor-mcp.mjs')] } } }))
  const args = ['-p', ...(live ? ['--input-format', 'stream-json'] : [prompt]), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--model', 'sonnet', '--effort', 'low',
    '--settings', settings, '--debug-file', debugFile, '--max-turns', '3', '--strict-mcp-config', '--mcp-config', mcp]
  const child = spawn('claude', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  const messages = [], waiting = new Map()
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line); messages.push(message)
      if (message.type === 'control_response') waiting.get(message.response.request_id)?.(message.response)
      if (message.type === 'result') child.stdin.end()
    }
  })
  const exited = new Promise(done => child.on('exit', done))
  const timer = setTimeout(() => child.kill(), 180_000)
  let applied = 'n/a'
  if (live) {
    const control = (id, request) => new Promise(done => { waiting.set(id, done); child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n') })
    await control('init', { subtype: 'initialize' })
    applied = (await control('flag', { subtype: 'apply_flag_settings', settings: { permissions: { allow: rules } } })).subtype
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
  } else child.stdin.end()
  await exited
  clearTimeout(timer)
  const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''
  // 2.1.282 logs an MCP call as "tool_dispatch_start tool=mcp_tool … permissionDecisionMs=N" and names
  // it on the next line, 'MCP server "conductor": Calling MCP tool: <name>'.
  const lines = debug.split(/\r?\n/), decisions = []
  lines.forEach((line, index) => {
    const match = line.match(/tool_dispatch_start tool=(\S+) .*permissionDecisionMs=(\d+)/)
    if (!match) return
    const name = match[1] === 'mcp_tool' ? lines.slice(index + 1, index + 4).map(next => next.match(/MCP server "conductor": Calling MCP tool: (\S+)/)?.[1]).find(Boolean) : match[1]
    if (name && (name === tool || `mcp__conductor__${name}` === tool)) decisions.push(Number(match[2]))
  })
  const ran = messages.some(message => message.type === 'user' && Array.isArray(message.message?.content) && message.message.content.some(block => block.type === 'tool_result' && /STUB/.test(JSON.stringify(block.content))))
  const denied = messages.filter(message => message.subtype === 'permission_denied').map(message => message.decision_reason)
  const ms = decisions[0]
  const seen = ms === undefined ? `no ${tool} call` : ms <= RULE_MS ? 'rule' : ms >= CLASSIFIER_MS ? 'classifier' : 'unclear'
  return { case: name, tool: tool.replace('mcp__conductor__', ''), rules: rules.length, live: Boolean(live), applied, permissionDecisionMs: ms ?? null, ran, denied: denied.join('; ') || '', seen, verdict: seen === expect ? 'as expected' : `expected ${expect}`, debug: debugFile }
}
