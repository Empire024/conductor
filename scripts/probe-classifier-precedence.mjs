// Does an installed exact allow rule decide a Bash call in Auto BEFORE the claude CLI's auto-mode
// classifier is consulted? (feature item permission-approval-delivery-classifier, part 2;
// docs/verification/2026-09-29-approvals-residual.md). A classifier refusal cannot be produced on
// demand, so this measures whether the classifier is consulted at all: the CLI's debug log records
// permissionDecisionMs per tool call, a few ms when a rule decides and a server round-trip (about 1 s)
// when the classifier does. Headless (no window), sonnet/low, harmless local commands:
//   A  no rule                                    -> classifier
//   B  Bash(node probe.mjs)                       -> rule
//   C  pipeline, rule per | part (Conductor's nativeGrantRules, read-only tail included) -> rule
//   D  pipeline, read-only part left to the CLI's read-only allowlist -> classifier (held)
//   E  node probe.mjs < input.txt 2>&1 | tail -5 with Conductor's rules            -> rule
//   L  E's rules delivered live with apply_flag_settings (stream-json), as a grant is -> rule
//   N  apply_flag_settings with no rules                                            -> classifier
// Spends a few cents of real Claude usage: gated on CONDUCTOR_REAL_CLAUDE=1. Exit 1 on any difference.
//   CONDUCTOR_REAL_CLAUDE=1 node scripts/probe-classifier-precedence.mjs [A B C D E L N]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.CONDUCTOR_REAL_CLAUDE !== '1') { console.log('skipped: set CONDUCTOR_REAL_CLAUDE=1 (spends real Claude usage)'); process.exit(0) }
const PIPE = 'node probe.mjs | tail -5', REDIRECT = 'node probe.mjs < input.txt 2>&1 | tail -5'
const REDIRECT_RULES = [`Bash(${REDIRECT})`, 'Bash(node probe.mjs < input.txt 2>&1)', 'Bash(tail -5)']
const cases = {
  A: { command: 'node probe.mjs', rules: [], expect: 'classifier' },
  B: { command: 'node probe.mjs', rules: ['Bash(node probe.mjs)'], expect: 'rule' },
  C: { command: PIPE, rules: [`Bash(${PIPE})`, 'Bash(node probe.mjs)', 'Bash(tail -5)'], expect: 'rule' },
  D: { command: PIPE, rules: [`Bash(${PIPE})`, 'Bash(node probe.mjs)'], expect: 'classifier' },
  E: { command: REDIRECT, rules: REDIRECT_RULES, expect: 'rule' },
  L: { command: REDIRECT, rules: REDIRECT_RULES, expect: 'rule', live: true },
  N: { command: REDIRECT, rules: [], expect: 'classifier', live: true }
}
// A rule decides in single-digit ms; the classifier took 848-1481 ms on 2026-09-29.
const RULE_MS = 150, CLASSIFIER_MS = 300
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)
const rows = []
for (const name of chosen) rows.push(await probe(name, cases[name]))
console.table(rows)
const wrong = rows.filter(row => row.verdict !== 'as expected')
if (wrong.length) { console.log(`${wrong.length} case(s) differ`); process.exit(1) }

async function probe(name, { command, rules, expect, live }) {
  const dir = join(tmpdir(), `conductor-precedence-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'probe.mjs'), "console.log('probe ran')\n")
  writeFileSync(join(dir, 'input.txt'), 'in\n')
  const settings = join(dir, 'flag.json'), debugFile = join(dir, 'debug.log')
  writeFileSync(settings, JSON.stringify({ permissions: { allow: live ? [] : rules } }))
  const prompt = `Run exactly this Bash command once: ${command}  (no cd, nothing else). Then reply with its output only.`
  const args = ['-p', ...(live ? ['--input-format', 'stream-json'] : [prompt]), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--model', 'sonnet', '--effort', 'low',
    '--settings', settings, '--debug-file', debugFile, '--max-turns', '3', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
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
  const decisions = [...debug.matchAll(/tool=Bash .*permissionDecisionMs=(\d+)/g)].map(match => Number(match[1]))
  const ran = messages.some(message => message.type === 'user' && Array.isArray(message.message?.content) && message.message.content.some(block => block.type === 'tool_result' && /probe ran/.test(JSON.stringify(block.content))))
  const denied = messages.filter(message => message.subtype === 'permission_denied').map(message => message.decision_reason)
  const ms = decisions[0]
  const seen = ms === undefined ? 'no Bash call' : ms <= RULE_MS ? 'rule' : ms >= CLASSIFIER_MS ? 'classifier' : 'unclear'
  return { case: name, command, rules: rules.length, live: Boolean(live), applied, permissionDecisionMs: ms ?? null, ran, denied: denied.join('; ') || '', seen, verdict: seen === expect ? 'as expected' : `expected ${expect}` }
}
