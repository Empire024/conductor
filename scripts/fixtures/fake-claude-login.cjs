// A stand-in for the Claude CLI's login commands, for scripts/smoke-phone-login.mjs. It signs
// nobody in: `auth login` and `setup-token` print a sign-in URL the way Claude Code 2.1.287 does
// when the browser cannot be opened, wait for a pasted code and accept only FAKE_GOOD_CODE;
// `auth status` reports whether that happened. The token it prints is fake.
const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')

const GOOD_CODE = process.env.FAKE_GOOD_CODE || 'smoke-good-code-12345#smoke-state'
const STATE = process.env.FAKE_LOGIN_STATE_FILE || join(__dirname, '.fake-claude-login-state')
const FAKE_TOKEN = 'sk-ant-oat01-' + 'SMOKEfakeTOKEN_'.repeat(6)
const URL_TEXT = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=fake&code_challenge_method=S256&state=smoke-state'
const args = process.argv.slice(2)
const out = text => process.stdout.write(text)

if (args[0] === 'auth' && args[1] === 'status') {
  out(JSON.stringify({ loggedIn: existsSync(STATE), authMethod: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : existsSync(STATE) ? 'claude.ai' : 'none', apiProvider: 'firstParty' }, null, 2) + '\n')
  process.exit(0)
}
const setup = args[0] === 'setup-token'
if (!setup && !(args[0] === 'auth' && args[1] === 'login')) { out('fake-claude-login: unsupported ' + args.join(' ') + '\n'); process.exit(2) }
if (!process.env.BROWSER) { out('fake-claude-login: refusing to "open a browser" without BROWSER set\n'); process.exit(3) }

out(setup ? 'This will guide you through long-lived (1-year) auth token setup for your Claude account.\r\n' : 'Opening browser to sign in…\r\n')
out((setup ? "Browser didn't open? Use the url below to sign in (c to copy)\r\n" : "If the browser didn't open, visit: ") + `\x1b]8;id=1;${URL_TEXT}\x07${URL_TEXT}\x1b]8;;\x07\r\n\r\n`)
out('Paste code here if prompted > ')
const input = readline.createInterface({ input: process.stdin })
input.once('line', line => {
  const code = line.trim()
  if (code !== GOOD_CODE) {
    out(setup ? '\r\nOAuth error: Request failed with status code 400\r\n' : '\r\nLogin failed: Request failed with status code 400\r\n')
    setTimeout(() => process.exit(1), 100)
    return
  }
  if (setup) {
    out('\r\n\x1b[32m✓ Long-lived authentication token created successfully!\x1b[0m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\x1b[33m' + FAKE_TOKEN + '\x1b[0m\r\n\r\nStore this token securely. You won\'t be able to see it again.\r\n')
    // The real CLI waits for a key here; Conductor kills it once it has the token.
    setInterval(() => {}, 1000)
    return
  }
  writeFileSync(STATE, new Date().toISOString())
  out('\r\nLogin successful.\r\n')
  setTimeout(() => process.exit(0), 100)
})
