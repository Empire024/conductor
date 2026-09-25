// Synthetic `claude` for cloud runs in offline tests and smokes. Never creates a cloud session.
// Mirrors what Claude Code 2.1.281 does (docs/cloud-coworker.md):
//   --cloud <task> ... --debug-file <f>   creates the session, prints its link and exits; the debug
//                                         log carries the create payload (model, branch) and the id.
//   --cloud <session_id>                  a live client, only with CLOUD_FIXTURE_ATTACH=1; otherwise
//                                         the account gate's refusal, exit 1.
//   -p <message> --cloud <session_id>     sends a message under the same gate.
//   --teleport <session_id>               saves the session as a local conversation under
//                                         $CLAUDE_CONFIG_DIR/projects and names it, then waits.
// CLOUD_FIXTURE_BRANCH sets the branch the create payload names (default claude/fixture-note).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const args = process.argv.slice(2)
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined }
const debugFile = value('--debug-file')
const debug = (line) => { if (debugFile) fs.appendFileSync(debugFile, new Date().toISOString() + ' [DEBUG] ' + line + '\n') }
const out = (text) => process.stdout.write(text.replace(/\n/g, '\r\n'))
const attachEnabled = process.env.CLOUD_FIXTURE_ATTACH === '1'
const GATE = 'Error: Attaching to an existing cloud session is not enabled for your account.'
const isSession = (text) => /^(session|cse)_/.test(text || '')

if (args.includes('--teleport')) {
  const sessionId = value('--teleport')
  const localId = crypto.randomUUID()
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const folder = path.join(config, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(folder, { recursive: true })
  const at = new Date().toISOString()
  const usage = { input_tokens: 2, output_tokens: 120, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }
  const records = [
    { type: 'user', timestamp: at, message: { role: 'user', content: 'Add a one-line note in NOTE.md on a branch and open a pull request.' } },
    { type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push -u origin HEAD' } }] } },
    { type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', content: 'To github.com:Empire024/conductor.git\n * [new branch] claude/fixture-note-x1' }] } },
    { type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'I added the note, pushed the branch and opened the pull request.' }] } },
    { type: 'user', isMeta: false, timestamp: at, message: { role: 'user', content: 'This session is being continued from another machine. Application state may have changed.' } },
    { type: 'cost-state', totalCostUSD: 0 }
  ]
  fs.writeFileSync(path.join(folder, localId + '.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  out(' ◒ Teleporting session…\n\n ' + sessionId + '\n\n   ✔ Validating session\n   ✔ Fetching session logs\n   ✔ Getting branch info\n   ✔ Checking out branch\n')
  // Like the real one: it then sits in its own prompt, and names the conversation on Ctrl+C.
  setTimeout(() => out('\x1b[2J\x1b[H' + '─'.repeat(60) + '\n❯ \n' + '─'.repeat(60) + '\n  ⏵⏵ auto mode on (shift+tab to cycle)'), 200)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (text) => { if (text.includes('\u0003')) { out('\n\nResume this session with:\nclaude --resume ' + localId + '\n'); setTimeout(() => process.exit(0), 50) } })
} else if (args.includes('-p')) {
  if (!attachEnabled) { process.stderr.write(GATE + '\n'); process.exit(1) }
  out('Sent to ' + value('--cloud') + '\n')
  process.exit(0)
} else if (isSession(value('--cloud'))) {
  if (!attachEnabled) { out(GATE + '\n'); setTimeout(() => process.exit(1), 50) } else liveClient(value('--cloud'))
} else {
  const task = value('--cloud') || ''
  const model = value('--model') || 'default'
  const sessionId = 'session_01FIXTURE' + String(process.pid).padStart(8, '0')
  const branch = process.env.CLOUD_FIXTURE_BRANCH || 'claude/fixture-note'
  debug('[teleport] phase: POST-sent')
  const payload = { title: value('--name') || task.slice(0, 40), session_context: { sources: [{ type: 'git_repository', url: 'https://github.com/Empire024/conductor', revision: value('--ref') || 'main' }], outcomes: [{ type: 'git_repository', git_info: { type: 'github', repo: 'Empire024/conductor', branches: [branch] } }], model } }
  debug(JSON.stringify('Creating session with payload: ' + JSON.stringify(payload, null, 2)))
  debug('Successfully created remote session: ' + sessionId)
  setTimeout(() => {
    out('Created cloud session: ' + payload.title + '\nView: https://claude.ai/code/' + sessionId + '?from=cli&m=0\nResume with: claude --teleport ' + sessionId + '\n')
    setTimeout(() => process.exit(0), 100)
  }, 300)
}

function liveClient(sessionId) {
  let working = null
  const turn = (reply) => {
    let tick = 0
    working = setInterval(() => { out('\x1b[2K\r' + ['✻', '✶', '✳', '✢'][tick++ % 4] + ' Working… (esc to interrupt)') }, 120)
    working.finish = setTimeout(() => { clearInterval(working); working = null; out('\x1b[2K\r● ' + reply + '\n> ') }, Number(process.env.CLOUD_FIXTURE_TURN_MS || 1500))
  }
  out('Claude Code · cloud session attached\nhttps://claude.ai/code/' + sessionId + '\n> ')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  let draft = '', pasting = false
  process.stdin.on('data', (text) => {
    if (text.includes('\u0003')) process.exit(0)
    if (text === '\u001b') { if (working) { clearInterval(working); clearTimeout(working.finish); working = null; out('\x1b[2K\r⎿ Interrupted by user\n> ') } return }
    text = text.replace(/\u001b\[200~/g, () => { pasting = true; return '' }).replace(/\u001b\[201~/g, () => { pasting = false; return '' })
    for (const character of text) {
      if (character === '\r' && !pasting) { const message = draft.trim(); draft = ''; out('\n'); if (message) turn('Received: ' + message); else out('> ') }
      else if (character === '\u007f') { draft = draft.slice(0, -1); out('\b \b') }
      else { draft += character; out(character) }
    }
  })
}
